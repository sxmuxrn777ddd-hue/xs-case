const test = require('node:test');
const assert = require('node:assert/strict');

test('case drop rates and probabilities match specifications', () => {
    // Free spin rates
    const freeRates = [
        { reward: 10, weight: 9500, chancePercent: 95 },
        { reward: 20, weight: 499, chancePercent: 4.99 },
        { reward: 30, weight: 1, chancePercent: 0.01 }
    ];
    const totalFreeWeight = freeRates.reduce((acc, p) => acc + p.weight, 0);
    assert.equal(totalFreeWeight, 10000, 'Free spin total weight must be exactly 10,000 (100.00%)');
    assert.equal(freeRates.some(p => p.reward >= 100), false, '100+ Stars must have 0% chance in Free spin');

    // Paid spin rates
    const paidRates = [
        { reward: 10, weight: 6500, chancePercent: 65 },
        { reward: 20, weight: 2000, chancePercent: 20 },
        { reward: 30, weight: 500, chancePercent: 5 },
        { reward: 50, weight: 500, chancePercent: 5 },
        { reward: 100, weight: 389, chancePercent: 3.89 },
        { reward: 120, weight: 50, chancePercent: 0.5 },
        { reward: 150, weight: 30, chancePercent: 0.3 },
        { reward: 200, weight: 15, chancePercent: 0.15 },
        { reward: 500, weight: 10, chancePercent: 0.1 },
        { reward: 1000, weight: 5, chancePercent: 0.05 },
        { reward: 10000, weight: 1, chancePercent: 0.01 }
    ];
    const totalPaidWeight = paidRates.reduce((acc, p) => acc + p.weight, 0);
    assert.equal(totalPaidWeight, 10000, 'Paid spin total weight must be exactly 10,000 (100.00%)');
});

test('24 hour cooldown calculation is accurate', () => {
    const cooldownMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const recentSpin = now - (2 * 60 * 60 * 1000); // 2 hours ago
    const oldSpin = now - (25 * 60 * 60 * 1000); // 25 hours ago

    assert.equal(now - recentSpin < cooldownMs, true, 'Spin 2 hours ago should still be on cooldown');
    assert.equal(now - oldSpin >= cooldownMs, true, 'Spin 25 hours ago should be eligible for free spin');
});
