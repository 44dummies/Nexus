import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as tickTest } from '../lib/tickStream';
import { metrics } from '../lib/metrics';

test('out_of_order_tick_drop', () => {
    tickTest.clear();
    tickTest.createSubscription('acc-tick-1', 'R_100');

    const countersBefore = metrics.snapshot().counters;
    const beforeDrops = countersBefore['tick.out_of_order_drop'] ?? 0;
    const beforeGaps = countersBefore['tick.seq_gap'] ?? 0;

    tickTest.processTick('acc-tick-1', 'R_100', { quote: 100.1, epoch: 1000 });
    tickTest.processTick('acc-tick-1', 'R_100', { quote: 100.2, epoch: 999 }); // out of order (drop)
    tickTest.processTick('acc-tick-1', 'R_100', { quote: 100.3, epoch: 1003 }); // seq gap

    const snapshot = tickTest.getSnapshot('acc-tick-1', 'R_100');
    assert.ok(snapshot);
    assert.equal(snapshot?.lastEpoch, 1003);
    assert.deepEqual(snapshot?.history, [100.1, 100.3]);

    const countersAfter = metrics.snapshot().counters;
    assert.equal(countersAfter['tick.out_of_order_drop'], beforeDrops + 1);
    assert.equal(countersAfter['tick.seq_gap'], beforeGaps + 1);
});
