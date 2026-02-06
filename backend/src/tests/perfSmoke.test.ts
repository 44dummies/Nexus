/**
 * Performance Smoke Test
 * Measures latency of critical trading path operations.
 * Reports p50 and p95 latency for:
 *   - Risk cache evaluation
 *   - Pre-trade gate (full pipeline)
 *   - Trade settlement recording
 *
 * Threshold: p95 < 5ms for all operations (single-threaded Node.js)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    initializeRiskCache,
    clearAllRiskCaches,
    evaluateCachedRisk,
    recordTradeOpened,
    recordTradeSettled,
} from '../lib/riskCache';
import { clearKillSwitch } from '../lib/riskManager';
import { evaluatePreTradeGate } from '../lib/preTradeGate';

const ITERATIONS = 500;
const P95_THRESHOLD_MS = 5; // 5ms ceiling for p95

function percentile(sorted: number[], pct: number): number {
    const idx = Math.ceil((pct / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
}

function collectLatencies(fn: () => void, iterations: number): number[] {
    const latencies: number[] = [];
    for (let i = 0; i < iterations; i++) {
        const start = performance.now();
        fn();
        latencies.push(performance.now() - start);
    }
    return latencies.sort((a, b) => a - b);
}

// ====================================================
// 1. evaluateCachedRisk latency
// ====================================================

test(`perf: evaluateCachedRisk p95 < ${P95_THRESHOLD_MS}ms (${ITERATIONS} iterations)`, () => {
    clearAllRiskCaches();
    const entry = initializeRiskCache('perf-risk', { equity: 10000 });
    entry.openTradeCount = 2;
    entry.totalLossToday = 50;
    entry.lossStreak = 1;

    const latencies = collectLatencies(() => {
        evaluateCachedRisk('perf-risk', {
            proposedStake: 10,
            maxStake: 100,
            dailyLossLimitPct: 5,
            drawdownLimitPct: 10,
            maxConsecutiveLosses: 5,
            cooldownMs: 3000,
            lossCooldownMs: 60000,
            maxConcurrentTrades: 5,
        });
    }, ITERATIONS);

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);

    console.log(`evaluateCachedRisk: p50=${p50.toFixed(3)}ms, p95=${p95.toFixed(3)}ms`);
    assert.ok(p95 < P95_THRESHOLD_MS, `p95 ${p95.toFixed(3)}ms exceeds ${P95_THRESHOLD_MS}ms threshold`);
});

// ====================================================
// 2. evaluatePreTradeGate latency (full pipeline)
// ====================================================

test(`perf: evaluatePreTradeGate p95 < ${P95_THRESHOLD_MS}ms (${ITERATIONS} iterations)`, () => {
    clearAllRiskCaches();
    clearKillSwitch('perf-gate');
    initializeRiskCache('perf-gate', { equity: 10000 });

    // Warm up the gate once to ensure any lazy initialization is done
    evaluatePreTradeGate({ accountId: 'perf-gate', stake: 5 });
    // Reset state after warmup
    clearAllRiskCaches();
    initializeRiskCache('perf-gate', { equity: 10000 });

    let settleCounter = 0;
    const latencies = collectLatencies(() => {
        const result = evaluatePreTradeGate({ accountId: 'perf-gate', stake: 5 });
        if (result.allowed) {
            // Settle immediately to keep openTradeCount from hitting limit
            settleCounter++;
            recordTradeSettled('perf-gate', 5, settleCounter % 2 === 0 ? 4 : -5);
        }
    }, ITERATIONS);

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);

    console.log(`evaluatePreTradeGate: p50=${p50.toFixed(3)}ms, p95=${p95.toFixed(3)}ms`);
    assert.ok(p95 < P95_THRESHOLD_MS, `p95 ${p95.toFixed(3)}ms exceeds ${P95_THRESHOLD_MS}ms threshold`);
});

// ====================================================
// 3. recordTradeSettled latency
// ====================================================

test(`perf: recordTradeSettled p95 < ${P95_THRESHOLD_MS}ms (${ITERATIONS} iterations)`, () => {
    clearAllRiskCaches();
    initializeRiskCache('perf-settle', { equity: 100000 });

    // Pre-fill with open trades (we settle more than we open, Math.max(0) protects)
    for (let i = 0; i < ITERATIONS; i++) {
        recordTradeOpened('perf-settle', 10);
    }

    const latencies = collectLatencies(() => {
        recordTradeSettled('perf-settle', 10, Math.random() > 0.5 ? 8 : -10);
    }, ITERATIONS);

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);

    console.log(`recordTradeSettled: p50=${p50.toFixed(3)}ms, p95=${p95.toFixed(3)}ms`);
    assert.ok(p95 < P95_THRESHOLD_MS, `p95 ${p95.toFixed(3)}ms exceeds ${P95_THRESHOLD_MS}ms threshold`);
});

// ====================================================
// 4. recordTradeOpened + limit check latency
// ====================================================

test(`perf: recordTradeOpened p95 < ${P95_THRESHOLD_MS}ms (${ITERATIONS} iterations)`, () => {
    clearAllRiskCaches();
    initializeRiskCache('perf-open', { equity: 100000 });

    let settleIdx = 0;
    const latencies = collectLatencies(() => {
        const result = recordTradeOpened('perf-open', 10, 1000);
        if (result.allowed) {
            settleIdx++;
            if (settleIdx % 2 === 0) {
                recordTradeSettled('perf-open', 10, 5);
            }
        }
    }, ITERATIONS);

    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);

    console.log(`recordTradeOpened: p50=${p50.toFixed(3)}ms, p95=${p95.toFixed(3)}ms`);
    assert.ok(p95 < P95_THRESHOLD_MS, `p95 ${p95.toFixed(3)}ms exceeds ${P95_THRESHOLD_MS}ms threshold`);
});
