/**
 * Bot Controller
 * Manages bot run lifecycle on the backend.
 * Links: symbol → tick stream → strategy → trade executor
 */

import { subscribeTicks, unsubscribeAll, getTickWindowView, type TickData } from './tickStream';
import { calculateATR, evaluateStrategy, getRequiredTicks, getStrategyName, type StrategyConfig, type TradeSignal } from './strategyEngine';
import { getRiskCache, initializeRiskCache, evaluateCachedRisk, recordTradeOpened } from './riskCache';
import { executeTradeServerFast, type TradeResultFast } from '../trade';
import { getSupabaseAdmin } from './supabaseAdmin';
import { botLogger } from './logger';
import { metrics } from './metrics';
import { LATENCY_METRICS, createLatencyTrace, nowMs, recordLatency } from './latencyTracker';
import { ensureMarketData, getImbalanceTopN, getMarketDataMode, getShortHorizonMomentum, getSpread } from './marketData';
import { isKillSwitchActive, registerKillSwitchListener, triggerKillSwitch } from './riskManager';

interface BotRunConfig {
    strategyId: string;
    symbol: string;
    stake: number;
    maxStake?: number;
    duration: number;
    durationUnit: 't' | 's' | 'm' | 'h' | 'd';
    cooldownMs: number;
    strategyConfig?: StrategyConfig;
    performance?: {
        microBatchSize?: number;
        microBatchIntervalMs?: number;
        strategyBudgetMs?: number;
        enableComputeBudget?: boolean;
    };
    risk?: {
        dailyLossLimitPct?: number;
        drawdownLimitPct?: number;
        maxConsecutiveLosses?: number;
        maxConcurrentTrades?: number;
        lossCooldownMs?: number;
        maxOrderSize?: number;
        maxNotional?: number;
        maxExposure?: number;
        maxOrdersPerSecond?: number;
        maxOrdersPerMinute?: number;
        maxCancelsPerSecond?: number;
        volatilityWindow?: number;
        volatilityThreshold?: number;
    };
}

export interface ActiveBotRun {
    id: string;
    accountId: string;
    accountType: 'real' | 'demo';
    token: string;
    config: BotRunConfig;
    status: 'running' | 'paused' | 'stopped';
    startedAt: Date;
    lastTradeAt: number | null;
    tradesExecuted: number;
    totalProfit: number;
    currency: string;
    pendingTicks: TickData[];
    batchTimer: ReturnType<typeof setTimeout> | null;
}

// Active bot runs: botRunId -> ActiveBotRun
const activeBotRuns = new Map<string, ActiveBotRun>();

// Cleanup timeout handles
const cleanupHandles = new Map<string, ReturnType<typeof setTimeout>>();

const { client: supabaseAdmin } = getSupabaseAdmin();

const DEFAULT_MICROBATCH_SIZE = Math.max(1, Number(process.env.BOT_MICROBATCH_SIZE) || 1);
const DEFAULT_MICROBATCH_INTERVAL_MS = Math.max(0, Number(process.env.BOT_MICROBATCH_INTERVAL_MS) || 0);
const DEFAULT_STRATEGY_BUDGET_MS = Math.max(0, Number(process.env.STRATEGY_BUDGET_MS) || 1);
const ENABLE_STRATEGY_BUDGET = (process.env.ENABLE_STRATEGY_BUDGET || 'false') === 'true';

registerKillSwitchListener((accountId, state) => {
    if (!state.active) return;
    if (accountId) {
        const runs = getAccountBotRuns(accountId);
        for (const run of runs) {
            pauseBotRun(run.id, `Kill switch: ${state.reason ?? 'unknown'}`).catch(() => undefined);
        }
        return;
    }
    for (const run of activeBotRuns.values()) {
        pauseBotRun(run.id, `Kill switch: ${state.reason ?? 'unknown'}`).catch(() => undefined);
    }
});

/**
 * Start a bot run in backend mode
 */
