export type RiskStatus = 'OK' | 'HALT' | 'REDUCE_STAKE' | 'COOLDOWN';
export type RiskReason =
    | 'STOP_LOSS'
    | 'TAKE_PROFIT'
    | 'DAILY_LOSS'
    | 'DRAWDOWN'
    | 'LOSS_STREAK'
    | 'STAKE_CAP'
    | 'COOLDOWN';

export interface RiskEvaluation {
    status: RiskStatus;
    reason?: RiskReason;
    cooldownMs?: number;
}

export interface RiskContext {
    totalLossToday: number;
    totalProfitToday: number;
    stopLoss: number;
    takeProfit: number;
    currentStake: number;
    maxStake: number;
    lastTradeTime: number | null;
    now: number;
    cooldownMs?: number;
    equity?: number | null;
    equityPeak?: number | null;
    dailyStartEquity?: number | null;
    dailyLossLimitPct?: number;
    drawdownLimitPct?: number;
    lossStreak?: number;
    maxConsecutiveLosses?: number;
    lastLossTime?: number | null;
    lossCooldownMs?: number;
}

export function evaluateRisk(context: RiskContext): RiskEvaluation {
    const LOW_LATENCY_MODE = process.env.NEXT_PUBLIC_LOW_LATENCY_MODE === 'true';
    const defaultCooldownMs = LOW_LATENCY_MODE ? 0 : 10_000; // 10 seconds - reduced from 60s for faster signal response
    const cooldownMs = context.cooldownMs ?? defaultCooldownMs;

    if (context.stopLoss > 0 && context.totalLossToday >= context.stopLoss) {
        return { status: 'HALT', reason: 'STOP_LOSS' };
    }
    if (context.takeProfit > 0 && context.totalProfitToday >= context.takeProfit) {
        return { status: 'HALT', reason: 'TAKE_PROFIT' };
    }

    const dailyLossLimitPct = context.dailyLossLimitPct ?? 0;
    if (dailyLossLimitPct > 0 && context.dailyStartEquity && context.dailyStartEquity > 0) {
        const lossPct = (context.totalLossToday / context.dailyStartEquity) * 100;
        if (lossPct >= dailyLossLimitPct) {
            return { status: 'HALT', reason: 'DAILY_LOSS' };
        }
    }

    const drawdownLimitPct = context.drawdownLimitPct ?? 0;
    if (drawdownLimitPct > 0 && typeof context.equity === 'number' && typeof context.equityPeak === 'number' && context.equityPeak > 0) {
        const drawdownPct = ((context.equityPeak - context.equity) / context.equityPeak) * 100;
        if (drawdownPct >= drawdownLimitPct) {
            return { status: 'HALT', reason: 'DRAWDOWN' };
        }
    }

    const maxLosses = context.maxConsecutiveLosses ?? 0;
    if (maxLosses > 0 && (context.lossStreak ?? 0) >= maxLosses && context.lastLossTime) {
        const lossCooldownMs = context.lossCooldownMs ?? 30 * 60 * 1000;
        if (context.now - context.lastLossTime < lossCooldownMs) {
            return { status: 'COOLDOWN', reason: 'LOSS_STREAK', cooldownMs: lossCooldownMs };
        }
    }

    if (context.currentStake > context.maxStake) {
        return { status: 'REDUCE_STAKE', reason: 'STAKE_CAP' };
    }

    if (context.lastTradeTime && context.now - context.lastTradeTime < cooldownMs) {
        return { status: 'COOLDOWN', reason: 'COOLDOWN', cooldownMs };
    }

    return { status: 'OK' };
}
