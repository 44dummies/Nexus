/**
 * Backtesting Engine
 * Simulates strategy execution against historical tick data from Deriv API.
 * - Fetches ticks via `ticks_history`
 * - Runs through strategy engine with confidence gate
 * - Applies slippage + commission models
 * - Computes full performance metrics
 */

import { sendMessage } from './wsManager';
import { logger } from './logger';
import { metrics } from './metrics';

// ==================== TYPES ====================

export interface BacktestConfig {
    symbol: string;
    /** Start epoch seconds */
    startTs: number;
    /** End epoch seconds */
    endTs: number;
    /** Base stake per trade */
    stake: number;
    /** Duration in ticks for each trade */
    tradeDurationTicks: number;
    /** Confidence threshold — only take signals >= this */
    confidenceThreshold: number;
    /** Slippage model: fraction of price (e.g. 0.0001 = 0.01%) */
    slippageFraction: number;
    /** Commission per trade (flat fee) */
    commissionFlat: number;
    /** Which strategy to test (matches strategy engine names) */
    strategy?: string;
}

export interface BacktestTrade {
    entryIndex: number;
    exitIndex: number;
    entryPrice: number;
    exitPrice: number;
    direction: 'CALL' | 'PUT';
    stake: number;
    payout: number;
    profit: number;
    confidence: number;
    strategy: string;
    entryTime: number;
    exitTime: number;
}

export interface BacktestMetrics {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalProfit: number;
    avgProfit: number;
    profitFactor: number;
    expectancy: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    sharpeRatio: number | null;
    sortinoRatio: number | null;
    bestTrade: number;
    worstTrade: number;
}

export interface BacktestResult {
    config: BacktestConfig;
    trades: BacktestTrade[];
    metrics: BacktestMetrics;
    equityCurve: { index: number; equity: number; timestamp: number }[];
    tickCount: number;
    durationMs: number;
}

interface TickData {
    epoch: number;
    quote: number;
}

// ==================== CONFIG ====================

const MAX_TICKS_PER_REQUEST = 5000;
const PAYOUT_RATE = 0.85; // Typical binary options payout
const backtestLog = logger.child({ module: 'backtest' });

// ==================== CORE API ====================

/**
 * Run a full backtest simulation
 */
export async function runBacktest(
    accountId: string,
    config: BacktestConfig,
): Promise<BacktestResult> {
    const start = Date.now();
    backtestLog.info({ symbol: config.symbol, startTs: config.startTs, endTs: config.endTs }, 'Starting backtest');

    // 1. Fetch historical ticks
    const ticks = await fetchHistoricalTicks(accountId, config.symbol, config.startTs, config.endTs);
    if (ticks.length < 50) {
        throw new Error(`Insufficient tick data: ${ticks.length} ticks (minimum 50 required)`);
    }

    // 2. Build price series and simulate
    const trades = simulateTrades(ticks, config);

    // 3. Compute metrics
    const tradeMetrics = computeBacktestMetrics(trades);

    // 4. Build equity curve
    const equityCurve = buildBacktestEquityCurve(trades, ticks);

    const durationMs = Date.now() - start;
    metrics.counter('backtest.runs');
    metrics.histogram('backtest.duration_ms', durationMs);

    backtestLog.info({
        symbol: config.symbol,
        ticks: ticks.length,
        trades: trades.length,
        totalProfit: tradeMetrics.totalProfit,
        winRate: tradeMetrics.winRate,
        durationMs,
    }, 'Backtest complete');

    return {
        config,
        trades,
        metrics: tradeMetrics,
        equityCurve,
        tickCount: ticks.length,
        durationMs,
    };
}

// ==================== INTERNAL ====================

/**
 * Fetch historical ticks from Deriv API via ticks_history
 */
async function fetchHistoricalTicks(
    accountId: string,
    symbol: string,
    startTs: number,
    endTs: number,
): Promise<TickData[]> {
    const allTicks: TickData[] = [];
    let currentStart = startTs;

    while (currentStart < endTs) {
        try {
            const response = await sendMessage<{
                history: { prices: number[]; times: number[] };
                error?: { message: string };
            }>(accountId, {
                ticks_history: symbol,
                start: currentStart,
                end: Math.min(currentStart + 86400, endTs), // Max 1 day per request
                style: 'ticks',
                count: MAX_TICKS_PER_REQUEST,
            }, 30000);

            if (response.error) {
                backtestLog.error({ error: response.error, symbol }, 'Deriv ticks_history error');
                break;
            }

            if (response.history?.prices && response.history?.times) {
                const { prices, times } = response.history;
                for (let i = 0; i < prices.length; i++) {
                    allTicks.push({ epoch: times[i], quote: prices[i] });
                }

                if (times.length > 0) {
                    currentStart = times[times.length - 1] + 1;
                } else {
                    currentStart += 86400;
                }
            } else {
                currentStart += 86400;
            }
        } catch (error) {
            backtestLog.error({ error, symbol, currentStart }, 'Failed to fetch ticks');
            break;
        }
    }

    return allTicks;
}

