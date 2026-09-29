/**
 * @NApiVersion 2.1
 * @NScriptType ScheduledScript
 * @NModuleScope SameAccount
 * @version 1.0.0
 */

/**
 * Enquiry Capture - website Task processor
 * ========================================
 * The CRM Perks Gravity Forms feed creates (or matches) a customer and a Task
 * assigned to the service employee for every website submission. This script
 * works through those open Tasks:
 *
 *   1  existing customer, no plans -> Task to the customer's sales rep
 *   2  existing customer, plans    -> Project (the project UE raises the
 *                                     Opportunity); Task Completed, linked to it
 *   3  new customer, no plans      -> Task Completed
 *   4  new customer, plans         -> as 2
 *   F  anything else               -> Task to the fallback employee, "ERROR: ..."
 *
 * A Task leaves the queue when it is Completed or reassigned.
 *
 * DELIBERATE - see docs/context.md §5 (D1-D8) before changing any of this:
 *   - One scheduled deployment, no Task user event (D1). NetSuite never runs a
 *     deployment twice at once, so no two runs can process the same Task.
 *   - "New" needs both D2 conditions; everything else is existing, because a
 *     wrong "new" silently completes a real customer's enquiry.
 *   - The Task is updated LAST (D7), so a crash leaves it in the queue and the
 *     GF-entry check (D4) makes the rerun safe.
 *   - A failed Task update is logged and left for the next run (D8).
 *
 * Grep the execution log for "ENQ ".
 */