export async function startBotRun(
    botRunId: string,
    accountId: string,
    accountType: 'real' | 'demo',
    token: string,
    config: BotRunConfig,
    currency: string = 'USD'
): Promise<void> {
    // Check if already running
    if (activeBotRuns.has(botRunId)) {
        throw new Error('Bot run already active');
    }

    // Initialize risk cache if not exists
    let riskEntry = getRiskCache(accountId);
    if (!riskEntry) {
        // Try to get balance from settings
        let balance = 10000;
        if (supabaseAdmin) {
            const { data } = await supabaseAdmin
                .from('settings')
                .select('value')
                .eq('account_id', accountId)
                .eq('key', 'balance_snapshot')
                .maybeSingle();
            if (data?.value && typeof data.value === 'object' && 'balance' in data.value) {
                balance = (data.value as { balance: number }).balance;
            }
        }
        riskEntry = initializeRiskCache(accountId, { equity: balance });
    }

    // Create bot run entry
    const botRun: ActiveBotRun = {
        id: botRunId,
        accountId,
        accountType,
        token,
        config,
        status: 'running',
        startedAt: new Date(),
        lastTradeAt: null,
        tradesExecuted: 0,
        totalProfit: 0,
        currency,
        pendingTicks: [],
        batchTimer: null,
    };

    activeBotRuns.set(botRunId, botRun);

    // Subscribe to tick stream
    await subscribeTicks(accountId, token, config.symbol, (tick) => {
        enqueueTick(botRunId, tick);
    });
    // Initialize market data (order_book if available; synthetic fallback otherwise)
    ensureMarketData(accountId, token, config.symbol).catch((error) => {
        botLogger.warn({ botRunId, symbol: config.symbol, error }, 'Market data init failed');
    });

    botLogger.info({ botRunId, strategyId: config.strategyId, symbol: config.symbol }, 'Bot run started');

    // Update database
    if (supabaseAdmin) {
        await supabaseAdmin
            .from('bot_runs')
            .update({
                run_status: 'running',
                backend_mode: true,
                started_at: botRun.startedAt.toISOString(),
            })
            .eq('id', botRunId);
    }
}

function getBatchSize(config: BotRunConfig): number {
    const size = config.performance?.microBatchSize ?? DEFAULT_MICROBATCH_SIZE;
    return Math.max(1, Math.floor(size));
}

function getBatchIntervalMs(config: BotRunConfig): number {
    const interval = config.performance?.microBatchIntervalMs ?? DEFAULT_MICROBATCH_INTERVAL_MS;
    return Math.max(0, Math.floor(interval));
}

function shouldEnforceBudget(config: BotRunConfig): boolean {
    const flag = config.performance?.enableComputeBudget;
    if (typeof flag === 'boolean') return flag;
    return ENABLE_STRATEGY_BUDGET;
}

function getBudgetMs(config: BotRunConfig): number {
    const budget = config.performance?.strategyBudgetMs ?? DEFAULT_STRATEGY_BUDGET_MS;
    return Math.max(0, budget);
}

/**
 * Enqueue incoming tick for micro-batching
 */
function enqueueTick(botRunId: string, tick: TickData): void {
    const botRun = activeBotRuns.get(botRunId);
    if (!botRun || botRun.status !== 'running') return;

    const batchSize = getBatchSize(botRun.config);
    const intervalMs = getBatchIntervalMs(botRun.config);

    if (batchSize <= 1 && intervalMs === 0) {
        handleTickCore(botRunId, tick);
        return;
    }

    botRun.pendingTicks.push(tick);
    metrics.gauge('tick.batch_queue_depth', botRun.pendingTicks.length);

    if (!botRun.batchTimer) {
        botRun.batchTimer = setTimeout(() => {
            flushTickBatch(botRunId);
        }, intervalMs);
    }
}

