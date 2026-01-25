import test from 'node:test';
import assert from 'node:assert/strict';

test('subscription throttle rejects when limit exceeded', async () => {
    process.env.DERIV_SUBSCRIPTIONS_PER_SEC = '1';
    process.env.DERIV_SUBSCRIPTION_BURST = '1';
    process.env.DERIV_SUBSCRIPTION_MAX_WAIT_MS = '0';

    const { throttleSubscription } = await import('../lib/subscriptionThrottle');

    await throttleSubscription('acc-throttle');
    await assert.rejects(async () => {
        await throttleSubscription('acc-throttle');
    });
});
