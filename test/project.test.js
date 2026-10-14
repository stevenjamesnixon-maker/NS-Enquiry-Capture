/**
 * Node tests for lib/enq_lib_project.js createProjectForEntity, with N/record,
 * N/search and the global log stubbed. The real config and parse modules are used.
 * Run: npm test
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

var LIB = path.join(__dirname, '..', 'src', 'FileCabinet', 'SuiteScripts', 'NuHeat',
    'Enquiry Capture', 'lib');

// Minimal AMD shim: each module calls define(deps, factory).
function load(file, deps) {
    var mod;
    global.define = function (names, factory) { mod = factory.apply(null, deps); };
    delete require.cache[require.resolve(path.join(LIB, file))];
    require(path.join(LIB, file));
    delete global.define;
    return mod;
}

var logs = [];
global.log = {
    audit: function (o) { logs.push({ level: 'audit', title: o.title, details: o.details }); },
    error: function (o) { logs.push({ level: 'error', title: o.title, details: o.details }); },
    debug: function (o) { logs.push({ level: 'debug', title: o.title, details: o.details }); }
};

var parse  = load('enq_lib_parse.js', []);
var config = load('enq_lib_config.js', [{}, {}]);

// The Project saved by the last create, and what the D4 search returns.
var saved;
var searchRows;

var recordStub = {
    create: function () {
        var values = {};
        return {
            setValue: function (o) { values[o.fieldId] = o.value; },
            save: function () { saved = values; return 501; }
        };
    }
};

var searchStub = {
    Sort: { ASC: 'ASC' },
    createColumn: function (o) { return o; },
    create: function () {
        return { run: function () {
            return { getRange: function () { return searchRows; } };
        } };
    },
    lookupFields: function () {
        return { name: 'PR00501', custrecord_proj_lead_opp: [{ value: '901', text: 'Opp' }],
            custrecord_proj_sales_rep: [] };
    }
};

var project = load('enq_lib_project.js', [recordStub, searchStub, config, parse]);

function reset() {
    saved = null;
    searchRows = [];
    logs.length = 0;
}

var INPUT = {
    entityId:    '42',
    title:       'Jane Smith new project',
    siteAddress: '1 High Street',
    notes:       'GF entry: 320422\nMessage: hello\nPlans:\n1. https://example.com/p.pdf',
    gfEntry:     '320422'
};

test('Project save does not carry the notes field', function () {
    reset();
    project.createProjectForEntity({}, INPUT);
    assert.ok(saved, 'a Project was saved');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(saved, 'custrecord_proj_notes'), false);
    // The other fields are untouched.
    assert.strictEqual(saved.altname, INPUT.title);
    assert.strictEqual(saved.custrecord_proj_customer, '42');
    assert.strictEqual(saved.custrecord_proj_address, '1 High Street');
    assert.strictEqual(saved.custrecord_proj_gf_entry, '320422');
    assert.strictEqual(saved.custrecord_proj_create_qr_pq, true);
});

test('a caller passing notes still gets a Project; notes logged once at debug', function () {
    reset();
    var r = project.createProjectForEntity({}, INPUT);
    assert.deepStrictEqual(r, { projectId: '501', projectName: 'PR00501', leadOppId: '901', reused: false });
    var ignored = logs.filter(function (l) { return l.title.indexOf('ENQ_NOTES_IGNORED') !== -1; });
    assert.strictEqual(ignored.length, 1);
    assert.strictEqual(ignored[0].level, 'debug');
    assert.ok(ignored[0].details.indexOf('notes length: ' + INPUT.notes.length) !== -1);
});

test('no notes: Project created, nothing logged as ignored', function () {
    reset();
    var r = project.createProjectForEntity({}, {
        entityId: '42', title: 'T', siteAddress: 'A', gfEntry: '320423'
    });
    assert.strictEqual(r.projectId, '501');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(saved, 'custrecord_proj_notes'), false);
    assert.strictEqual(logs.filter(function (l) { return l.title.indexOf('ENQ_NOTES_IGNORED') !== -1; }).length, 0);
});

function withUrgent(urgent) {
    var input = {};
    Object.keys(INPUT).forEach(function (k) { input[k] = INPUT[k]; });
    if (urgent !== undefined) {
        input.urgent = urgent;
    }
    return input;
}

function titled(key) {
    return logs.filter(function (l) { return l.title.indexOf(key) !== -1; });
}

test('urgent: true ticks custrecord_proj_urgent on the new Project and logs ENQ_URGENT_SET', function () {
    reset();
    var r = project.createProjectForEntity({}, withUrgent(true));
    assert.strictEqual(saved.custrecord_proj_urgent, true);
    var set = titled('ENQ_URGENT_SET');
    assert.strictEqual(set.length, 1);
    assert.strictEqual(set[0].level, 'audit');
    assert.ok(set[0].details.indexOf('GF entry 320422') !== -1);
    assert.ok(set[0].details.indexOf('Project ' + r.projectId) !== -1);
});

test('urgent absent or false: custrecord_proj_urgent is not on the save at all', function () {
    [undefined, false].forEach(function (urgent) {
        reset();
        project.createProjectForEntity({}, withUrgent(urgent));
        assert.ok(saved, 'a Project was saved');
        assert.strictEqual(Object.prototype.hasOwnProperty.call(saved, 'custrecord_proj_urgent'), false);
        assert.strictEqual(titled('ENQ_URGENT_SET').length, 0);
    });
});

test('reuse (D4) with urgent: true saves nothing and logs ENQ_URGENT_SKIPPED_REUSE', function () {
    reset();
    searchRows = [{ id: 77, getValue: function () { return '42'; } }];
    var r = project.createProjectForEntity({}, withUrgent(true));
    assert.strictEqual(r.reused, true);
    assert.strictEqual(saved, null, 'no Project save');
    assert.strictEqual(titled('ENQ_URGENT_SET').length, 0);
    var skipped = titled('ENQ_URGENT_SKIPPED_REUSE');
    assert.strictEqual(skipped.length, 1);
    assert.strictEqual(skipped[0].level, 'audit');
    assert.ok(skipped[0].details.indexOf('Project 77') !== -1);
});
