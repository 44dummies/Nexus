import { metrics } from './metrics';
import { nowMs } from './latencyTracker';

class TokenBucket {
    private capacity: number;
    private tokens: number;
    private refillPerMs: number;
    private lastRefill: number;

    constructor(ratePerSec: number, burst: number) {
        this.capacity = Math.max(1, burst);
        this.tokens = this.capacity;
        this.refillPerMs = Math.max(0.0001, ratePerSec / 1000);
        this.lastRefill = nowMs();
    }

    tryConsume(amount: number = 1): boolean {
        const now = nowMs();
        const elapsed = now - this.lastRefill;
        if (elapsed > 0) {
            const refill = elapsed * this.refillPerMs;
            this.tokens = Math.min(this.capacity, this.tokens + refill);
            this.lastRefill = now;
        }
        if (this.tokens >= amount) {
            this.tokens -= amount;
            return true;
        }
        return false;
    }
}

const SUBS_PER_SEC = Math.max(1, Number(process.env.DERIV_SUBSCRIPTIONS_PER_SEC) || 2);
const SUBS_BURST = Math.max(1, Number(process.env.DERIV_SUBSCRIPTION_BURST) || 2);
const SUBS_MAX_WAIT_MS = Math.max(0, Number(process.env.DERIV_SUBSCRIPTION_MAX_WAIT_MS) || 500);

const buckets = new Map<string, TokenBucket>();

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function throttleSubscription(accountId: string): Promise<void> {
    let bucket = buckets.get(accountId);
    if (!bucket) {
        bucket = new TokenBucket(SUBS_PER_SEC, SUBS_BURST);
        buckets.set(accountId, bucket);
    }

    if (bucket.tryConsume()) return;
    const start = nowMs();
    while (nowMs() - start < SUBS_MAX_WAIT_MS) {
        await sleep(5);
        if (bucket.tryConsume()) {
            metrics.histogram('subscription.throttle_wait_ms', nowMs() - start);
            return;
        }
    }
    metrics.counter('subscription.throttle_reject');
    throw new Error('Subscription throttle limit reached');
}
