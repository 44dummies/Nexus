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
    entryMode: z.enum(['HYBRID_LIMIT_MARKET', 'MARKET']).optional(),
    entryTargetPrice: z.number().positive().optional(),
    entrySlippagePct: z.number().min(0).optional(),
});

export type TradeSignal = z.infer<typeof TradeSignalSchema>;
export type ExecuteTradeParams = z.infer<typeof ExecuteTradeParamsSchema>;
