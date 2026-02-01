/**
 * Strategy Engine Tests
 * Tests for technical indicators and strategy evaluation
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Mock PriceSeries interface
interface PriceSeries {
    length: number;
    get(index: number): number;
    toArray(): number[];
}

class MockPriceSeries implements PriceSeries {
    private data: number[];
    
    constructor(data: number[]) {
        this.data = data;
    }
    
    get length(): number {
        return this.data.length;
    }
    
    get(index: number): number {
        if (index < 0 || index >= this.data.length) return NaN;
        return this.data[index];
    }
    
    toArray(): number[] {
        return [...this.data];
    }
}

// RSI calculation (copied from strategyEngine for testing)
function calculateRSI(prices: PriceSeries, period: number = 14): number | null {
    if (prices.length < period + 1) return null;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const change = prices.get(prices.length - period - 1 + i) - prices.get(prices.length - period - 1 + i - 1);
        if (change > 0) {
            gains += change;
        } else {
            losses += Math.abs(change);
        }
    }

    const avgGain = gains / period;
    const avgLoss = losses / period;

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// SMA calculation
function calculateSMA(prices: PriceSeries, period: number): number | null {
    if (prices.length < period) return null;

    let sum = 0;
    for (let i = prices.length - period; i < prices.length; i++) {
        sum += prices.get(i);
    }
    return sum / period;
}

// EMA calculation
function calculateEMA(prices: PriceSeries, period: number): number | null {
    if (prices.length < period) return null;

    const multiplier = 2 / (period + 1);

    let ema = 0;
    for (let i = 0; i < period; i++) {
        ema += prices.get(i);
    }
    ema /= period;

    for (let i = period; i < prices.length; i++) {
        ema = (prices.get(i) - ema) * multiplier + ema;
    }

    return ema;
}

// ATR calculation
function calculateATR(prices: PriceSeries, period: number): number | null {
    if (prices.length < period + 1) return null;

    let atr = 0;
    const startIdx = prices.length - period;

    for (let i = startIdx; i < prices.length; i++) {
        const tr = Math.abs(prices.get(i) - prices.get(i - 1));
        atr += tr;
    }

    return atr / period;
}

// Test: RSI calculation accuracy
test('RSI calculation returns correct values', () => {
    // Create price series with known RSI
    // 15 prices with first 7 increasing (gains) then 7 decreasing (losses)
    const prices = new MockPriceSeries([
        100, 101, 102, 103, 104, 105, 106, 107,  // 7 gains of 1
        106, 105, 104, 103, 102, 101, 100        // 7 losses of 1
    ]);
    
    const rsi = calculateRSI(prices, 14);
    assert.notEqual(rsi, null);
    
    // With equal gains and losses, RSI should be close to 50
    assert.ok(rsi! >= 45 && rsi! <= 55, `RSI ${rsi} should be near 50`);
});

// Test: RSI returns null for insufficient data
test('RSI returns null for insufficient data', () => {
    const prices = new MockPriceSeries([100, 101, 102]);
    const rsi = calculateRSI(prices, 14);
    assert.equal(rsi, null);
});

// Test: RSI returns 100 when no losses
test('RSI returns 100 when all gains', () => {
    const prices = new MockPriceSeries([
        100, 101, 102, 103, 104, 105, 106, 107, 
        108, 109, 110, 111, 112, 113, 114, 115
    ]);
    const rsi = calculateRSI(prices, 14);
    assert.equal(rsi, 100);
});

// Test: SMA calculation accuracy
test('SMA calculation returns correct values', () => {
    const prices = new MockPriceSeries([10, 20, 30, 40, 50]);
    
    // SMA of 5 = (10+20+30+40+50) / 5 = 30
    assert.equal(calculateSMA(prices, 5), 30);
    
    // SMA of 3 (last 3) = (30+40+50) / 3 = 40
    assert.equal(calculateSMA(prices, 3), 40);
});

// Test: SMA returns null for insufficient data
test('SMA returns null for insufficient data', () => {
    const prices = new MockPriceSeries([10, 20]);
    assert.equal(calculateSMA(prices, 5), null);
});

// Test: EMA calculation
test('EMA calculation returns reasonable values', () => {
    const prices = new MockPriceSeries([
        100, 102, 104, 106, 108, 110, 112, 114, 116, 118
    ]);
    
    const ema = calculateEMA(prices, 5);
    assert.notEqual(ema, null);
    
    // EMA should be between min and max prices
    assert.ok(ema! >= 100 && ema! <= 118, `EMA ${ema} out of range`);
    
    // EMA should be closer to recent prices (uptrend)
    assert.ok(ema! > 110, `EMA ${ema} should be weighted toward recent prices`);
});

// Test: ATR calculation accuracy
test('ATR calculation returns correct values', () => {
    // Prices with consistent 1-point moves
    const prices = new MockPriceSeries([100, 101, 100, 101, 100, 101, 100, 101, 100, 101]);
    
    const atr = calculateATR(prices, 5);
    assert.notEqual(atr, null);
    
    // ATR should be 1 (average of |1| moves)
    assert.ok(Math.abs(atr! - 1) < 0.01, `ATR ${atr} should be ~1`);
});

// Test: ATR with varying volatility
test('ATR increases with higher volatility', () => {
    const lowVolPrices = new MockPriceSeries([100, 100.5, 100, 100.5, 100, 100.5]);
    const highVolPrices = new MockPriceSeries([100, 105, 100, 105, 100, 105]);
    
    const lowATR = calculateATR(lowVolPrices, 5);
    const highATR = calculateATR(highVolPrices, 5);
    
    assert.ok(highATR! > lowATR!, 'High vol ATR should exceed low vol ATR');
});

// Test: RSI strategy signal generation
test('RSI strategy generates correct signals', () => {
    type TradeSignal = 'CALL' | 'PUT' | null;
    
    const evaluateRsiStrategy = (
        rsi: number | null, 
        lower: number, 
        upper: number
    ): TradeSignal => {
        if (rsi === null) return null;
        if (rsi < lower) return 'CALL';  // Oversold
        if (rsi > upper) return 'PUT';   // Overbought
        return null;
    };
    
    // Oversold
    assert.equal(evaluateRsiStrategy(25, 30, 70), 'CALL');
    
    // Overbought
    assert.equal(evaluateRsiStrategy(75, 30, 70), 'PUT');
    
    // Neutral
    assert.equal(evaluateRsiStrategy(50, 30, 70), null);
    
    // Edge cases
    assert.equal(evaluateRsiStrategy(30, 30, 70), null);  // At lower bound
    assert.equal(evaluateRsiStrategy(70, 30, 70), null);  // At upper bound
    assert.equal(evaluateRsiStrategy(null, 30, 70), null); // No data
});

// Test: EMA crossover signal
test('EMA crossover generates correct signals', () => {
    type TradeSignal = 'CALL' | 'PUT' | null;
    
    const evaluateCrossover = (
        emaFast: number | null,
        emaSlow: number | null,
        price: number
    ): TradeSignal => {
        if (emaFast === null || emaSlow === null) return null;
        
        const bullish = emaFast > emaSlow && price > emaFast;
        const bearish = emaFast < emaSlow && price < emaFast;
        
        if (bullish) return 'CALL';
        if (bearish) return 'PUT';
        return null;
    };
    
    // Bullish crossover
    assert.equal(evaluateCrossover(105, 100, 110), 'CALL');
    
    // Bearish crossover
    assert.equal(evaluateCrossover(95, 100, 90), 'PUT');
    
    // No clear signal
    assert.equal(evaluateCrossover(100, 100, 100), null);
    assert.equal(evaluateCrossover(105, 100, 103), null); // Price below fast EMA
});

// Test: Breakout detection
test('Breakout detection identifies price breaks', () => {
    const detectBreakout = (
        price: number,
        high: number,
        low: number,
        buffer: number
    ): 'UP' | 'DOWN' | null => {
        if (price > high + buffer) return 'UP';
        if (price < low - buffer) return 'DOWN';
        return null;
    };
    
    const HIGH = 110;
    const LOW = 100;
    const BUFFER = 0.5;
    
    // Upside breakout
    assert.equal(detectBreakout(111, HIGH, LOW, BUFFER), 'UP');
    
    // Downside breakout
    assert.equal(detectBreakout(99, HIGH, LOW, BUFFER), 'DOWN');
    
    // No breakout (within range)
    assert.equal(detectBreakout(105, HIGH, LOW, BUFFER), null);
    
    // At boundary (no breakout)
    assert.equal(detectBreakout(110.5, HIGH, LOW, BUFFER), null);
});

// Test: Required ticks calculation
test('Strategy requires sufficient tick history', () => {
    const getRequiredTicks = (strategyId: string, config: { period?: number }): number => {
        const period = config.period ?? 14;
        
        switch (strategyId) {
            case 'rsi':
                return period + 2;
            case 'trend-rider':
                return Math.max(21, period) + 2;
            case 'breakout-atr':
                return 35;
            default:
                return 20;
        }
    };
    
    assert.equal(getRequiredTicks('rsi', { period: 14 }), 16);
    assert.equal(getRequiredTicks('rsi', { period: 7 }), 9);
    assert.equal(getRequiredTicks('trend-rider', {}), 23);
    assert.equal(getRequiredTicks('breakout-atr', {}), 35);
    assert.equal(getRequiredTicks('unknown', {}), 20);
});

// Test: Confidence score normalization
test('Confidence score is properly normalized', () => {
    const normalizeConfidence = (raw: number, threshold: number): number => {
        const conf = Math.abs(raw) / Math.max(threshold, 0.0001);
        return Math.max(0, Math.min(1, conf));
    };
    
    // Normal case
    assert.ok(Math.abs(normalizeConfidence(0.5, 1) - 0.5) < 0.001);
    
    // Exceeds threshold - capped at 1
    assert.equal(normalizeConfidence(2, 1), 1);
    
    // Zero - minimum 0
    assert.equal(normalizeConfidence(0, 1), 0);
    
    // Negative value - uses absolute
    assert.ok(Math.abs(normalizeConfidence(-0.5, 1) - 0.5) < 0.001);
    
    // Zero threshold protection
    assert.equal(normalizeConfidence(1, 0), 1);
});
