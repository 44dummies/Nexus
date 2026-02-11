
import test, { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePreTradeGate, PreTradeGateContext } from '../lib/preTradeGate';
import * as rollingPerformanceTracker from '../lib/rollingPerformanceTracker';
import * as riskCache from '../lib/riskCache';
import * as riskConfigCache from '../lib/riskConfigCache';

describe('EV Gate / PreTradeGate', () => {
    // Mock risk cache to always return allowed (unless we want to test that too)
    // We'll mock the module methods

    // We need to mock dependencies before usage if possible, or use a loader.
    // Since we are compiled to CommonJS, we can mock properties of the imported objects if they are configurable.

    // However, with ts-node or direct import, it's safer to rely on internal logic or dependency injection.
    // But specific to this codebase, let's try to mock the specific function isStrategyViable.

    it('blocks strategy when isStrategyViable returns false', (t) => {
        // Mock isStrategyViable to return false
        const viableMock = mock.method(rollingPerformanceTracker, 'isStrategyViable', () => false);

        // Mock risk functions to avoid side effects/errors
        mock.method(riskCache, 'getRiskCache', () => ({
            accountId: 'acc1',
            maxDailyLoss: 100,
            currentDailyLoss: 0,
            maxDrawdown: 100,
            currentDrawdown: 0,
            openPositions: 0,
            openExposure: 0,
            consecutiveLosses: 0,
            lastTradeTime: 0,
            lastLossTime: 0,
        }));

        mock.method(riskCache, 'evaluateCachedRisk', () => ({ status: 'ALLOWED' }));
        mock.method(riskCache, 'recordTradeOpened', () => ({ allowed: true }));
        mock.method(riskConfigCache, 'getRiskConfigCached', () => ({}));

        const ctx: PreTradeGateContext = {
            accountId: 'acc1',
            stake: 10,
            strategy: 'test-strat',
            symbol: 'R_100',
            regime: 'bull',
        };

        const result = evaluatePreTradeGate(ctx);

        assert.equal(result.allowed, false, 'Should be rejected');
        assert.ok(result.reasons.includes('NEGATIVE_EV'), 'Reasons should include NEGATIVE_EV');

        viableMock.mock.restore();
    });

    it('allows strategy when isStrategyViable returns true', (t) => {
        const viableMock = mock.method(rollingPerformanceTracker, 'isStrategyViable', () => true);

        // Ensure other checks pass
        mock.method(riskCache, 'getRiskCache', () => ({
            accountId: 'acc1',
        }));
        mock.method(riskCache, 'evaluateCachedRisk', () => ({ status: 'ALLOWED' }));
        mock.method(riskCache, 'recordTradeOpened', () => ({ allowed: true }));
        mock.method(riskConfigCache, 'getRiskConfigCached', () => ({}));

        const ctx: PreTradeGateContext = {
            accountId: 'acc1',
            stake: 10,
            strategy: 'test-strat',
            symbol: 'R_100',
            regime: 'bull',
        };

        const result = evaluatePreTradeGate(ctx);

        assert.equal(result.allowed, true, 'Should be allowed');
        assert.equal(result.reasons.length, 0, 'No reasons for rejection');

        viableMock.mock.restore();
    });

    it('skips EV check if strategy/symbol not provided', (t) => {
        const viableMock = mock.method(rollingPerformanceTracker, 'isStrategyViable', () => false);

        const ctx: PreTradeGateContext = {
            accountId: 'acc1',
            stake: 10,
            // No strategy/symbol
        };

        const result = evaluatePreTradeGate(ctx);

        // EV check should be skipped, so result depends on other factors (allowed here)
        assert.equal(result.allowed, true);
        assert.ok(!result.reasons.includes('NEGATIVE_EV'));

        viableMock.mock.restore();
    });
});
