export type DurationUnit = 't' | 's' | 'm' | 'h' | 'd';

export interface BotConfig {
    duration?: number;
    durationUnit?: DurationUnit;
    cooldownMs?: number;
    rsiPeriod?: number;
    rsiLower?: number;
    rsiUpper?: number;
    emaFast?: number;
    emaSlow?: number;
    trendStrengthMultiplier?: number;
    trendRsiLower?: number;
    trendRsiUpper?: number;
    atrFast?: number;
    atrSlow?: number;
    breakoutLookback?: number;
    breakoutBufferMultiplier?: number;
    breakoutExpansionMultiplier?: number;
    smaPeriod?: number;
    capitalRsiLower?: number;
    capitalRsiUpper?: number;
    capitalCalmMultiplier?: number;
    capitalMeanDistanceMultiplier?: number;
    recoveryRsiLower?: number;
    recoveryRsiUpper?: number;
    recoveryMaxLossStreak?: number;
    recoveryStepMultiplier?: number;
    recoveryMaxSteps?: number;
}

export const DEFAULT_BOT_CONFIGS: Record<string, BotConfig> = {
    rsi: {
        duration: 5,
        durationUnit: 't',
        cooldownMs: 10_000,
        rsiPeriod: 14,
        rsiLower: 28,
        rsiUpper: 72,
    },
    'trend-rider': {
        duration: 5,
        durationUnit: 't',
        cooldownMs: 8_000,
        emaFast: 9,
        emaSlow: 26,
        trendStrengthMultiplier: 0.6,
        rsiPeriod: 14,
        trendRsiLower: 45,
        trendRsiUpper: 55,
    },
    'breakout-atr': {
        duration: 4,
        durationUnit: 't',
        cooldownMs: 7_000,
        atrFast: 14,
        atrSlow: 42,
        breakoutLookback: 20,
        breakoutBufferMultiplier: 0.18,
        breakoutExpansionMultiplier: 1.15,
    },
    'capital-guard': {
        duration: 6,
        durationUnit: 't',
        cooldownMs: 12_000,
        atrFast: 14,
        atrSlow: 55,
        smaPeriod: 30,
        rsiPeriod: 14,
        capitalRsiLower: 25,
        capitalRsiUpper: 75,
        capitalCalmMultiplier: 0.85,
        capitalMeanDistanceMultiplier: 1.0,
    },
    'recovery-lite': {
        duration: 5,
        durationUnit: 't',
        cooldownMs: 12_000,
        rsiPeriod: 14,
        recoveryRsiLower: 30,
        recoveryRsiUpper: 70,
        recoveryMaxLossStreak: 3,
        recoveryStepMultiplier: 0.2,
        recoveryMaxSteps: 2,
    },
};

export const getBotConfig = (
    botId: string | null | undefined,
    overrides?: Record<string, BotConfig>
) => {
    const key = botId && DEFAULT_BOT_CONFIGS[botId] ? botId : 'rsi';
    return {
        ...DEFAULT_BOT_CONFIGS[key],
        ...(overrides?.[key] ?? {}),
    };
};
