import { evaluateCachedRisk, getRiskCache, recordTradeOpened } from './riskCache';
import { isKillSwitchActive, preTradeCheck } from './riskManager';
import { RISK_DEFAULTS, toNumber, type TradeRiskConfig } from './riskConfig';
import { getRiskConfigCached } from './riskConfigCache';
import { nowMs, recordLatency, LATENCY_METRICS, type LatencyTrace, markTrace } from './latencyTracker';
import { riskLogger } from './logger';
import { metrics } from './metrics';
import { isStrategyViable } from './rollingPerformanceTracker';

export interface PreTradeGateContext {
    accountId: string;
    stake: number;
    botRunId?: string | null;
    riskOverrides?: Partial<TradeRiskConfig>;
    /** Strategy ID for EV gate lookup */
    strategy?: string | null;
    /** Current regime for EV gate lookup */
    regime?: string | null;
    /** Symbol being traded for EV gate lookup */
    symbol?: string | null;
}

export interface PreTradeGateResult {
    allowed: boolean;
    reasons: string[];
    stake: number;
    risk: TradeRiskConfig;
}

export class PreTradeGateError extends Error {
    reasons: string[];

    constructor(message: string, reasons: string[]) {
        super(message);
        this.reasons = reasons;
    }
}

const LOW_LATENCY_MODE = (process.env.LOW_LATENCY_MODE || 'false') === 'true';
const DEFAULT_TRADE_COOLDOWN_MS = Math.max(0, Number(process.env.DEFAULT_TRADE_COOLDOWN_MS) || (LOW_LATENCY_MODE ? 0 : 3000));
const DEFAULT_LOSS_COOLDOWN_MS = Math.max(0, Number(process.env.DEFAULT_LOSS_COOLDOWN_MS) || 60000);