function flushTickBatch(botRunId: string): void {
    const botRun = activeBotRuns.get(botRunId);
    if (!botRun || botRun.status !== 'running') return;

    botRun.batchTimer = null;
    const batchSize = getBatchSize(botRun.config);
    const batch = botRun.pendingTicks.splice(0, batchSize);
    metrics.histogram('tick.batch_size', batch.length);
    metrics.counter('tick.batch_flush');
    metrics.gauge('tick.batch_queue_depth', botRun.pendingTicks.length);

    for (const tick of batch) {
        handleTickCore(botRunId, tick);
    }

    if (botRun.pendingTicks.length > 0) {
        const intervalMs = getBatchIntervalMs(botRun.config);
        botRun.batchTimer = setTimeout(() => {
            flushTickBatch(botRunId);
        }, intervalMs);
    }
}

/**
 * Handle incoming tick for a bot run
 */
function handleTickCore(botRunId: string, tick: TickData): void {
    const botRun = activeBotRuns.get(botRunId);
    if (!botRun || botRun.status !== 'running') return;

    const { accountId, config } = botRun;
    if (isKillSwitchActive(accountId)) {
        pauseBotRun(botRunId, 'Kill switch active').catch(() => undefined);
        return;
    }
    const requiredTicks = getRequiredTicks(config.strategyId, config.strategyConfig);
    const prices = getTickWindowView(accountId, config.symbol, requiredTicks);

    // Check if we have enough ticks
    if (!prices || prices.length < requiredTicks) {
        return;
    }

    const volatilityThreshold = config.risk?.volatilityThreshold;
    if (typeof volatilityThreshold === 'number' && volatilityThreshold > 0) {
        const window = config.risk?.volatilityWindow ?? 20;
        const atr = calculateATR(prices, window);
        if (typeof atr === 'number' && atr > volatilityThreshold) {
            triggerKillSwitch(accountId, 'VOLATILITY_SPIKE', false);
            pauseBotRun(botRunId, 'Volatility spike guard').catch(() => undefined);
            return;
        }
    }

    // Check cooldown
    const now = Date.now();
    if (botRun.lastTradeAt && now - botRun.lastTradeAt < config.cooldownMs) {
        return;
    }

    // Get loss streak from risk cache
    const riskEntry = getRiskCache(accountId);
    const lossStreak = riskEntry?.lossStreak ?? 0;

    // Evaluate strategy
    const strategyStart = nowMs();
    const microContext = config.strategyId === 'microstructure'
        ? {
            imbalance: getImbalanceTopN(accountId, config.symbol, config.strategyConfig?.imbalanceLevels ?? 10),
            spread: getSpread(accountId, config.symbol),
            momentum: getShortHorizonMomentum(accountId, config.symbol, config.strategyConfig?.momentumWindowMs ?? 500),
            mode: getMarketDataMode(accountId, config.symbol),
        }
        : undefined;

    const evaluation = evaluateStrategy(
        config.strategyId,
        prices,
        config.strategyConfig,
        lossStreak,
        microContext
    );
    const strategyEnd = nowMs();
    metrics.histogram('strategy.compute_ms', strategyEnd - strategyStart);
    metrics.counter('strategy.eval_count');
    if (typeof tick.receivedPerfMs === 'number') {
        recordLatency(LATENCY_METRICS.tickToDecision, tick.receivedPerfMs, strategyEnd);
    }
    const budgetMs = getBudgetMs(config);
    if (shouldEnforceBudget(config) && budgetMs > 0 && (strategyEnd - strategyStart) > budgetMs) {
        metrics.counter('strategy.budget_overrun');
        return;
    }

    if (!evaluation.signal) return;

    metrics.counter(`strategy.signal.${evaluation.signal.toLowerCase()}`);

    // Calculate stake with multiplier
    let stake = config.stake;
    if (evaluation.stakeMultiplier) {
        stake = Math.max(0.35, stake * evaluation.stakeMultiplier);
    }

    // Check risk limits using actual stake
    const riskStatus = evaluateCachedRisk(accountId, {
        proposedStake: stake,
        maxStake: config.maxStake ?? config.stake * 10,
        dailyLossLimitPct: config.risk?.dailyLossLimitPct ?? 2,
        drawdownLimitPct: config.risk?.drawdownLimitPct ?? 6,
        maxConsecutiveLosses: config.risk?.maxConsecutiveLosses ?? 3,
        cooldownMs: config.cooldownMs,
        lossCooldownMs: config.risk?.lossCooldownMs,
        maxConcurrentTrades: config.risk?.maxConcurrentTrades,
    });

    if (riskStatus.status === 'HALT') {
        botLogger.warn({ botRunId, reason: riskStatus.reason }, 'Bot risk halt');
        pauseBotRun(botRunId, `Risk limit: ${riskStatus.reason}`);
        return;
    }

    if (riskStatus.status === 'MAX_CONCURRENT') {
        return; // Silently wait for concurrent trades to settle
    }

    if (riskStatus.status === 'COOLDOWN') {
        return;
    }

    if (riskStatus.status === 'REDUCE_STAKE') {
        const maxStake = config.maxStake ?? config.stake * 10;
        stake = Math.min(stake, maxStake);
    }

    // Execute trade
    const latencyTrace = createLatencyTrace({
        tickReceivedTs: tick.receivedPerfMs,
        decisionTs: strategyEnd,
    });
    executeTrade(botRunId, evaluation.signal, stake, evaluation.detail, latencyTrace, evaluation.confidence, evaluation.reasonCodes);
}

