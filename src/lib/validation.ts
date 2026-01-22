import { z } from 'zod';

export const TradeSignalSchema = z.enum(['CALL', 'PUT']);

export const ExecuteTradeParamsSchema = z.object({
    stake: z.number().positive('Stake must be positive'),
    symbol: z.string().min(1, 'Symbol is required'),
    duration: z.number().min(1, 'Duration must be at least 1').optional(),
    durationUnit: z.enum(['t', 'm', 's', 'h', 'd']).optional(),
    botId: z.string().min(1).optional(),
    botRunId: z.string().uuid().optional(),
    entryProfileId: z.string().min(1).optional(),
});

export const BotConfigSchema = z.object({
    baseStake: z.number().positive('Base stake must be positive'),
    maxStake: z.number().positive('Max stake must be positive'),
    stopLoss: z.number().min(0, 'Stop loss cannot be negative'),
    takeProfit: z.number().min(0, 'Take profit cannot be negative'),
    cooldownMs: z.number().min(0, 'Cooldown cannot be negative'),
    baseRiskPct: z.number().min(0, 'Risk per trade cannot be negative'),
    dailyLossLimitPct: z.number().min(0, 'Daily loss cap cannot be negative'),
    drawdownLimitPct: z.number().min(0, 'Drawdown cap cannot be negative'),
    maxConsecutiveLosses: z.number().min(1, 'Max consecutive losses must be at least 1'),
    lossCooldownMs: z.number().min(0, 'Loss cooldown cannot be negative'),
});

// Infer types
export type TradeSignal = z.infer<typeof TradeSignalSchema>;
export type ExecuteTradeParams = z.infer<typeof ExecuteTradeParamsSchema>;
export type BotConfig = z.infer<typeof BotConfigSchema>;
