import test from 'node:test';
import assert from 'node:assert/strict';
import { clearAllRiskCaches } from '../lib/riskCache';
import { evaluatePreTradeGate } from '../lib/preTradeGate';

test('slow path enforces preTradeGate when risk cache is missing', () => {
    clearAllRiskCaches();

    const result = evaluatePreTradeGate({
        accountId: 'ACC-TEST',
        stake: 1,
    });

    assert.equal(result.allowed, false);
    assert.ok(result.reasons.includes('RISK_CACHE_UNAVAILABLE'));
    assert.ok(result.reasons.includes('RISK_HALT'));
});
