import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as tradePersistence from '../lib/tradePersistence';
import {
    clearExecutionLedgerForTest,
    getExecutionLedgerForTest,
    writeExecutionLedgerPending,
} from '../lib/executionLedger';
import { recoverUnsettledExecutionLedger } from '../trade';

test('atomic_settlement_recovery', async () => {
    clearExecutionLedgerForTest();

    const persistStub = mock.method(tradePersistence, 'persistTrade', async () => 'trade-recovered-id');

    const ledgerId = await writeExecutionLedgerPending({
        correlationId: 'recovery-corr-1',
        accountId: 'CR_RECOVERY_1',
        symbol: 'R_100',
        pnl: 8.5,
        fees: 0,
        contractId: 7001,
        tradePayload: {
            accountId: 'CR_RECOVERY_1',
            accountType: 'demo',
            contractId: 7001,
            symbol: 'R_100',
            stake: 10,
            duration: 5,
            durationUnit: 't',
            profit: 8.5,
            buyPrice: 10,
            payout: 18.5,
            direction: 'CALL',
            status: 'settled',
        },
    });

    const replayed = await recoverUnsettledExecutionLedger();

    assert.equal(replayed, 1);
    assert.equal(persistStub.mock.callCount(), 1);

    const entry = getExecutionLedgerForTest().find((row) => row.id === ledgerId);
    assert.ok(entry);
    assert.equal(entry?.state, 'SETTLED');

    persistStub.mock.restore();
    clearExecutionLedgerForTest();
});
