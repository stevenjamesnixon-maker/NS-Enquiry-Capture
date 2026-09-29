/**
 * @NApiVersion 2.x
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */

/**
 * Project (customrecord_project) User Event
 * =========================================
 * v2.0.2 - Pre-Quote retired
 *
 * v2.0.2 fixes the alternate-customer Opportunity not being raised.
 *
 * THE REAL FIX: alternate customers are now RECONCILED, not diffed. Every save
 * asks which alternate customers on the project do not yet hold an Opportunity,
 * and raises those. Both v1 and v2.0.0 compared against the old record and acted
 * only on what had just been added, which is why an alternate customer that missed
 * its Opportunity once never got one - by the next save it was on the old list too,
 * so the diff never mentioned it again. Reconciling is self-healing and idempotent,
 * and it picks up the customers already sitting on your projects without one.
 * It also now runs on create, so alternate customers entered on the new-project
 * form are no longer ignored.
 *
 * Three v2.0.0 regressions closed off at the same time:
 *
 *   a) The branch was gated on "&& oldRecord". Without oldRecord that silently did
 *      nothing - no Opportunity, no error, nothing in the log. Gone.
 *   b) v1's "autoCreate == true" had been tightened to "=== true". A checkbox
 *      coming back as 1 or 'T' rather than boolean true passes the first and fails
 *      the second. isTrue() now accepts all of them.
 *   c) The trigger type was tested against the scriptContext.UserEventType enum
 *      instead of v1's plain strings. Back to plain strings.
 *
 * Every gate writes an audit line, so if anything still does not fire, the
 * execution log says which test failed and what the raw values were. Grep PROJ_UE.
 *
 * Purpose
 * -------
 * On a project save, raise the Opportunity (or Opportunities) the project needs,
 * link the lead Opportunity back to the project, and keep the market / build type
 * in step across the project's Opportunities.
 *
 * Changes from v1
 * ---------------
 *  1. Pre-Quote removed. createPreQuote() has gone, and with it the block that
 *     pushed the build type onto customrecord_pre_quote records. The form is
 *     redundant, so nothing here reads or writes it any more.
 *  2. Market sync fired on every save in v1. oldMarket was initialised to null and
 *     only assigned inside the edit branch, so on create, on OZ projects, and
 *     whenever auto-create was off, "null != projectMarket" was true and the
 *     search + submitFields ran for nothing. It now runs only on an edit where the
 *     build type genuinely changed.
 *  3. Every record write is wrapped in try/catch and logged at audit level with the
 *     project ID. A failed Opportunity no longer rolls back the user's save.
 *  4. Empty alternate-customer multiselects and customers with no sales rep no
 *     longer throw (arrayDifference read .length off null; salesRep[0].value threw
 *     on an empty array).
 *  5. The Opportunity search is fully paged - v1's getRange({start:0,end:20}) hid
 *     everything past the 20th row - and filters on mainline so each Opportunity
 *     is visited once, not once per line.
 *  6. Governance is checked before each create in the alternate-customer loop.
 *  7. redirect only runs in a user-interface context, and never on inline edit.
 *  8. The New/Existing/Returning lookup only runs when an Opportunity is actually
 *     going to be created.
 *
 * DELIBERATE - do not "correct" these field IDs. They are the real IDs in the
 * account and the script stops finding the fields if they are tidied:
 *     custbodycustbody_opp_max_status   (doubled prefix)
 *     custbody_opp_site_adress          (single 'd')
 *
 * Note on re-entry: the lead-Opportunity write-back uses record.submitFields,
 * which re-triggers this script as an 'edit'. That pass is harmless - the market
 * has not changed and the alternate-customer list has not changed - but keep it in
 * mind before adding unconditional work to afterSubmit.
 *
 * Grep the execution log for PROJ_UE.
 */

