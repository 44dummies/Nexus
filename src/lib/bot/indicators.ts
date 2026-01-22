export function calculateRSI(prices: number[], period: number): number | null {
    if (period <= 0) return null;
    if (prices.length < period + 1) return null;

    let gains = 0;
    let losses = 0;

    const startIndex = prices.length - period;

    for (let i = startIndex; i < prices.length; i += 1) {
        const change = prices[i] - prices[i - 1];
        if (change >= 0) {
            gains += change;
        } else {
            losses += Math.abs(change);
        }
    }

    const averageGain = gains / period;
    const averageLoss = losses / period;

    if (averageLoss === 0) return 100;
    if (averageGain === 0) return 0;

    const relativeStrength = averageGain / averageLoss;
    return 100 - (100 / (1 + relativeStrength));
}

export function calculateSMA(values: number[], period: number): number | null {
    if (period <= 0) return null;
    if (values.length < period) return null;

    const startIndex = values.length - period;
    let sum = 0;
    for (let i = startIndex; i < values.length; i += 1) {
        sum += values[i];
    }
    return sum / period;
}

export function calculateEMA(values: number[], period: number): number | null {
    if (period <= 0) return null;
    if (values.length < period) return null;

    const k = 2 / (period + 1);
    let ema = values[values.length - period];
    for (let i = values.length - period + 1; i < values.length; i += 1) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

export function calculateATR(values: number[], period: number): number | null {
    if (period <= 0) return null;
    if (values.length < period + 1) return null;

    let sum = 0;
    const startIndex = values.length - period;
    for (let i = startIndex; i < values.length; i += 1) {
        sum += Math.abs(values[i] - values[i - 1]);
    }
    return sum / period;
}
