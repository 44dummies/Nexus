/**
 * Risk Integration Tests
 * Tests for risk management flow integration
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Mock risk cache entry
interface RiskCacheEntry {
    accountId: string;
    equity: number;
    equityPeak: number;
    dailyStartEquity: number;
    dailyPnL: number;
    totalLossToday: number;
    totalProfitToday: number;
    lossStreak: number;
    consecutiveWins: number;
    openExposure: number;
    openTradeCount: number;
    lastTradeTime: number | null;
    lastLossTime: number | null;
}

// Mock risk cache
const mockRiskCache = new Map<string, RiskCacheEntry>();

function initializeRiskCache(accountId: string, equity: number): RiskCacheEntry {
    const entry: RiskCacheEntry = {
        accountId,
        equity,
        equityPeak: equity,
        dailyStartEquity: equity,
        dailyPnL: 0,
        totalLossToday: 0,
        totalProfitToday: 0,
        lossStreak: 0,
        consecutiveWins: 0,
        openExposure: 0,
        openTradeCount: 0,
        lastTradeTime: null,
        lastLossTime: null,
    };
    mockRiskCache.set(accountId, entry);
    return entry;
}

function getRiskCache(accountId: string): RiskCacheEntry | null {
    return mockRiskCache.get(accountId) ?? null;
}

// Risk evaluation function
function evaluateRisk(
    accountId: string,
    proposedStake: number,
    config: {
        maxStake?: number;
        dailyLossLimitPct?: number;
        drawdownLimitPct?: number;
        maxConsecutiveLosses?: number;
        maxConcurrentTrades?: number;
        cooldownMs?: number;
    }
): { status: 'OK' | 'HALT' | 'COOLDOWN' | 'MAX_CONCURRENT' | 'REDUCE_STAKE'; reason?: string } {
    const entry = getRiskCache(accountId);
    
    // CRITICAL: Fail closed if no risk state
    if (!entry) {
        return { status: 'HALT', reason: 'Risk state not initialized' };
    }
    
    const now = Date.now();
    
    // Check concurrent trades
    const maxConcurrent = config.maxConcurrentTrades ?? 5;
    if (entry.openTradeCount >= maxConcurrent) {
        return { status: 'MAX_CONCURRENT', reason: `Max ${maxConcurrent} concurrent trades` };
    }
    
    // Check cooldown
    if (config.cooldownMs && entry.lastTradeTime) {
        if (now - entry.lastTradeTime < config.cooldownMs) {
            return { status: 'COOLDOWN', reason: 'Trade cooldown active' };
        }
    }
    
    // Check loss streak
    if (config.maxConsecutiveLosses && entry.lossStreak >= config.maxConsecutiveLosses) {
        return { status: 'HALT', reason: 'Max consecutive losses reached' };
    }
    
    // Check daily loss limit
    if (config.dailyLossLimitPct && entry.dailyStartEquity > 0) {
        const dailyLossPct = (entry.totalLossToday / entry.dailyStartEquity) * 100;
        if (dailyLossPct >= config.dailyLossLimitPct) {
            return { status: 'HALT', reason: 'Daily loss limit reached' };
        }
    }
    
    // Check drawdown limit
    if (config.drawdownLimitPct && entry.equityPeak > 0) {
        const drawdownPct = ((entry.equityPeak - entry.equity) / entry.equityPeak) * 100;
        if (drawdownPct >= config.drawdownLimitPct) {
            return { status: 'HALT', reason: 'Drawdown limit reached' };
        }
    }
    
    // Check max stake
    if (config.maxStake && proposedStake > config.maxStake) {
        return { status: 'REDUCE_STAKE', reason: 'Stake exceeds maximum' };
    }
    
    return { status: 'OK' };
}

// Record trade opened
function recordTradeOpened(accountId: string, stake: number): boolean {
    const entry = getRiskCache(accountId);
    if (!entry) return false;
    
    entry.openTradeCount++;
    entry.openExposure += stake;
    entry.lastTradeTime = Date.now();
    return true;
}

// Record trade settled
function recordTradeSettled(accountId: string, stake: number, profit: number): void {
    const entry = getRiskCache(accountId);
    if (!entry) return;
    
    entry.openTradeCount = Math.max(0, entry.openTradeCount - 1);
    entry.openExposure = Math.max(0, entry.openExposure - stake);
    entry.dailyPnL += profit;
    entry.equity += profit;
    
    if (profit < 0) {
        entry.totalLossToday += Math.abs(profit);
        entry.lossStreak++;
        entry.consecutiveWins = 0;
        entry.lastLossTime = Date.now();
    } else {
        entry.totalProfitToday += profit;
        entry.consecutiveWins++;
        entry.lossStreak = 0;
    }
    
    if (entry.equity > entry.equityPeak) {
        entry.equityPeak = entry.equity;
    }
}

// Cleanup
test.beforeEach(() => {
    mockRiskCache.clear();
});

// Test: Risk cache initialization
test('Risk cache initializes with correct values', () => {
    const entry = initializeRiskCache('acc-1', 10000);
    
    assert.equal(entry.equity, 10000);
    assert.equal(entry.equityPeak, 10000);
    assert.equal(entry.dailyStartEquity, 10000);
    assert.equal(entry.dailyPnL, 0);
    assert.equal(entry.openExposure, 0);
    assert.equal(entry.openTradeCount, 0);
});

// Test: Fail closed when risk cache missing
test('Evaluation fails closed when cache missing', () => {
    const result = evaluateRisk('nonexistent', 10, {});
    
    assert.equal(result.status, 'HALT');
    assert.equal(result.reason, 'Risk state not initialized');
});

// Test: Concurrent trade limit
test('Concurrent trade limit blocks excess trades', () => {
    initializeRiskCache('acc-1', 10000);
    const entry = getRiskCache('acc-1')!;
    
    // Allow up to limit
    entry.openTradeCount = 4;
    assert.equal(evaluateRisk('acc-1', 10, { maxConcurrentTrades: 5 }).status, 'OK');
    
    // Block at limit
    entry.openTradeCount = 5;
    assert.equal(evaluateRisk('acc-1', 10, { maxConcurrentTrades: 5 }).status, 'MAX_CONCURRENT');
});

// Test: Daily loss limit
test('Daily loss limit halts trading', () => {
    initializeRiskCache('acc-1', 10000);
    const entry = getRiskCache('acc-1')!;
    
    // Under limit
    entry.totalLossToday = 150; // 1.5% of 10000
    assert.equal(evaluateRisk('acc-1', 10, { dailyLossLimitPct: 2 }).status, 'OK');
    
    // At/over limit
    entry.totalLossToday = 200; // 2% of 10000
    assert.equal(evaluateRisk('acc-1', 10, { dailyLossLimitPct: 2 }).status, 'HALT');
});

// Test: Drawdown limit
test('Drawdown limit halts trading', () => {
    initializeRiskCache('acc-1', 10000);
    const entry = getRiskCache('acc-1')!;
    
    // Set peak and current equity
    entry.equityPeak = 10000;
    entry.equity = 9500; // 5% drawdown
    
    assert.equal(evaluateRisk('acc-1', 10, { drawdownLimitPct: 6 }).status, 'OK');
    
    entry.equity = 9400; // 6% drawdown
    assert.equal(evaluateRisk('acc-1', 10, { drawdownLimitPct: 6 }).status, 'HALT');
});

// Test: Consecutive loss limit
test('Consecutive loss limit halts trading', () => {
    initializeRiskCache('acc-1', 10000);
    const entry = getRiskCache('acc-1')!;
    
    entry.lossStreak = 2;
    assert.equal(evaluateRisk('acc-1', 10, { maxConsecutiveLosses: 3 }).status, 'OK');
    
    entry.lossStreak = 3;
    assert.equal(evaluateRisk('acc-1', 10, { maxConsecutiveLosses: 3 }).status, 'HALT');
});

// Test: Trade cooldown
test('Trade cooldown blocks rapid trades', () => {
    initializeRiskCache('acc-1', 10000);
    const entry = getRiskCache('acc-1')!;
    
    // No last trade - no cooldown
    assert.equal(evaluateRisk('acc-1', 10, { cooldownMs: 5000 }).status, 'OK');
    
    // Recent trade - in cooldown
    entry.lastTradeTime = Date.now();
    assert.equal(evaluateRisk('acc-1', 10, { cooldownMs: 5000 }).status, 'COOLDOWN');
    
    // Old trade - cooldown expired
    entry.lastTradeTime = Date.now() - 6000;
    assert.equal(evaluateRisk('acc-1', 10, { cooldownMs: 5000 }).status, 'OK');
});

// Test: Max stake enforcement
test('Max stake suggests reduction', () => {
    initializeRiskCache('acc-1', 10000);
    
    assert.equal(evaluateRisk('acc-1', 50, { maxStake: 100 }).status, 'OK');
    assert.equal(evaluateRisk('acc-1', 150, { maxStake: 100 }).status, 'REDUCE_STAKE');
});

// Test: Trade lifecycle updates risk state
test('Trade lifecycle updates risk state correctly', () => {
    initializeRiskCache('acc-1', 10000);
    
    // Open trade
    assert.equal(recordTradeOpened('acc-1', 50), true);
    const afterOpen = getRiskCache('acc-1')!;
    assert.equal(afterOpen.openTradeCount, 1);
    assert.equal(afterOpen.openExposure, 50);
    
    // Settle with profit
    recordTradeSettled('acc-1', 50, 25);
    const afterWin = getRiskCache('acc-1')!;
    assert.equal(afterWin.openTradeCount, 0);
    assert.equal(afterWin.openExposure, 0);
    assert.equal(afterWin.equity, 10025);
    assert.equal(afterWin.dailyPnL, 25);
    assert.equal(afterWin.consecutiveWins, 1);
    assert.equal(afterWin.lossStreak, 0);
});

// Test: Loss streak tracking
test('Loss streak increments correctly', () => {
    initializeRiskCache('acc-1', 10000);
    
    recordTradeOpened('acc-1', 50);
    recordTradeSettled('acc-1', 50, -50);
    
    recordTradeOpened('acc-1', 50);
    recordTradeSettled('acc-1', 50, -50);
    
    recordTradeOpened('acc-1', 50);
    recordTradeSettled('acc-1', 50, -50);
    
    const entry = getRiskCache('acc-1')!;
    assert.equal(entry.lossStreak, 3);
    assert.equal(entry.consecutiveWins, 0);
    assert.equal(entry.totalLossToday, 150);
});

// Test: Win resets loss streak
test('Win resets loss streak', () => {
    initializeRiskCache('acc-1', 10000);
    const entry = getRiskCache('acc-1')!;
    
    entry.lossStreak = 5;
    
    recordTradeOpened('acc-1', 50);
    recordTradeSettled('acc-1', 50, 25);
    
    assert.equal(entry.lossStreak, 0);
    assert.equal(entry.consecutiveWins, 1);
});

// Test: Equity peak tracking
test('Equity peak updates on new highs only', () => {
    initializeRiskCache('acc-1', 10000);
    
    recordTradeOpened('acc-1', 50);
    recordTradeSettled('acc-1', 50, 100);
    
    const afterWin = getRiskCache('acc-1')!;
    assert.equal(afterWin.equity, 10100);
    assert.equal(afterWin.equityPeak, 10100);
    
    recordTradeOpened('acc-1', 50);
    recordTradeSettled('acc-1', 50, -50);
    
    const afterLoss = getRiskCache('acc-1')!;
    assert.equal(afterLoss.equity, 10050);
    assert.equal(afterLoss.equityPeak, 10100); // Peak unchanged
});

// Test: Exposure cannot go negative
test('Exposure stays non-negative on edge cases', () => {
    initializeRiskCache('acc-1', 10000);
    
    // Settle without opening (edge case)
    recordTradeSettled('acc-1', 50, 0);
    
    const entry = getRiskCache('acc-1')!;
    assert.equal(entry.openTradeCount, 0); // Clamped to 0
    assert.equal(entry.openExposure, 0);   // Clamped to 0
});
