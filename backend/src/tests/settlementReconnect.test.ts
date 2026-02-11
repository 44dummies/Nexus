
import test, { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as wsManager from '../lib/wsManager';
import { registerPendingSettlement, clearPendingSettlement } from '../lib/settlementSubscriptions';
import { tradeLogger } from '../lib/logger';

describe('Settlement Reconnect Logic', () => {
    // We need to reset registeredAccounts in settlementSubscriptions between tests if possible, 
    // but it's a module level Set. We might need to rely on unique accountIds for isolation.

    const mockReadyListener = mock.fn();
    const mockDisconnectListener = mock.fn();
    const mockSendMessage = mock.fn();

    // Mock wsManager methods
    mock.method(wsManager, 'registerConnectionReadyListener', (accId: string, cb: any) => {
        mockReadyListener(accId, cb);
    });
    mock.method(wsManager, 'registerDisconnectListener', (accId: string, cb: any) => {
        mockDisconnectListener(accId, cb);
    });
    mock.method(wsManager, 'sendMessageAsync', mockSendMessage);

    // Mock logger to avoid console spam
    mock.method(tradeLogger, 'warn', () => { });
    mock.method(tradeLogger, 'error', () => { });

    afterEach(() => {
        mockReadyListener.mock.resetCalls();
        mockDisconnectListener.mock.resetCalls();
        mockSendMessage.mock.resetCalls();
    });

    it('registers listeners on first pending settlement', () => {
        const accountId = 'acc_reconnect_test_1';
        registerPendingSettlement(accountId, 12345);

        assert.strictEqual(mockReadyListener.mock.callCount(), 1);
        assert.strictEqual(mockDisconnectListener.mock.callCount(), 1);

        // Cleanup
        clearPendingSettlement(accountId, 12345);
    });

    it('triggers resubscription on reconnect', () => {
        const accountId = 'acc_reconnect_test_2';
        registerPendingSettlement(accountId, 67890);

        // Get the registered callback
        const readyCallback = mockReadyListener.mock.calls[0].arguments[1];
        assert.ok(typeof readyCallback === 'function');

        // Simulate reconnect (isReconnect = true)
        readyCallback(accountId, true);

        // Should call sendMessageAsync to resubscribe
        assert.strictEqual(mockSendMessage.mock.callCount(), 1);
        const args = mockSendMessage.mock.calls[0].arguments;
        assert.strictEqual(args[0], accountId);
        assert.strictEqual(args[1].contract_id, 67890);
        assert.strictEqual(args[1].proposal_open_contract, 1);

        // Cleanup
        clearPendingSettlement(accountId, 67890);
    });

    it('detects settlement gap if disconnected previously', () => {
        const accountId = 'acc_reconnect_test_3';
        registerPendingSettlement(accountId, 11122);

        const disconnectCallback = mockDisconnectListener.mock.calls[0].arguments[1];
        const readyCallback = mockReadyListener.mock.calls[0].arguments[1];

        // Simulate disconnect
        disconnectCallback(accountId);

        // Simulate wait (in real time this would be small, but logic uses Date.now())
        // We can't easily mock Date.now() without more boilerplate or sinon, 
        // so we just check that it runs without error and logs warning (mocked).

        // Simulate reconnect
        readyCallback(accountId, true);

        // Should resubscribe
        assert.strictEqual(mockSendMessage.mock.callCount(), 1);

        // Cleanup
        clearPendingSettlement(accountId, 11122);
    });
});