/**
 * Execute a trade for a bot run
 */
async function executeTrade(
    botRunId: string,
    signal: TradeSignal,
    stake: number,
    detail?: string,
    latencyTrace?: ReturnType<typeof createLatencyTrace>,
    confidence?: number,
    reasonCodes?: string[]
): Promise<void> {
    const botRun = activeBotRuns.get(botRunId);
    if (!botRun || botRun.status !== 'running') return;

    const { accountId, accountType, token, config, currency } = botRun;

    // Mark trade time immediately
    botRun.lastTradeAt = Date.now();

    try {
        const result = await executeTradeServerFast(
            signal,
            {
                symbol: config.symbol,
                stake,
                duration: config.duration,
                durationUnit: config.durationUnit,
                botId: config.strategyId,
                botRunId: botRunId,
                entryMode: 'MARKET',
            },
            {
                token,
                accountId,
                accountType,
                accountCurrency: currency,
            },
            {
                dailyLossLimitPct: config.risk?.dailyLossLimitPct ?? 2,
                drawdownLimitPct: config.risk?.drawdownLimitPct ?? 6,
                maxConsecutiveLosses: config.risk?.maxConsecutiveLosses ?? 3,
                cooldownMs: config.cooldownMs,
                lossCooldownMs: config.risk?.lossCooldownMs,
                maxStake: config.maxStake ?? config.stake * 10,
                maxConcurrentTrades: config.risk?.maxConcurrentTrades,
                maxOrderSize: config.risk?.maxOrderSize,
                maxNotional: config.risk?.maxNotional,
                maxExposure: config.risk?.maxExposure,
                maxOrdersPerSecond: config.risk?.maxOrdersPerSecond,
                maxOrdersPerMinute: config.risk?.maxOrdersPerMinute,
                maxCancelsPerSecond: config.risk?.maxCancelsPerSecond,
            },
            latencyTrace
        );

        botRun.tradesExecuted += 1;

        botLogger.info({
            botRunId,
            signal,
            contractId: result.contractId,
            executionTimeMs: result.executionTimeMs,
        }, 'Trade executed');

        // Log to database
        if (supabaseAdmin) {
            await supabaseAdmin.from('bot_logs').insert({
                bot_run_id: botRunId,
                account_id: accountId,
                level: 'trade',
                message: `${signal} - $${stake} - Contract #${result.contractId}`,
                data: {
                    signal,
                    stake,
                    contractId: result.contractId,
                    executionTimeMs: result.executionTimeMs,
                    detail,
                    confidence,
                    reasonCodes,
                },
            });
        }

    } catch (error) {
        const message = error instanceof Error ? error.message : 'Trade failed';
        botLogger.error({ botRunId, signal, stake, error: message }, 'Trade failed');

        if (supabaseAdmin) {
            await supabaseAdmin.from('bot_logs').insert({
                bot_run_id: botRunId,
                account_id: accountId,
                level: 'error',
                message: `Trade failed: ${message}`,
                data: { signal, stake, detail },
            });
        }
    }
}