/**
 * Simulate trades through price series
 */
function simulateTrades(ticks: TickData[], config: BacktestConfig): BacktestTrade[] {
    const trades: BacktestTrade[] = [];
    const lookback = 50; // Minimum ticks for indicator calculation

    // Simple indicators from price series
    let i = lookback;
    let openTradeExitIndex = -1; // Block overlapping trades

    while (i < ticks.length - config.tradeDurationTicks) {
        if (i <= openTradeExitIndex) {
            i++;
            continue;
        }

        // Compute simple indicators at current tick
        const window = ticks.slice(i - lookback, i + 1);
        const signal = generateSimpleSignal(window, config);

        if (signal && signal.confidence >= config.confidenceThreshold) {
            const entryPrice = ticks[i].quote;
            const exitIndex = Math.min(i + config.tradeDurationTicks, ticks.length - 1);
            const exitPrice = ticks[exitIndex].quote;

            // Apply slippage
            const slippage = entryPrice * config.slippageFraction * (Math.random() * 2 - 1);
            const adjustedEntry = entryPrice + slippage;

            // Determine outcome
            let won: boolean;
            if (signal.direction === 'CALL') {
                won = exitPrice > adjustedEntry;
            } else {
                won = exitPrice < adjustedEntry;
            }

            const payout = won ? config.stake * PAYOUT_RATE : 0;
            const profit = payout - config.stake - config.commissionFlat;

            trades.push({
                entryIndex: i,
                exitIndex,
                entryPrice: adjustedEntry,
                exitPrice,
                direction: signal.direction,
                stake: config.stake,
                payout: won ? config.stake + payout : 0,
                profit: round(profit),
                confidence: signal.confidence,
                strategy: signal.strategy,
                entryTime: ticks[i].epoch,
                exitTime: ticks[exitIndex].epoch,
            });

            openTradeExitIndex = exitIndex;
            i = exitIndex + 1;
        } else {
            i++;
        }
    }

    return trades;
}

/**
 * Simple signal generator for backtesting
 * Uses RSI + SMA crossover patterns
 */
function generateSimpleSignal(
    window: TickData[],
    config: BacktestConfig,
): { direction: 'CALL' | 'PUT'; confidence: number; strategy: string } | null {
    const prices = window.map(t => t.quote);
    const n = prices.length;

    // Compute RSI(14)
    const rsiPeriod = 14;
    if (n < rsiPeriod + 1) return null;

    let gainSum = 0;
    let lossSum = 0;
    for (let j = n - rsiPeriod; j < n; j++) {
        const diff = prices[j] - prices[j - 1];
        if (diff > 0) gainSum += diff;
        else lossSum += Math.abs(diff);
    }
    const avgGain = gainSum / rsiPeriod;
    const avgLoss = lossSum / rsiPeriod;
    const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
    const rsi = 100 - (100 / (1 + rs));

    // Compute SMA(20) and SMA(50) from available data
    const sma20 = n >= 20 ? prices.slice(n - 20).reduce((s, p) => s + p, 0) / 20 : null;
    const sma50 = n >= 50 ? prices.slice(n - 50).reduce((s, p) => s + p, 0) / 50 : null;

    const currentPrice = prices[n - 1];

    // Signal logic
    let direction: 'CALL' | 'PUT' | null = null;
    let confidence = 0;

    // Oversold + price above SMA → CALL
    if (rsi < 30 && sma20 !== null && currentPrice > sma20) {
        direction = 'CALL';
        const rsiScore = (30 - rsi) / 30;
        const trendScore = sma50 !== null && sma20 > sma50 ? 0.3 : 0;
        confidence = Math.min(0.95, 0.5 + rsiScore * 0.3 + trendScore);
    }
    // Overbought + price below SMA → PUT
    else if (rsi > 70 && sma20 !== null && currentPrice < sma20) {
        direction = 'PUT';
        const rsiScore = (rsi - 70) / 30;
        const trendScore = sma50 !== null && sma20 < sma50 ? 0.3 : 0;
        confidence = Math.min(0.95, 0.5 + rsiScore * 0.3 + trendScore);
    }
    // SMA crossover
    else if (sma20 !== null && sma50 !== null) {
        // Recent crossover detection
        const prevPrice = prices[n - 2];
        if (prevPrice < sma20 && currentPrice > sma20 && sma20 > sma50) {
            direction = 'CALL';
            confidence = 0.55 + Math.min(0.2, (sma20 - sma50) / sma50 * 10);
        } else if (prevPrice > sma20 && currentPrice < sma20 && sma20 < sma50) {
            direction = 'PUT';
            confidence = 0.55 + Math.min(0.2, (sma50 - sma20) / sma50 * 10);
        }
    }

    if (direction === null) return null;

    // Apply strategy filter
    const strategy = config.strategy || 'backtest_composite';

    return { direction, confidence: round(confidence), strategy };
}