export function evaluatePreTradeGate(
    ctx: PreTradeGateContext,
    latency?: LatencyTrace
): PreTradeGateResult {
    const gateStart = latency ? markTrace(latency, 'gateStartTs', nowMs()) : nowMs();
    const reasons: string[] = [];

    if (isKillSwitchActive(ctx.accountId)) {
        reasons.push('KILL_SWITCH_ACTIVE');
    }

    const cacheEntry = getRiskCache(ctx.accountId);
    if (!cacheEntry) {
        reasons.push('RISK_CACHE_UNAVAILABLE');
    }

    const storedConfig = getRiskConfigCached(ctx.botRunId);
    const merged = {
        ...storedConfig,
        ...ctx.riskOverrides,
    } as Partial<TradeRiskConfig>;

    const risk: TradeRiskConfig = {
        stopLoss: toNumber(merged.stopLoss, RISK_DEFAULTS.stopLoss),
        takeProfit: toNumber(merged.takeProfit, RISK_DEFAULTS.takeProfit),
        dailyLossLimitPct: toNumber(merged.dailyLossLimitPct, RISK_DEFAULTS.dailyLossLimitPct),
        drawdownLimitPct: toNumber(merged.drawdownLimitPct, RISK_DEFAULTS.drawdownLimitPct),
        maxConsecutiveLosses: Math.max(0, Math.floor(toNumber(merged.maxConsecutiveLosses, RISK_DEFAULTS.maxConsecutiveLosses))),
        lossCooldownMs: toNumber(merged.lossCooldownMs, RISK_DEFAULTS.lossCooldownMs),
        cooldownMs: Number.isFinite(merged.cooldownMs) ? merged.cooldownMs : DEFAULT_TRADE_COOLDOWN_MS,
        maxStake: Number.isFinite(merged.maxStake) ? merged.maxStake : undefined,
        maxConcurrentTrades: Number.isFinite(merged.maxConcurrentTrades) ? merged.maxConcurrentTrades : undefined,
        maxOrderSize: Number.isFinite(merged.maxOrderSize) ? merged.maxOrderSize : undefined,
        maxNotional: Number.isFinite(merged.maxNotional) ? merged.maxNotional : undefined,
        maxExposure: Number.isFinite(merged.maxExposure) ? merged.maxExposure : undefined,
        maxOrdersPerSecond: Number.isFinite(merged.maxOrdersPerSecond) ? merged.maxOrdersPerSecond : undefined,
        maxOrdersPerMinute: Number.isFinite(merged.maxOrdersPerMinute) ? merged.maxOrdersPerMinute : undefined,
        maxCancelsPerSecond: Number.isFinite(merged.maxCancelsPerSecond) ? merged.maxCancelsPerSecond : undefined,
    };

    const maxStake = typeof risk.maxStake === 'number' && Number.isFinite(risk.maxStake)
        ? risk.maxStake
        : ctx.stake * 10;
    const cooldownMs = Number.isFinite(risk.cooldownMs) ? risk.cooldownMs : DEFAULT_TRADE_COOLDOWN_MS;
    const lossCooldownMs = Number.isFinite(risk.lossCooldownMs) ? risk.lossCooldownMs : DEFAULT_LOSS_COOLDOWN_MS;

    const riskStatus = evaluateCachedRisk(ctx.accountId, {
        proposedStake: ctx.stake,
        maxStake,
        dailyLossLimitPct: risk.dailyLossLimitPct,
        drawdownLimitPct: risk.drawdownLimitPct,
        maxConsecutiveLosses: risk.maxConsecutiveLosses,
        cooldownMs,
        lossCooldownMs,
        maxConcurrentTrades: risk.maxConcurrentTrades,
        stopLoss: risk.stopLoss,
        maxExposure: risk.maxExposure,
    });

    if (riskStatus.status === 'HALT') {
        reasons.push(riskStatus.reason === 'DAILY_LOSS'
            ? 'DAILY_LOSS_LIMIT'
            : riskStatus.reason === 'DRAWDOWN'
                ? 'DRAWDOWN_LIMIT'
                : riskStatus.reason === 'STOP_LOSS'
                    ? 'STOP_LOSS_REACHED'
                    : 'RISK_HALT');
    }

    if (riskStatus.status === 'MAX_CONCURRENT') {
        reasons.push('MAX_CONCURRENT_TRADES');
    }

    if (riskStatus.status === 'COOLDOWN') {
        reasons.push(riskStatus.reason === 'LOSS_STREAK' ? 'LOSS_COOLDOWN' : 'TRADE_COOLDOWN');
    }

    // EV Gate: block strategies with negative expected value
    if (ctx.strategy && ctx.symbol) {
        const evKey = `${ctx.strategy}:${ctx.regime ?? 'UNKNOWN'}:${ctx.symbol}`;
        if (!isStrategyViable(evKey)) {
            reasons.push('NEGATIVE_EV');
        }
    }

    let stake = ctx.stake;
    if (riskStatus.status === 'REDUCE_STAKE') {
        stake = Math.min(stake, maxStake);
    }

    const preTrade = preTradeCheck(ctx.accountId, stake, {
        maxOrderSize: risk.maxOrderSize,
        maxNotional: risk.maxNotional,
        maxExposure: risk.maxExposure,
        maxOrdersPerSecond: risk.maxOrdersPerSecond,
        maxOrdersPerMinute: risk.maxOrdersPerMinute,
        maxCancelsPerSecond: risk.maxCancelsPerSecond,
    });

    if (!preTrade.allowed) {
        reasons.push(`RISK_LIMIT_${preTrade.reason ?? 'UNKNOWN'}`);
    }

    if (reasons.length === 0) {
        const openResult = recordTradeOpened(ctx.accountId, stake, risk.maxConcurrentTrades);
        if (!openResult.allowed) {
            reasons.push(openResult.reason ?? 'RISK_OPEN_TRADE_REJECT');
        }
    }

    if (latency) {
        markTrace(latency, 'gateEndTs', nowMs());
        recordLatency(LATENCY_METRICS.gateDuration, gateStart, latency.gateEndTs);
    }

    if (reasons.length > 0) {
        metrics.counter('risk.pre_trade_reject');
        for (const reason of reasons) {
            metrics.counter(`risk.pre_trade_reject.${reason.toLowerCase()}`);
        }
        riskLogger.warn({
            accountId: ctx.accountId,
            botRunId: ctx.botRunId ?? null,
            stake,
            reasons,
        }, 'Risk decision trace: pre-trade rejected');
    }

    return { allowed: reasons.length === 0, reasons, stake, risk };
}

function formatRejectionMessage(reasons: string[]): string {
    if (reasons.length === 0) return 'Risk gate rejected';
    if (reasons.includes('KILL_SWITCH_ACTIVE')) return 'Kill switch active';
    if (reasons.includes('STOP_LOSS_REACHED')) return 'Stop-loss reached — session halted';
    if (reasons.includes('DAILY_LOSS_LIMIT')) return 'Daily loss limit reached';
    if (reasons.includes('DRAWDOWN_LIMIT')) return 'Drawdown limit reached';
    if (reasons.includes('MAX_CONCURRENT_TRADES')) return 'Maximum concurrent trades reached';
    if (reasons.includes('LOSS_COOLDOWN')) return 'Loss streak cooldown active';
    if (reasons.includes('TRADE_COOLDOWN')) return 'Trade cooldown active';
    return `Risk limit: ${reasons[0]}`;
}

export function preTradeGate(
    ctx: PreTradeGateContext,
    latency?: LatencyTrace
): { stake: number; risk: TradeRiskConfig } {
    const result = evaluatePreTradeGate(ctx, latency);
    if (!result.allowed) {
        throw new PreTradeGateError(formatRejectionMessage(result.reasons), result.reasons);
    }
    return { stake: result.stake, risk: result.risk };
}
