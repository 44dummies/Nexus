import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMicrostructureSignals } from '../lib/microSignals';

test('Microstructure signals produce directional output', () => {
    const result = evaluateMicrostructureSignals({
        imbalance: 0.2,
        spread: 0,
        momentum: 0.001,
        mode: 'order_book',
    }, {
        imbalanceThreshold: 0.15,
        momentumThreshold: 0.0005,
        enableImbalance: true,
        enableMomentum: true,
    });

    assert.equal(result.signal, 'CALL');
    assert.ok(result.confidence >= 0);
    assert.ok(result.reasonCodes.length > 0);
});
