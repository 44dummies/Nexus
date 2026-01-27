import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAllRiskCaches, initializeRiskCache, recordTradeFailedAttempt, recordTradeOpened } from '../lib/riskCache';

test('failed attempt does not mutate win/loss streaks', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('acc-roll', { equity: 1000 });
    entry.lossStreak = 2;
    entry.consecutiveWins = 1;

    recordTradeOpened('acc-roll', 10);
    recordTradeFailedAttempt('acc-roll', 10);

    assert.equal(entry.lossStreak, 2);
    assert.equal(entry.consecutiveWins, 1);
    assert.equal(entry.openTradeCount, 0);
});
