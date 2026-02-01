import { evaluateCachedRisk, getRiskCache, recordTradeOpened } from './riskCache';
import { isKillSwitchActive, preTradeCheck } from './riskManager';
import { RISK_DEFAULTS, toNumber, type TradeRiskConfig } from './riskConfig';
import { getRiskConfigCached } from './riskConfigCache';
import { nowMs, recordLatency, LATENCY_METRICS, type LatencyTrace, markTrace } from './latencyTracker';

export interface PreTradeGateContext {
    accountId: string;
    stake: number;
    botRunId?: string | null;
    riskOverrides?: Partial<TradeRiskConfig>;
}

const LOW_LATENCY_MODE = (process.env.LOW_LATENCY_MODE || 'false') === 'true';
const DEFAULT_TRADE_COOLDOWN_MS = Math.max(0, Number(process.env.DEFAULT_TRADE_COOLDOWN_MS) || (LOW_LATENCY_MODE ? 0 : 3000));
const DEFAULT_LOSS_COOLDOWN_MS = Math.max(0, Number(process.env.DEFAULT_LOSS_COOLDOWN_MS) || 60000);

export function preTradeGate(
    ctx: PreTradeGateContext,
    latency?: LatencyTrace
): { stake: number; risk: TradeRiskConfig } {
    const gateStart = latency ? markTrace(latency, 'gateStartTs', nowMs()) : nowMs();
    if (isKillSwitchActive(ctx.accountId)) {
        throw new Error('Kill switch active');
    }

    const cacheEntry = getRiskCache(ctx.accountId);
    if (!cacheEntry) {
        throw new Error('Risk state unavailable');
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
    });

    if (riskStatus.status === 'HALT') {
        throw new Error(riskStatus.reason === 'DAILY_LOSS'
            ? 'Daily loss limit reached'
            : riskStatus.reason === 'DRAWDOWN'
                ? 'Drawdown limit reached'
                : 'Risk halt');
    }

    if (riskStatus.status === 'MAX_CONCURRENT') {
        throw new Error('Maximum concurrent trades reached');
    }

    if (riskStatus.status === 'COOLDOWN') {
        const waitMs = riskStatus.cooldownMs ?? 1000;
        throw new Error(`Cooldown active - wait ${Math.ceil(waitMs / 1000)}s`);
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
        throw new Error(`Risk limit: ${preTrade.reason}`);
    }

    const openResult = recordTradeOpened(ctx.accountId, stake, risk.maxConcurrentTrades);
    if (!openResult.allowed) {
        throw new Error(openResult.reason ?? 'Risk check failed');
    }

    if (latency) {
        markTrace(latency, 'gateEndTs', nowMs());
        recordLatency(LATENCY_METRICS.gateDuration, gateStart, latency.gateEndTs);
    }
    return { stake, risk };
}
