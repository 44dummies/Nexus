import { getSupabaseAdmin } from './supabaseAdmin';

export interface TradeRiskConfig {
    stopLoss: number;
    takeProfit: number;
    dailyLossLimitPct: number;
    drawdownLimitPct: number;
    maxConsecutiveLosses: number;
    lossCooldownMs: number;
    cooldownMs?: number;
    maxStake?: number;
    maxConcurrentTrades?: number;
    maxOrderSize?: number;
    maxNotional?: number;
    maxExposure?: number;
    maxOrdersPerSecond?: number;
    maxOrdersPerMinute?: number;
    maxCancelsPerSecond?: number;
}

export const RISK_DEFAULTS: TradeRiskConfig = {
    stopLoss: 0,
    takeProfit: 0,
    dailyLossLimitPct: 2,
    drawdownLimitPct: 6,
    maxConsecutiveLosses: 3,
    lossCooldownMs: 2 * 60 * 60 * 1000,
};

export const toNumber = (value: unknown, fallback = 0): number => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
};

export async function getSettingValue(accountId: string, key: string) {
    const { client: supabaseAdmin } = getSupabaseAdmin();
    if (!supabaseAdmin) return null;
    const { data } = await supabaseAdmin
        .from('settings')
        .select('value')
        .eq('account_id', accountId)
        .eq('key', key)
        .maybeSingle();
    return data?.value ?? null;
}

export async function getRiskConfig(accountId: string, botRunId?: string | null) {
    const { client: supabaseAdmin } = getSupabaseAdmin();
    if (!supabaseAdmin) return null;
    let runConfig: { risk?: Partial<TradeRiskConfig> } | null = null;

    if (botRunId) {
        const { data } = await supabaseAdmin
            .from('bot_runs')
            .select('config')
            .eq('account_id', accountId)
            .eq('id', botRunId)
            .maybeSingle();
        runConfig = data?.config ?? null;
    }

    if (!runConfig) {
        const { data } = await supabaseAdmin
            .from('bot_runs')
            .select('config')
            .eq('account_id', accountId)
            .eq('run_status', 'running')
            .order('started_at', { ascending: false })
            .limit(1)
            .maybeSingle();
        runConfig = data?.config ?? null;
    }

    const risk = runConfig && typeof runConfig === 'object' ? (runConfig as { risk?: Partial<TradeRiskConfig> }).risk : null;
    return risk ?? null;
}
