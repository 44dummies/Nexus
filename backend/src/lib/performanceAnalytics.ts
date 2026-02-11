/**
 * Performance Analytics
 * Aggregates trade data from Supabase for win rate, expectancy,
 * profit factor, equity curve, and per-strategy breakdown.
 */

import { withSupabaseRetry, classifySupabaseError } from './supabaseAdmin';
import { logger } from './logger';
import { metrics } from './metrics';

// ==================== TYPES ====================

export interface TradeAnalytics {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    avgWin: number;
    avgLoss: number;
    expectancy: number;
    profitFactor: number;
    totalProfit: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    sharpeRatio: number | null;
    sortinoRatio: number | null;
    avgHoldTimeMs: number | null;
    bestTrade: number;
    worstTrade: number;
}

export interface EquityPoint {
    timestamp: string;
    cumulativePnL: number;
    tradeIndex: number;
}

export interface StrategyBreakdown {
    strategy: string;
    trades: number;
    winRate: number;
    totalProfit: number;
    avgProfit: number;
    expectancy: number;
}

export interface SymbolBreakdown {
    symbol: string;
    trades: number;
    winRate: number;
    totalProfit: number;
}

// ==================== CONFIG ====================

const RISK_FREE_RATE_ANNUAL = 0.02;
const analyticsLog = logger.child({ module: 'analytics' });

// ==================== CORE API ====================

/**
 * Get full trade analytics for an account
 */
export async function getTradeAnalytics(
    accountId: string,
    filters?: {
        startDate?: string;
        endDate?: string;
        symbol?: string;
        strategy?: string;
    },
): Promise<TradeAnalytics> {
    const trades = await fetchTrades(accountId, filters);
    return computeAnalytics(trades);
}

/**
 * Get equity curve for an account
 */
export async function getEquityCurve(
    accountId: string,
    filters?: { startDate?: string; endDate?: string },
): Promise<EquityPoint[]> {
    const trades = await fetchTrades(accountId, filters);
    return buildEquityCurve(trades);
}

/**
 * Get per-strategy performance breakdown
 */
export async function getStrategyBreakdown(
    accountId: string,
    filters?: { startDate?: string; endDate?: string },
): Promise<StrategyBreakdown[]> {
    const trades = await fetchTrades(accountId, filters);
    return computeStrategyBreakdown(trades);
}

/**
 * Get per-symbol performance breakdown
 */
export async function getSymbolBreakdown(
    accountId: string,
    filters?: { startDate?: string; endDate?: string },
): Promise<SymbolBreakdown[]> {
    const trades = await fetchTrades(accountId, filters);
    return computeSymbolBreakdown(trades);
}

// ==================== INTERNAL ====================

interface TradeRow {
    profit: number;
    created_at: string;
    symbol: string | null;
    entry_profile_id: string | null;
    stake: number | null;
    duration: number | null;
    duration_unit: string | null;
}

async function fetchTrades(
    accountId: string,
    filters?: {
        startDate?: string;
        endDate?: string;
        symbol?: string;
        strategy?: string;
    },
): Promise<TradeRow[]> {
    try {
        const { data, error } = await withSupabaseRetry('trades.analytics', async (client) => {
            let query = client
                .from('trades')
                .select('profit, created_at, symbol, entry_profile_id, stake, duration, duration_unit')
                .eq('account_id', accountId)
                .eq('status', 'settled')
                .order('created_at', { ascending: true });

            if (filters?.startDate) query = query.gte('created_at', filters.startDate);
            if (filters?.endDate) query = query.lte('created_at', filters.endDate);
            if (filters?.symbol) query = query.eq('symbol', filters.symbol);
            if (filters?.strategy) query = query.eq('entry_profile_id', filters.strategy);

            return await query;
        });

        if (error) throw error;
        metrics.counter('analytics.query_ok');
        return (data as TradeRow[]) ?? [];
    } catch (error) {
        const info = classifySupabaseError(error);
        analyticsLog.error({ error: info.message }, 'Failed to fetch trades for analytics');
        metrics.counter('analytics.query_error');
        return [];
    }
}

