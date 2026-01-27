import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceRunOwnership } from '../routes/bot-runs';
import { clearBotRunsForTest, setBotRunForTest, type ActiveBotRun } from '../lib/botController';

function buildRun(accountId: string, runId: string): ActiveBotRun {
    return {
        id: runId,
        accountId,
        accountType: 'real',
        token: 'token',
        config: {
            strategyId: 'rsi',
            symbol: 'R_100',
            stake: 1,
            duration: 5,
            durationUnit: 't',
            cooldownMs: 1000,
        },
        status: 'running',
        startedAt: new Date(),
        lastTradeAt: null,
        tradesExecuted: 0,
        totalProfit: 0,
        currency: 'USD',
        pendingTicks: [],
        batchTimer: null,
    };
}

test('bot run ownership blocks other accounts', () => {
    clearBotRunsForTest();
    setBotRunForTest(buildRun('acc-owner', 'run-1'));

    const result = enforceRunOwnership('acc-other', 'run-1');
    assert.equal(result.status, 403);
    assert.equal(result.error, 'Unauthorized');
});
