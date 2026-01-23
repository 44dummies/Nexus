import { evaluateRisk } from '@/lib/bot/risk';
import { getBotConfig } from '@/lib/bot/config';
import { getStrategy } from '@/lib/bot/strategies';
import { useTradingStore } from '@/store/tradingStore';
import { showTradeToast } from '@/lib/toast';
import type { TradeSignal } from '@/lib/bot/types';
import { apiFetch, executeTradeApi } from '@/lib/api';

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
    private tickBuffer: number[] = [];
    private inFlight = false;
    private bufferSize: number;
    private cooldownMs: number;
    private maxStake?: number;
    private entryMode: 'HYBRID_LIMIT_MARKET' | 'MARKET';
    private entryTimeoutMs: number;
    private entryPollingMs: number;
    private entrySlippagePct: number;
    private entryAggressiveness: number;
    private entryMinEdgePct: number;
    private duration?: number;
    private durationUnit?: 't' | 'm' | 's' | 'h' | 'd';
    private ws: WebSocket;
    private symbol: string;
    private pendingEntry: {
        signal: TradeSignal;
        targetPrice: number;
        expiresAt: number;
        createdAt: number;
        stake: number;
        minEdgePct: number;
        aggressiveness: number;
        slippagePct: number;
        pollingMs: number;
        duration?: number;
        durationUnit?: 't' | 'm' | 's' | 'h' | 'd';
        lastReqId?: number;
    } | null = null;
    private lastStrategyId: string | null = null;
    private proposalTimer: ReturnType<typeof setInterval> | null = null;
    private proposalReqId = 900;

    constructor(options: BotEngineOptions) {
        this.ws = options.ws;
        this.symbol = options.symbol;
        this.bufferSize = options.bufferSize ?? 100;
        this.cooldownMs = options.cooldownMs ?? 10_000; // 10 seconds cooldown
        this.maxStake = options.maxStake;
        this.entryMode = options.entryMode ?? 'HYBRID_LIMIT_MARKET';
        this.entryTimeoutMs = options.entryTimeoutMs ?? 4000;
        this.entryPollingMs = options.entryPollingMs ?? 500;
        this.entrySlippagePct = options.entrySlippagePct ?? 0.05;
        this.entryAggressiveness = options.entryAggressiveness ?? 0.45;
        this.entryMinEdgePct = options.entryMinEdgePct ?? 0.2;
        this.duration = options.duration;
        this.durationUnit = options.durationUnit;
    }

    updateConfig(config: Partial<Pick<BotEngineOptions, 'cooldownMs' | 'maxStake' | 'entryMode' | 'entryTimeoutMs' | 'entryPollingMs' | 'entrySlippagePct' | 'entryAggressiveness' | 'entryMinEdgePct'>>) {
        if (typeof config.cooldownMs === 'number') {
            this.cooldownMs = config.cooldownMs;
        }
        if (typeof config.maxStake === 'number') {
            this.maxStake = config.maxStake;
        }
        if (config.entryMode) {
            this.entryMode = config.entryMode;
            if (config.entryMode === 'MARKET' && this.pendingEntry) {
                this.addLog('info', 'Pending entry cleared (market mode)');
                this.pendingEntry = null;
                this.stopProposalPolling();
            }
        }
        if (typeof config.entryTimeoutMs === 'number') {
            this.entryTimeoutMs = config.entryTimeoutMs;
        }
        if (typeof config.entryPollingMs === 'number') {
            this.entryPollingMs = config.entryPollingMs;
            if (this.pendingEntry) {
                this.pendingEntry.pollingMs = Math.max(50, config.entryPollingMs);
                this.startProposalPolling();
            }
        }
        if (typeof config.entrySlippagePct === 'number') {
            this.entrySlippagePct = config.entrySlippagePct;
            if (this.pendingEntry) {
                this.pendingEntry.slippagePct = config.entrySlippagePct;
            }
        }
        if (typeof config.entryAggressiveness === 'number') {
            this.entryAggressiveness = config.entryAggressiveness;
        }
        if (typeof config.entryMinEdgePct === 'number') {
            this.entryMinEdgePct = config.entryMinEdgePct;
        }
    }

    private addLog(type: 'info' | 'signal' | 'trade' | 'error' | 'result', message: string, data?: Record<string, unknown>) {
        useTradingStore.getState().addLog(type, message, data);
    }

    private getAverageChange(sampleSize = 10) {
        if (this.tickBuffer.length < 2) return 0;
        const start = Math.max(1, this.tickBuffer.length - sampleSize);
        let sum = 0;
        let count = 0;
        for (let i = start; i < this.tickBuffer.length; i += 1) {
            const change = Math.abs(this.tickBuffer[i] - this.tickBuffer[i - 1]);
            sum += change;
            count += 1;
        }
        return count > 0 ? sum / count : 0;
    }

    private getVolatilityScale() {
        const shortVol = this.getAverageChange(10);
        const longVol = this.getAverageChange(40);
        if (shortVol <= 0 || longVol <= 0) return 1;
        const ratio = longVol / shortVol;
        return Math.min(1.4, Math.max(0.6, ratio));
    }

    private computeDynamicStake(store: ReturnType<typeof useTradingStore.getState>, stakeMultiplier?: number) {
        const baseStake = store.baseStake;
        const maxStake = this.maxStake ?? store.maxStake ?? baseStake;
        const equity = store.equity ?? store.balance ?? 0;

        let stake = baseStake;
        if (equity > 0) {
            const baseRiskPct = store.baseRiskPct ?? 0.35;
            const riskAmount = equity * (baseRiskPct / 100);
            const volScale = this.getVolatilityScale();
            const lossPenalty = store.lossStreak > 0 ? Math.max(0.7, 1 - 0.1 * store.lossStreak) : 1;
            const winBoost = store.lossStreak === 0 ? Math.min(1.1, 1 + 0.05 * (store.consecutiveWins ?? 0)) : 1;
            let drawdownScale = 1;
            if (store.equityPeak && equity < store.equityPeak && (store.drawdownLimitPct ?? 0) > 0) {
                const drawdownPct = ((store.equityPeak - equity) / store.equityPeak) * 100;
                drawdownScale = Math.max(0.5, 1 - (drawdownPct / (store.drawdownLimitPct ?? 1)) * 0.5);
            }
            stake = riskAmount * volScale * lossPenalty * winBoost * drawdownScale;
        }

        if (stakeMultiplier) {
            stake *= stakeMultiplier;
        }

        if (!Number.isFinite(stake) || stake <= 0) {
            stake = baseStake;
        }

        stake = Math.max(baseStake, Math.min(maxStake, stake));
        return Number(stake.toFixed(2));
    }

    private shouldFillHybrid(signal: TradeSignal, price: number, targetPrice: number) {
        if (signal === 'CALL') return price <= targetPrice;
        return price >= targetPrice;
    }

    private computeTargetPrice(signal: TradeSignal, price: number, minEdgePct: number, aggressiveness: number) {
        const clampedAggressiveness = Math.min(1, Math.max(0, aggressiveness));
        const edgePct = Math.max(0, minEdgePct);
        const edgeFactor = Math.max(0.05, 1 - clampedAggressiveness);
        const edgeAmount = price * (edgePct / 100) * edgeFactor;
        if (signal === 'CALL') return price - edgeAmount;
        return price + edgeAmount;
    }

    private startProposalPolling() {
        if (!this.pendingEntry) return;
        if (this.proposalTimer) {
            clearInterval(this.proposalTimer);
        }
        const pollingMs = Math.max(50, this.pendingEntry.pollingMs);
        this.proposalTimer = setInterval(() => {
            this.requestProposal();
        }, pollingMs);
    }

    private stopProposalPolling() {
        if (this.proposalTimer) {
            clearInterval(this.proposalTimer);
            this.proposalTimer = null;
        }
    }

    private requestProposal() {
        if (!this.pendingEntry) return;
        if (this.ws.readyState !== WebSocket.OPEN) return;

        const store = useTradingStore.getState();
        const currency = store.activeCurrency ?? store.currency ?? 'USD';
        const reqId = this.proposalReqId += 1;
        const duration = this.pendingEntry.duration ?? this.duration ?? 5;
        const durationUnit = this.pendingEntry.durationUnit ?? this.durationUnit ?? 't';

        this.pendingEntry.lastReqId = reqId;

        this.ws.send(JSON.stringify({
            proposal: 1,
            amount: this.pendingEntry.stake,
            basis: 'stake',
            contract_type: this.pendingEntry.signal,
            currency,
            duration,
            duration_unit: durationUnit,
            symbol: this.symbol,
            req_id: reqId,
        }));
    }

    private queueHybridEntry(
        signal: TradeSignal,
        price: number,
        stake: number,
        minEdgePct: number,
        duration?: number,
        durationUnit?: 't' | 'm' | 's' | 'h' | 'd'
    ) {
        const targetPrice = this.computeTargetPrice(signal, price, minEdgePct, this.entryAggressiveness);
        const now = Date.now();
        const pollingMs = Math.max(50, this.entryPollingMs);
        this.pendingEntry = {
            signal,
            targetPrice,
            createdAt: now,
            expiresAt: now + this.entryTimeoutMs,
            stake,
            minEdgePct,
            aggressiveness: this.entryAggressiveness,
            slippagePct: this.entrySlippagePct,
            pollingMs,
            duration,
            durationUnit,
        };
        this.addLog(
            'info',
            `Hybrid entry queued: ${signal} @ ${targetPrice.toFixed(2)} (edge ${minEdgePct.toFixed(2)}%, aggr ${this.entryAggressiveness.toFixed(2)}, timeout ${Math.round(this.entryTimeoutMs / 1000)}s)`,
            { signal, targetPrice, minEdgePct, aggressiveness: this.entryAggressiveness }
        );
        this.startProposalPolling();
        this.requestProposal();
    }

    private settlePendingEntry(action: 'filled' | 'timeout', price: number) {
        if (!this.pendingEntry) return;
        const pending = this.pendingEntry;
        if (action === 'filled') {
            this.addLog('info', `Hybrid entry filled at ${price.toFixed(2)}`);
        } else {
            const slippagePct = Math.abs((price - pending.targetPrice) / pending.targetPrice) * 100;
            if (slippagePct > pending.slippagePct) {
                this.addLog('info', `Hybrid timeout - slippage ${slippagePct.toFixed(2)}% > ${pending.slippagePct.toFixed(2)}% (canceled)`);
                this.emitRiskEvent('entry_skipped', 'Hybrid fallback skipped (slippage exceeded)', {
                    slippagePct,
                    tolerancePct: pending.slippagePct,
                });
                this.pendingEntry = null;
                this.stopProposalPolling();
                return;
            }
            this.addLog('info', `Hybrid timeout - fallback market`);
        }

        this.executeSignal(pending.signal, pending.stake, pending.duration, pending.durationUnit, {
            mode: 'HYBRID_LIMIT_MARKET',
            targetPrice: pending.targetPrice,
            slippagePct: pending.slippagePct,
        });
        this.pendingEntry = null;
        this.stopProposalPolling();
    }

    private emitRiskEvent(eventType: string, detail: string, metadata?: Record<string, unknown>) {
        if (typeof fetch === 'undefined') return;
        apiFetch('/api/risk-events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                eventType,
                detail,
                metadata,
            }),
        }).catch(() => undefined);
    }

    handleMessage(payload: { msg_type?: string; proposal?: { spot?: number | string }; req_id?: number }) {
        if (!payload || payload.msg_type !== 'proposal' || !this.pendingEntry) return;
        if (this.pendingEntry.lastReqId && payload.req_id && this.pendingEntry.lastReqId !== payload.req_id) return;

        const spotValue = typeof payload.proposal?.spot === 'string'
            ? Number(payload.proposal?.spot)
            : payload.proposal?.spot;
        const spot = Number.isFinite(spotValue)
            ? Number(spotValue)
            : this.tickBuffer[this.tickBuffer.length - 1];

        if (!Number.isFinite(spot)) return;

        if (Date.now() >= this.pendingEntry.expiresAt) {
            this.settlePendingEntry('timeout', spot);
            return;
        }

        if (this.shouldFillHybrid(this.pendingEntry.signal, spot, this.pendingEntry.targetPrice)) {
            this.settlePendingEntry('filled', spot);
        }
    }

    shutdown() {
        this.pendingEntry = null;
        this.stopProposalPolling();
    }

    private executeSignal(
        signal: TradeSignal,
        stake: number,
        duration?: number,
        durationUnit?: 't' | 'm' | 's' | 'h' | 'd',
        entryMeta?: {
            mode?: 'HYBRID_LIMIT_MARKET' | 'MARKET';
            targetPrice?: number;
            slippagePct?: number;
        }
    ) {
        const store = useTradingStore.getState();

        if (this.ws.readyState !== WebSocket.OPEN) {
            this.addLog('error', 'WebSocket not open - trade skipped');
            showTradeToast.connectionError();
            return;
        }

        this.inFlight = true;
        store.setLastTradeTime(Date.now());
        this.addLog('trade', `Executing ${signal} - $${stake} stake`, { signal, stake });

        executeTradeApi<{ contractId: number; profit: number; status?: string }>({
            signal,
            stake,
            symbol: this.symbol,
            duration: duration ?? this.duration,
            durationUnit: durationUnit ?? this.durationUnit,
            botId: store.selectedBotId ?? 'rsi',
            botRunId: store.activeRunId ?? undefined,
            entryProfileId: store.entryProfileId ?? undefined,
            entryMode: entryMeta?.mode ?? this.entryMode,
            entryTargetPrice: entryMeta?.targetPrice,
            entrySlippagePct: entryMeta?.slippagePct,
        })
            .then((result) => {
                this.addLog('trade', `Trade placed: Contract #${result.contractId}`, { contractId: result.contractId });
                showTradeToast.success(result.contractId, result.profit);
                useTradingStore.getState().recordTradeResult(Number(result.profit));
            })
            .catch((error) => {
                this.addLog('error', `Trade failed: ${error.message}`);
                showTradeToast.error(error.message);
            })
            .finally(() => {
                this.inFlight = false;
            });
    }

    handleTick(price: number) {
        if (!Number.isFinite(price)) return;

        this.tickBuffer.push(price);
        if (this.tickBuffer.length > this.bufferSize) {
            this.tickBuffer.shift();
        }

        const store = useTradingStore.getState();

        if (!store.botRunning) {
            if (this.pendingEntry) {
                this.addLog('info', 'Pending entry canceled (bot stopped)');
                this.pendingEntry = null;
                this.stopProposalPolling();
            }
            return;
        }

        const selectedBotId = store.selectedBotId || 'rsi';
        const strategy = getStrategy(selectedBotId);
        const botConfig = getBotConfig(selectedBotId, store.botConfigs);
        const effectiveCooldownMs = botConfig.cooldownMs ?? this.cooldownMs;
        const effectiveDuration = botConfig.duration ?? this.duration;
        const effectiveDurationUnit = botConfig.durationUnit ?? this.durationUnit;
        if (this.lastStrategyId !== selectedBotId) {
            this.lastStrategyId = selectedBotId;
            this.addLog('info', `Active bot: ${strategy.name}`);
        }

        if (this.pendingEntry) {
            if (Date.now() >= this.pendingEntry.expiresAt) {
                this.settlePendingEntry('timeout', price);
                return;
            }
            if (this.shouldFillHybrid(this.pendingEntry.signal, price, this.pendingEntry.targetPrice)) {
                this.settlePendingEntry('filled', price);
                return;
            }
            return;
        }

        const requiredTicks = strategy.getRequiredTicks ? strategy.getRequiredTicks(botConfig) : strategy.minTicks;
        if (this.tickBuffer.length < requiredTicks) {
            return;
        }
        const evaluation = strategy.evaluate({
            prices: this.tickBuffer,
            lastPrice: price,
            prevPrice: this.tickBuffer[this.tickBuffer.length - 2] ?? null,
            lossStreak: store.lossStreak,
            lastTradeProfit: store.lastTradeProfit,
        }, botConfig);

        if (!evaluation.signal) return;
        const signal = evaluation.signal;

        const detail = evaluation.detail ? ` | ${evaluation.detail}` : '';
        this.addLog('signal', `Signal: ${evaluation.signal} (${strategy.name}${detail})`, {
            signal: evaluation.signal,
            strategy: strategy.id,
            detail: evaluation.detail,
        });

        if (this.inFlight) {
            this.addLog('info', 'Trade in flight, skipping signal');
            return;
        }

        const rawMaxStake = this.maxStake ?? store.maxStake ?? store.baseStake;
        const maxStake = rawMaxStake > 0 ? rawMaxStake : store.baseStake;
        let stake = this.computeDynamicStake(store, evaluation.stakeMultiplier);
        if (!Number.isFinite(stake) || stake <= 0) {
            this.addLog('error', 'Invalid stake configured - update base stake');
            return;
        }

        const riskStatus = evaluateRisk({
            totalLossToday: store.totalLossToday,
            totalProfitToday: store.totalProfitToday,
            stopLoss: store.stopLoss,
            takeProfit: store.takeProfit,
            currentStake: stake,
            maxStake,
            lastTradeTime: store.lastTradeTime,
            now: Date.now(),
            cooldownMs: effectiveCooldownMs,
            equity: store.equity ?? store.balance,
            equityPeak: store.equityPeak,
            dailyStartEquity: store.dailyStartEquity,
            dailyLossLimitPct: store.dailyLossLimitPct,
            drawdownLimitPct: store.drawdownLimitPct,
            lossStreak: store.lossStreak,
            maxConsecutiveLosses: store.maxConsecutiveLosses,
            lastLossTime: store.lastLossTime,
            lossCooldownMs: store.lossCooldownMs,
        });

        if (riskStatus.status === 'HALT') {
            let reason = 'Risk limit hit - BOT HALTED';
            if (riskStatus.reason === 'TAKE_PROFIT') reason = 'Take profit reached - BOT HALTED';
            if (riskStatus.reason === 'STOP_LOSS') reason = 'Stop loss reached - BOT HALTED';
            if (riskStatus.reason === 'DAILY_LOSS') reason = 'Daily loss cap reached - BOT HALTED';
            if (riskStatus.reason === 'DRAWDOWN') reason = 'Drawdown cap reached - BOT HALTED';
            this.addLog('error', reason);
            this.emitRiskEvent(riskStatus.reason ?? 'halt', reason, {
                totalLossToday: store.totalLossToday,
                totalProfitToday: store.totalProfitToday,
                equity: store.equity ?? store.balance,
            });
            showTradeToast.halted();
            store.setBotRunning(false);
            return;
        }

        if (riskStatus.status === 'COOLDOWN') {
            const cooldownMs = riskStatus.cooldownMs ?? effectiveCooldownMs;
            const lastRef = riskStatus.reason === 'LOSS_STREAK' ? store.lastLossTime : store.lastTradeTime;
            const timeLeft = Math.ceil((cooldownMs - (Date.now() - (lastRef || 0))) / 1000);
            const label = riskStatus.reason === 'LOSS_STREAK' ? 'Loss streak pause' : 'Cooldown active';
            this.addLog('info', `${label} (${timeLeft}s remaining)`);
            if (riskStatus.reason === 'LOSS_STREAK') {
                this.emitRiskEvent('loss_streak_pause', label, {
                    lossStreak: store.lossStreak,
                    cooldownMs,
                });
            }
            return;
        }

        if (riskStatus.status === 'REDUCE_STAKE') {
            this.addLog('info', `Stake capped at $${maxStake} (requested $${stake.toFixed(2)})`);
            stake = maxStake;
        }

        if (this.entryMode === 'HYBRID_LIMIT_MARKET') {
            const minEdgePct = Math.max(this.entryMinEdgePct, evaluation.minEdgePct ?? 0);
            this.queueHybridEntry(signal, price, stake, minEdgePct, effectiveDuration, effectiveDurationUnit);
            return;
        }

        this.executeSignal(signal, stake, effectiveDuration, effectiveDurationUnit, { mode: 'MARKET' });
    }
}