define(['N/record', 'N/search', 'N/format', 'N/runtime', 'N/redirect'],

function (record, search, format, runtime, redirect) {

    'use strict';

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------
    var REC_PROJECT        = 'customrecord_project';

    var QUOTE_TYPE_STD     = 23;    // standard project
    var QUOTE_TYPE_OZ      = 2;     // OZ project
    var DEPT_SALES         = 25;    // 25 = Sales

    var NER_NEW            = 1;
    var NER_EXISTING       = 2;
    var NER_RETURNING      = 3;
    var RETURNING_DAYS     = 730;   // 2 years since last sale = Returning

    var FLD_OPP_MARKET     = 'custbody_mis_opp_market';

    // An Opportunity save costs 20 governance units. Stop the alternate-customer
    // loop before we run out rather than creating half of them and dying.
    var MIN_UNITS_PER_OPP  = 50;

    var LOG_KEY            = 'PROJ_UE';

    // =======================================================================
    // Entry points
    // =======================================================================

    /**
     * beforeLoad - on copy only: flag the record as a copy and clear the lead
     * Opportunity, so the copy raises its own rather than pointing at the
     * original's.
     */
    function beforeLoad(scriptContext) {

        if (scriptContext.type !== scriptContext.UserEventType.COPY) {
            return;
        }

        try {
            scriptContext.newRecord.setValue({
                fieldId: 'custrecord_proj_copy',
                value: true
            });
            // setValue('') rather than setText('') - setText on a select field is
            // unreliable and silently leaves the old value in place.
            scriptContext.newRecord.setValue({
                fieldId: 'custrecord_proj_lead_opp',
                value: ''
            });
        } catch (e) {
            log.error(LOG_KEY + ' beforeLoad failed', e);
        }
    }

    /**
     * afterSubmit - create Opportunities and keep the market in step.
     */
    function afterSubmit(scriptContext) {

        // Plain strings, as v1 used. The scriptContext.UserEventType enum is
        // equivalent, but this removes any question of it.
        var type = String(scriptContext.type);

        if (type === 'delete') {
            return;
        }

        var newRecord = scriptContext.newRecord;
        var oldRecord = scriptContext.oldRecord;
        var projectID = newRecord.id;

        var isCreate = (type === 'create' || type === 'copy');

        var customerID    = newRecord.getValue({ fieldId: 'custrecord_proj_customer' });
        var altCust       = toIdArray(newRecord.getValue({ fieldId: 'custrecord_proj_alt_cust' }));
        var siteAddress   = newRecord.getValue({ fieldId: 'custrecord_proj_address' });
        var projectMarket = newRecord.getValue({ fieldId: 'custrecord_proj_build_type' });
        var projectName   = newRecord.getValue({ fieldId: 'altname' });
        var urgentPR      = newRecord.getValue({ fieldId: 'custrecord_proj_urgent' });
        var oppMaxStatus  = newRecord.getValue({ fieldId: 'custrecord_oppmaxstatus' });
        var ozRaw         = newRecord.getValue({ fieldId: 'custrecord_proj_oz' });
        var autoCreateRaw = newRecord.getValue({ fieldId: 'custrecord_proj_create_qr_pq' });
        var parentOpp     = newRecord.getValue({ fieldId: 'custrecord_proj_lead_opp' });

        var isOZ       = isTrue(ozRaw);
        var autoCreate = isTrue(autoCreateRaw);

        // TODO (pending decision) - these fed the retired Pre-Quote record and are
        // currently unused. If the notes, the primary contact or the alternate
        // customer's sales rep should land on the Opportunity instead, read them
        // here and set them in createOpp(). getSalesRep() below is kept for the
        // same reason.
        // var projectNotes   = newRecord.getValue({ fieldId: 'custrecord_proj_notes' });
        // var projectContact = newRecord.getValue({ fieldId: 'custrecord_proj_prim_contact' });

        // Raw values as well as the interpreted ones - if a gate closes when it
        // should not have, this line says why.
        log.audit(LOG_KEY + ' afterSubmit project ' + projectID,
            'type: ' + type +
            ', autoCreate: ' + autoCreate + ' (raw: ' + autoCreateRaw + ')' +
            ', OZ: ' + isOZ + ' (raw: ' + ozRaw + ')' +
            ', market: ' + projectMarket +
            ', altCust: [' + altCust.join(', ') + ']' +
            ', oldRecord present: ' + (oldRecord ? 'yes' : 'NO'));

        // -------------------------------------------------------------------
        // Opportunity creation
        // -------------------------------------------------------------------
        if (!autoCreate) {
            log.audit(LOG_KEY + ' no Opportunity raised on project ' + projectID,
                'custrecord_proj_create_qr_pq is not ticked (raw value: ' + autoCreateRaw + ')');

        } else if (isOZ && altCust.length) {
            log.audit(LOG_KEY + ' alternate customers skipped on project ' + projectID,
                'OZ project - alternate customers are not actioned on OZ, as in v1. ' +
                'On the project: [' + altCust.join(', ') + ']');
        }

        if (autoCreate) {

            var leadOppID = parentOpp;

            if (isCreate) {
                // v1 had two near-identical create branches differing only in
                // quote type (and the Pre-Quote, now gone). Merged.
                leadOppID = createLeadOpportunity({
                    projectID:    projectID,
                    customerID:   customerID,
                    quoteType:    isOZ ? QUOTE_TYPE_OZ : QUOTE_TYPE_STD,
                    address:      siteAddress,
                    market:       projectMarket,
                    oppMaxStatus: oppMaxStatus,
                    title:        projectName,
                    urgent:       urgentPR
                }) || parentOpp;
            }

            // Alternate customers are now reconciled on EVERY save, create
            // included. v1 only looked at them on edit, so any alternate customer
            // entered on the new-project form was never given an Opportunity - and
            // was on the "old" list by the next save, so the diff never caught up.
            //
            // Still skipped for OZ projects, as in v1.
            if (!isOZ) {
                createAlternateCustomerOpportunities({
                    projectID:    projectID,
                    added:        newAlternateCustomers(projectID, altCust, oldRecord),
                    address:      siteAddress,
                    market:       projectMarket,
                    oppMaxStatus: oppMaxStatus,
                    title:        projectName,
                    urgent:       urgentPR,
                    parentOpp:    leadOppID
                });
            }
        }

        // -------------------------------------------------------------------
        // Market sync - edit only, and only when the build type actually changed
        // -------------------------------------------------------------------
        if (!isCreate && oldRecord) {
            var oldMarket = oldRecord.getValue({ fieldId: 'custrecord_proj_build_type' });
            if (String(oldMarket) !== String(projectMarket)) {
                log.audit(LOG_KEY + ' market changed on project ' + projectID,
                    'from: ' + oldMarket + ' to: ' + projectMarket);
                updateOpportunityField(projectID, FLD_OPP_MARKET, projectMarket);
            }
        }

        // -------------------------------------------------------------------
        // Return the user to the project record. UI only - a redirect during a
        // CSV import, a web services call or an inline edit either errors or
        // breaks the edit.
        // -------------------------------------------------------------------
        if (runtime.executionContext === runtime.ContextType.USER_INTERFACE &&
            type !== 'xedit') {
            redirect.toRecord({ type: REC_PROJECT, id: projectID });
        }
    }

    // =======================================================================
    // Opportunity creation
    // =======================================================================

    /**
     * Create the project's lead Opportunity and write it back onto the project.
     */
    function createLeadOpportunity(cfg) {

        var oppID = null;

        try {
            oppID = createOpp({
                customerID:   cfg.customerID,
                projectID:    cfg.projectID,
                quoteType:    cfg.quoteType,
                address:      cfg.address,
                market:       cfg.market,
                oppMaxStatus: cfg.oppMaxStatus,
                ner:          nerCalc(cfg.customerID),
                title:        cfg.title,
                urgent:       cfg.urgent,
                isCopy:       false,
                parentOpp:    null
            });
        } catch (e) {
            log.error(LOG_KEY + ' lead Opportunity failed for project ' + cfg.projectID,
                'customer: ' + cfg.customerID + ' - ' + e.message);
            return null;
        }

        try {
            record.submitFields({
                type:   REC_PROJECT,
                id:     cfg.projectID,
                values: { custrecord_proj_lead_opp: oppID }
            });
            log.audit(LOG_KEY + ' lead Opportunity linked', 'project ' + cfg.projectID + ' -> opp ' + oppID);
        } catch (e) {
            // The Opportunity exists but is not linked. Loud, because it needs
            // fixing by hand.
            log.error(LOG_KEY + ' lead Opportunity NOT linked to project ' + cfg.projectID,
                'opp ' + oppID + ' was created but the write-back failed - ' + e.message);
        }

        return oppID;
    }

    /**
     * Work out which alternate customers still need an Opportunity.
     *
     * RECONCILE, DO NOT DIFF. v1 and v2.0.0 both compared the alternate-customer
     * list against the old record and acted only on what had just been added. That
     * is fragile in a way that showed up in testing: an alternate customer that
     * misses its Opportunity for any reason - added on the new-project form before
     * a lead Opportunity exists, added during a save that errored, added while
     * v2.0.0's oldRecord gate was silently closing the branch - is on the old list
     * by the next save, so the diff never mentions it again and it stays without an
     * Opportunity permanently. That is exactly the "still missing from the original
     * alternate customer" symptom.
     *
     * So instead of asking "what changed", ask the account "which of these
     * customers does not yet hold an Opportunity on this project" and raise those.
     * Self-healing, and idempotent - a save that changes nothing raises nothing.
     *
     * CONSEQUENCE, deliberate: if someone deletes an alternate customer's
     * Opportunity by hand but leaves them on the project, the next save raises a
     * replacement. Remove the customer from the list as well, or say the word and
     * this goes back to diffing.
     */
    function newAlternateCustomers(projectID, altCust, oldRecord) {

        if (!altCust.length) {
            return [];
        }

        var alreadyHave = opportunityCustomers(projectID);
        var toRaise     = arrayDifference(altCust, alreadyHave);

        // Logged for comparison only - this is what v1 would have acted on.
        if (oldRecord) {
            var oldAltCust = toIdArray(oldRecord.getValue({ fieldId: 'custrecord_proj_alt_cust' }));
            log.audit(LOG_KEY + ' alternate customer change on project ' + projectID,
                'now: [' + altCust.join(', ') + '], was: [' + oldAltCust.join(', ') +
                '], just added: [' + arrayDifference(altCust, oldAltCust).join(', ') + ']');
        }

        log.audit(LOG_KEY + ' alternate customer reconcile on project ' + projectID,
            'on the project: [' + altCust.join(', ') + '], already hold an opp: [' +
            alreadyHave.join(', ') + '], to raise: [' + toRaise.join(', ') + ']');

        return toRaise;
    }

    /**
     * Internal IDs of the customers that already hold an Opportunity on this
     * project. Used only by the oldRecord fallback above.
     */
    function opportunityCustomers(projectID) {

        var customers = [];

        try {
            search.create({
                type: search.Type.TRANSACTION,
                filters: [
                    search.createFilter({ name: 'custbody_trans_project', operator: search.Operator.IS, values: projectID }),
                    search.createFilter({ name: 'type',                   operator: search.Operator.IS, values: 'Opprtnty' }),
                    search.createFilter({ name: 'mainline',               operator: search.Operator.IS, values: 'T' })
                ],
                columns: [search.createColumn({ name: 'entity' })]
            }).run().each(function (result) {
                var entity = result.getValue('entity');
                if (entity) {
                    customers.push(String(entity));
                }
                return true;
            });
        } catch (e) {
            log.error(LOG_KEY + ' existing Opportunity search failed on project ' + projectID, e.message);
        }

        return customers;
    }

    /**
     * Raise a child Opportunity for every customer newly added to the
     * alternate-customer list.
     */
    function createAlternateCustomerOpportunities(cfg) {

        var added = cfg.added || [];

        if (!added.length) {
            log.audit(LOG_KEY + ' no new alternate customers on project ' + cfg.projectID,
                'nothing to raise');
            return;
        }

        log.audit(LOG_KEY + ' alternate customers added on project ' + cfg.projectID, added.join(', '));

        for (var i = 0; i < added.length; i++) {

            if (runtime.getCurrentScript().getRemainingUsage() < MIN_UNITS_PER_OPP) {
                log.error(LOG_KEY + ' out of governance on project ' + cfg.projectID,
                    'stopped after ' + i + ' of ' + added.length +
                    ' alternate customers. Not created: ' + added.slice(i).join(', '));
                break;
            }

            var custID = added[i];

            try {
                // TODO (pending decision): getSalesRep(custID) was used to own the
                // Pre-Quote. Wire it into createOpp if the rep should carry over.
                var oppID = createOpp({
                    customerID:   custID,
                    projectID:    cfg.projectID,
                    quoteType:    QUOTE_TYPE_STD,
                    address:      cfg.address,
                    market:       cfg.market,
                    oppMaxStatus: cfg.oppMaxStatus,
                    ner:          nerCalc(custID),
                    title:        cfg.title,
                    urgent:       cfg.urgent,
                    isCopy:       true,
                    parentOpp:    cfg.parentOpp || null
                });
                log.audit(LOG_KEY + ' alternate Opportunity created',
                    'project ' + cfg.projectID + ', customer ' + custID + ' -> opp ' + oppID);
            } catch (e) {
                // Carry on - one bad customer should not cost the others.
                log.error(LOG_KEY + ' alternate Opportunity failed on project ' + cfg.projectID,
                    'customer ' + custID + ' - ' + e.message);
            }
        }
    }

    /**
     * Create a single Opportunity. Throws on failure - callers decide what that
     * means.
     */
    function createOpp(cfg) {

        var opp = record.create({ type: record.Type.OPPORTUNITY });

        opp.setValue({ fieldId: 'entity',                          value: cfg.customerID });
        opp.setValue({ fieldId: 'custbody_trans_project',          value: cfg.projectID });
        opp.setValue({ fieldId: 'custbody_quote_type',             value: cfg.quoteType });
        opp.setValue({ fieldId: 'custbody_opp_site_adress',        value: cfg.address });       // sic - real field ID
        opp.setValue({ fieldId: FLD_OPP_MARKET,                    value: cfg.market });
        opp.setValue({ fieldId: 'custbodycustbody_opp_max_status', value: cfg.oppMaxStatus });  // sic - real field ID
        opp.setValue({ fieldId: 'department',                      value: DEPT_SALES });
        opp.setValue({ fieldId: 'custbody_new_ex_ret',             value: cfg.ner });
        opp.setValue({ fieldId: 'custbody_quote_email_ref',        value: cfg.title });
        opp.setValue({ fieldId: 'custbody_urgent',                 value: cfg.urgent });
        opp.setValue({ fieldId: 'custbody_copy_qr',                value: cfg.isCopy });

        if (cfg.parentOpp) {
            opp.setValue({ fieldId: 'custbody_parent_opp', value: cfg.parentOpp });
        }

        return opp.save({ enableSourcing: true, ignoreMandatoryFields: true });
    }

    // =======================================================================
    // Opportunity maintenance
    // =======================================================================

    /**
     * Set fieldId to updateValue on every Opportunity linked to the project that
     * does not already hold that value.
     *
     * v1 searched with getRange({start:0, end:20}), so anything past the 20th row
     * was silently skipped, and it had no mainline filter, so a multi-line
     * Opportunity was visited once per line. Both fixed.
     */
    function updateOpportunityField(projectID, fieldId, updateValue) {

        var checked = 0;
        var updated = 0;

        try {
            var oppSearch = search.create({
                type: search.Type.TRANSACTION,
                filters: [
                    search.createFilter({
                        name:     'custbody_trans_project',
                        operator: search.Operator.IS,
                        values:   projectID
                    }),
                    search.createFilter({
                        name:     'type',
                        operator: search.Operator.IS,
                        values:   'Opprtnty'
                    }),
                    search.createFilter({
                        name:     'mainline',
                        operator: search.Operator.IS,
                        values:   'T'
                    })
                ],
                columns: [search.createColumn({ name: fieldId })]
            });

            oppSearch.run().each(function (result) {

                checked++;

                var current = result.getValue(fieldId);

                if (String(current) === String(updateValue)) {
                    return true;
                }

                try {
                    var values = {};
                    values[fieldId] = updateValue;   // v1 hardcoded the market field
                                                     // here and ignored its own
                                                     // parameter.

                    record.submitFields({
                        type:   record.Type.OPPORTUNITY,
                        id:     result.id,
                        values: values
                    });
                    updated++;
                } catch (e) {
                    log.error(LOG_KEY + ' Opportunity update failed',
                        'opp ' + result.id + ', ' + fieldId + ' -> ' + updateValue + ' - ' + e.message);
                }

                return true;
            });

            log.audit(LOG_KEY + ' Opportunity sync on project ' + projectID,
                fieldId + ' -> ' + updateValue + '; checked ' + checked + ', updated ' + updated);

        } catch (e) {
            log.error(LOG_KEY + ' Opportunity search failed on project ' + projectID, e.message);
        }
    }

    // =======================================================================
    // Helpers
    // =======================================================================

    /**
     * New (1) / Existing (2) / Returning (3), from the customer's last sale date.
     * Defaults to New and logs when anything goes wrong, so a lookup failure never
     * costs the user their save.
     */
    function nerCalc(customerID) {

        if (!customerID) {
            return NER_NEW;
        }

        try {
            var lookup = search.lookupFields({
                type:    record.Type.CUSTOMER,
                id:      customerID,
                columns: ['lastsaledate']
            });

            // lookupFields always returns an object, so v1's "if (!lastSale)"
            // never fired. Test the field, not the result.
            var lastSaleRaw = (lookup && lookup.lastsaledate) ? lookup.lastsaledate : null;

            if (!lastSaleRaw) {
                log.debug(LOG_KEY + ' nerCalc', 'customer ' + customerID + ' has no last sale date - New');
                return NER_NEW;
            }

            // lookupFields returns the date as a string in the account's date
            // format, so it parses directly - no need to format it first.
            var lastSaleDate = format.parse({ value: lastSaleRaw, type: format.Type.DATE });
            var days         = dateDiffInDays(lastSaleDate, new Date());

            log.debug(LOG_KEY + ' nerCalc', 'customer ' + customerID +
                ', last sale ' + lastSaleRaw + ', ' + days + ' days ago');

            if (days > RETURNING_DAYS) { return NER_RETURNING; }
            if (days > 0)              { return NER_EXISTING; }

            // NOTE: a last sale dated today (0 days) resolves to New, as it did in
            // v1. Change to (days >= 0) if that is wrong.
            return NER_NEW;

        } catch (e) {
            log.error(LOG_KEY + ' nerCalc failed - defaulting to New',
                'customer ' + customerID + ' - ' + e.message);
            return NER_NEW;
        }
    }

    /**
     * Retained for the pending decision on where the Pre-Quote's data should go.
     * Returns the customer's sales rep internal ID, or null - v1 read
     * salesRep[0].value straight off the lookup and threw when the customer had
     * no rep.
     */
    function getSalesRep(customerID) {

        try {
            var lookup = search.lookupFields({
                type:    record.Type.CUSTOMER,
                id:      customerID,
                columns: ['salesrep']
            });

            if (lookup && lookup.salesrep && lookup.salesrep.length && lookup.salesrep[0].value) {
                return lookup.salesrep[0].value;
            }

            log.audit(LOG_KEY + ' no sales rep', 'customer ' + customerID + ' has no sales rep set');

        } catch (e) {
            log.error(LOG_KEY + ' sales rep lookup failed', 'customer ' + customerID + ' - ' + e.message);
        }

        return null;
    }

    /**
     * True for anything NetSuite might hand back for a ticked checkbox: boolean
     * true, 'T', 'true', 1, '1'. v1 used "== true", which accepts 1 but not 'T';
     * v2.0.0 used "=== true", which accepts neither. This accepts the lot.
     */
    function isTrue(value) {

        if (value === true) { return true; }
        if (value === 1)    { return true; }

        if (typeof value === 'string') {
            var v = value.toLowerCase();
            return (v === 't' || v === 'true' || v === '1' || v === 'y' || v === 'yes');
        }

        return false;
    }

    /**
     * Normalise a multiselect field value to an array of ID strings. Handles null,
     * empty string, a single value, a comma-separated string, and an array-like
     * that is not a native JS Array (which the instanceof / toString checks miss).
     */
    function toIdArray(value) {

        if (value === null || value === undefined || value === '') {
            return [];
        }

        var raw;

        if (typeof value === 'string') {
            // A multiselect occasionally arrives as '123,456' rather than an array.
            raw = value.split(',');
        } else if (typeof value === 'number' || typeof value === 'boolean') {
            raw = [value];
        } else if (typeof value.length === 'number') {
            // Array, or anything array-like. Copied element by element rather than
            // trusted as an Array.
            raw = [];
            for (var j = 0; j < value.length; j++) {
                raw.push(value[j]);
            }
        } else {
            raw = [value];
        }

        var out = [];

        for (var i = 0; i < raw.length; i++) {
            var id = (raw[i] === null || raw[i] === undefined) ? '' : String(raw[i]).replace(/^\s+|\s+$/g, '');
            if (id !== '' && out.indexOf(id) === -1) {
                out.push(id);
            }
        }

        return out;
    }

    /**
     * Members of a1 that are not in a2. Both are expected to have been through
     * toIdArray().
     */
    function arrayDifference(a1, a2) {

        var result = [];

        for (var i = 0; i < a1.length; i++) {
            if (a2.indexOf(a1[i]) === -1) {
                result.push(a1[i]);
            }
        }

        return result;
    }

    /**
     * Whole days between two dates, ignoring time of day.
     */
    function dateDiffInDays(date1, date2) {

        var dt1 = new Date(date1);
        var dt2 = new Date(date2);

        return Math.floor(
            (Date.UTC(dt2.getFullYear(), dt2.getMonth(), dt2.getDate()) -
             Date.UTC(dt1.getFullYear(), dt1.getMonth(), dt1.getDate())) /
            (1000 * 60 * 60 * 24)
        );
    }

    return {
        beforeLoad:  beforeLoad,
        afterSubmit: afterSubmit
    };

});