import test from 'node:test';
import assert from 'node:assert/strict';
import { OrderBook } from '../lib/orderBook';

test('OrderBook computes spread, mid, and imbalance', () => {
    const ob = new OrderBook('R_100');
    ob.updateFromSnapshot({
        symbol: 'R_100',
        bids: [{ price: 99, size: 5 }, { price: 98, size: 3 }],
        asks: [{ price: 101, size: 4 }, { price: 102, size: 2 }],
    });
    assert.equal(ob.getSpread(), 2);
    assert.equal(ob.getMid(), 100);
    const imbalance = ob.getImbalanceTopN(1);
    assert.ok(typeof imbalance === 'number');
    assert.equal(Number(imbalance?.toFixed(3)), Number(((5 - 4) / (5 + 4)).toFixed(3)));
});
