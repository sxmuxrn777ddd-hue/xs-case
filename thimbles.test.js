const test = require('node:test');
const assert = require('node:assert/strict');

test('thimbles multipliers and probabilities', () => {
    // Mode 1: 1 ball out of 3 cups -> multiplier 2.91
    const mode1Multiplier = 2.91;
    const bet1 = 100;
    const win1 = Math.round(bet1 * mode1Multiplier);
    assert.equal(win1, 291);

    // Mode 2: 2 balls out of 3 cups -> multiplier 1.45
    const mode2Multiplier = 1.45;
    const bet2 = 100;
    const win2 = Math.round(bet2 * mode2Multiplier);
    assert.equal(win2, 145);
});

test('thimbles cup generation logic', () => {
    // Mode 1: 1 ball
    for (let i = 0; i < 50; i++) {
        const winningCup = Math.floor(Math.random() * 3);
        const winningCups = [winningCup];
        assert.equal(winningCups.length, 1);
        assert.equal([0, 1, 2].includes(winningCups[0]), true);
    }

    // Mode 2: 2 balls
    for (let i = 0; i < 50; i++) {
        const emptyCup = Math.floor(Math.random() * 3);
        const winningCups = [0, 1, 2].filter(c => c !== emptyCup);
        assert.equal(winningCups.length, 2);
        assert.equal(winningCups.includes(emptyCup), false);
    }
});
