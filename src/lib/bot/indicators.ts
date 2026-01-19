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
