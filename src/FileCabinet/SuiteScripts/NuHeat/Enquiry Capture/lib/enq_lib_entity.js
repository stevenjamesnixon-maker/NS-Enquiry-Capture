/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 * @version 1.0.0
 */

/**
 * Enquiry Capture - customer read
 * ===============================
 * One search on search.Type.CUSTOMER, which covers the Lead, Prospect and
 * Customer stages. Read only: nothing here writes an entity.
 *
 * To verify in Sandbox (recon R8, and the brief's riskiest points):
 *   - the "address" column: the default address, formatted. If it is not a valid
 *     column the search throws and the Task goes to the fallback, visibly. If it
 *     is empty, address1 / city / zipcode are joined instead.
 *   - datecreated: its precision and timezone. The raw string and the parsed ISO
 *     value are logged on every call.
 */

define(['N/search', './enq_lib_config', './enq_lib_parse'], function (search, config, parse) {

    'use strict';

    var VERSION = '1.0.0';

    var COLUMNS = ['datecreated', 'salesrep', 'isperson', 'companyname', 'firstname',
                   'lastname', 'entityid', 'address', 'address1', 'city', 'zipcode'];

    /**
     * @param {string|number} id customer internal ID
     * @returns {{id: string, dateCreated: Date|null, dateCreatedRaw: string,
     *            salesRepId: string|null, isPerson: boolean, displayName: string,
     *            defaultAddress: string}}
     * @throws {Error} when no customer has that ID
     */
    function readCustomer(id) {

        var rows = search.create({
            type:    search.Type.CUSTOMER,
            filters: [['internalid', 'anyof', String(id)]],
            columns: COLUMNS
        }).run().getRange({ start: 0, end: 10 });

        if (!rows || !rows.length) {
            throw new Error('Customer ' + id + ' not found by a customer search');
        }

        // One row is expected. If the address column joins to the address book and
        // returns one row per address, the first row is used and the count logged.
        var r = rows[0];

        var dateCreatedRaw = r.getValue('datecreated');
        var dateCreated = config.parseDateTime(dateCreatedRaw);

        var isPersonRaw = r.getValue('isperson');
        var isPerson = (isPersonRaw === true || isPersonRaw === 'T');

        var displayName = '';
        if (isPerson) {
            displayName = (String(r.getValue('firstname') || '') + ' ' +
                           String(r.getValue('lastname') || '')).trim();
        } else {
            displayName = String(r.getValue('companyname') || '').trim();
        }
        if (!displayName) {
            displayName = String(r.getValue('entityid') || '').trim();
        }

        var addressRaw = r.getValue('address');
        var defaultAddress = parse.flattenAddress(addressRaw);
        if (!defaultAddress) {
            var parts = [];
            var fields = ['address1', 'city', 'zipcode'];
            for (var i = 0; i < fields.length; i++) {
                var p = String(r.getValue(fields[i]) || '').trim();
                if (p) {
                    parts.push(p);
                }
            }
            defaultAddress = parse.flattenAddress(parts.join(', '));
        }

        var salesRepId = config.asId(r.getValue('salesrep')) || null;

        config.audit('customer read ' + id,
            'rows: ' + rows.length +
            ', datecreated raw: ' + dateCreatedRaw + ' -> ' + config.isoOrBlank(dateCreated) +
            ', salesrep: ' + (salesRepId || '(none)') +
            ', isperson raw: ' + isPersonRaw +
            ', display name: ' + displayName +
            ', address raw: ' + JSON.stringify(addressRaw || '').slice(0, 300) +
            ', address used: ' + (defaultAddress || '(none)'));

        return {
            id:             String(id),
            dateCreated:    dateCreated,
            dateCreatedRaw: String(dateCreatedRaw || ''),
            salesRepId:     salesRepId,
            isPerson:       isPerson,
            displayName:    displayName,
            defaultAddress: defaultAddress
        };
    }

    return {
        VERSION:      VERSION,
        readCustomer: readCustomer
    };
});
