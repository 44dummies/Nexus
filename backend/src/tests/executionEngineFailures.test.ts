import test from 'node:test';
import assert from 'node:assert/strict';

test('execution engine maps proposal rejection', async () => {
    const {
        executeProposalAndBuy,
        ExecutionError,
        setExecutionDepsForTest,
        resetExecutionDepsForTest,
        clearThrottleForTest,
    } = await import('../lib/executionEngine');

    let calls = 0;
    setExecutionDepsForTest({
        getOrCreateConnection: async () => ({ ws: null, authorized: true }) as any,
        sendMessage: async <T>() => {
            calls += 1;
            if (calls === 1) {
                return { error: { message: 'proposal rejected' } } as T;
            }
            return { buy: { contract_id: 1, buy_price: 1, payout: 1 } } as T;
        }
    });

    await assert.rejects(
        () => executeProposalAndBuy({
            accountId: 'acc-1',
            token: 'token',
            signal: 'CALL',
            stake: 1,
            symbol: 'R_100',
            duration: 1,
            durationUnit: 't',
            currency: 'USD',
        }),
        (err: any) => err instanceof ExecutionError && err.code === 'PROPOSAL_REJECT'
    );

    resetExecutionDepsForTest();
    clearThrottleForTest();
});

test('execution engine maps buy rejection', async () => {
    const {
        executeProposalAndBuy,
        ExecutionError,
        setExecutionDepsForTest,
        resetExecutionDepsForTest,
        clearThrottleForTest,
    } = await import('../lib/executionEngine');

    let calls = 0;
    setExecutionDepsForTest({
        getOrCreateConnection: async () => ({ ws: null, authorized: true }) as any,
        sendMessage: async <T>() => {
            calls += 1;
            if (calls === 1) {
                return { proposal: { id: 'prop-1', ask_price: 1, payout: 1 } } as T;
            }
            return { error: { message: 'buy rejected' } } as T;
        }
    });

    await assert.rejects(
        () => executeProposalAndBuy({
            accountId: 'acc-2',
            token: 'token',
            signal: 'PUT',
            stake: 1,
            symbol: 'R_100',
            duration: 1,
            durationUnit: 't',
            currency: 'USD',
        }),
        (err: any) => err instanceof ExecutionError && err.code === 'BUY_REJECT'
    );

    resetExecutionDepsForTest();
    clearThrottleForTest();
});

test('execution engine throttling error is retryable', async () => {
    const {
        executeProposalAndBuy,
        ExecutionError,
        setExecutionDepsForTest,
        resetExecutionDepsForTest,
        setThrottleForTest,
        clearThrottleForTest,
    } = await import('../lib/executionEngine');

    setExecutionDepsForTest({
        getOrCreateConnection: async () => ({ ws: null, authorized: true }) as any,
        sendMessage: async <T>() => ({ proposal: { id: 'prop-1', ask_price: 1, payout: 1 } } as T),
    });

    setThrottleForTest('acc-3', {
        proposalLimiter: {
            tryConsume: () => false,
            nextAvailableAt: () => Number.POSITIVE_INFINITY,
        } as any,
        buyLimiter: {
            tryConsume: () => true,
            nextAvailableAt: () => Date.now(),
        } as any,
    });

    await assert.rejects(
        () => executeProposalAndBuy({
            accountId: 'acc-3',
            token: 'token',
            signal: 'CALL',
            stake: 1,
            symbol: 'R_100',
            duration: 1,
            durationUnit: 't',
            currency: 'USD',
        }),
        (err: any) => err instanceof ExecutionError && err.code === 'THROTTLE' && err.retryable === true
    );

    resetExecutionDepsForTest();
    clearThrottleForTest();
});
