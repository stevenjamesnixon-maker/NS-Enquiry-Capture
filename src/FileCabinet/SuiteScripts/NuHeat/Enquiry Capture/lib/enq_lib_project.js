/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.1.0
 */

/**
 * Enquiry Capture - the only code that creates a Project
 * ======================================================
 * createProjectForEntity(cfg, input) is the entry point for any caller that
 * needs a Project raised against a customer (see docs/context.md, "Entry point
 * for other callers"). It knows nothing about Tasks, email or parsing.
 *
 * DELIBERATE - do not change without reading docs/context.md §5:
 *   - The Project is created with record.create + save and NEVER updated
 *     afterwards. No submitFields, no inline edit: an xedit reaches
 *     project_ue.js's market sync with only the changed fields, reads the build
 *     type as blank and blanks the market on every Opportunity (recon R1d).
 *   - Nothing here creates, edits or deletes an Opportunity.
 *     customscript_project_ue raises it in afterSubmit, inside our save(), and
 *     writes it to custrecord_proj_lead_opp, which is re-read afterwards (C3).
 *   - Idempotent by GF entry (D4): an existing Project with the same entry is
 *     used as it is, and nothing is created.
 *   - custrecord_proj_sales_rep is not set: it sources from the customer.
 *   - custrecord_proj_notes is never written (D5, 10 Oct 2026): free text on
 *     the Project causes side effects. input.notes is accepted and ignored.
 *   - custrecord_proj_urgent is set to true only on a NEW Project and only when
 *     input.urgent === true (14 Oct 2026). Otherwise it is not set at all, so
 *     NetSuite's default stands; false is never written. The project UE copies it
 *     to custbody_urgent on the Opportunity it raises. A reused Project (D4) is
 *     never saved again to set it.
 */

