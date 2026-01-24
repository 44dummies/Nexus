import { useTradingStore } from '@/store/tradingStore';
import { showTradeToast } from '@/lib/toast';
import { apiFetch } from '@/lib/api';

interface BotEngineOptions {
    ws: WebSocket;
    symbol: string;
    bufferSize?: number;
    cooldownMs?: number;
    maxStake?: number;
    entryMode?: 'HYBRID_LIMIT_MARKET' | 'MARKET';
    entryTimeoutMs?: number;
    entryPollingMs?: number;
    entrySlippagePct?: number;
    entryAggressiveness?: number;
    entryMinEdgePct?: number;
    duration?: number;
    durationUnit?: 't' | 'm' | 's' | 'h' | 'd';
}

export class BotEngine {
    private ws: WebSocket;
    private symbol: string;
    private bufferSize: number;
    private cooldownMs: number;
    private maxStake?: number;
    private duration?: number;
    private durationUnit?: 't' | 'm' | 's' | 'h' | 'd';
    private running = false;
    private paused = false;
    private lastStrategyId: string | null = null;
    private backendRunId: string | null = null;

    // Kept for basic UI updates
    private tickBuffer: number[] = [];
    private openTradeCount = 0;

    constructor(options: BotEngineOptions) {
        this.ws = options.ws;
        this.symbol = options.symbol;
        this.bufferSize = options.bufferSize ?? 100;
        this.cooldownMs = options.cooldownMs ?? 3000;
        this.maxStake = options.maxStake;
        this.duration = options.duration;
        this.durationUnit = options.durationUnit;
    }

    updateConfig(config: Partial<BotEngineOptions>) {
        if (typeof config.cooldownMs === 'number') this.cooldownMs = config.cooldownMs;
        if (typeof config.maxStake === 'number') this.maxStake = config.maxStake;
        // Other configs are just stored for next start
    }

    async start(strategyId: string, stake: number) {
        if (this.running) return;
        this.running = true;
        this.paused = false;
        this.lastStrategyId = strategyId;

        this.addLog('info', `Starting backend bot: ${strategyId} on ${this.symbol}`);

        try {
            const response = await apiFetch('/api/bot-runs', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'start-backend',
                    botId: strategyId,
                    symbol: this.symbol,
                    stake,
                    maxStake: this.maxStake,
                    duration: this.duration ?? 5,
                    durationUnit: this.durationUnit ?? 't',
                    cooldownMs: this.cooldownMs,
                    strategyConfig: {}, // Can pass UI config here if needed
                }),
            });
            const result = await response.json();

            if (result.runId) {
                this.backendRunId = result.runId;
                this.addLog('success', `Backend bot started (ID: ${result.runId})`);
            } else {
                throw new Error('No run ID returned');
            }
        } catch (error) {
            this.running = false;
            this.backendRunId = null;
            const message = error instanceof Error ? error.message : 'Unknown error';
            this.addLog('error', `Failed to start backend bot: ${message}`);
            showTradeToast.error('Failed to start backend bot');
        }
    }

    async stop() {
        if (!this.running) return;

        this.running = false;
        this.paused = false;
        this.addLog('info', 'Stopping backend bot...');

        if (this.backendRunId) {
            try {
                await apiFetch('/api/bot-runs', {
                    method: 'POST',
                    body: JSON.stringify({
                        action: 'stop-backend',
                        runId: this.backendRunId,
                    }),
                });
                this.addLog('info', 'Backend bot stopped');
            } catch (error) {
                this.addLog('error', 'Failed to stop backend bot cleanly');
            }
            this.backendRunId = null;
        }
    }

    async pause() {
        if (!this.running || this.paused || !this.backendRunId) return;
        this.paused = true;
        this.addLog('info', 'Pausing backend bot...');

        try {
            await apiFetch('/api/bot-runs', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'pause-backend',
                    runId: this.backendRunId,
                }),
            });
        } catch (error) {
            this.addLog('error', 'Failed to pause backend bot');
        }
    }

    async resume() {
        if (!this.running || !this.paused || !this.backendRunId) return;
        this.paused = false;
        this.addLog('info', 'Resuming backend bot...');

        try {
            await apiFetch('/api/bot-runs', {
                method: 'POST',
                body: JSON.stringify({
                    action: 'resume-backend',
                    runId: this.backendRunId,
                }),
            });
        } catch (error) {
            this.addLog('error', 'Failed to resume backend bot');
        }
    }

    /**
     * Process tick (only for UI updates now)
     */
    onTick(price: number, epoch: number) {
        // Keep a small buffer for UI graph if needed, or just logging
        this.tickBuffer.push(price);
        if (this.tickBuffer.length > this.bufferSize) {
            this.tickBuffer.shift();
        }

        // We could poll status here occasionally or rely on SSE/WebSocket updates 
        // from backend for trade notifications (which we already have via notifications API)
    }

    private addLog(level: 'info' | 'success' | 'warning' | 'error', message: string) {
        // Map to supported store log types: 'info' | 'error' | 'signal' | 'trade' | 'result'
        let storeLevel: 'info' | 'error' | 'signal' | 'trade' | 'result' = 'info';

        switch (level) {
            case 'error':
                storeLevel = 'error';
                break;
            case 'success':
            case 'warning':
            default:
                storeLevel = 'info';
                break;
        }

        useTradingStore.getState().addLog(storeLevel, message);
    }

    get isActive() {
        return this.running;
    }

    get isPaused() {
        return this.paused;
    }

    shutdown() {
        this.running = false;
        // Do not stop backend bot on shutdown (tab close/refresh)
    }
}