function computeBacktestMetrics(trades: BacktestTrade[]): BacktestMetrics {
    if (trades.length === 0) {
        return {
            totalTrades: 0, wins: 0, losses: 0, winRate: 0,
            totalProfit: 0, avgProfit: 0, profitFactor: 0, expectancy: 0,
            maxDrawdown: 0, maxDrawdownPct: 0,
            sharpeRatio: null, sortinoRatio: null,
            bestTrade: 0, worstTrade: 0,
        };
    }

    const profits = trades.map(t => t.profit);
    const wins = profits.filter(p => p > 0);
    const losses = profits.filter(p => p <= 0);
    const totalProfit = profits.reduce((s, p) => s + p, 0);
    const grossProfit = wins.reduce((s, p) => s + p, 0);
    const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));

    const winRate = (wins.length / profits.length) * 100;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const wr = wins.length / profits.length;
    const expectancy = (wr * avgWin) - ((1 - wr) * avgLoss);
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

    // Max drawdown
    let peak = 0;
    let cumPnL = 0;
    let maxDD = 0;
    let maxDDPct = 0;
    for (const p of profits) {
        cumPnL += p;
        if (cumPnL > peak) peak = cumPnL;
        const dd = peak - cumPnL;
        if (dd > maxDD) {
            maxDD = dd;
            maxDDPct = peak > 0 ? dd / peak : 0;
        }
    }

    // Sharpe ratio
    const meanReturn = totalProfit / profits.length;
    const variance = profits.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / profits.length;
    const stdReturn = Math.sqrt(variance);
    const rfPerTrade = 0.02 / 252;
    const sharpeRatio = stdReturn > 0 ? (meanReturn - rfPerTrade) / stdReturn : null;

    // Sortino
    const downside = profits.filter(p => p < rfPerTrade);
    const dsVar = downside.length > 0
        ? downside.reduce((s, r) => s + (r - rfPerTrade) ** 2, 0) / downside.length
        : 0;
    const dsDev = Math.sqrt(dsVar);
    const sortinoRatio = dsDev > 0 ? (meanReturn - rfPerTrade) / dsDev : null;

    return {
        totalTrades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: round(winRate),
        totalProfit: round(totalProfit),
        avgProfit: round(totalProfit / trades.length),
        profitFactor: round(profitFactor),
        expectancy: round(expectancy),
        maxDrawdown: round(maxDD),
        maxDrawdownPct: round(maxDDPct * 100),
        sharpeRatio: sharpeRatio !== null ? round(sharpeRatio) : null,
        sortinoRatio: sortinoRatio !== null ? round(sortinoRatio) : null,
        bestTrade: round(Math.max(...profits)),
        worstTrade: round(Math.min(...profits)),
    };
}

function buildBacktestEquityCurve(
    trades: BacktestTrade[],
    ticks: TickData[],
): { index: number; equity: number; timestamp: number }[] {
    let equity = 0;
    return trades.map((t, i) => {
        equity += t.profit;
        return {
            index: i + 1,
            equity: round(equity),
            timestamp: t.exitTime,
        };
    });
}

function round(n: number): number {
    return Math.round(n * 100) / 100;
}

// ==================== EXPORTS FOR TESTING ====================

export const __test = {
    generateSimpleSignal,
    computeBacktestMetrics,
    simulateTrades,
    buildBacktestEquityCurve,
};
