export type RiskStatus = 'OK' | 'HALT' | 'REDUCE_STAKE' | 'COOLDOWN';

export interface RiskContext {
    totalLossToday: number;
    limit: number;
    currentStake: number;
    maxStake: number;
    lastTradeTime: number | null;
    now: number;
    cooldownMs?: number;
}

export function evaluateRisk(context: RiskContext): RiskStatus {
    const cooldownMs = context.cooldownMs ?? 60_000;

    if (context.totalLossToday > context.limit) return 'HALT';
    if (context.currentStake > context.maxStake) return 'REDUCE_STAKE';

    if (context.lastTradeTime && context.now - context.lastTradeTime < cooldownMs) {
        return 'COOLDOWN';
    }

    return 'OK';
}