define(['N/runtime',
        './lib/enq_lib_config',
        './lib/enq_lib_parse',
        './lib/enq_lib_entity',
        './lib/enq_lib_task',
        './lib/enq_lib_project'],
function (runtime, config, parse, entity, task, project) {

    'use strict';

    var VERSION = '1.0.0';

    function execute(context) {

        var user = runtime.getCurrentUser();
        config.audit('start',
            'version ' + VERSION +
            ', user: ' + user.id + ' (' + user.name + ')' +
            ', role: ' + user.role + ' (' + user.roleId + ')' +
            ', context type: ' + (context && context.type) +
            ', governance: ' + config.remainingUsage());

        var cfg;
        try {
            cfg = config.load();
        } catch (e) {
            config.error('config invalid', e.message + '. No Task touched.');
            return;
        }

        config.audit('config',
            'service employee: ' + cfg.serviceEmployeeId +
            ', fallback employee: ' + cfg.fallbackEmployeeId +
            ', new window: ' + cfg.newWindowMin + ' min' +
            ', min governance: ' + cfg.minGovernance);

        var counts = {
            case1: 0, case2: 0, case3: 0, case4: 0,
            failed: 0, skipped: 0, taskUpdateFailed: 0
        };
        var seen = {};
        var stoppedEarly = false;

        // Search, work the list, search again: Tasks that arrive during the run
        // are picked up. Never the same ID twice in one run.
        while (!stoppedEarly) {

            var ids = task.searchQueue(cfg);
            var fresh = [];
            for (var i = 0; i < ids.length; i++) {
                if (!seen[ids[i]]) {
                    fresh.push(ids[i]);
                }
            }
            if (!fresh.length) {
                break;
            }

            for (var j = 0; j < fresh.length; j++) {
                var remaining = config.remainingUsage();
                if (remaining < cfg.minGovernance) {
                    config.audit('governance low, stopping',
                        'remaining ' + remaining + ' < ' + cfg.minGovernance +
                        '; ' + (fresh.length - j) + ' Task(s) left in this batch for the next run');
                    stoppedEarly = true;
                    break;
                }
                seen[fresh[j]] = true;
                processTask(cfg, fresh[j], counts);
            }
        }

        config.audit('done',
            'existing/no plans (1): ' + counts.case1 +
            ', existing/plans (2): ' + counts.case2 +
            ', new/no plans (3): ' + counts.case3 +
            ', new/plans (4): ' + counts.case4 +
            ', failed (F): ' + counts.failed +
            ', skipped: ' + counts.skipped +
            ', Task updates failed: ' + counts.taskUpdateFailed +
            ', stopped early: ' + stoppedEarly +
            ', governance: ' + config.remainingUsage());
    }

    /**
     * One Task, in its own try/catch. Every path ends in exactly one Task update,
     * or none when the Task has already left the queue.
     */
    function processTask(cfg, id, counts) {

        // What has been done so far, so a failure message says what exists.
        var progress = '';

        try {
            var t = task.readTask(id);

            // The queue search and the load are not atomic: a person may have
            // taken the Task in between. Leave it alone if so.
            if (t.assignedId !== cfg.serviceEmployeeId || t.status === task.STATUS_COMPLETE) {
                config.audit('task ' + id + ' skipped',
                    'no longer in the queue (assigned: ' + t.assignedId + ', status: ' + t.status + ')');
                counts.skipped++;
                return;
            }

            if (!parse.isWebsiteTitle(t.title)) {
                return failTask(cfg, id, counts,
                    'Task title does not start "' + parse.WEBSITE_TITLE_PREFIX + '"');
            }
            if (!t.companyId) {
                return failTask(cfg, id, counts, 'Task has no company');
            }

            var notes = parse.parseNotes(t.notes);
            config.audit('task ' + id + ' parsed',
                'ok: ' + notes.ok + (notes.reason ? ' (' + notes.reason + ')' : '') +
                ', GF entry: ' + notes.gfEntry +
                ', plans line: ' + JSON.stringify(notes.plansLine) +
                ', plans: ' + notes.planUrls.length);
            if (!notes.ok) {
                return failTask(cfg, id, counts, notes.reason);
            }

            var cust = entity.readCustomer(t.companyId);
            var isNew = decideIsNew(cfg, t, cust);

            if (!notes.hasPlans) {

                if (!isNew) {
                    // Case 1
                    if (!cust.salesRepId) {
                        return failTask(cfg, id, counts, 'Existing customer has no sales rep');
                    }
                    if (cust.salesRepId === cfg.serviceEmployeeId) {
                        // Reassigning to the service account would leave it in the queue.
                        return failTask(cfg, id, counts, 'Existing customer\'s sales rep is the service account');
                    }
                    task.reassign(id, cust.salesRepId,
                        'Existing customer, no plans: assigned to account manager');
                    counts.case1++;
                    return;
                }

                // Case 3
                task.complete(id, null, 'New lead, no plans: closed; the lead is with its sales rep');
                counts.case3++;
                return;
            }

            // Cases 2 and 4
            var title = cust.displayName + ' new project';
            var proj = project.createProjectForEntity(cfg, {
                entityId:    t.companyId,
                title:       title,
                siteAddress: cust.defaultAddress || title,
                notes:       parse.normalise(t.notes),
                gfEntry:     notes.gfEntry
            });
            progress = 'Project ' + proj.projectName + ' (' + proj.projectId + ') ' +
                (proj.reused ? 'already existed' : 'created') + '. ';

            if (!proj.leadOppId) {
                return failTask(cfg, id, counts,
                    'Project ' + proj.projectName + ' created (or found) but no Opportunity was raised: ' +
                    'check the PROJ_UE execution log, then raise the Opportunity by hand');
            }

            var n = notes.planUrls.length;
            var result = 'Project ' + proj.projectName + ' and Opportunity ' + proj.leadOppId + ' ' +
                (proj.reused ? 'already existed' : 'created') +
                ' (' + (isNew ? 'new' : 'existing') + ' customer, ' + n + ' plan(s))';

            task.complete(id, proj.leadOppId, result);
            counts[isNew ? 'case4' : 'case2']++;

        } catch (e) {
            // Includes a failed final Task write for cases 1-4: the Task goes to the
            // fallback with what was done so far.
            config.error('task ' + id + ' failed', progress + (e.message || String(e)));
            failTask(cfg, id, counts, progress + (e.message || String(e)));
        }
    }

    /**
     * D2: new only when the customer was created within the window before the
     * Task AND no other website Task on the company predates this one.
     */
    function decideIsNew(cfg, t, cust) {

        var windowCheck = parse.createdWithinWindow(cust.dateCreated, t.createdDate, cfg.newWindowMin);

        // Only search for earlier Tasks when (a) holds; (b) cannot make it new otherwise.
        var earlier = null;
        if (windowCheck.ok) {
            earlier = task.hasEarlierWebsiteTask(t.companyId, t.id, t.createdDate);
        }

        var isNew = windowCheck.ok && earlier === false;

        config.audit('task ' + t.id + ' new/existing',
            (isNew ? 'NEW' : 'EXISTING') +
            '. customer ' + cust.id + ' datecreated raw: ' + cust.dateCreatedRaw +
            ' (' + config.isoOrBlank(cust.dateCreated) + ')' +
            ', Task createddate raw: ' + t.createdDateRaw +
            ' (' + config.isoOrBlank(t.createdDate) + ')' +
            ', minutes before: ' + (windowCheck.minutesBefore === null ? 'n/a' : windowCheck.minutesBefore) +
            ', window: ' + cfg.newWindowMin +
            ', (a): ' + windowCheck.ok + ' - ' + windowCheck.note +
            ', (b) earlier website Task: ' + (earlier === null ? 'not checked' : earlier));

        return isNew;
    }

    /**
     * Send the Task to the fallback employee. If that write fails too, D8: log
     * and move on; the Task stays in the queue for the next run.
     */
    function failTask(cfg, id, counts, reason) {
        try {
            task.fail(id, cfg, reason);
            counts.failed++;
        } catch (e) {
            counts.taskUpdateFailed++;
            config.error('task update failed',
                'Task ' + id + ' - could not send it to the fallback (' + reason + '): ' +
                (e.message || String(e)) + '. It stays in the queue for the next run.');
        }
    }

    return {
        execute: execute
    };
});
