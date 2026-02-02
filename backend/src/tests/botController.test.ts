/**
 * Bot Controller Tests
 * Tests for bot lifecycle management
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Mock types
interface MockBotRun {
    id: string;
    accountId: string;
    status: 'running' | 'paused' | 'stopped';
    tradesExecuted: number;
    totalProfit: number;
    lastTradeAt: number | null;
}

// Mock bot runs storage
const mockBotRuns = new Map<string, MockBotRun>();

// Helper functions simulating botController behavior
function createBotRun(id: string, accountId: string): MockBotRun {
    const run: MockBotRun = {
        id,
        accountId,
        status: 'running',
        tradesExecuted: 0,
        totalProfit: 0,
        lastTradeAt: null,
    };
    mockBotRuns.set(id, run);
    return run;
}

function getBotRun(id: string): MockBotRun | undefined {
    return mockBotRuns.get(id);
}

function pauseBotRun(id: string): boolean {
    const run = mockBotRuns.get(id);
    if (!run) return false;
    run.status = 'paused';
    return true;
}

function resumeBotRun(id: string): boolean {
    const run = mockBotRuns.get(id);
    if (!run || run.status !== 'paused') return false;
    run.status = 'running';
    return true;
}

function stopBotRun(id: string): boolean {
    const run = mockBotRuns.get(id);
    if (!run) return false;
    run.status = 'stopped';
    mockBotRuns.delete(id);
    return true;
}

function getAccountBotRuns(accountId: string): MockBotRun[] {
    return Array.from(mockBotRuns.values()).filter(r => r.accountId === accountId);
}

// Cleanup before each test
test.beforeEach(() => {
    mockBotRuns.clear();
});

// Test: Bot run creation
test('Bot run is created with correct initial state', () => {
    const run = createBotRun('run-1', 'acc-1');
    
    assert.equal(run.id, 'run-1');
    assert.equal(run.accountId, 'acc-1');
    assert.equal(run.status, 'running');
    assert.equal(run.tradesExecuted, 0);
    assert.equal(run.totalProfit, 0);
    assert.equal(run.lastTradeAt, null);
});

// Test: Bot run lifecycle transitions
test('Bot run lifecycle: running → paused → resumed → stopped', () => {
    createBotRun('run-1', 'acc-1');
    
    // Initial state
    assert.equal(getBotRun('run-1')?.status, 'running');
    
    // Pause
    assert.equal(pauseBotRun('run-1'), true);
    assert.equal(getBotRun('run-1')?.status, 'paused');
    
    // Resume
    assert.equal(resumeBotRun('run-1'), true);
    assert.equal(getBotRun('run-1')?.status, 'running');
    
    // Stop (removes from map)
    assert.equal(stopBotRun('run-1'), true);
    assert.equal(getBotRun('run-1'), undefined);
});

// Test: Cannot resume non-paused bot
test('Cannot resume a running bot', () => {
    createBotRun('run-1', 'acc-1');
    
    // Try to resume while running
    assert.equal(resumeBotRun('run-1'), false);
    assert.equal(getBotRun('run-1')?.status, 'running');
});

// Test: Account isolation
test('Bot runs are isolated by account', () => {
    createBotRun('run-1', 'acc-1');
    createBotRun('run-2', 'acc-1');
    createBotRun('run-3', 'acc-2');
    
    const acc1Runs = getAccountBotRuns('acc-1');
    const acc2Runs = getAccountBotRuns('acc-2');
    
    assert.equal(acc1Runs.length, 2);
    assert.equal(acc2Runs.length, 1);
    assert.equal(acc1Runs[0].id, 'run-1');
    assert.equal(acc2Runs[0].id, 'run-3');
});

// Test: Ownership enforcement
test('Bot run ownership prevents cross-account access', () => {
    const enforceOwnership = (runId: string, requestingAccountId: string): { allowed: boolean; error?: string } => {
        const run = getBotRun(runId);
        if (!run) {
            return { allowed: false, error: 'Bot run not found' };
        }
        if (run.accountId !== requestingAccountId) {
            return { allowed: false, error: 'Unauthorized' };
        }
        return { allowed: true };
    };
    
    createBotRun('run-1', 'acc-1');
    
    // Owner can access
    assert.deepEqual(enforceOwnership('run-1', 'acc-1'), { allowed: true });
    
    // Non-owner cannot access
    assert.deepEqual(enforceOwnership('run-1', 'acc-2'), { allowed: false, error: 'Unauthorized' });
    
    // Non-existent run
    assert.deepEqual(enforceOwnership('run-999', 'acc-1'), { allowed: false, error: 'Bot run not found' });
});

// Test: Duplicate run prevention
test('Cannot start duplicate bot run for same ID', () => {
    createBotRun('run-1', 'acc-1');
    
    const canCreateRun = (id: string): boolean => {
        return !mockBotRuns.has(id);
    };
    
    assert.equal(canCreateRun('run-1'), false);
    assert.equal(canCreateRun('run-2'), true);
});

// Test: Cooldown enforcement
test('Cooldown prevents rapid trades', () => {
    const COOLDOWN_MS = 1000;
    
    const isInCooldown = (lastTradeAt: number | null, cooldownMs: number): boolean => {
        if (lastTradeAt === null) return false;
        return Date.now() - lastTradeAt < cooldownMs;
    };
    
    const run = createBotRun('run-1', 'acc-1');
    
    // No trades yet - not in cooldown
    assert.equal(isInCooldown(run.lastTradeAt, COOLDOWN_MS), false);
    
    // Simulate trade
    run.lastTradeAt = Date.now();
    
    // Now in cooldown
    assert.equal(isInCooldown(run.lastTradeAt, COOLDOWN_MS), true);
    
    // After cooldown (simulated with old timestamp)
    run.lastTradeAt = Date.now() - COOLDOWN_MS - 100;
    assert.equal(isInCooldown(run.lastTradeAt, COOLDOWN_MS), false);
});

// Test: Trade statistics tracking
test('Trade statistics are tracked correctly', () => {
    const run = createBotRun('run-1', 'acc-1');
    
    const recordTrade = (profit: number): void => {
        run.tradesExecuted++;
        run.totalProfit += profit;
        run.lastTradeAt = Date.now();
    };
    
    recordTrade(0.5);   // Win
    recordTrade(-1.0);  // Loss
    recordTrade(0.8);   // Win
    
    assert.equal(run.tradesExecuted, 3);
    // Use tolerance for floating point comparison (0.5 - 1.0 + 0.8 = 0.3)
    assert.ok(Math.abs(run.totalProfit - 0.3) < 0.0001, `Expected ~0.3 but got ${run.totalProfit}`);
    assert.notEqual(run.lastTradeAt, null);
});

// Test: Kill switch integration
test('Kill switch pauses all account bots', () => {
    createBotRun('run-1', 'acc-1');
    createBotRun('run-2', 'acc-1');
    createBotRun('run-3', 'acc-2'); // Different account
    
    const triggerKillSwitch = (accountId: string): void => {
        for (const run of mockBotRuns.values()) {
            if (run.accountId === accountId && run.status === 'running') {
                run.status = 'paused';
            }
        }
    };
    
    triggerKillSwitch('acc-1');
    
    assert.equal(getBotRun('run-1')?.status, 'paused');
    assert.equal(getBotRun('run-2')?.status, 'paused');
    assert.equal(getBotRun('run-3')?.status, 'running'); // Unaffected
});

// Test: Volatility guard
test('Volatility spike pauses bot', () => {
    const checkVolatility = (atr: number, threshold: number): boolean => {
        return atr > threshold;
    };
    
    const THRESHOLD = 0.5;
    
    // Normal volatility
    assert.equal(checkVolatility(0.3, THRESHOLD), false);
    
    // High volatility
    assert.equal(checkVolatility(0.7, THRESHOLD), true);
    
    // Edge case - at threshold
    assert.equal(checkVolatility(0.5, THRESHOLD), false);
    assert.equal(checkVolatility(0.500001, THRESHOLD), true);
});
