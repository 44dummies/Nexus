/**
 * Tick Stream Tests
 * Tests for tick subscriptions and data streaming
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// RingBuffer implementation for testing
class TestRingBuffer {
    private buffer: Float64Array;
    private head: number = 0;
    private count: number = 0;
    private readonly capacity: number;

    constructor(capacity: number) {
        this.capacity = capacity;
        this.buffer = new Float64Array(capacity);
    }

    push(value: number): void {
        this.buffer[this.head] = value;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity) {
            this.count++;
        }
    }

    get length(): number {
        return this.count;
    }

    get(index: number): number {
        if (index < 0 || index >= this.count) return NaN;
        const actualIndex = (this.head - this.count + index + this.capacity) % this.capacity;
        return this.buffer[actualIndex];
    }

    toArray(): number[] {
        const result: number[] = [];
        for (let i = 0; i < this.count; i++) {
            result.push(this.get(i));
        }
        return result;
    }

    getLastN(n: number): number[] {
        const count = Math.min(n, this.count);
        const result: number[] = [];
        for (let i = this.count - count; i < this.count; i++) {
            result.push(this.get(i));
        }
        return result;
    }
}

// Test: RingBuffer initialization
test('RingBuffer initializes with zero length', () => {
    const buffer = new TestRingBuffer(10);
    assert.equal(buffer.length, 0);
});

// Test: RingBuffer push increases length
test('RingBuffer push increases length up to capacity', () => {
    const buffer = new TestRingBuffer(5);
    
    buffer.push(1);
    assert.equal(buffer.length, 1);
    
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);
    buffer.push(5);
    assert.equal(buffer.length, 5);
    
    // Exceeding capacity doesn't increase length
    buffer.push(6);
    assert.equal(buffer.length, 5);
});

// Test: RingBuffer maintains FIFO order
test('RingBuffer maintains FIFO order after wrap', () => {
    const buffer = new TestRingBuffer(5);
    
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);
    buffer.push(5);
    
    assert.deepEqual(buffer.toArray(), [1, 2, 3, 4, 5]);
    
    // Push 3 more, wrapping around
    buffer.push(6);
    buffer.push(7);
    buffer.push(8);
    
    assert.deepEqual(buffer.toArray(), [4, 5, 6, 7, 8]);
});

// Test: RingBuffer get returns correct values
test('RingBuffer get returns correct values', () => {
    const buffer = new TestRingBuffer(5);
    
    buffer.push(10);
    buffer.push(20);
    buffer.push(30);
    
    assert.equal(buffer.get(0), 10);
    assert.equal(buffer.get(1), 20);
    assert.equal(buffer.get(2), 30);
});

// Test: RingBuffer get returns NaN for out of bounds
test('RingBuffer get returns NaN for invalid indices', () => {
    const buffer = new TestRingBuffer(5);
    buffer.push(1);
    
    assert.ok(Number.isNaN(buffer.get(-1)));
    assert.ok(Number.isNaN(buffer.get(5)));
    assert.ok(Number.isNaN(buffer.get(100)));
});

// Test: RingBuffer getLastN
test('RingBuffer getLastN returns correct subset', () => {
    const buffer = new TestRingBuffer(10);
    
    for (let i = 1; i <= 10; i++) {
        buffer.push(i);
    }
    
    assert.deepEqual(buffer.getLastN(3), [8, 9, 10]);
    assert.deepEqual(buffer.getLastN(5), [6, 7, 8, 9, 10]);
    
    // Request more than available
    assert.deepEqual(buffer.getLastN(20), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

// Mock tick stream types
interface TickData {
    symbol: string;
    quote: number;
    epoch: number;
}

interface TickListener {
    id: string;
    callback: (tick: TickData) => void;
}

// Mock symbol actor
class MockSymbolActor {
    private buffer: TestRingBuffer;
    private listeners: Map<string, TickListener> = new Map();
    
    constructor(private symbol: string, bufferSize: number = 100) {
        this.buffer = new TestRingBuffer(bufferSize);
    }
    
    addListener(id: string, callback: (tick: TickData) => void): void {
        this.listeners.set(id, { id, callback });
    }
    
    removeListener(id: string): boolean {
        return this.listeners.delete(id);
    }
    
    getListenerCount(): number {
        return this.listeners.size;
    }
    
    hasListener(id: string): boolean {
        return this.listeners.has(id);
    }
    
    onTick(tick: TickData): void {
        this.buffer.push(tick.quote);
        
        for (const listener of this.listeners.values()) {
            try {
                listener.callback(tick);
            } catch {
                // Ignore listener errors
            }
        }
    }
    
    getPriceHistory(count: number): number[] {
        return this.buffer.getLastN(count);
    }
}

// Test: Symbol actor listener management
test('Symbol actor manages listeners correctly', () => {
    const actor = new MockSymbolActor('R_100');
    
    const received: TickData[] = [];
    
    actor.addListener('bot-1', (tick) => received.push(tick));
    assert.equal(actor.getListenerCount(), 1);
    assert.equal(actor.hasListener('bot-1'), true);
    
    actor.addListener('bot-2', () => {});
    assert.equal(actor.getListenerCount(), 2);
    
    assert.equal(actor.removeListener('bot-1'), true);
    assert.equal(actor.getListenerCount(), 1);
    assert.equal(actor.hasListener('bot-1'), false);
    
    // Remove non-existent
    assert.equal(actor.removeListener('bot-99'), false);
});

// Test: Symbol actor broadcasts to all listeners
test('Symbol actor broadcasts ticks to all listeners', () => {
    const actor = new MockSymbolActor('R_100');
    
    const received1: number[] = [];
    const received2: number[] = [];
    
    actor.addListener('bot-1', (tick) => received1.push(tick.quote));
    actor.addListener('bot-2', (tick) => received2.push(tick.quote));
    
    actor.onTick({ symbol: 'R_100', quote: 100.5, epoch: Date.now() });
    actor.onTick({ symbol: 'R_100', quote: 100.6, epoch: Date.now() });
    
    assert.deepEqual(received1, [100.5, 100.6]);
    assert.deepEqual(received2, [100.5, 100.6]);
});

// Test: Symbol actor buffers price history
test('Symbol actor maintains price history', () => {
    const actor = new MockSymbolActor('R_100', 5);
    
    for (let i = 1; i <= 7; i++) {
        actor.onTick({ symbol: 'R_100', quote: i * 10, epoch: Date.now() });
    }
    
    // Only last 5 ticks retained
    assert.deepEqual(actor.getPriceHistory(3), [50, 60, 70]);
    assert.deepEqual(actor.getPriceHistory(10), [30, 40, 50, 60, 70]);
});

// Test: Symbol actor tolerates listener errors
test('Symbol actor continues broadcasting despite listener errors', () => {
    const actor = new MockSymbolActor('R_100');
    
    const received: number[] = [];
    
    actor.addListener('bad-listener', () => {
        throw new Error('Listener error');
    });
    actor.addListener('good-listener', (tick) => received.push(tick.quote));
    
    // Should not throw
    actor.onTick({ symbol: 'R_100', quote: 100, epoch: Date.now() });
    
    // Good listener still received the tick
    assert.deepEqual(received, [100]);
});

// Subscription throttle simulation
test('Subscription throttle limits subscription rate', () => {
    class SubscriptionThrottle {
        private tokens: number;
        private lastRefill: number;
        private readonly maxTokens: number;
        private readonly refillRate: number; // tokens per second
        
        constructor(maxTokens: number, refillRate: number) {
            this.maxTokens = maxTokens;
            this.refillRate = refillRate;
            this.tokens = maxTokens;
            this.lastRefill = Date.now();
        }
        
        private refill(): void {
            const now = Date.now();
            const elapsed = (now - this.lastRefill) / 1000;
            this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
            this.lastRefill = now;
        }
        
        tryConsume(): boolean {
            this.refill();
            if (this.tokens >= 1) {
                this.tokens -= 1;
                return true;
            }
            return false;
        }
        
        getTokens(): number {
            this.refill();
            return this.tokens;
        }
    }
    
    const throttle = new SubscriptionThrottle(5, 1);
    
    // Should allow up to max tokens
    assert.equal(throttle.tryConsume(), true);
    assert.equal(throttle.tryConsume(), true);
    assert.equal(throttle.tryConsume(), true);
    assert.equal(throttle.tryConsume(), true);
    assert.equal(throttle.tryConsume(), true);
    
    // Should be exhausted
    assert.equal(throttle.tryConsume(), false);
    
    assert.ok(throttle.getTokens() < 1);
});

// Test: Tick deduplication
test('Tick deduplication prevents duplicate processing', () => {
    const processedEpochs = new Set<number>();
    
    const processTick = (tick: TickData): boolean => {
        const key = tick.epoch;
        if (processedEpochs.has(key)) {
            return false;
        }
        processedEpochs.add(key);
        return true;
    };
    
    const tick1 = { symbol: 'R_100', quote: 100, epoch: 1000 };
    const tick2 = { symbol: 'R_100', quote: 101, epoch: 1000 }; // Same epoch
    const tick3 = { symbol: 'R_100', quote: 102, epoch: 1001 };
    
    assert.equal(processTick(tick1), true);
    assert.equal(processTick(tick2), false); // Duplicate epoch
    assert.equal(processTick(tick3), true);
});

// Test: Tick validation
test('Tick validation rejects invalid data', () => {
    const isValidTick = (tick: unknown): tick is TickData => {
        if (!tick || typeof tick !== 'object') return false;
        const t = tick as Record<string, unknown>;
        
        return typeof t.symbol === 'string' &&
               t.symbol.length > 0 &&
               typeof t.quote === 'number' &&
               Number.isFinite(t.quote) &&
               typeof t.epoch === 'number' &&
               t.epoch > 0;
    };
    
    // Valid tick
    assert.equal(isValidTick({ symbol: 'R_100', quote: 100.5, epoch: Date.now() }), true);
    
    // Invalid cases
    assert.equal(isValidTick(null), false);
    assert.equal(isValidTick({}), false);
    assert.equal(isValidTick({ symbol: '', quote: 100, epoch: Date.now() }), false);
    assert.equal(isValidTick({ symbol: 'R_100', quote: NaN, epoch: Date.now() }), false);
    assert.equal(isValidTick({ symbol: 'R_100', quote: 100, epoch: 0 }), false);
});
