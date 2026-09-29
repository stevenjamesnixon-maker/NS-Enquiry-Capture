/**
 * Node tests for lib/enq_lib_parse.js (pure; no NetSuite modules).
 * Run: npm test
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var path = require('node:path');

// Minimal AMD shim: the module calls define([], factory).
var parse;
global.define = function (deps, factory) { parse = factory(); };
require(path.join(__dirname, '..', 'src', 'FileCabinet', 'SuiteScripts', 'NuHeat',
    'Enquiry Capture', 'lib', 'enq_lib_parse.js'));
delete global.define;

var QUOTE = [
    'GF entry: 320422',
    'Form: Request a quote',
    '',
    'Email: jane@example.com',
    'Phone: 01234 567890',
    'Project stage: New build | Planning granted |',
    'Message: Hello, please quote for the ground floor.',
    'Thanks, Jane',
    '',
    'Plans:',
    '1. https://www.nu-heat.co.uk/wp-content/uploads/gravity_forms/plan-1.pdf'
].join('\n');

var CONTACT = [
    'GF entry: 320500',
    'Form: Contact us',
    '',
    'Email: bob@example.com',
    'Phone: 07700 900000',
    'Project stage:  |',
    'Message: Can someone call me?',
    '',
    'Plans: None'
].join('\n');

test('quote form with one plan', function () {
    var r = parse.parseNotes(QUOTE);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.gfEntry, '320422');
    assert.strictEqual(r.form, 'Request a quote');
    assert.strictEqual(r.email, 'jane@example.com');
    assert.strictEqual(r.phone, '01234 567890');
    assert.deepStrictEqual(r.projectStage, ['New build', 'Planning granted']);
    assert.strictEqual(r.message, 'Hello, please quote for the ground floor.\nThanks, Jane');
    assert.strictEqual(r.hasPlans, true);
    assert.deepStrictEqual(r.planUrls,
        ['https://www.nu-heat.co.uk/wp-content/uploads/gravity_forms/plan-1.pdf']);
});

test('contact request with Plans: None and an empty stage', function () {
    var r = parse.parseNotes(CONTACT);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.gfEntry, '320500');
    assert.deepStrictEqual(r.projectStage, []);
    assert.strictEqual(r.message, 'Can someone call me?');
    assert.strictEqual(r.hasPlans, false);
    assert.deepStrictEqual(r.planUrls, []);
});

test('twelve plans (numbering past 9)', function () {
    var lines = ['GF entry: 1', 'Message: x', 'Plans:'];
    for (var i = 1; i <= 12; i++) {
        lines.push(i + '. https://example.com/p' + i + '.pdf');
    }
    var r = parse.parseNotes(lines.join('\n'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.planUrls.length, 12);
    assert.strictEqual(r.planUrls[11], 'https://example.com/p12.pdf');
});

test('\\r\\n line endings', function () {
    var r = parse.parseNotes(QUOTE.replace(/\n/g, '\r\n'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.gfEntry, '320422');
    assert.strictEqual(r.planUrls.length, 1);
    assert.strictEqual(r.message.indexOf('\r'), -1);
});

test('bare \\r line endings', function () {
    var r = parse.parseNotes(CONTACT.replace(/\n/g, '\r'));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.hasPlans, false);
});

test('HTML-wrapped notes', function () {
    var html = '<div><p>' + QUOTE.split('\n').join('<br />\n') + '</p></div>';
    html = html.replace('Hello, please', 'Hello &amp; please');
    var r = parse.parseNotes(html);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.gfEntry, '320422');
    assert.strictEqual(r.message, 'Hello & please quote for the ground floor.\nThanks, Jane');
    assert.strictEqual(r.planUrls.length, 1);
});

test('HTML entities: &amp; decoded last', function () {
    assert.strictEqual(parse.normalise('a &amp;lt; b<br>c'), 'a &lt; b\nc');
});

test('Plans: inside the Message, then the real block (the last wins)', function () {
    var text = [
        'GF entry: 7',
        'Message: I have attached drawings.',
        'Plans: I will send the rest later',
        '1. https://example.com/in-message.pdf',
        '',
        'Plans:',
        '1. https://example.com/real-1.pdf',
        '2. https://example.com/real-2.pdf'
    ].join('\n');
    var r = parse.parseNotes(text);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.planUrls, ['https://example.com/real-1.pdf', 'https://example.com/real-2.pdf']);
    assert.strictEqual(r.message,
        'I have attached drawings.\nPlans: I will send the rest later\n1. https://example.com/in-message.pdf');
});

test('Plans: inside the Message, then Plans: None (no plans)', function () {
    var text = ['GF entry: 7', 'Message: see', 'Plans:', '1. https://example.com/x.pdf', '', 'Plans: None'].join('\n');
    var r = parse.parseNotes(text);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.hasPlans, false);
});

test('Plans: with nothing after it is unparseable', function () {
    var r = parse.parseNotes('GF entry: 9\nMessage: hi\n\nPlans:');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.hasPlans, false);
    assert.strictEqual(r.reason, 'Plans line not understood: Plans:');
});

test('numbered line with no URL is unparseable', function () {
    var r = parse.parseNotes('GF entry: 9\nMessage: hi\n\nPlans:\n1. plan.pdf\n2.');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.hasPlans, false);
    assert.strictEqual(r.reason, 'Plans line not understood: 1. plan.pdf');
});

test('Plans: see attached is unparseable', function () {
    var r = parse.parseNotes('GF entry: 9\nMessage: hi\n\nPlans: see attached');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.hasPlans, false);
    assert.strictEqual(r.reason, 'Plans line not understood: Plans: see attached');
});

test('Plans: none (lower case) means no plans', function () {
    var r = parse.parseNotes('GF entry: 9\nMessage: hi\n\nPlans: none');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.hasPlans, false);
    assert.deepStrictEqual(r.planUrls, []);
});

test('missing GF entry: line is unparseable', function () {
    var r = parse.parseNotes(QUOTE.replace('GF entry: 320422\n', ''));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /GF entry/);
});

test('empty GF entry value is unparseable', function () {
    var r = parse.parseNotes(QUOTE.replace('GF entry: 320422', 'GF entry:'));
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /GF entry/);
});

test('GF entry: inside the Message does not count', function () {
    var r = parse.parseNotes('Message: GF entry: 5\n\nPlans: None');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /GF entry/);
});

test('missing Plans: line is unparseable', function () {
    var text = QUOTE.split('\n').slice(0, 8).join('\n');
    var r = parse.parseNotes(text);
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /Plans/);
});

test('URL on the Plans: line itself', function () {
    var r = parse.parseNotes('GF entry: 3\nMessage: m\nPlans: https://example.com/a.pdf');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.planUrls, ['https://example.com/a.pdf']);
});

test('URL on the Plans: line plus numbered lines', function () {
    var r = parse.parseNotes('GF entry: 3\nPlans: 1. https://example.com/a.pdf\n2. https://example.com/b.pdf');
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.planUrls, ['https://example.com/a.pdf', 'https://example.com/b.pdf']);
});

test('Plans: None followed by URLs is unparseable', function () {
    var r = parse.parseNotes('GF entry: 3\nPlans: None\n1. https://example.com/a.pdf');
    assert.strictEqual(r.ok, false);
    assert.match(r.reason, /None/);
});

test('empty and null notes are unparseable', function () {
    assert.strictEqual(parse.parseNotes('').ok, false);
    assert.strictEqual(parse.parseNotes(null).ok, false);
});

test('truncate', function () {
    assert.strictEqual(parse.truncate('abc', 5), 'abc');
    assert.strictEqual(parse.truncate('abcdef', 5), 'abcd…');
    assert.strictEqual(parse.truncate('abcdef', 5).length, 5);
    assert.strictEqual(parse.truncate(null, 5), '');
});

test('flattenAddress', function () {
    assert.strictEqual(parse.flattenAddress('Jane Doe<br>1 High St<br>\nTown\r\nAB1 2CD'),
        'Jane Doe, 1 High St, Town, AB1 2CD');
    assert.strictEqual(parse.flattenAddress('  , 1 High St,,  Town , '), '1 High St, Town');
    assert.strictEqual(parse.flattenAddress(''), '');
    assert.strictEqual(parse.flattenAddress(null), '');
});

test('isWebsiteTitle', function () {
    assert.strictEqual(parse.isWebsiteTitle('Website form submission - Quote'), true);
    assert.strictEqual(parse.isWebsiteTitle('website form submission'), false);
    assert.strictEqual(parse.isWebsiteTitle('Call back'), false);
    assert.strictEqual(parse.isWebsiteTitle(null), false);
});

test('createdWithinWindow (D2a)', function () {
    var task = new Date('2026-09-29T10:10:00Z');
    function at(s) { return new Date(s); }
    assert.strictEqual(parse.createdWithinWindow(at('2026-09-29T10:05:00Z'), task, 10).ok, true);
    assert.strictEqual(parse.createdWithinWindow(at('2026-09-29T10:00:00Z'), task, 10).ok, true);
    assert.strictEqual(parse.createdWithinWindow(at('2026-09-29T09:59:00Z'), task, 10).ok, false);
    assert.strictEqual(parse.createdWithinWindow(at('2026-09-29T10:10:00Z'), task, 10).ok, true);
    assert.strictEqual(parse.createdWithinWindow(at('2026-09-29T10:11:00Z'), task, 10).ok, true);
    assert.strictEqual(parse.createdWithinWindow(at('2026-09-29T10:12:00Z'), task, 10).ok, false);
    assert.strictEqual(parse.createdWithinWindow(null, task, 10).ok, false);
    assert.strictEqual(parse.createdWithinWindow(new Date('x'), task, 10).ok, false);
});

test('isEarlierTask (D2b)', function () {
    var t = new Date('2026-09-29T10:10:00Z');
    assert.strictEqual(parse.isEarlierTask(new Date('2026-09-29T10:07:00Z'), 5, t, 9), true);
    assert.strictEqual(parse.isEarlierTask(new Date('2026-09-29T10:13:00Z'), 5, t, 9), false);
    assert.strictEqual(parse.isEarlierTask(t, 5, t, 9), true);
    assert.strictEqual(parse.isEarlierTask(t, 12, t, 9), false);
    assert.strictEqual(parse.isEarlierTask(null, 12, t, 9), true);
});
