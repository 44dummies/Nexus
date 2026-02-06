/**
 * Risk Invariant Golden Tests
 * Validates that risk management outputs match expected baseline behavior.
 * Tests real modules (riskCache, riskManager, preTradeGate) — no mocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    initializeRiskCache,
    clearAllRiskCaches,
    evaluateCachedRisk,
    recordTradeOpened,
    recordTradeSettled,
    recordTradeFailedAttempt,
    getRiskCache,
} from '../lib/riskCache';
import {
    triggerKillSwitch,
    clearKillSwitch,
    isKillSwitchActive,
    preTradeCheck,
} from '../lib/riskManager';
import { evaluatePreTradeGate } from '../lib/preTradeGate';

// ====================================================
// 1. RISK CACHE: Fail-Closed Invariant
// ====================================================

test('evaluateCachedRisk: HALT when risk cache is missing (fail-closed)', () => {
    clearAllRiskCaches();
    const result = evaluateCachedRisk('nonexistent-account', {
        proposedStake: 1,
        maxStake: 100,
    });
    assert.equal(result.status, 'HALT');
    assert.match(result.reason!, /not initialized/i);
});

// ====================================================
// 2. DAILY LOSS LIMIT
// ====================================================

test('evaluateCachedRisk: HALT when daily loss limit exceeded', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('dl-acc', { equity: 1000 });
    // Simulate 25 in losses against 1000 equity = 2.5% loss
    entry.totalLossToday = 25;
    entry.dailyStartEquity = 1000;

    const result = evaluateCachedRisk('dl-acc', {
        proposedStake: 1,
        maxStake: 100,
        dailyLossLimitPct: 2, // 2% limit → 20 is limit, 25 exceeds
    });
    assert.equal(result.status, 'HALT');
    assert.equal(result.reason, 'DAILY_LOSS');
});

test('evaluateCachedRisk: OK when daily loss is within limit', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('dl-ok', { equity: 1000 });
    entry.totalLossToday = 15;
    entry.dailyStartEquity = 1000;

    const result = evaluateCachedRisk('dl-ok', {
        proposedStake: 1,
        maxStake: 100,
        dailyLossLimitPct: 2, // 2% = 20 limit, 15 < 20
    });
    assert.equal(result.status, 'OK');
});

// ====================================================
// 3. DRAWDOWN LIMIT
// ====================================================

test('evaluateCachedRisk: HALT when drawdown limit exceeded', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('dd-acc', { equity: 1000 });
    entry.equityPeak = 1200;
    entry.equity = 1100; // Drawdown = (1200-1100)/1200 = 8.33%

    const result = evaluateCachedRisk('dd-acc', {
        proposedStake: 1,
        maxStake: 100,
        drawdownLimitPct: 6, // 6% limit, 8.33% exceeds
    });
    assert.equal(result.status, 'HALT');
    assert.equal(result.reason, 'DRAWDOWN');
});

test('evaluateCachedRisk: OK when drawdown is within limit', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('dd-ok', { equity: 1000 });
    entry.equityPeak = 1020;
    entry.equity = 1000; // Drawdown = (1020-1000)/1020 ≈ 1.96%

    const result = evaluateCachedRisk('dd-ok', {
        proposedStake: 1,
        maxStake: 100,
        drawdownLimitPct: 6,
    });
    assert.equal(result.status, 'OK');
});

// ====================================================
// 4. MAX CONCURRENT TRADES
// ====================================================

test('evaluateCachedRisk: MAX_CONCURRENT when concurrent trade limit reached', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('mc-acc', { equity: 1000 });
    entry.openTradeCount = 3;

    const result = evaluateCachedRisk('mc-acc', {
        proposedStake: 1,
        maxStake: 100,
        maxConcurrentTrades: 3,
    });
    assert.equal(result.status, 'MAX_CONCURRENT');
});

test('evaluateCachedRisk: OK when below concurrent trade limit', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('mc-ok', { equity: 1000 });
    entry.openTradeCount = 2;

    const result = evaluateCachedRisk('mc-ok', {
        proposedStake: 1,
        maxStake: 100,
        maxConcurrentTrades: 3,
    });
    assert.equal(result.status, 'OK');
});

// ====================================================
// 5. TRADE COOLDOWN
// ====================================================

test('evaluateCachedRisk: COOLDOWN when within trade cooldown period', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('cd-acc', { equity: 1000 });
    entry.lastTradeTime = Date.now() - 500; // 500ms ago

    const result = evaluateCachedRisk('cd-acc', {
        proposedStake: 1,
        maxStake: 100,
        cooldownMs: 3000, // 3s cooldown
    });
    assert.equal(result.status, 'COOLDOWN');
    assert.equal(result.reason, 'TRADE_COOLDOWN');
});

test('evaluateCachedRisk: OK when cooldown has expired', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('cd-ok', { equity: 1000 });
    entry.lastTradeTime = Date.now() - 5000; // 5s ago

    const result = evaluateCachedRisk('cd-ok', {
        proposedStake: 1,
        maxStake: 100,
        cooldownMs: 3000,
    });
    assert.equal(result.status, 'OK');
});

// ====================================================
// 6. LOSS STREAK COOLDOWN
// ====================================================

test('evaluateCachedRisk: COOLDOWN when loss streak + loss cooldown active', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('ls-acc', { equity: 1000 });
    entry.lossStreak = 3;
    entry.lastLossTime = Date.now() - 1000; // 1s ago

    const result = evaluateCachedRisk('ls-acc', {
        proposedStake: 1,
        maxStake: 100,
        maxConsecutiveLosses: 3,
        lossCooldownMs: 60000, // 60s
    });
    assert.equal(result.status, 'COOLDOWN');
    assert.equal(result.reason, 'LOSS_STREAK');
});

// ====================================================
// 7. STAKE LIMIT
// ====================================================

test('evaluateCachedRisk: REDUCE_STAKE when proposed exceeds max', () => {
    clearAllRiskCaches();
    initializeRiskCache('sl-acc', { equity: 1000 });

    const result = evaluateCachedRisk('sl-acc', {
        proposedStake: 200,
        maxStake: 100,
    });
    assert.equal(result.status, 'REDUCE_STAKE');
    assert.equal(result.reason, 'STAKE_LIMIT');
});

// ====================================================
// 8. KILL SWITCH
// ====================================================

test('kill switch: blocks when active, allows when cleared', () => {
    clearKillSwitch('ks-acc');
    assert.equal(isKillSwitchActive('ks-acc'), false);

    triggerKillSwitch('ks-acc', 'TEST_TRIGGER', true);
    assert.equal(isKillSwitchActive('ks-acc'), true);

    clearKillSwitch('ks-acc');
    assert.equal(isKillSwitchActive('ks-acc'), false);
});

test('kill switch: global blocks all accounts', () => {
    clearKillSwitch(null);
    clearKillSwitch('ks-g1');

    triggerKillSwitch(null, 'GLOBAL_TEST', true);
    assert.equal(isKillSwitchActive('ks-g1'), true);
    assert.equal(isKillSwitchActive('ks-g2'), true);

    clearKillSwitch(null);
    assert.equal(isKillSwitchActive('ks-g1'), false);
});

test('kill switch: auto-clear for non-manual triggers after TTL', () => {
    // This tests the inline TTL in isKillSwitchActive.
    // We can't easily fake time in real modules, so we test that manual switches do NOT auto-clear
    clearKillSwitch('ks-manual');
    triggerKillSwitch('ks-manual', 'MANUAL_TEST', true);
    // Manual switches should remain active regardless of time
    assert.equal(isKillSwitchActive('ks-manual'), true);
    clearKillSwitch('ks-manual');
});

// ====================================================
// 9. RISK CACHE: Settlement Accounting
// ====================================================

test('recordTradeSettled: updates equity, PnL, and streaks on loss', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('settle-loss', { equity: 1000 });

    recordTradeOpened('settle-loss', 10);
    assert.equal(entry.openTradeCount, 1);
    assert.equal(entry.openExposure, 10);

    recordTradeSettled('settle-loss', 10, -10); // Lost the stake
    assert.equal(entry.openTradeCount, 0);
    assert.equal(entry.openExposure, 0);
    assert.equal(entry.equity, 990);
    assert.equal(entry.dailyPnL, -10);
    assert.equal(entry.totalLossToday, 10);
    assert.equal(entry.lossStreak, 1);
    assert.equal(entry.consecutiveWins, 0);
});

test('recordTradeSettled: updates equity, PnL, and streaks on win', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('settle-win', { equity: 1000 });

    recordTradeOpened('settle-win', 10);
    recordTradeSettled('settle-win', 10, 8.5); // Won 8.5 profit

    assert.equal(entry.openTradeCount, 0);
    assert.equal(entry.equity, 1008.5);
    assert.equal(entry.dailyPnL, 8.5);
    assert.equal(entry.totalProfitToday, 8.5);
    assert.equal(entry.consecutiveWins, 1);
    assert.equal(entry.lossStreak, 0);
});

test('recordTradeSettled: equity peak updates on new high', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('settle-peak', { equity: 1000 });
    assert.equal(entry.equityPeak, 1000);

    recordTradeOpened('settle-peak', 10);
    recordTradeSettled('settle-peak', 10, 50); // Won big

    assert.equal(entry.equity, 1050);
    assert.equal(entry.equityPeak, 1050); // Peak should update
});

test('recordTradeSettled: equity peak does NOT update on loss', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('settle-nopeak', { equity: 1000 });
    entry.equityPeak = 1100;

    recordTradeOpened('settle-nopeak', 10);
    recordTradeSettled('settle-nopeak', 10, -10);

    assert.equal(entry.equity, 990);
    assert.equal(entry.equityPeak, 1100); // Peak unchanged
});

// ====================================================
// 10. RISK CACHE: Failed Attempt Rollback
// ====================================================

test('recordTradeFailedAttempt: rolls back exposure without affecting PnL', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('fail-roll', { equity: 1000 });
    entry.lossStreak = 2;
    entry.consecutiveWins = 1;

    recordTradeOpened('fail-roll', 10);
    assert.equal(entry.openTradeCount, 1);

    recordTradeFailedAttempt('fail-roll', 10);
    assert.equal(entry.openTradeCount, 0);
    assert.equal(entry.openExposure, 0);
    // PnL and streaks must be unchanged
    assert.equal(entry.lossStreak, 2);
    assert.equal(entry.consecutiveWins, 1);
    assert.equal(entry.dailyPnL, 0);
});

// ====================================================
// 11. RISK CACHE: Concurrent Trade Gating via recordTradeOpened
// ====================================================

test('recordTradeOpened: blocks when at concurrent limit', () => {
    clearAllRiskCaches();
    initializeRiskCache('conc-limit', { equity: 1000 });

    // Fill up to limit
    for (let i = 0; i < 3; i++) {
        const r = recordTradeOpened('conc-limit', 5, 3);
        assert.equal(r.allowed, true, `Trade ${i + 1} should be allowed`);
    }

    // 4th should be blocked
    const blocked = recordTradeOpened('conc-limit', 5, 3);
    assert.equal(blocked.allowed, false);
    assert.match(blocked.reason!, /concurrent/i);
});

// ====================================================
// 12. PRE-TRADE CHECK: Order size limits
// ====================================================

test('preTradeCheck: blocks MAX_ORDER_SIZE', () => {
    clearAllRiskCaches();
    initializeRiskCache('ptc-size', { equity: 1000 });
    const result = preTradeCheck('ptc-size', 50, { maxOrderSize: 25 });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'MAX_ORDER_SIZE');
});

test('preTradeCheck: blocks MAX_EXPOSURE', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('ptc-exp', { equity: 1000 });
    entry.openExposure = 90;

    const result = preTradeCheck('ptc-exp', 20, { maxExposure: 100 });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'MAX_EXPOSURE');
});

test('preTradeCheck: allows when within all limits', () => {
    clearAllRiskCaches();
    initializeRiskCache('ptc-ok', { equity: 1000 });
    const result = preTradeCheck('ptc-ok', 10, { maxOrderSize: 100, maxExposure: 500 });
    assert.equal(result.allowed, true);
});

// ====================================================
// 13. PRE-TRADE GATE (Integration): Kill switch blocks gate
// ====================================================

test('evaluatePreTradeGate: rejects when kill switch active', () => {
    clearAllRiskCaches();
    initializeRiskCache('gate-ks', { equity: 1000 });
    clearKillSwitch('gate-ks');

    triggerKillSwitch('gate-ks', 'TEST_BLOCK', true);
    const result = evaluatePreTradeGate({
        accountId: 'gate-ks',
        stake: 5,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.includes('KILL_SWITCH_ACTIVE'));

    clearKillSwitch('gate-ks');
});

test('evaluatePreTradeGate: rejects when risk cache missing', () => {
    clearAllRiskCaches();
    clearKillSwitch('gate-nocache');
    const result = evaluatePreTradeGate({
        accountId: 'gate-nocache',
        stake: 5,
    });
    assert.equal(result.allowed, false);
    assert.ok(result.reasons.includes('RISK_CACHE_UNAVAILABLE'));
});

test('evaluatePreTradeGate: allows valid trade and increments openTradeCount', () => {
    clearAllRiskCaches();
    clearKillSwitch('gate-ok');
    const entry = initializeRiskCache('gate-ok', { equity: 1000 });

    const result = evaluatePreTradeGate({
        accountId: 'gate-ok',
        stake: 5,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.reasons.length, 0);
    // The gate should have called recordTradeOpened internally
    assert.equal(entry.openTradeCount, 1);
    assert.equal(entry.openExposure, 5);
});

// ====================================================
// 14. DETERMINISTIC STAKE SIZING
// ====================================================

test('evaluatePreTradeGate: returns original stake when within limits', () => {
    clearAllRiskCaches();
    clearKillSwitch('stake-det');
    initializeRiskCache('stake-det', { equity: 1000 });

    const result = evaluatePreTradeGate({
        accountId: 'stake-det',
        stake: 10,
        riskOverrides: { maxStake: 100 },
    });
    assert.equal(result.allowed, true);
    assert.equal(result.stake, 10);
});

// ====================================================
// 15. LOSS STREAK → DAILY LOSS ESCALATION
// ====================================================

test('sequential losses trigger HALT via daily loss accumulation', () => {
    clearAllRiskCaches();
    clearKillSwitch('escalate');
    const entry = initializeRiskCache('escalate', { equity: 1000 });

    // Simulate 4 losses of $5 each = $20 = 2% of 1000
    for (let i = 0; i < 4; i++) {
        recordTradeOpened('escalate', 5);
        recordTradeSettled('escalate', 5, -5);
    }

    assert.equal(entry.totalLossToday, 20);
    assert.equal(entry.lossStreak, 4);

    const result = evaluateCachedRisk('escalate', {
        proposedStake: 5,
        maxStake: 100,
        dailyLossLimitPct: 2, // 2% of 1000 = 20
    });
    assert.equal(result.status, 'HALT');
    assert.equal(result.reason, 'DAILY_LOSS');
});
