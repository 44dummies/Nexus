import { calculateATR, calculateEMA, calculateRSI, calculateSMA } from '@/lib/bot/indicators';
import type { BotConfig } from '@/lib/bot/config';
import type { TradeSignal } from '@/lib/bot/types';

export interface StrategyContext {
    prices: number[];
    lastPrice: number;
    prevPrice: number | null;
    lossStreak: number;
    lastTradeProfit: number | null;
}

export interface StrategyEvaluation {
    signal: TradeSignal | null;
    detail?: string;
    stakeMultiplier?: number;
    minEdgePct?: number;
}

export interface BotStrategy {
    id: string;
    name: string;
    minTicks: number;
    getRequiredTicks?: (config: BotConfig) => number;
    evaluate: (context: StrategyContext, config: BotConfig) => StrategyEvaluation;
}

const getLookbackSlice = (values: number[], lookback: number, excludeLast = true) => {
    const end = excludeLast ? values.length - 1 : values.length;
    if (end <= 0) return [];
    const start = Math.max(0, end - lookback);
    return values.slice(start, end);
};

const getRecentHigh = (values: number[], lookback: number) => {
    const slice = getLookbackSlice(values, lookback, true);
    if (slice.length === 0) return null;
    return Math.max(...slice);
};

const getRecentLow = (values: number[], lookback: number) => {
    const slice = getLookbackSlice(values, lookback, true);
    if (slice.length === 0) return null;
    return Math.min(...slice);
};

const rsiStrategy: BotStrategy = {
    id: 'rsi',
    name: 'Mean Reversion RSI',
    minTicks: 20,
    getRequiredTicks: (config) => Math.max(5, (config.rsiPeriod ?? 14) + 1),
    evaluate: ({ prices }, config) => {
        const period = config.rsiPeriod ?? 14;
        const lower = config.rsiLower ?? 30;
        const upper = config.rsiUpper ?? 70;
        const rsi = calculateRSI(prices, period);
        if (rsi === null) return { signal: null };
        if (rsi < lower) return { signal: 'CALL', detail: `RSI ${rsi.toFixed(1)}`, minEdgePct: 0.12 };
        if (rsi > upper) return { signal: 'PUT', detail: `RSI ${rsi.toFixed(1)}`, minEdgePct: 0.12 };
        return { signal: null };
    },
};

const trendRiderStrategy: BotStrategy = {
    id: 'trend-rider',
    name: 'Trend Rider',
    minTicks: 40,
    getRequiredTicks: (config) => {
        const emaSlow = config.emaSlow ?? 30;
        const rsiPeriod = config.rsiPeriod ?? 14;
        return Math.max(emaSlow + 2, rsiPeriod + 2, 20);
    },
    evaluate: ({ prices, lastPrice }, config) => {
        const emaFastPeriod = config.emaFast ?? 10;
        const emaSlowPeriod = config.emaSlow ?? 30;
        const rsiPeriod = config.rsiPeriod ?? 14;
        const strengthMultiplier = config.trendStrengthMultiplier ?? 0.6;
        const rsiLower = config.trendRsiLower ?? 45;
        const rsiUpper = config.trendRsiUpper ?? 55;
        const emaFast = calculateEMA(prices, emaFastPeriod);
        const emaSlow = calculateEMA(prices, emaSlowPeriod);
        const atr = calculateATR(prices, Math.max(emaSlowPeriod, 14));
        const rsi = calculateRSI(prices, rsiPeriod);
        if (emaFast === null || emaSlow === null || rsi === null || atr === null) return { signal: null };

        const trendStrength = Math.abs(emaFast - emaSlow);
        if (trendStrength < atr * strengthMultiplier) return { signal: null };

        const trendUp = emaFast > emaSlow && lastPrice > emaFast && rsi > rsiUpper;
        const trendDown = emaFast < emaSlow && lastPrice < emaFast && rsi < rsiLower;

        if (trendUp) {
            return { signal: 'CALL', detail: `EMA ${emaFast.toFixed(2)} > ${emaSlow.toFixed(2)} | RSI ${rsi.toFixed(1)}`, minEdgePct: 0.12 };
        }
        if (trendDown) {
            return { signal: 'PUT', detail: `EMA ${emaFast.toFixed(2)} < ${emaSlow.toFixed(2)} | RSI ${rsi.toFixed(1)}`, minEdgePct: 0.12 };
        }

        return { signal: null };
    },
};

