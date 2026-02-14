import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStrategy, UnknownStrategyError } from '../lib/strategyEngine';

test('unknown strategy throws UnknownStrategyError', () => {
    const prices = {
        length: 3,
        get(index: number) {
            return [100, 101, 102][index];
        },
    };

    assert.throws(
        () => evaluateStrategy('does-not-exist', prices as any),
        (error: unknown) => error instanceof UnknownStrategyError
    );
});