function computeAnalytics(trades: TradeRow[]): TradeAnalytics {
    if (trades.length === 0) {
        return {
            totalTrades: 0, wins: 0, losses: 0, winRate: 0,
            avgWin: 0, avgLoss: 0, expectancy: 0, profitFactor: 0,
            totalProfit: 0, maxDrawdown: 0, maxDrawdownPct: 0,
            sharpeRatio: null, sortinoRatio: null, avgHoldTimeMs: null,
            bestTrade: 0, worstTrade: 0,
        };
    }

    const profits = trades.map(t => t.profit);
    const wins = profits.filter(p => p > 0);
    const losses = profits.filter(p => p < 0);
    const totalProfit = profits.reduce((s, p) => s + p, 0);
    const grossProfit = wins.reduce((s, p) => s + p, 0);
    const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));

    const winRate = wins.length / profits.length;
    const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
    const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);
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

    // Sharpe ratio (daily returns approximation)
    const returns = profits;
    const meanReturn = totalProfit / returns.length;
    const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length;
    const stdReturn = Math.sqrt(variance);
    const rfPerTrade = RISK_FREE_RATE_ANNUAL / 252;
    const sharpeRatio = stdReturn > 0 ? (meanReturn - rfPerTrade) / stdReturn : null;

    // Sortino ratio (downside deviation only)
    const downsideReturns = returns.filter(r => r < rfPerTrade);
    const downsideVariance = downsideReturns.length > 0
        ? downsideReturns.reduce((s, r) => s + (r - rfPerTrade) ** 2, 0) / downsideReturns.length
        : 0;
    const downsideDeviation = Math.sqrt(downsideVariance);
    const sortinoRatio = downsideDeviation > 0 ? (meanReturn - rfPerTrade) / downsideDeviation : null;

    return {
        totalTrades: profits.length,
        wins: wins.length,
        losses: losses.length,
        winRate: Math.round(winRate * 10000) / 100,
        avgWin: round(avgWin),
        avgLoss: round(avgLoss),
        expectancy: round(expectancy),
        profitFactor: round(profitFactor),
        totalProfit: round(totalProfit),
        maxDrawdown: round(maxDD),
        maxDrawdownPct: Math.round(maxDDPct * 10000) / 100,
        sharpeRatio: sharpeRatio !== null ? round(sharpeRatio) : null,
        sortinoRatio: sortinoRatio !== null ? round(sortinoRatio) : null,
        avgHoldTimeMs: null, // Would need entry+exit timestamps
        bestTrade: round(Math.max(...profits)),
        worstTrade: round(Math.min(...profits)),
    };
}

function buildEquityCurve(trades: TradeRow[]): EquityPoint[] {
    let cumPnL = 0;
    return trades.map((t, i) => {
        cumPnL += t.profit;
        return {
            timestamp: t.created_at,
            cumulativePnL: round(cumPnL),
            tradeIndex: i + 1,
        };
    });
}

function computeStrategyBreakdown(trades: TradeRow[]): StrategyBreakdown[] {
    const groups = new Map<string, TradeRow[]>();
    for (const t of trades) {
        const key = t.entry_profile_id || 'unknown';
        const group = groups.get(key) ?? [];
        group.push(t);
        groups.set(key, group);
    }

    const result: StrategyBreakdown[] = [];
    for (const [strategy, groupTrades] of groups) {
        const profits = groupTrades.map(t => t.profit);
        const wins = profits.filter(p => p > 0);
        const losses = profits.filter(p => p < 0);
        const totalProfit = profits.reduce((s, p) => s + p, 0);
        const grossProfit = wins.reduce((s, p) => s + p, 0);
        const grossLoss = Math.abs(losses.reduce((s, p) => s + p, 0));
        const winRate = profits.length > 0 ? (wins.length / profits.length) * 100 : 0;
        const avgWin = wins.length > 0 ? grossProfit / wins.length : 0;
        const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
        const wr = wins.length / (profits.length || 1);
        const expectancy = (wr * avgWin) - ((1 - wr) * avgLoss);

        result.push({
            strategy,
            trades: profits.length,
            winRate: Math.round(winRate * 100) / 100,
            totalProfit: round(totalProfit),
            avgProfit: round(totalProfit / profits.length),
            expectancy: round(expectancy),
        });
    }

    return result.sort((a, b) => b.totalProfit - a.totalProfit);
}

function computeSymbolBreakdown(trades: TradeRow[]): SymbolBreakdown[] {
    const groups = new Map<string, TradeRow[]>();
    for (const t of trades) {
        const key = t.symbol || 'UNKNOWN';
        const group = groups.get(key) ?? [];
        group.push(t);
        groups.set(key, group);
    }

    const result: SymbolBreakdown[] = [];
    for (const [symbol, groupTrades] of groups) {
        const profits = groupTrades.map(t => t.profit);
        const wins = profits.filter(p => p > 0);
        const totalProfit = profits.reduce((s, p) => s + p, 0);
        const winRate = profits.length > 0 ? (wins.length / profits.length) * 100 : 0;

        result.push({
            symbol,
            trades: profits.length,
            winRate: Math.round(winRate * 100) / 100,
            totalProfit: round(totalProfit),
        });
    }

    return result.sort((a, b) => b.totalProfit - a.totalProfit);
}

function round(n: number): number {
    return Math.round(n * 100) / 100;
}

// ==================== EXPORTS FOR TESTING ====================

export const __test = {
    computeAnalytics,
    buildEquityCurve,
    computeStrategyBreakdown,
    computeSymbolBreakdown,
};