const breakoutAtrStrategy: BotStrategy = {
    id: 'breakout-atr',
    name: 'Breakout ATR',
    minTicks: 60,
    getRequiredTicks: (config) => {
        const atrSlow = config.atrSlow ?? 42;
        const lookback = config.breakoutLookback ?? 20;
        return Math.max(atrSlow + 2, lookback + 2, 30);
    },
    evaluate: ({ prices, lastPrice }, config) => {
        const atrFastPeriod = config.atrFast ?? 14;
        const atrSlowPeriod = config.atrSlow ?? 42;
        const lookback = config.breakoutLookback ?? 20;
        const bufferMultiplier = config.breakoutBufferMultiplier ?? 0.2;
        const expansionMultiplier = config.breakoutExpansionMultiplier ?? 1.1;
        const atrFast = calculateATR(prices, atrFastPeriod);
        const atrSlow = calculateATR(prices, atrSlowPeriod);
        if (atrFast === null || atrSlow === null) return { signal: null };

        const expanding = atrFast > atrSlow * expansionMultiplier;
        if (!expanding) return { signal: null };

        const high = getRecentHigh(prices, lookback);
        const low = getRecentLow(prices, lookback);
        if (high === null || low === null) return { signal: null };

        const buffer = atrFast * bufferMultiplier;
        if (lastPrice > high + buffer) {
            return { signal: 'CALL', detail: `Breakout +${buffer.toFixed(2)} | ATR ${atrFast.toFixed(3)}`, minEdgePct: 0.2 };
        }
        if (lastPrice < low - buffer) {
            return { signal: 'PUT', detail: `Breakout -${buffer.toFixed(2)} | ATR ${atrFast.toFixed(3)}`, minEdgePct: 0.2 };
        }

        return { signal: null };
    },
};

const capitalGuardStrategy: BotStrategy = {
    id: 'capital-guard',
    name: 'Capital Guard',
    minTicks: 60,
    getRequiredTicks: (config) => {
        const atrSlow = config.atrSlow ?? 50;
        const smaPeriod = config.smaPeriod ?? 20;
        const rsiPeriod = config.rsiPeriod ?? 14;
        return Math.max(atrSlow + 2, smaPeriod + 2, rsiPeriod + 2, 30);
    },
    evaluate: ({ prices, lastPrice }, config) => {
        const atrFastPeriod = config.atrFast ?? 14;
        const atrSlowPeriod = config.atrSlow ?? 50;
        const rsiPeriod = config.rsiPeriod ?? 14;
        const smaPeriod = config.smaPeriod ?? 20;
        const rsiLower = config.capitalRsiLower ?? 25;
        const rsiUpper = config.capitalRsiUpper ?? 75;
        const calmMultiplier = config.capitalCalmMultiplier ?? 0.9;
        const meanDistanceMultiplier = config.capitalMeanDistanceMultiplier ?? 1.2;
        const atrFast = calculateATR(prices, atrFastPeriod);
        const atrSlow = calculateATR(prices, atrSlowPeriod);
        const rsi = calculateRSI(prices, rsiPeriod);
        const sma = calculateSMA(prices, smaPeriod);
        if (atrFast === null || atrSlow === null || rsi === null || sma === null) return { signal: null };

        const calmMarket = atrFast < atrSlow * calmMultiplier;
        if (!calmMarket) return { signal: null };

        const distanceFromMean = Math.abs(lastPrice - sma);
        if (distanceFromMean > atrFast * meanDistanceMultiplier) return { signal: null };

        if (rsi < rsiLower) return { signal: 'CALL', detail: `RSI ${rsi.toFixed(1)} | calm`, minEdgePct: 0.2 };
        if (rsi > rsiUpper) return { signal: 'PUT', detail: `RSI ${rsi.toFixed(1)} | calm`, minEdgePct: 0.2 };

        return { signal: null };
    },
};

const recoveryLiteStrategy: BotStrategy = {
    id: 'recovery-lite',
    name: 'Recovery Lite',
    minTicks: 25,
    getRequiredTicks: (config) => Math.max(5, (config.rsiPeriod ?? 14) + 1),
    evaluate: ({ prices, lossStreak }, config) => {
        const rsiPeriod = config.rsiPeriod ?? 14;
        const lower = config.recoveryRsiLower ?? 30;
        const upper = config.recoveryRsiUpper ?? 70;
        const maxLossStreak = config.recoveryMaxLossStreak ?? 3;
        const stepMultiplier = config.recoveryStepMultiplier ?? 0.2;
        const maxSteps = config.recoveryMaxSteps ?? 2;
        const rsi = calculateRSI(prices, rsiPeriod);
        if (rsi === null) return { signal: null };
        if (lossStreak >= maxLossStreak) return { signal: null };

        let signal: TradeSignal | null = null;
        if (rsi < lower) signal = 'CALL';
        if (rsi > upper) signal = 'PUT';
        if (!signal) return { signal: null };

        const reduction = lossStreak > 0 ? Math.min(lossStreak, maxSteps) * stepMultiplier : 0;
        const multiplier = Math.max(0.5, 1 - reduction);
        return {
            signal,
            detail: `RSI ${rsi.toFixed(1)} | streak ${lossStreak}`,
            stakeMultiplier: multiplier < 1 ? multiplier : undefined,
            minEdgePct: 0.25,
        };
    },
};

export const BOT_STRATEGIES: Record<string, BotStrategy> = {
    [rsiStrategy.id]: rsiStrategy,
    [trendRiderStrategy.id]: trendRiderStrategy,
    [breakoutAtrStrategy.id]: breakoutAtrStrategy,
    [capitalGuardStrategy.id]: capitalGuardStrategy,
    [recoveryLiteStrategy.id]: recoveryLiteStrategy,
};

export const getStrategy = (botId: string | null | undefined) => {
    if (botId && BOT_STRATEGIES[botId]) return BOT_STRATEGIES[botId];
    return rsiStrategy;
};
