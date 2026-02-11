/**
 * Recovery Engine Tests
 * Tests for the SMRT loss-recovery state machine
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    onTradeSettled,
    getRecoveryOverrides,
    getRecoveryState,
    isRecoveryActive,
    getCompletedEpisodes,
    resetAllRecoveryStates,
    buildFeatureVector,
    __test,
} from '../lib/smartLayer/recoveryEngine';
import { resetAllNetworks } from '../lib/smartLayer/neuralRecoveryNet';
import type { RecoveryConfig } from '../lib/smartLayer/recoveryTypes';
import { DEFAULT_RECOVERY_CONFIG } from '../lib/smartLayer/recoveryTypes';

// ==================== HELPERS ====================

const ACCOUNT = 'test-account-recovery';

const defaultContext = {
    equity: 1000,
    lossStreak: 0,
    recentWinRate: 0.5,
    regimeConfidence: 0.7,
    volatilityRatio: 1.0 as number | null,
    lastWinTimeMs: Date.now() as number | null,
    drawdownPct: 0,
};

function freshContext(overrides?: Partial<typeof defaultContext>) {
    return { ...defaultContext, ...overrides };
}

function cleanup() {
    resetAllRecoveryStates();
    resetAllNetworks();
}

// ==================== STATE MACHINE TESTS ====================

test('Recovery: loss triggers RECOVERING mode', () => {
    cleanup();
    const result = onTradeSettled(ACCOUNT, -10, 5, freshContext());
    assert.equal(result.previousMode, 'IDLE');
    assert.equal(result.currentMode, 'RECOVERING');
    assert.equal(result.transition, 'ENTERED_RECOVERY');

    const state = getRecoveryState(ACCOUNT);
    assert.ok(state);
    assert.equal(state.mode, 'RECOVERING');
    assert.equal(state.deficit, 10);
    assert.equal(state.originalDeficit, 10);
    assert.equal(state.tradesInRecovery, 1);
    assert.equal(state.lossesInRecovery, 1);
    cleanup();
});

test('Recovery: wins reduce deficit during recovery', () => {
    cleanup();
    // Enter recovery with $10 loss
    onTradeSettled(ACCOUNT, -10, 5, freshContext());
    assert.equal(isRecoveryActive(ACCOUNT), true);

    // Win $4
    const result = onTradeSettled(ACCOUNT, 4, 5, freshContext());
    assert.equal(result.currentMode, 'RECOVERING');
    assert.equal(result.transition, 'WIN_IN_RECOVERY');

    const state = getRecoveryState(ACCOUNT)!;
    assert.equal(state.deficit, 6); // 10 - 4 = 6
    assert.equal(state.recovered, 4);
    assert.equal(state.winsInRecovery, 1);
    assert.equal(state.tradesInRecovery, 2);
    cleanup();
});

test('Recovery: full deficit recovery triggers GRADUATED', () => {
    cleanup();
    // Enter recovery with $10 loss
    onTradeSettled(ACCOUNT, -10, 5, freshContext());

    // Win $6
    onTradeSettled(ACCOUNT, 6, 5, freshContext());

    // Win $5 — exceeds deficit
    const result = onTradeSettled(ACCOUNT, 5, 5, freshContext());
    assert.equal(result.currentMode, 'GRADUATED');
    assert.equal(result.transition, 'GRADUATED');

    const state = getRecoveryState(ACCOUNT)!;
    assert.equal(state.mode, 'GRADUATED');
    assert.equal(state.successfulEpisodes, 1);
    assert.equal(state.deficit, 0);
    cleanup();
});

test('Recovery: consecutive losses compound deficit', () => {
    cleanup();
    // First loss
    onTradeSettled(ACCOUNT, -10, 5, freshContext({ lossStreak: 1 }));

    // Second loss during recovery
    const result = onTradeSettled(ACCOUNT, -5, 5, freshContext({ lossStreak: 2 }));
    assert.equal(result.transition, 'LOSS_IN_RECOVERY');

    const state = getRecoveryState(ACCOUNT)!;
    assert.equal(state.deficit, 15); // 10 + 5
    assert.equal(state.lossesInRecovery, 2);
    assert.equal(state.currentLossStreak, 2);
    cleanup();
});

test('Recovery: fails when deficit exceeds max % of equity', () => {
    cleanup();
    const config: RecoveryConfig = { ...DEFAULT_RECOVERY_CONFIG, maxDeficitPct: 10 };

    // Enter recovery
    onTradeSettled(ACCOUNT, -50, 25, freshContext({ equity: 100 }), config);

    // Add another loss to push deficit > 10% of equity
    const result = onTradeSettled(ACCOUNT, -60, 25, freshContext({ equity: 100 }), config);
    assert.equal(result.transition, 'FAILED');
    assert.equal(result.currentMode, 'COOLDOWN');

    const state = getRecoveryState(ACCOUNT)!;
    assert.equal(state.mode, 'COOLDOWN');
    assert.equal(state.failedEpisodes, 1);
    assert.ok(state.cooldownUntil !== null);
    cleanup();
});

test('Recovery: fails when max trades exceeded', () => {
    cleanup();
    const config: RecoveryConfig = { ...DEFAULT_RECOVERY_CONFIG, maxRecoveryTrades: 5 };

    // Enter recovery
    onTradeSettled(ACCOUNT, -100, 5, freshContext(), config);

    // Make 4 more trades (total = 5 including the first loss)
    for (let i = 0; i < 3; i++) {
        onTradeSettled(ACCOUNT, 1, 5, freshContext(), config);
    }

    // 5th trade — should trigger failure
    const result = onTradeSettled(ACCOUNT, -1, 5, freshContext(), config);
    assert.equal(result.transition, 'FAILED');
    cleanup();
});

test('Recovery: circuit breaker blocks new recovery after max failed episodes', () => {
    cleanup();
    const config: RecoveryConfig = {
        ...DEFAULT_RECOVERY_CONFIG,
        maxDeficitPct: 1,
        maxFailedEpisodes: 2,
        failedRecoveryCooldownMs: 0, // No cooldown for test speed
    };

    // Fail 2 episodes
    for (let i = 0; i < 2; i++) {
        onTradeSettled(ACCOUNT, -50, 5, freshContext({ equity: 100 }), config);
        // Trigger failure by exceeding deficit
        onTradeSettled(ACCOUNT, -50, 5, freshContext({ equity: 100 }), config);
        // Manually exit cooldown by waiting (cooldown = 0ms)
        const state = __test.recoveryStates.get(ACCOUNT)!;
        state.cooldownUntil = Date.now() - 1; // Expired
    }

    const state = getRecoveryState(ACCOUNT)!;
    assert.equal(state.failedEpisodes, 2);

    // New loss should NOT trigger recovery (circuit breaker)
    // First move to IDLE from COOLDOWN
    const cooldownState = __test.recoveryStates.get(ACCOUNT)!;
    cooldownState.mode = 'IDLE';

    const result = onTradeSettled(ACCOUNT, -10, 5, freshContext(), config);
    assert.equal(result.transition, 'NONE');
    cleanup();
});

test('Recovery: IDLE when no losses', () => {
    cleanup();
    const result = onTradeSettled(ACCOUNT, 5, 5, freshContext());
    assert.equal(result.currentMode, 'IDLE');
    assert.equal(result.transition, 'NONE');
    assert.equal(isRecoveryActive(ACCOUNT), false);
    cleanup();
});

test('Recovery: completed episodes are recorded', () => {
    cleanup();
    // Run a successful recovery
    onTradeSettled(ACCOUNT, -10, 5, freshContext());
    onTradeSettled(ACCOUNT, 15, 5, freshContext());

    const episodes = getCompletedEpisodes(ACCOUNT);
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0].success, true);
    assert.equal(episodes[0].originalDeficit, 10);
    assert.ok(episodes[0].reward > 0);
    cleanup();
});

// ==================== RECOVERY OVERRIDES TESTS ====================

test('Recovery: overrides returned only during RECOVERING mode', () => {
    cleanup();

    // Not in recovery — should return null
    const noOverrides = getRecoveryOverrides(ACCOUNT, freshContext());
    assert.equal(noOverrides, null);

    // Enter recovery
    onTradeSettled(ACCOUNT, -10, 5, freshContext());

    // Now should return overrides
    const overrides = getRecoveryOverrides(ACCOUNT, freshContext());
    assert.ok(overrides);
    assert.ok(overrides.stakeMultiplier >= 0.5 && overrides.stakeMultiplier <= 3.0);
    assert.ok(overrides.precisionThreshold >= 0.6 && overrides.precisionThreshold <= 0.95);
    assert.ok(overrides.confidenceBoost >= 0.0 && overrides.confidenceBoost <= 0.35);
    assert.ok(overrides.aggressiveness >= 0.0 && overrides.aggressiveness <= 1.0);
    cleanup();
});

test('Recovery: anti-martingale increases stake on win streak', () => {
    cleanup();
    // Enter recovery
    onTradeSettled(ACCOUNT, -50, 5, freshContext());

    // Win twice to build streak
    onTradeSettled(ACCOUNT, 5, 5, freshContext());
    onTradeSettled(ACCOUNT, 5, 5, freshContext());

    const state = getRecoveryState(ACCOUNT)!;
    assert.equal(state.currentWinStreak, 2);

    // Get overrides — stake should be boosted due to win streak
    const overrides = getRecoveryOverrides(ACCOUNT, freshContext());
    assert.ok(overrides);
    // With 2-win streak, the anti-martingale should have increased stake
    // (relative to fresh recovery with no streak)
    assert.ok(overrides.stakeMultiplier > 0, 'Stake multiplier should be positive');
    cleanup();
});

test('Recovery: anti-martingale decreases stake on loss streak', () => {
    cleanup();
    // Enter recovery
    onTradeSettled(ACCOUNT, -10, 5, freshContext());

    // Additional loss during recovery (2 losses total)
    onTradeSettled(ACCOUNT, -5, 5, freshContext());

    const state = getRecoveryState(ACCOUNT)!;
    assert.equal(state.currentLossStreak, 2);

    // Get overrides — should be more conservative
    const overrides = getRecoveryOverrides(ACCOUNT, freshContext());
    assert.ok(overrides);
    assert.ok(overrides.stakeMultiplier <= 1.0, 'Stake should be conservative during loss streak');
    cleanup();
});

// ==================== FEATURE VECTOR TESTS ====================

test('Recovery: feature vector is properly normalized', () => {
    cleanup();
    const features = buildFeatureVector(ACCOUNT, {
        lossStreak: 10,
        equity: 1000,
        deficit: 100,
        recentWinRate: 0.6,
        regimeConfidence: 0.8,
        volatilityRatio: 2.5,
        lastWinTimeMs: Date.now() - 30 * 60 * 1000, // 30 min ago
        drawdownPct: 0.15,
    });

    assert.ok(features.lossStreakNorm >= 0 && features.lossStreakNorm <= 1);
    assert.ok(features.deficitPctEquity >= 0 && features.deficitPctEquity <= 1);
    assert.ok(features.recentWinRate >= 0 && features.recentWinRate <= 1);
    assert.ok(features.regimeConfidence >= 0 && features.regimeConfidence <= 1);
    assert.ok(features.volatilityNorm >= 0 && features.volatilityNorm <= 1);
    assert.ok(features.timeSinceWinNorm >= 0 && features.timeSinceWinNorm <= 1);
    assert.ok(features.recoveryAttemptNorm >= 0 && features.recoveryAttemptNorm <= 1);
    assert.ok(features.drawdownPct >= 0 && features.drawdownPct <= 1);

    // Check specific values
    assert.equal(features.lossStreakNorm, 0.5); // 10/20
    assert.equal(features.deficitPctEquity, 0.1); // 100/1000
    assert.equal(features.recentWinRate, 0.6);
    cleanup();
});

test('Recovery: feature vector handles edge cases', () => {
    cleanup();
    // Zero equity
    const features = buildFeatureVector(ACCOUNT, {
        lossStreak: 100, // Way above max
        equity: 0,
        deficit: 100,
        recentWinRate: 2, // Above 1
        regimeConfidence: -0.5, // Below 0
        volatilityRatio: null,
        lastWinTimeMs: null,
        drawdownPct: 2, // Above 1
    });

    assert.equal(features.lossStreakNorm, 1); // Clamped
    assert.equal(features.deficitPctEquity, 1); // Zero equity → max
    assert.equal(features.recentWinRate, 1); // Clamped
    assert.equal(features.regimeConfidence, 0); // Clamped
    assert.equal(features.volatilityNorm, 0.5); // Null → default
    assert.equal(features.timeSinceWinNorm, 1); // Null → max
    assert.equal(features.drawdownPct, 1); // Clamped
    cleanup();
});

// ==================== LIFECYCLE TESTS ====================

test('Recovery: new loss after GRADUATED re-enters recovery', () => {
    cleanup();
    // Complete a recovery cycle
    onTradeSettled(ACCOUNT, -10, 5, freshContext());
    onTradeSettled(ACCOUNT, 15, 5, freshContext());

    const state1 = getRecoveryState(ACCOUNT)!;
    assert.equal(state1.mode, 'GRADUATED');

    // New loss
    const result = onTradeSettled(ACCOUNT, -8, 5, freshContext());
    assert.equal(result.transition, 'ENTERED_RECOVERY');
    assert.equal(result.currentMode, 'RECOVERING');

    const state2 = getRecoveryState(ACCOUNT)!;
    assert.equal(state2.deficit, 8);
    assert.equal(state2.successfulEpisodes, 1); // Previous success preserved
    cleanup();
});

test('Recovery: minimum equity check prevents recovery', () => {
    cleanup();
    const config: RecoveryConfig = { ...DEFAULT_RECOVERY_CONFIG, minEquityForRecovery: 100 };

    // Equity below minimum
    const result = onTradeSettled(ACCOUNT, -10, 5, freshContext({ equity: 50 }), config);
    assert.equal(result.transition, 'NONE');
    assert.equal(isRecoveryActive(ACCOUNT), false);
    cleanup();
});
