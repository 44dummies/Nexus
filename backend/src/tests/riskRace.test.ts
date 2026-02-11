
import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recordTradeSettled, getRiskCache, initializeRiskCache } from '../lib/riskCache';

describe('Risk Race Conditions', () => {
    it('handles concurrent trade settlements correctly', async () => {
        const accountId = 'acc_race_test_1';
        initializeRiskCache(accountId, { equity: 1000 });

        // Simulate 10 concurrent trade losses (stake 10, profit -10)
        const settlements = [];
        for (let i = 0; i < 10; i++) {
            settlements.push(recordTradeSettled(accountId, 10, -10));
        }

        await Promise.all(settlements);

        const cache = getRiskCache(accountId);
        assert.ok(cache, 'Cache should exist');

        // Verify daily loss accumulated correctly (10 * 10 = 100)
        assert.equal(cache?.totalLossToday, 100, `Total loss should be 100, got ${cache?.totalLossToday}`);

        // Verify consecutive losses tracked correctly (10)
        assert.equal(cache?.lossStreak, 10, `Loss streak should be 10, got ${cache?.lossStreak}`);
    });
});
