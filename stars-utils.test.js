const test = require('node:test');
const assert = require('node:assert/strict');
const { createInvoicePayload, hasValidInvoicePayload } = require('../stars-utils');

test('signed invoice payload is bound to the user and Stars amount', () => {
    const token = '123456:example-token';
    const payload = createInvoicePayload('123456789', 250, token);

    assert.equal(hasValidInvoicePayload(payload, '123456789', 250, token), true);
    assert.equal(hasValidInvoicePayload(payload, '987654321', 250, token), false);
    assert.equal(hasValidInvoicePayload(payload, '123456789', 100, token), false);
    assert.equal(hasValidInvoicePayload(payload, '123456789', 250, 'another-token'), false);
});

test('invoice payload rejects changed or malformed signatures', () => {
    const payload = createInvoicePayload('123456789', 50, '123456:example-token');
    const changed = `${payload.slice(0, -1)}${payload.endsWith('a') ? 'b' : 'a'}`;

    assert.equal(hasValidInvoicePayload(changed, '123456789', 50, '123456:example-token'), false);
    assert.equal(hasValidInvoicePayload('not-an-invoice', '123456789', 50, '123456:example-token'), false);
});
