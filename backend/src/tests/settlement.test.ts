import test from 'node:test';
import assert from 'node:assert/strict';

test('settlement lock serializes concurrent finalization', async () => {
    const { __test } = await import('../trade');
    const order: string[] = [];

    await Promise.all([
        __test.withSettlementLock('acc:1', async () => {
            order.push('first-start');
            await new Promise(resolve => setTimeout(resolve, 50));
            order.push('first-end');
        }),
        __test.withSettlementLock('acc:1', async () => {
            order.push('second-start');
            await new Promise(resolve => setTimeout(resolve, 10));
            order.push('second-end');
        }),
    ]);

    assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('settlement timeout calculation clamps min/max', async () => {
    process.env.SETTLEMENT_MIN_TIMEOUT_MS = '1000';
    process.env.SETTLEMENT_MAX_TIMEOUT_MS = '2000';
    process.env.SETTLEMENT_BUFFER_MS = '500';

    const { calculateSettlementTimeoutMs } = await import('../trade');

    const short = calculateSettlementTimeoutMs(0, 's');
    assert.equal(short, 1000);

    const mid = calculateSettlementTimeoutMs(1, 's');
    assert.equal(mid, 1500);

    const long = calculateSettlementTimeoutMs(10, 's');
    assert.equal(long, 2000);
});