define(['N/record', 'N/search', './enq_lib_config', './enq_lib_parse'],
function (record, search, config, parse) {

    'use strict';

    var VERSION = '1.1.0';

    var REC_PROJECT = 'customrecord_project';

    var MAX_ADDRESS_LENGTH = 300;    // D6: custbody_opp_site_adress may be Free-Form Text

    /**
     * @param {Object} cfg    loaded configuration (reserved for callers; unused in v1)
     * @param {{entityId: string, title: string, siteAddress: string, notes: string,
     *          gfEntry: string, urgent: (boolean|undefined)}} input
     *        urgent is optional: true ticks custrecord_proj_urgent on a new
     *        Project; anything else leaves the field unset. Never applied to a
     *        reused Project (logged as ENQ_URGENT_SKIPPED_REUSE).
     *        notes is accepted and IGNORED (D5, 10 Oct 2026): free text is never
     *        written to the Project. The enquiry text stays on the website Task,
     *        which is linked to the Opportunity. Logged once at debug
     *        (ENQ_NOTES_IGNORED) with its length.
     * @returns {{projectId: string, projectName: string, leadOppId: string|null,
     *            reused: boolean}}
     */
    function createProjectForEntity(cfg, input) {

        input = input || {};
        var entityId = config.asId(input.entityId);
        var gfEntry  = config.asId(input.gfEntry);

        if (!entityId || !gfEntry) {
            throw new Error('createProjectForEntity needs entityId and gfEntry (entityId: ' +
                (entityId || '(empty)') + ', gfEntry: ' + (gfEntry || '(empty)') + ')');
        }

        // D4: one Project per GF entry.
        var existing = findByGfEntry(gfEntry);
        if (existing) {
            if (existing.customerId !== entityId) {
                // Doubt goes to a person: the entry is already on someone else's Project.
                throw new Error('GF entry ' + gfEntry + ' is already on Project ' + existing.id +
                    ' for customer ' + (existing.customerId || '(none)') + ', not ' + entityId);
            }
            var found = readProjectLink(existing.id);
            config.audit('project reused ' + existing.id,
                'GF entry ' + gfEntry + ', customer ' + entityId +
                ', name: ' + found.name + ', lead opp: ' + (found.leadOppId || '(none)') +
                (existing.count > 1 ? ', NOTE: ' + existing.count + ' Projects carry this entry; the oldest is used' : ''));
            // D4: the existing Project is used as it is. It is not saved again to
            // set Urgent, and its Opportunity already exists.
            if (input.urgent === true) {
                config.audit('ENQ_URGENT_SKIPPED_REUSE',
                    'GF entry ' + gfEntry + ', Project ' + existing.id +
                    ': urgent stage on the Task, but the Project already existed; Urgent not written');
            }
            return {
                projectId:   String(existing.id),
                projectName: found.name,
                leadOppId:   found.leadOppId,
                reused:      true
            };
        }

        var address = parse.truncate(input.siteAddress, MAX_ADDRESS_LENGTH);
        if (String(input.siteAddress || '').length > MAX_ADDRESS_LENGTH) {
            config.audit('site address truncated',
                'customer ' + entityId + ', GF entry ' + gfEntry + ': ' +
                String(input.siteAddress).length + ' -> ' + MAX_ADDRESS_LENGTH + ' characters');
        }

        // D5: never write free text to the Project's notes field.
        if (input.notes !== undefined && input.notes !== null) {
            config.debug('ENQ_NOTES_IGNORED',
                'customer ' + entityId + ', GF entry ' + gfEntry +
                ', notes length: ' + String(input.notes).length);
        }

        var proj = record.create({ type: REC_PROJECT });
        proj.setValue({ fieldId: 'altname',                      value: input.title || '' });
        proj.setValue({ fieldId: 'custrecord_proj_customer',     value: entityId });
        proj.setValue({ fieldId: 'custrecord_proj_address',      value: address });
        proj.setValue({ fieldId: config.FIELD_PROJECT_GF_ENTRY,  value: gfEntry });
        proj.setValue({ fieldId: 'custrecord_proj_create_qr_pq', value: true });
        // Only ever true; when not urgent the field is left to NetSuite's default.
        if (input.urgent === true) {
            proj.setValue({ fieldId: 'custrecord_proj_urgent', value: true });
        }

        // customscript_project_ue's afterSubmit runs inside this save.
        var projectId = String(proj.save({ enableSourcing: true, ignoreMandatoryFields: true }));

        // C3: the UE writes the lead Opportunity back with submitFields,
        // synchronously within the save above. Re-read it; never trust the
        // in-memory record.
        var link = readProjectLink(projectId);

        config.audit('project created ' + projectId,
            'customer ' + entityId + ', GF entry ' + gfEntry +
            ', name: ' + link.name + ', title: ' + (input.title || '') +
            ', sales rep sourced: ' + (link.salesRepId || '(none)') +
            ', lead opp: ' + (link.leadOppId || '(none - check the PROJ_UE log)'));

        if (input.urgent === true) {
            config.audit('ENQ_URGENT_SET',
                'GF entry ' + gfEntry + ', Project ' + projectId + ': custrecord_proj_urgent set to true');
        }

        return {
            projectId:   projectId,
            projectName: link.name,
            leadOppId:   link.leadOppId,
            reused:      false
        };
    }

    /**
     * @returns {{id: string, customerId: string, count: number}|null} the oldest
     *          Project carrying this GF entry, inactive ones included
     */
    function findByGfEntry(gfEntry) {

        var rows = search.create({
            type: REC_PROJECT,
            filters: [[config.FIELD_PROJECT_GF_ENTRY, 'is', gfEntry]],
            columns: [
                search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
                'custrecord_proj_customer'
            ]
        }).run().getRange({ start: 0, end: 10 });

        if (!rows || !rows.length) {
            return null;
        }
        return {
            id:         String(rows[0].id),
            customerId: config.asId(rows[0].getValue('custrecord_proj_customer')),
            count:      rows.length
        };
    }

    function readProjectLink(projectId) {
        var v = search.lookupFields({
            type:    REC_PROJECT,
            id:      projectId,
            columns: ['name', 'custrecord_proj_lead_opp', 'custrecord_proj_sales_rep']
        });
        return {
            name:       String(v.name || projectId),
            leadOppId:  config.selectValue(v.custrecord_proj_lead_opp) || null,
            salesRepId: config.selectValue(v.custrecord_proj_sales_rep)
        };
    }

    return {
        VERSION:                VERSION,
        createProjectForEntity: createProjectForEntity
    };
});
