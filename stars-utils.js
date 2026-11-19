const crypto = require('crypto');

function createInvoicePayload(userId, amount, botToken) {
    const payloadData = `${userId}:${amount}:${crypto.randomBytes(16).toString('hex')}`;
    const signature = crypto
        .createHmac('sha256', botToken)
        .update(payloadData)
        .digest('base64url');
    return `stars_${Buffer.from(payloadData).toString('base64url')}_${signature}`;
}

function hasValidInvoicePayload(payload, userId, amount, botToken) {
    if (typeof payload !== 'string') return false;
    const match = /^stars_([A-Za-z0-9_-]+)_([A-Za-z0-9_-]{43})$/.exec(payload);
    if (!match) return false;

    const payloadData = Buffer.from(match[1], 'base64url').toString('utf8');
    const dataMatch = /^(\d{1,20}):(\d{1,5}):([a-f0-9]{32})$/.exec(payloadData);
    if (!dataMatch || dataMatch[1] !== userId || Number(dataMatch[2]) !== Number(amount)) return false;

    const expected = Buffer.from(crypto
        .createHmac('sha256', botToken)
        .update(payloadData)
        .digest('base64url'));
    const received = Buffer.from(match[2]);
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

module.exports = { createInvoicePayload, hasValidInvoicePayload };
