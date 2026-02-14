import test from 'node:test';
import assert from 'node:assert/strict';
import { orderIntentStore } from '../lib/orderIntentStore';

test('duplicate_correlation_replay', async () => {
    const {
        executeProposalAndBuy,
        ExecutionError,
        setExecutionDepsForTest,
        resetExecutionDepsForTest,
        clearThrottleForTest,
    } = await import('../lib/executionEngine');

    orderIntentStore.clear();

    let wsCalls = 0;
    setExecutionDepsForTest({
        getOrCreateConnection: async () => ({ ws: null, authorized: true }) as any,
        sendMessage: async <T>() => {
            wsCalls += 1;
            if (wsCalls === 1) {
                return { proposal: { id: 'prop-dup-1', ask_price: 1.23, payout: 2.1 } } as T;
            }
            if (wsCalls === 2) {
                return { buy: { contract_id: 424242, buy_price: 1.23, payout: 2.1 } } as T;
            }
            throw new Error('Unexpected extra WS call');
        },
    });

    await executeProposalAndBuy({
        accountId: 'acc-dup-1',
        token: 'token',
        signal: 'CALL',
        stake: 1,
        symbol: 'R_100',
        duration: 1,
        durationUnit: 't',
        currency: 'USD',
        correlationId: 'corr-replay-1',
    });

    await assert.rejects(
        () => executeProposalAndBuy({
            accountId: 'acc-dup-1',
            token: 'token',
            signal: 'CALL',
            stake: 1,
            symbol: 'R_100',
            duration: 1,
            durationUnit: 't',
            currency: 'USD',
            correlationId: 'corr-replay-1',
        }),
        (error: unknown) => error instanceof ExecutionError && error.code === 'DUPLICATE_REJECTED'
    );

    // First execution should consume exactly 2 WS round-trips (proposal + buy).
    assert.equal(wsCalls, 2);

    resetExecutionDepsForTest();
    clearThrottleForTest();
    orderIntentStore.clear();
});
