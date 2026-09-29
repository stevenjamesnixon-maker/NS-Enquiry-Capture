/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.0.0
 */

/**
 * Enquiry Capture - pure parsing and decision functions
 * =====================================================
 * No NetSuite modules. Everything here runs under node (test/parse.test.js).
 *
 * The Notes layout is the CRM Perks feed template, owned by the website side:
 *
 *     GF entry: 320422
 *     Form: Request a quote
 *
 *     Email: someone@example.com
 *     Phone: 01234 567890
 *     Project stage: New build | Planning |
 *     Message: ...
 *
 *     Plans:
 *     1. https://...
 *     2. https://...
 *
 * or the single line "Plans: None".
 *
 * DELIBERATE (D3): only an unambiguous plans block counts. A missing
 * "GF entry:" or "Plans:" line is unparseable and goes to a person; it is never
 * completed. A change to the feed template must never silently complete Tasks.
 */

define([], function () {

    'use strict';

    var VERSION = '1.0.0';

    var WEBSITE_TITLE_PREFIX = 'Website form submission';

    var RE_GF_ENTRY   = /^GF entry:\s*(.*)$/i;
    var RE_FORM       = /^Form:\s*(.*)$/i;
    var RE_EMAIL      = /^Email:\s*(.*)$/i;
    var RE_PHONE      = /^Phone:\s*(.*)$/i;
    var RE_STAGE      = /^Project stage:\s*(.*)$/i;
    var RE_MESSAGE    = /^Message:\s*(.*)$/i;
    var RE_PLANS      = /^Plans:\s*(.*)$/i;
    var RE_PLAN_LINE  = /^\d+\.\s*(https?:\/\/\S+)$/i;
    // A URL on the Plans: line itself, with or without a "1." in front of it.
    var RE_PLAN_INLINE = /^(?:\d+\.\s*)?(https?:\/\/\S+)$/i;
    var RE_NONE       = /^none$/i;

    /**
     * Line endings to \n, HTML to text when the notes arrive as HTML, every line
     * trimmed.
     */
    function normalise(text) {

        var s = (text === null || text === undefined) ? '' : String(text);

        s = s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        if (/<br|<\/p>|<\/div>/i.test(s)) {
            // A source newline straight after the tag (nl2br output) is the same
            // line break, not a second one.
            s = s.replace(/(<br\s*\/?>|<\/p\s*>|<\/div\s*>)[ \t]*\n?/gi, '\n')
                 .replace(/<[^>]*>/g, '');
            s = decodeEntities(s);
        }

        var lines = s.split('\n');
        for (var i = 0; i < lines.length; i++) {
            lines[i] = lines[i].trim();
        }
        return lines.join('\n').trim();
    }

    /**
     * &amp; is decoded last, so "&amp;lt;" becomes "&lt;" and not "<".
     */
    function decodeEntities(s) {
        return s.replace(/&nbsp;/gi, ' ')
                .replace(/&lt;/gi, '<')
                .replace(/&gt;/gi, '>')
                .replace(/&quot;/gi, '"')
                .replace(/&#39;|&apos;/gi, '\'')
                .replace(/&#x([0-9a-f]+);/gi, function (m, hex) {
                    return String.fromCharCode(parseInt(hex, 16));
                })
                .replace(/&#(\d+);/g, function (m, dec) {
                    return String.fromCharCode(parseInt(dec, 10));
                })
                .replace(/&amp;/gi, '&');
    }

    /**
     * Parse the Task's Notes.
     *
     * @returns {{ok: boolean, reason: string, gfEntry: string, form: string,
     *            email: string, phone: string, projectStage: string[],
     *            message: string, plansLine: string, hasPlans: boolean,
     *            planUrls: string[]}}
     */
    function parseNotes(text) {

        var result = {
            ok:           false,
            reason:       '',
            gfEntry:      '',
            form:         '',
            email:        '',
            phone:        '',
            projectStage: [],
            message:      '',
            plansLine:    '',
            hasPlans:     false,
            planUrls:     []
        };

        var lines = normalise(text).split('\n');

        // The LAST Plans: line starts the plans block, so a "Plans:" typed into
        // the Message is ignored.
        var plansIdx = -1;
        var messageIdx = -1;
        var i, m;

        for (i = 0; i < lines.length; i++) {
            if (RE_PLANS.test(lines[i])) {
                plansIdx = i;
            }
            if (messageIdx < 0 && RE_MESSAGE.test(lines[i])) {
                messageIdx = i;
            }
        }
        if (messageIdx > plansIdx) {
            // A Message: line after the plans block is not the template's.
            messageIdx = -1;
        }

        // Header fields: first occurrence above the Message (or the plans block),
        // so nothing typed into the Message can override them.
        var headerEnd = messageIdx >= 0 ? messageIdx : (plansIdx >= 0 ? plansIdx : lines.length);
        for (i = 0; i < headerEnd; i++) {
            if (!result.gfEntry && (m = RE_GF_ENTRY.exec(lines[i]))) {
                result.gfEntry = m[1].trim();
            } else if (!result.form && (m = RE_FORM.exec(lines[i]))) {
                result.form = m[1].trim();
            } else if (!result.email && (m = RE_EMAIL.exec(lines[i]))) {
                result.email = m[1].trim();
            } else if (!result.phone && (m = RE_PHONE.exec(lines[i]))) {
                result.phone = m[1].trim();
            } else if (!result.projectStage.length && (m = RE_STAGE.exec(lines[i]))) {
                result.projectStage = splitStage(m[1]);
            }
        }

        if (messageIdx >= 0) {
            var msg = [RE_MESSAGE.exec(lines[messageIdx])[1]];
            for (i = messageIdx + 1; i < plansIdx; i++) {
                msg.push(lines[i]);
            }
            result.message = msg.join('\n').trim();
        }

        if (!result.gfEntry) {
            result.reason = 'Notes have no GF entry: line';
            return result;
        }
        if (plansIdx < 0) {
            result.reason = 'Notes have no Plans: line';
            return result;
        }

        var inline = RE_PLANS.exec(lines[plansIdx])[1].trim();
        result.plansLine = lines[plansIdx];

        if (inline && (m = RE_PLAN_INLINE.exec(inline))) {
            result.planUrls.push(m[1]);
        }
        for (i = plansIdx + 1; i < lines.length; i++) {
            if ((m = RE_PLAN_LINE.exec(lines[i]))) {
                result.planUrls.push(m[1]);
            }
        }

        // "Plans: None" with plan URLs under it contradicts itself. Doubt goes to
        // a person (D2/D3), so it is unparseable rather than either answer.
        if (RE_NONE.test(inline) && result.planUrls.length) {
            result.planUrls = [];
            result.reason = 'Notes say Plans: None but list plan URLs';
            return result;
        }

        result.hasPlans = result.planUrls.length > 0;
        result.ok = true;
        return result;
    }

    function splitStage(raw) {
        var s = String(raw || '').trim().replace(/\|\s*$/, '');
        var parts = s.split('|');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (p) {
                out.push(p);
            }
        }
        return out;
    }

    /**
     * Cut to at most max characters, the last being the '…' marker.
     */
    function truncate(text, max) {
        var s = (text === null || text === undefined) ? '' : String(text);
        if (s.length <= max) {
            return s;
        }
        return s.slice(0, Math.max(0, max - 1)) + '…';
    }

    /**
     * A formatted address as one line: <br> and newlines become ', ', repeated
     * separators collapse, then trim.
     */
    function flattenAddress(text) {
        var s = (text === null || text === undefined) ? '' : String(text);
        s = s.replace(/<br\s*\/?>/gi, '\n').replace(/\r\n|\r|\n/g, ', ');
        s = s.replace(/\s+/g, ' ');
        s = s.replace(/\s*,\s*/g, ', ');
        s = s.replace(/(, )+/g, ', ');
        s = s.replace(/^[\s,]+|[\s,]+$/g, '');
        return s;
    }

    function isWebsiteTitle(title) {
        return String(title || '').indexOf(WEBSITE_TITLE_PREFIX) === 0;
    }

    /**
     * D2(a): was the customer created within the window before the Task?
     *
     * DELIBERATE: a customer created up to 1 minute AFTER the Task still passes.
     * The two timestamps come from searches formatted to the minute, so a
     * customer and Task saved in the same few seconds can straddle a minute
     * boundary either way. Anything later than that is not new.
     *
     * @returns {{ok: boolean, minutesBefore: number|null, note: string}}
     */
    function createdWithinWindow(customerCreated, taskCreated, windowMin) {

        if (!isValidDate(customerCreated) || !isValidDate(taskCreated)) {
            return { ok: false, minutesBefore: null, note: 'unreadable date' };
        }

        var minutesBefore = (taskCreated.getTime() - customerCreated.getTime()) / 60000;

        if (minutesBefore < -1) {
            return { ok: false, minutesBefore: minutesBefore,
                     note: 'customer created more than 1 minute after the Task' };
        }
        if (minutesBefore < 0) {
            return { ok: true, minutesBefore: minutesBefore,
                     note: 'customer created after the Task, within 1 minute' };
        }
        if (minutesBefore > windowMin) {
            return { ok: false, minutesBefore: minutesBefore,
                     note: 'customer created more than ' + windowMin + ' minutes before the Task' };
        }
        return { ok: true, minutesBefore: minutesBefore, note: 'within window' };
    }

    /**
     * Is another Task "earlier" than this one? Timestamps are to the minute, so a
     * tie is broken on internal ID.
     */
    function isEarlierTask(otherCreated, otherId, thisCreated, thisId) {
        if (!isValidDate(otherCreated) || !isValidDate(thisCreated)) {
            // Can't tell: count it as earlier, which makes the customer existing
            // and puts the Task in front of a person (D2).
            return true;
        }
        var a = otherCreated.getTime();
        var b = thisCreated.getTime();
        if (a !== b) {
            return a < b;
        }
        return Number(otherId) < Number(thisId);
    }

    function isValidDate(d) {
        return d instanceof Date && !isNaN(d.getTime());
    }

    return {
        VERSION:              VERSION,
        WEBSITE_TITLE_PREFIX: WEBSITE_TITLE_PREFIX,
        normalise:            normalise,
        parseNotes:           parseNotes,
        truncate:             truncate,
        flattenAddress:       flattenAddress,
        isWebsiteTitle:       isWebsiteTitle,
        createdWithinWindow:  createdWithinWindow,
        isEarlierTask:        isEarlierTask
    };
});
