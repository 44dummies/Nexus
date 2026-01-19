import { calculateRSI } from '@/lib/bot/indicators';
import { evaluateRisk } from '@/lib/bot/risk';
import { executeTrade } from '@/lib/deriv/executor';
import { useTradingStore } from '@/store/tradingStore';
import type { TradeSignal } from '@/lib/bot/types';

interface BotEngineOptions {
    ws: WebSocket;
    symbol: string;
    rsiPeriod?: number;
    bufferSize?: number;
    cooldownMs?: number;
    maxStake?: number;
    duration?: number;
    durationUnit?: 't' | 'm' | 's' | 'h' | 'd';
}

export class BotEngine {
    private tickBuffer: number[] = [];
    private inFlight = false;
    private rsiPeriod: number;
    private bufferSize: number;
    private cooldownMs: number;
    private maxStake?: number;
    private duration?: number;
    private durationUnit?: 't' | 'm' | 's' | 'h' | 'd';
    private ws: WebSocket;
    private symbol: string;

    constructor(options: BotEngineOptions) {
        this.ws = options.ws;
        this.symbol = options.symbol;
        this.rsiPeriod = options.rsiPeriod ?? 14;
        this.bufferSize = options.bufferSize ?? 100;
        this.cooldownMs = options.cooldownMs ?? 60_000;
        this.maxStake = options.maxStake;
        this.duration = options.duration;
        this.durationUnit = options.durationUnit;
    }

    handleTick(price: number) {
        if (!Number.isFinite(price)) return;

        this.tickBuffer.push(price);
        if (this.tickBuffer.length > this.bufferSize) {
            this.tickBuffer.shift();
        }

        const rsi = calculateRSI(this.tickBuffer, this.rsiPeriod);
        if (rsi === null) {
            console.log(`RSI(${this.rsiPeriod}): calculating...`);
            return;
        }

        console.log(`RSI(${this.rsiPeriod}): ${rsi.toFixed(2)}`);

        let signal: TradeSignal | null = null;
        if (rsi < 30) signal = 'CALL';
        if (rsi > 70) signal = 'PUT';

        if (!signal) return;

        console.log(`Signal: ${signal}`);

        const store = useTradingStore.getState();

        if (!store.botRunning) {
            console.log('Bot paused; signal ignored.');
            return;
        }

        if (this.inFlight) {
            console.log('Trade in flight; skipping signal.');
            return;
        }

        const maxStake = this.maxStake ?? store.baseStake;
        const riskStatus = evaluateRisk({
            totalLossToday: store.totalLossToday,
            limit: store.stopLoss,
            currentStake: store.baseStake,
            maxStake,
            lastTradeTime: store.lastTradeTime,
            now: Date.now(),
            cooldownMs: this.cooldownMs,
        });

        if (riskStatus === 'HALT') {
            console.warn('Risk limit hit. Halting bot.');
            store.setBotRunning(false);
            return;
        }

        if (riskStatus === 'COOLDOWN') {
            console.log('Cooldown active. Waiting...');
            return;
        }

        let stake = store.baseStake;
        if (riskStatus === 'REDUCE_STAKE') {
            stake = maxStake;
            console.warn(`Reducing stake to ${maxStake}.`);
        }

        if (this.ws.readyState !== WebSocket.OPEN) {
            console.warn('WebSocket not open. Trade skipped.');
            return;
        }

        this.inFlight = true;

        executeTrade(signal, {
            ws: this.ws,
            stake,
            symbol: this.symbol,
            duration: this.duration,
            durationUnit: this.durationUnit,
        })
            .catch((error) => {
                console.error('Trade execution failed:', error);
            })
            .finally(() => {
                this.inFlight = false;
            });
    }
}
