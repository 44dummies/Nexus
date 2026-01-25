import test from 'node:test';
import assert from 'node:assert/strict';
import { initializeRiskCache, recordTradeOpened, clearAllRiskCaches } from '../lib/riskCache';
import { preTradeCheck, triggerKillSwitch, clearKillSwitch, isKillSwitchActive } from '../lib/riskManager';

test('preTradeCheck enforces max exposure', () => {
    clearAllRiskCaches();
    initializeRiskCache('acc1', { equity: 1000 });
    recordTradeOpened('acc1', 10);
    const result = preTradeCheck('acc1', 5, { maxExposure: 10 });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'MAX_EXPOSURE');
});

test('kill switch toggles correctly', () => {
    const accountId = 'acc2';
    clearKillSwitch(accountId);
    triggerKillSwitch(accountId, 'TEST', true);
    assert.equal(isKillSwitchActive(accountId), true);
    clearKillSwitch(accountId);
    assert.equal(isKillSwitchActive(accountId), false);
});
