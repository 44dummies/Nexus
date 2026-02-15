import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAllRiskCaches, getRiskCache, initializeRiskCache, recordTradeFailedAttempt, recordTradeOpened } from '../lib/riskCache';

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

test('stale risk cache entry is served instead of being evicted', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('acc-stale', { equity: 1000 });

    // Simulate stale age beyond TTL threshold.
    entry.lastUpdated = Date.now() - (10 * 60 * 1000);

    const cached = getRiskCache('acc-stale');
    assert.ok(cached);
    assert.equal(cached?.accountId, 'acc-stale');
});
