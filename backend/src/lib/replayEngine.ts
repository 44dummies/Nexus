import fs from 'fs';
import { RingBuffer } from './ringBuffer';
import { OrderBook } from './orderBook';
import { evaluateStrategy, type StrategyConfig, type TradeSignal } from './strategyEngine';

interface RecordedEvent {
    type: 'tick' | 'order_book';
    symbol: string;
    ts: number;
    quote?: number;
    bids?: { price: number; size: number }[];
    asks?: { price: number; size: number }[];
}

interface ReplayTrade {
    entryTs: number;
    exitTs: number;
    entryPrice: number;
    exitPrice: number;
    signal: TradeSignal;
    profit: number;
}

export interface ReplayConfig {
    symbol: string;
    strategyId: string;
    strategyConfig?: StrategyConfig;
    stake: number;
    duration: number;
    durationUnit: 't' | 's' | 'm' | 'h' | 'd';
    payoutFactor?: number;
    historySize?: number;
}

export interface ReplayResult {
    trades: ReplayTrade[];
    totalProfit: number;
    winRate: number;
}

function durationToMs(duration: number, unit: ReplayConfig['durationUnit']): number {
    switch (unit) {
        case 't':
            return duration * 1000;
        case 's':
            return duration * 1000;
        case 'm':
            return duration * 60 * 1000;
        case 'h':
            return duration * 60 * 60 * 1000;
        case 'd':
            return duration * 24 * 60 * 60 * 1000;
        default:
            return duration * 1000;
    }
}

export function runReplay(filePath: string, config: ReplayConfig): ReplayResult {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const events: RecordedEvent[] = [];
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as RecordedEvent;
            if (parsed.symbol === config.symbol) {
                events.push(parsed);
            }
        } catch {
            // skip bad lines
        }
    }
    events.sort((a, b) => a.ts - b.ts);

    const history = new RingBuffer(config.historySize ?? 500);
    const orderBook = new OrderBook(config.symbol);
    const trades: ReplayTrade[] = [];
    const durationMs = durationToMs(config.duration, config.durationUnit);
    const payoutFactor = config.payoutFactor ?? 0.95;

    let openTrade: { entryTs: number; entryPrice: number; signal: TradeSignal } | null = null;

    for (const event of events) {
        if (event.type === 'order_book' && event.bids && event.asks) {
            orderBook.updateFromSnapshot({
                symbol: event.symbol,
                bids: event.bids,
                asks: event.asks,
            });
        }

        if (event.type !== 'tick' || typeof event.quote !== 'number') continue;

        history.push(event.quote);

        if (openTrade) {
            const shouldClose = event.ts >= openTrade.entryTs + durationMs;
            if (shouldClose) {
                const exitPrice = event.quote;
                const win = openTrade.signal === 'CALL'
                    ? exitPrice > openTrade.entryPrice
                    : exitPrice < openTrade.entryPrice;
                const profit = win ? config.stake * payoutFactor : -config.stake;
                trades.push({
                    entryTs: openTrade.entryTs,
                    exitTs: event.ts,
                    entryPrice: openTrade.entryPrice,
                    exitPrice,
                    signal: openTrade.signal,
                    profit,
                });
                openTrade = null;
            }
            continue;
        }

        if (history.length < 10) continue;

        const microContext = {
            imbalance: orderBook.getImbalanceTopN(config.strategyConfig?.imbalanceLevels ?? 10),
            spread: orderBook.getSpread(),
            momentum: null,
            mode: 'order_book' as const,
        };

        const evaluation = evaluateStrategy(
            config.strategyId,
            history.getView(history.length),
            config.strategyConfig,
            0,
            microContext
        );

        if (evaluation.signal) {
            openTrade = {
                entryTs: event.ts,
                entryPrice: event.quote,
                signal: evaluation.signal,
            };
        }
    }

    const totalProfit = trades.reduce((sum, trade) => sum + trade.profit, 0);
    const wins = trades.filter(trade => trade.profit > 0).length;
    const winRate = trades.length > 0 ? wins / trades.length : 0;

    return {
        trades,
        totalProfit,
        winRate,
    };
}