/**
 * Pause a bot run
 */
export async function pauseBotRun(botRunId: string, reason?: string): Promise<void> {
    const botRun = activeBotRuns.get(botRunId);
    if (!botRun) return;

    botRun.status = 'paused';

    botLogger.info({ botRunId, reason }, 'Bot run paused');

    if (supabaseAdmin) {
        await supabaseAdmin
            .from('bot_runs')
            .update({
                run_status: 'paused',
                paused_reason: reason,
            })
            .eq('id', botRunId);
    }
}

/**
 * Resume a paused bot run
 */
export async function resumeBotRun(botRunId: string): Promise<void> {
    const botRun = activeBotRuns.get(botRunId);
    if (!botRun || botRun.status !== 'paused') return;

    botRun.status = 'running';

    botLogger.info({ botRunId }, 'Bot run resumed');

    if (supabaseAdmin) {
        await supabaseAdmin
            .from('bot_runs')
            .update({
                run_status: 'running',
                paused_reason: null,
            })
            .eq('id', botRunId);
    }
}

/**
 * Stop a bot run
 */
export async function stopBotRun(botRunId: string): Promise<void> {
    const botRun = activeBotRuns.get(botRunId);
    if (!botRun) return;

    botRun.status = 'stopped';

    // Unsubscribe from ticks
    unsubscribeAll(botRun.accountId);
    if (botRun.batchTimer) {
        clearTimeout(botRun.batchTimer);
        botRun.batchTimer = null;
    }
    botRun.pendingTicks = [];

    // Remove from active runs
    activeBotRuns.delete(botRunId);

    botLogger.info({
        botRunId,
        tradesExecuted: botRun.tradesExecuted,
        totalProfit: botRun.totalProfit,
    }, 'Bot run stopped');

    if (supabaseAdmin) {
        await supabaseAdmin
            .from('bot_runs')
            .update({
                run_status: 'stopped',
                stopped_at: new Date().toISOString(),
                trades_executed: botRun.tradesExecuted,
                total_profit: botRun.totalProfit,
            })
            .eq('id', botRunId);
    }
}

/**
 * Get status of a bot run
 */
export function getBotRunStatus(botRunId: string): ActiveBotRun | null {
    return activeBotRuns.get(botRunId) ?? null;
}

/**
 * Get all active bot runs for an account
 */
export function getAccountBotRuns(accountId: string): ActiveBotRun[] {
    const runs: ActiveBotRun[] = [];
    for (const run of activeBotRuns.values()) {
        if (run.accountId === accountId) {
            runs.push(run);
        }
    }
    return runs;
}

/**
 * Check if an account has an active backend bot run
 */
export function hasActiveBackendRun(accountId: string): boolean {
    for (const run of activeBotRuns.values()) {
        if (run.accountId === accountId && run.status === 'running') {
            return true;
        }
    }
    return false;
}

/**
 * Stop all bot runs for an account
 */
export async function stopAllBotRuns(accountId: string): Promise<void> {
    const runs = getAccountBotRuns(accountId);
    for (const run of runs) {
        await stopBotRun(run.id);
    }
}

// Test helpers
export function setBotRunForTest(run: ActiveBotRun): void {
    activeBotRuns.set(run.id, run);
}

export function clearBotRunsForTest(): void {
    activeBotRuns.clear();
}
