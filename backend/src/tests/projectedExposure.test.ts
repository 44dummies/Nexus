
import test, { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCachedRisk, getRiskCache, recordTradeOpened, initializeRiskCache } from '../lib/riskCache';

describe('Projected Exposure Logic', () => {
    it('blocks trade if projected exposure exceeds limit', () => {
        const accountId = 'acc_exposure_test_1';
        initializeRiskCache(accountId, { equity: 10000 });
        const maxExposure = 1000;

        // Simulate existing exposure
        recordTradeOpened(accountId, 900, 10); // 900 exposure

        // Try to open trade for 200 (would bring to 1100 > 1000)
        const result = evaluateCachedRisk(accountId, {
            proposedStake: 200,
            maxExposure,
            maxStake: 1000,
            dailyLossLimitPct: 100,
            drawdownLimitPct: 100,
            maxConsecutiveLosses: 10,
            cooldownMs: 0,
            lossCooldownMs: 0,
            maxConcurrentTrades: 10,
            stopLoss: 1000,
        });

        assert.equal(result.status, 'HALT');
        assert.equal(result.reason, 'MAX_EXPOSURE');
    });

    it('allows trade if projected exposure is within limit', () => {
        const accountId = 'acc_exposure_test_2';
        initializeRiskCache(accountId, { equity: 10000 });
        const maxExposure = 1000;

        // Simulate existing exposure
        recordTradeOpened(accountId, 500, 10); // 500 exposure

        // Try to open trade for 400 (brings to 900 < 1000)
        const result = evaluateCachedRisk(accountId, {
            proposedStake: 400,
            maxExposure,
            maxStake: 1000,
            dailyLossLimitPct: 100,
            drawdownLimitPct: 100,
            maxConsecutiveLosses: 10,
            cooldownMs: 0,
            lossCooldownMs: 0,
            maxConcurrentTrades: 10,
            stopLoss: 1000,
        });

        assert.equal(result.status, 'ALLOWED');
    });
});
