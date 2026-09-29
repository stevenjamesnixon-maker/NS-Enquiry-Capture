/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.0.0
 */

/**
 * Enquiry Capture - configuration, audit key and shared helpers
 * =============================================================
 * Account-specific values come in through the scheduled script's parameters.
 * Nothing numeric is committed here.
 *
 * load() throws ONE error naming every missing or invalid parameter. The
 * processor catches it, logs ERROR and exits without touching any Task.
 *
 * Grep the execution log for "ENQ ".
 */

define(['N/runtime', 'N/format'], function (runtime, format) {

    'use strict';

    var VERSION = '1.0.0';

    var LOG_KEY = 'ENQ';

    // Custom fields Steve creates. If the account's IDs differ, change them here only.
    var FIELD_PROJECT_GF_ENTRY = 'custrecord_proj_gf_entry';   // Project, Free-Form Text
    var FIELD_TASK_RESULT      = 'custevent_enq_result';       // Task, Text Area

    var PARAM_SERVICE_EMPLOYEE  = 'custscript_enq_service_employee';
    var PARAM_FALLBACK_EMPLOYEE = 'custscript_enq_fallback_employee';
    var PARAM_NEW_WINDOW_MIN    = 'custscript_enq_new_window_min';
    var PARAM_MIN_GOVERNANCE    = 'custscript_enq_min_governance';

    var DEFAULT_NEW_WINDOW_MIN = 10;
    var MIN_NEW_WINDOW_MIN     = 1;
    var MAX_NEW_WINDOW_MIN     = 120;
    var DEFAULT_MIN_GOVERNANCE = 500;

    /**
     * Read and validate the script parameters.
     *
     * @returns {{serviceEmployeeId: string, fallbackEmployeeId: string,
     *            newWindowMin: number, minGovernance: number}}
     * @throws {Error} naming every missing or invalid parameter
     */
    function load() {

        var script = runtime.getCurrentScript();
        var problems = [];

        var serviceEmployeeId  = asId(script.getParameter({ name: PARAM_SERVICE_EMPLOYEE }));
        var fallbackEmployeeId = asId(script.getParameter({ name: PARAM_FALLBACK_EMPLOYEE }));
        var rawWindow          = script.getParameter({ name: PARAM_NEW_WINDOW_MIN });
        var rawGovernance      = script.getParameter({ name: PARAM_MIN_GOVERNANCE });

        if (!serviceEmployeeId) {
            problems.push(PARAM_SERVICE_EMPLOYEE + ' is empty (the queue cannot be identified)');
        }
        if (!fallbackEmployeeId) {
            problems.push(PARAM_FALLBACK_EMPLOYEE + ' is empty (failures would have nowhere to go)');
        }
        // DELIBERATE: a fallback equal to the service account would put every
        // failed Task straight back in the queue, to be retried on every run.
        if (serviceEmployeeId && fallbackEmployeeId && serviceEmployeeId === fallbackEmployeeId) {
            problems.push(PARAM_FALLBACK_EMPLOYEE + ' is the same employee as ' + PARAM_SERVICE_EMPLOYEE);
        }

        var newWindowMin = DEFAULT_NEW_WINDOW_MIN;
        if (!isEmpty(rawWindow)) {
            newWindowMin = Number(rawWindow);
            if (!isInteger(newWindowMin) || newWindowMin < MIN_NEW_WINDOW_MIN || newWindowMin > MAX_NEW_WINDOW_MIN) {
                problems.push(PARAM_NEW_WINDOW_MIN + ' is ' + rawWindow + '; it must be a whole number from ' +
                    MIN_NEW_WINDOW_MIN + ' to ' + MAX_NEW_WINDOW_MIN);
            }
        }

        var minGovernance = DEFAULT_MIN_GOVERNANCE;
        if (!isEmpty(rawGovernance)) {
            minGovernance = Number(rawGovernance);
            if (!isInteger(minGovernance) || minGovernance < 0) {
                problems.push(PARAM_MIN_GOVERNANCE + ' is ' + rawGovernance + '; it must be a whole number, 0 or more');
            }
        }

        if (problems.length) {
            throw new Error('Invalid script parameters: ' + problems.join('; '));
        }

        return {
            serviceEmployeeId:  serviceEmployeeId,
            fallbackEmployeeId: fallbackEmployeeId,
            newWindowMin:       newWindowMin,
            minGovernance:      minGovernance
        };
    }

    // -----------------------------------------------------------------------
    // Logging - every title starts "ENQ ". log.warn does not exist.
    // -----------------------------------------------------------------------

    function audit(title, details) {
        log.audit({ title: LOG_KEY + ' ' + title, details: details });
    }

    function error(title, details) {
        log.error({ title: LOG_KEY + ' ' + title, details: details });
    }

    function debug(title, details) {
        log.debug({ title: LOG_KEY + ' ' + title, details: details });
    }

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    /**
     * Parse a date-time string as a search or lookupFields returns it.
     *
     * DELIBERATE: every timestamp the new/existing decision compares goes through
     * this one function, from a search-formatted string. Mixing a record's Date
     * object (to the second) with a search string (to the minute, in the user's
     * format) would compare two different precisions. Returns null when the
     * value can't be parsed.
     */
    function parseDateTime(raw) {
        if (isEmpty(raw)) {
            return null;
        }
        try {
            var d = format.parse({ value: String(raw), type: format.Type.DATETIME });
            if (d instanceof Date && !isNaN(d.getTime())) {
                return d;
            }
        } catch (e) {
            debug('date parse failed', 'raw: ' + raw + ' - ' + e.message);
        }
        return null;
    }

    function isoOrBlank(d) {
        return (d instanceof Date && !isNaN(d.getTime())) ? d.toISOString() : '(unparsed)';
    }

    function isEmpty(v) {
        return v === null || v === undefined || String(v).trim() === '';
    }

    function asId(v) {
        return isEmpty(v) ? '' : String(v).trim();
    }

    function isInteger(n) {
        return typeof n === 'number' && isFinite(n) && Math.floor(n) === n;
    }

    /**
     * lookupFields returns [] for an empty select and [{ value, text }] otherwise.
     * Never read [0].value unguarded.
     */
    function selectValue(v) {
        if (v && typeof v === 'object' && v.length !== undefined) {
            return v.length ? asId(v[0].value) : '';
        }
        return asId(v);
    }

    function remainingUsage() {
        return runtime.getCurrentScript().getRemainingUsage();
    }

    return {
        VERSION:                VERSION,
        LOG_KEY:                LOG_KEY,
        FIELD_PROJECT_GF_ENTRY: FIELD_PROJECT_GF_ENTRY,
        FIELD_TASK_RESULT:      FIELD_TASK_RESULT,
        load:                   load,
        audit:                  audit,
        error:                  error,
        debug:                  debug,
        parseDateTime:          parseDateTime,
        isoOrBlank:             isoOrBlank,
        isEmpty:                isEmpty,
        asId:                   asId,
        selectValue:            selectValue,
        remainingUsage:         remainingUsage
    };
});
