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
        cooldownMs: 3_000, // 3s for fast volatility trading
        rsiPeriod: 14,
        rsiLower: 32, // Widened from 28 for more signals
        rsiUpper: 68, // Widened from 72 for more signals
    },
    'trend-rider': {
        duration: 5,
        durationUnit: 't',
        cooldownMs: 4_000, // 4s cooldown
        emaFast: 9,
        emaSlow: 21, // Reduced from 26 for faster trend detection
        trendStrengthMultiplier: 0.4, // Reduced from 0.6 for more signals
        rsiPeriod: 14,
        trendRsiLower: 40, // Widened from 45
        trendRsiUpper: 60, // Widened from 55
    },
    'breakout-atr': {
        duration: 4,
        durationUnit: 't',
        cooldownMs: 3_000, // 3s cooldown
        atrFast: 10, // Reduced from 14 for faster detection
        atrSlow: 30, // Reduced from 42
        breakoutLookback: 15, // Reduced from 20
        breakoutBufferMultiplier: 0.1, // Reduced from 0.18 for more entries
        breakoutExpansionMultiplier: 1.05, // Reduced from 1.15
    },
    'capital-guard': {
        duration: 6,
        durationUnit: 't',
        cooldownMs: 5_000, // Reduced from 12s
        atrFast: 10, // Faster detection
        atrSlow: 40, // Reduced from 55
        smaPeriod: 20, // Reduced from 30
        rsiPeriod: 14,
        capitalRsiLower: 28, // Widened from 25
        capitalRsiUpper: 72, // Widened from 75
        capitalCalmMultiplier: 1.0, // Increased from 0.85 for more signals
        capitalMeanDistanceMultiplier: 1.5, // Increased from 1.0
    },
    'recovery-lite': {
        duration: 5,
        durationUnit: 't',
        cooldownMs: 4_000, // Reduced from 12s
        rsiPeriod: 14,
        recoveryRsiLower: 32, // Widened from 30
        recoveryRsiUpper: 68, // Widened from 70
        recoveryMaxLossStreak: 4, // Increased from 3
        recoveryStepMultiplier: 0.15, // Reduced from 0.2 for less stake reduction
        recoveryMaxSteps: 3, // Increased from 2
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
