/**
 * Multi-Trade Concurrency Tests
 * Verifies that concurrent trade operations maintain invariants:
 *   - No double-counting of open trades
 *   - Settlement correctly decrements counters even under parallel settlement
 *   - Failed attempt rollback is idempotent and safe
 *   - Concurrent limit enforcement is strict
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    initializeRiskCache,
    clearAllRiskCaches,
    recordTradeOpened,
    recordTradeSettled,
    recordTradeFailedAttempt,
    getRiskCache,
} from '../lib/riskCache';

// ====================================================
// 1. PARALLEL OPEN → SETTLE CYCLE (no deadlocks)
// ====================================================

test('concurrent: parallel open+settle cycle maintains zero open count', async () => {
    clearAllRiskCaches();
    initializeRiskCache('para-1', { equity: 10000 });

    const TRADES = 20;
    const MAX_CONCURRENT = 10;

    // Open all trades first (sequentially, as they would be in real flow)
    const opened: number[] = [];
    for (let i = 0; i < TRADES; i++) {
        const result = recordTradeOpened('para-1', 10, MAX_CONCURRENT);
        if (result.allowed) {
            opened.push(i);
        }
    }

    // First 10 should succeed, rest should be blocked
    assert.equal(opened.length, MAX_CONCURRENT);

    const cache = getRiskCache('para-1')!
    assert.equal(cache.openTradeCount, MAX_CONCURRENT);
    assert.equal(cache.openExposure, MAX_CONCURRENT * 10);

    // Now settle all concurrently (simulate async settlements resolving)
    // Now settle all concurrently (simulate async settlements resolving)
    const settlements = [];
    for (let i = 0; i < MAX_CONCURRENT; i++) {
        settlements.push(recordTradeSettled('para-1', 10, i % 2 === 0 ? 8 : -10)); // Alternating win/loss
    }
    await Promise.all(settlements);

    assert.equal(cache.openTradeCount, 0);
    assert.equal(cache.openExposure, 0);
});

// ====================================================
// 2. OPEN TRADE COUNT NEVER GOES NEGATIVE
// ====================================================

test('concurrent: openTradeCount never goes below zero on excess settlements', async () => {
    clearAllRiskCaches();
    initializeRiskCache('neg-guard', { equity: 1000 });

    recordTradeOpened('neg-guard', 10);
    await recordTradeSettled('neg-guard', 10, 5);
    // Settle again (double settle — should not go negative)
    await recordTradeSettled('neg-guard', 10, 5);

    const cache = getRiskCache('neg-guard')!
    assert.equal(cache.openTradeCount, 0); // Clamped at 0 via Math.max(0, ...)
    assert.equal(cache.openExposure, 0);
});

// ====================================================
// 3. FAILED ATTEMPT IDEMPOTENCY
// ====================================================

test('concurrent: multiple failed attempt rollbacks do not corrupt state', () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('idem-fail', { equity: 1000 });

    recordTradeOpened('idem-fail', 10);
    assert.equal(entry.openTradeCount, 1);

    // Double rollback (simulates duplicate error handling)
    recordTradeFailedAttempt('idem-fail', 10);
    recordTradeFailedAttempt('idem-fail', 10);

    assert.equal(entry.openTradeCount, 0); // Clamped, not -1
    assert.equal(entry.openExposure, 0);
    assert.equal(entry.dailyPnL, 0); // No PnL impact
});

// ====================================================
// 4. INTERLEAVED OPEN/SETTLE/FAIL SEQUENCE
// ====================================================

test('concurrent: interleaved open→fail→open→settle keeps counters correct', async () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('interleave', { equity: 5000 });

    // Trade 1: opens
    const t1 = recordTradeOpened('interleave', 10, 5);
    assert.equal(t1.allowed, true);
    assert.equal(entry.openTradeCount, 1);

    // Trade 2: opens
    const t2 = recordTradeOpened('interleave', 20, 5);
    assert.equal(t2.allowed, true);
    assert.equal(entry.openTradeCount, 2);

    // Trade 1: fails (rolled back)
    recordTradeFailedAttempt('interleave', 10);
    assert.equal(entry.openTradeCount, 1);
    assert.equal(entry.openExposure, 20);

    // Trade 3: opens (in the slot freed by trade 1's failure)
    const t3 = recordTradeOpened('interleave', 15, 5);
    assert.equal(t3.allowed, true);
    assert.equal(entry.openTradeCount, 2);
    assert.equal(entry.openExposure, 35); // 20 + 15

    // Trade 2: settles (win)
    await recordTradeSettled('interleave', 20, 15);
    assert.equal(entry.openTradeCount, 1);
    assert.equal(entry.openExposure, 15);
    assert.equal(entry.dailyPnL, 15);
    assert.equal(entry.consecutiveWins, 1);

    // Trade 3: settles (loss)
    await recordTradeSettled('interleave', 15, -15);
    assert.equal(entry.openTradeCount, 0);
    assert.equal(entry.openExposure, 0);
    assert.equal(entry.dailyPnL, 0); // 15 - 15 = 0
    assert.equal(entry.lossStreak, 1);
    assert.equal(entry.consecutiveWins, 0);
});

// ====================================================
// 5. STRICT CONCURRENT LIMIT ENFORCEMENT
// ====================================================

test('concurrent: exactly N trades allowed, N+1 blocked', () => {
    clearAllRiskCaches();
    initializeRiskCache('strict-n', { equity: 10000 });
    const LIMIT = 3;

    const results = [];
    for (let i = 0; i < LIMIT + 2; i++) {
        results.push(recordTradeOpened('strict-n', 5, LIMIT));
    }

    // First N should be allowed
    for (let i = 0; i < LIMIT; i++) {
        assert.equal(results[i].allowed, true, `Trade ${i + 1} of ${LIMIT} should be allowed`);
    }

    // N+1 and N+2 should be blocked
    assert.equal(results[LIMIT].allowed, false);
    assert.equal(results[LIMIT + 1].allowed, false);
});

// ====================================================
// 6. SETTLEMENT CORRECTLY FREES SLOTS
// ====================================================

test('concurrent: settling one trade frees slot for next trade', async () => {
    clearAllRiskCaches();
    initializeRiskCache('slot-free', { equity: 10000 });
    const LIMIT = 2;

    // Fill to limit
    recordTradeOpened('slot-free', 10, LIMIT);
    recordTradeOpened('slot-free', 10, LIMIT);

    // Blocked
    const blocked = recordTradeOpened('slot-free', 10, LIMIT);
    assert.equal(blocked.allowed, false);

    // Settle one
    await recordTradeSettled('slot-free', 10, 5);

    // Now should be allowed
    const freed = recordTradeOpened('slot-free', 10, LIMIT);
    assert.equal(freed.allowed, true);
});

// ====================================================
// 7. HIGH-VOLUME SEQUENTIAL TRADES (stress)
// ====================================================

test('concurrent: 100 sequential open→settle cycles maintain invariants', async () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('stress-100', { equity: 10000 });
    const LIMIT = 5;

    let totalProfit = 0;
    for (let i = 0; i < 100; i++) {
        const result = recordTradeOpened('stress-100', 10, LIMIT);
        assert.equal(result.allowed, true);

        const profit = i % 3 === 0 ? -10 : 8;
        totalProfit += profit;
        await recordTradeSettled('stress-100', 10, profit);
    }

    assert.equal(entry.openTradeCount, 0);
    assert.equal(entry.openExposure, 0);
    // Verify PnL math: 34 losses * -10 + 66 wins * 8 = -340 + 528 = 188
    const expectedProfit = totalProfit;
    assert.equal(entry.dailyPnL, expectedProfit);
    assert.equal(entry.equity, 10000 + expectedProfit);
});

// ====================================================
// 8. EQUITY PEAK TRACKING THROUGH OSCILLATION
// ====================================================

test('concurrent: equity peak tracks highest point through win/loss cycles', async () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('peak-track', { equity: 1000 });

    // Win → peak rises
    recordTradeOpened('peak-track', 10);
    await recordTradeSettled('peak-track', 10, 50); // equity = 1050, peak = 1050
    assert.equal(entry.equityPeak, 1050);

    // Lose → peak unchanged
    recordTradeOpened('peak-track', 10);
    await recordTradeSettled('peak-track', 10, -30); // equity = 1020, peak still 1050
    assert.equal(entry.equityPeak, 1050);

    // Win bigger → peak rises again
    recordTradeOpened('peak-track', 10);
    await recordTradeSettled('peak-track', 10, 100); // equity = 1120, peak = 1120
    assert.equal(entry.equityPeak, 1120);
});

// ====================================================
// 9. LOSS STREAK RESETS ON WIN
// ====================================================

test('concurrent: loss streak resets to zero on first win', async () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('streak-reset', { equity: 5000 });

    // 3 losses
    for (let i = 0; i < 3; i++) {
        recordTradeOpened('streak-reset', 10);
        await recordTradeSettled('streak-reset', 10, -10);
    }
    assert.equal(entry.lossStreak, 3);

    // 1 win resets
    recordTradeOpened('streak-reset', 10);
    await recordTradeSettled('streak-reset', 10, 8);
    assert.equal(entry.lossStreak, 0);
    assert.equal(entry.consecutiveWins, 1);
});
