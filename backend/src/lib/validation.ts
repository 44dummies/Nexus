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
    // Allow payload fields that might be present in req.body
    signal: TradeSignalSchema.optional(),
    useFast: z.boolean().optional(),
}).strict();

export type TradeSignal = z.infer<typeof TradeSignalSchema>;
export type ExecuteTradeParams = z.infer<typeof ExecuteTradeParamsSchema>;

// Bot-run risk configuration schema
export const BotRunRiskSchema = z.object({
    baseStake: z.number().min(0.35).optional(),
    maxStake: z.number().positive().optional(),
    stopLoss: z.number().min(0).optional(),
    takeProfit: z.number().min(0).optional(),
    cooldownMs: z.number().min(0).max(300000).optional(), // Max 5 min
    baseRiskPct: z.number().min(0).max(100).optional(),
    dailyLossLimitPct: z.number().min(0).max(100).optional(),
    drawdownLimitPct: z.number().min(0).max(100).optional(),
    maxConsecutiveLosses: z.number().int().min(0).max(20).optional(),
    lossCooldownMs: z.number().min(0).max(3600000).optional(), // Max 1 hour
    maxConcurrentTrades: z.number().int().min(1).max(50).optional(),
    maxOrderSize: z.number().min(0).optional(),
    maxNotional: z.number().min(0).optional(),
    maxExposure: z.number().min(0).optional(),
    maxOrdersPerSecond: z.number().int().min(1).max(100).optional(),
    maxOrdersPerMinute: z.number().int().min(1).max(1000).optional(),
    maxCancelsPerSecond: z.number().int().min(1).max(100).optional(),
    volatilityWindow: z.number().int().min(5).max(500).optional(),
    volatilityThreshold: z.number().min(0).optional(),
}).strict().optional();

export const PerformanceConfigSchema = z.object({
    microBatchSize: z.number().int().min(1).max(100).optional(),
    microBatchIntervalMs: z.number().min(0).max(1000).optional(),
    strategyBudgetMs: z.number().min(0).max(50).optional(),
    enableComputeBudget: z.boolean().optional(),
}).strict().optional();

// Frontend Bot Actions (Legacy)
export const StartBotSchema = z.object({
    action: z.literal('start'),
    botId: z.string().min(1).nullable().optional(),
    config: z.record(z.unknown()).nullable().optional(),
}).strict();

export const StopBotSchema = z.object({
    action: z.literal('stop'),
    runId: z.string().uuid().nullable().optional(),
}).strict();

// Backend Bot Actions
export const StartBackendSchema = z.object({
    action: z.literal('start-backend'),
    botId: z.string().min(1).max(100).default('rsi'),
    symbol: z.string().min(1).max(50).default('R_100'),
    stake: z.number().min(0.35).max(100000).default(1),
    maxStake: z.number().min(0.35).max(1000000).optional(),
    duration: z.number().int().min(1).max(86400).default(5), // Max 1 day in seconds
    durationUnit: z.enum(['t', 's', 'm', 'h', 'd']).default('t'),
    cooldownMs: z.number().min(0).max(300000).default(3000), // Max 5 min
    strategyConfig: z.record(z.unknown()).optional(),
    risk: BotRunRiskSchema,
    performance: PerformanceConfigSchema,
    entry: z.object({
        profileId: z.string().optional(),
        mode: z.enum(['HYBRID_LIMIT_MARKET', 'MARKET']).optional(),
        timeoutMs: z.number().min(0).optional(),
        pollingMs: z.number().min(0).optional(),
        slippagePct: z.number().min(0).optional(),
        aggressiveness: z.number().min(0).max(1).optional(),
        minEdgePct: z.number().min(0).optional(),
    }).strict().optional(),
}).strict();

export const StopBackendSchema = z.object({
    action: z.literal('stop-backend'),
    runId: z.string().uuid().optional(),
}).strict();

export const PauseBackendSchema = z.object({
    action: z.literal('pause-backend'),
    runId: z.string().uuid(),
    reason: z.string().max(200).optional(),
}).strict();

export const ResumeBackendSchema = z.object({
    action: z.literal('resume-backend'),
    runId: z.string().uuid(),
}).strict();

export const StatusBackendSchema = z.object({
    action: z.literal('status-backend'),
    runId: z.string().uuid().optional(),
}).strict();

export type BotRunRisk = z.infer<typeof BotRunRiskSchema>;
export type StartBackendPayload = z.infer<typeof StartBackendSchema>;
export type StopBackendPayload = z.infer<typeof StopBackendSchema>;
