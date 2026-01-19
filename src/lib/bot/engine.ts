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
    private lastLoggedRsi: number | null = null;

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

    private addLog(type: 'info' | 'signal' | 'trade' | 'error' | 'result', message: string, data?: Record<string, unknown>) {
        useTradingStore.getState().addLog(type, message, data);
    }

    handleTick(price: number) {
        if (!Number.isFinite(price)) return;

        this.tickBuffer.push(price);
        if (this.tickBuffer.length > this.bufferSize) {
            this.tickBuffer.shift();
        }

        const rsi = calculateRSI(this.tickBuffer, this.rsiPeriod);
        if (rsi === null) {
            return;
        }

        // Log RSI every 10 ticks to avoid spam
        const roundedRsi = Math.round(rsi);
        if (this.lastLoggedRsi !== roundedRsi && this.tickBuffer.length % 10 === 0) {
            this.addLog('info', `RSI(${this.rsiPeriod}): ${rsi.toFixed(2)}`, { rsi });
            this.lastLoggedRsi = roundedRsi;
        }

        let signal: TradeSignal | null = null;
        if (rsi < 30) signal = 'CALL';
        if (rsi > 70) signal = 'PUT';

        if (!signal) return;

        const store = useTradingStore.getState();

        if (!store.botRunning) {
            return;
        }

        this.addLog('signal', `Signal: ${signal} (RSI: ${rsi.toFixed(2)})`, { signal, rsi });

        if (this.inFlight) {
            this.addLog('info', 'Trade in flight, skipping signal');
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
            this.addLog('error', 'Risk limit hit - BOT HALTED');
            store.setBotRunning(false);
            return;
        }

        if (riskStatus === 'COOLDOWN') {
            const timeLeft = Math.ceil((this.cooldownMs - (Date.now() - (store.lastTradeTime || 0))) / 1000);
            this.addLog('info', `Cooldown active (${timeLeft}s remaining)`);
            return;
        }

        let stake = store.baseStake;
        if (riskStatus === 'REDUCE_STAKE') {
            stake = maxStake;
            this.addLog('info', `Reducing stake to $${maxStake}`);
        }

        if (this.ws.readyState !== WebSocket.OPEN) {
            this.addLog('error', 'WebSocket not open - trade skipped');
            return;
        }

        this.inFlight = true;
        this.addLog('trade', `Executing ${signal} - $${stake} stake`, { signal, stake });

        executeTrade(signal, {
            ws: this.ws,
            stake,
            symbol: this.symbol,
            duration: this.duration,
            durationUnit: this.durationUnit,
        })
            .then((result) => {
                this.addLog('trade', `Trade placed: Contract #${result.contractId}`, { contractId: result.contractId });
            })
            .catch((error) => {
                this.addLog('error', `Trade failed: ${error.message}`);
            })
            .finally(() => {
                this.inFlight = false;
            });
    }
}
