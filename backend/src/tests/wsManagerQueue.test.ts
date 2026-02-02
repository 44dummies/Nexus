import test from 'node:test';
import assert from 'node:assert/strict';
import { sendMessage, setConnectionStateForTest, clearConnectionStateForTest, type WSConnectionState } from '../lib/wsManager';

function buildState(accountId: string): WSConnectionState {
    return {
        ws: null,
        authorized: false,
        token: 'token',
        accountId,
        pendingMessages: new Map(),
        messageQueue: [],
        reconnectAttempts: 0,
        lastActivity: Date.now(),
        inboundInFlight: 0,
    };
}

test('queued messages time out and are removed', async () => {
    const accountId = 'acc-timeout';
    const state = buildState(accountId);
    setConnectionStateForTest(accountId, state);

    await assert.rejects(
        () => sendMessage(accountId, { ping: 1 }, 20),
        /Message timeout/
    );

    assert.equal(state.messageQueue.length, 0);
    assert.equal(state.pendingMessages.size, 0);
    clearConnectionStateForTest(accountId);
});

test('queue enforces max depth (backpressure)', async () => {
    const accountId = 'acc-queue-full';
    const state = buildState(accountId);
    // Force queue to be "full" by adding many entries.
    for (let i = 0; i < 10000; i += 1) {
        state.messageQueue.push({
            data: '{}',
            resolve: () => undefined,
            reject: () => undefined,
            reqId: i + 1,
            queuedAt: Date.now(),
            timeoutAt: Date.now() + 1000,
            priority: 0,
        });
    }
    setConnectionStateForTest(accountId, state);

    await assert.rejects(
        () => sendMessage(accountId, { ping: 2 }, 50),
        /Message queue full/
    );

    clearConnectionStateForTest(accountId);
});
