import test from 'node:test';
import assert from 'node:assert/strict';
import { RingBuffer } from '../lib/ringBuffer';

test('RingBuffer retains most recent values in order', () => {
    const rb = new RingBuffer(3);
    rb.push(1);
    rb.push(2);
    rb.push(3);
    assert.equal(rb.length, 3);
    assert.equal(rb.get(0), 1);
    assert.equal(rb.get(2), 3);
    rb.push(4);
    assert.equal(rb.length, 3);
    assert.equal(rb.get(0), 2);
    assert.equal(rb.get(2), 4);
});

test('RingBuffer view exposes correct window', () => {
    const rb = new RingBuffer(5);
    [10, 11, 12, 13, 14].forEach(v => rb.push(v));
    const view = rb.getView(3);
    assert.equal(view.length, 3);
    assert.deepEqual(view.toArray(), [12, 13, 14]);
});
