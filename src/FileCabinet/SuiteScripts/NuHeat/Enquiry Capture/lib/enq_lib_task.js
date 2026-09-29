/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.0.0
 */

/**
 * Enquiry Capture - Task queue, lookups and updates
 * =================================================
 * The queue is every open Task assigned to the service employee. A Task leaves
 * the queue when it is Completed or reassigned; the three update functions here
 * are the only code that does either.
 *
 * To verify in Sandbox (recon R3):
 *   - search field IDs assigned, status, company, title, createddate;
 *   - status values COMPLETE (search and record);
 *   - message is the Notes field;
 *   - transaction is the Task's transaction field;
 *   - whether a scripted save to Completed fills completeddate. It is NOT set
 *     here; complete() logs its value after the save.
 * The first queue row's raw values and every Task's notes are logged at audit.
 */

define(['N/record', 'N/search', './enq_lib_config', './enq_lib_parse'],
function (record, search, config, parse) {

    'use strict';

    var VERSION = '1.0.0';

    var STATUS_COMPLETE = 'COMPLETE';

    var MAX_RESULT_LENGTH = 3900;

    var QUEUE_PAGE = 1000;

    /**
     * Open Tasks assigned to the service employee, oldest first.
     *
     * @returns {string[]} Task internal IDs
     */
    function searchQueue(cfg) {

        var rows = search.create({
            type: search.Type.TASK,
            filters: [
                ['assigned', 'anyof', cfg.serviceEmployeeId], 'AND',
                ['status', 'noneof', STATUS_COMPLETE]
            ],
            columns: [
                search.createColumn({ name: 'createddate', sort: search.Sort.ASC }),
                search.createColumn({ name: 'internalid', sort: search.Sort.ASC }),
                'title', 'status', 'assigned', 'company'
            ]
        }).run().getRange({ start: 0, end: QUEUE_PAGE });

        var ids = [];
        for (var i = 0; i < rows.length; i++) {
            ids.push(String(rows[i].id));
        }

        if (rows.length) {
            var r = rows[0];
            config.audit('queue search',
                rows.length + ' Task(s)' + (rows.length === QUEUE_PAGE ? ' (page full; more follow)' : '') +
                '. First: id ' + r.id +
                ', createddate raw: ' + r.getValue('createddate') +
                ', status raw: ' + r.getValue('status') + ' (' + r.getText('status') + ')' +
                ', assigned raw: ' + r.getValue('assigned') +
                ', company raw: ' + r.getValue('company') +
                ', title: ' + r.getValue('title'));
        } else {
            config.audit('queue search', '0 Tasks');
        }

        return ids;
    }

    /**
     * @returns {{id: string, title: string, companyId: string, createdDate: Date|null,
     *            createdDateRaw: string, notes: string, status: string, assignedId: string}}
     */
    function readTask(id) {

        var rec = record.load({ type: record.Type.TASK, id: id });

        var notes = String(rec.getValue({ fieldId: 'message' }) || '');

        // The date the new/existing decision uses comes from lookupFields, a
        // search-formatted string, like the customer's datecreated and the other
        // Tasks' createddate (see config.parseDateTime).
        var lookup = search.lookupFields({ type: search.Type.TASK, id: id, columns: ['createddate'] });
        var createdDateRaw = String(lookup.createddate || '');
        var createdDate = config.parseDateTime(createdDateRaw);

        var task = {
            id:             String(id),
            title:          String(rec.getValue({ fieldId: 'title' }) || ''),
            companyId:      config.asId(rec.getValue({ fieldId: 'company' })),
            createdDate:    createdDate,
            createdDateRaw: createdDateRaw,
            notes:          notes,
            status:         String(rec.getValue({ fieldId: 'status' }) || ''),
            assignedId:     config.asId(rec.getValue({ fieldId: 'assigned' }))
        };

        config.audit('task read ' + id,
            'title: ' + task.title +
            ', company: ' + (task.companyId || '(none)') +
            ', status raw: ' + task.status +
            ', assigned: ' + task.assignedId +
            ', createddate raw: ' + createdDateRaw + ' -> ' + config.isoOrBlank(createdDate) +
            ' (record value: ' + rec.getValue({ fieldId: 'createddate' }) + ')' +
            ', notes: ' + JSON.stringify(notes).slice(0, 500));

        return task;
    }

    /**
     * D2(b): does another website Task on this company predate this one?
     *
     * Filtered on date in code, not with a createddate filter: a date filter may
     * not take a time, and ties (same minute) are broken on internal ID.
     */
    function hasEarlierWebsiteTask(companyId, taskId, createdDate) {

        var found = null;
        var checked = 0;

        search.create({
            type: search.Type.TASK,
            filters: [
                ['company', 'anyof', companyId], 'AND',
                ['internalid', 'noneof', taskId], 'AND',
                ['title', 'startswith', parse.WEBSITE_TITLE_PREFIX]
            ],
            columns: ['createddate', 'title']
        }).run().each(function (r) {
            checked++;
            var raw = r.getValue('createddate');
            if (parse.isEarlierTask(config.parseDateTime(raw), r.id, createdDate, taskId)) {
                found = { id: r.id, createdRaw: raw };
                return false;
            }
            return true;
        });

        config.audit('earlier website task check ' + taskId,
            'company ' + companyId + ': checked ' + checked + ' other website Task(s); ' +
            (found ? 'earlier Task ' + found.id + ' created ' + found.createdRaw : 'none earlier'));

        return !!found;
    }

    // -----------------------------------------------------------------------
    // Updates. record.load + setValue + save; each logs an ENQ audit line.
    // -----------------------------------------------------------------------

    function complete(id, oppId, result) {

        var rec = record.load({ type: record.Type.TASK, id: id });
        rec.setValue({ fieldId: 'status', value: STATUS_COMPLETE });
        if (oppId) {
            rec.setValue({ fieldId: 'transaction', value: oppId });
        }
        rec.setValue({ fieldId: config.FIELD_TASK_RESULT, value: parse.truncate(result, MAX_RESULT_LENGTH) });
        rec.save({ enableSourcing: true, ignoreMandatoryFields: true });

        // Sandbox check: does a scripted save to Completed fill completeddate?
        var completedDate = '';
        try {
            completedDate = search.lookupFields({
                type: search.Type.TASK, id: id, columns: ['completeddate']
            }).completeddate;
        } catch (e) {
            completedDate = '(lookup failed: ' + e.message + ')';
        }

        config.audit('task completed ' + id,
            'transaction: ' + (oppId || '(none)') +
            ', completeddate after save: ' + (completedDate || '(blank)') +
            ', result: ' + result);
    }

    function reassign(id, employeeId, result) {

        var rec = record.load({ type: record.Type.TASK, id: id });
        rec.setValue({ fieldId: 'assigned', value: employeeId });
        rec.setValue({ fieldId: config.FIELD_TASK_RESULT, value: parse.truncate(result, MAX_RESULT_LENGTH) });
        rec.save({ enableSourcing: true, ignoreMandatoryFields: true });

        config.audit('task reassigned ' + id, 'to employee ' + employeeId + ', result: ' + result);
    }

    function fail(id, cfg, result) {
        reassign(id, cfg.fallbackEmployeeId, 'ERROR: ' + result);
    }

    return {
        VERSION:               VERSION,
        STATUS_COMPLETE:       STATUS_COMPLETE,
        searchQueue:           searchQueue,
        readTask:              readTask,
        hasEarlierWebsiteTask: hasEarlierWebsiteTask,
        complete:              complete,
        reassign:              reassign,
        fail:                  fail
    };
});
