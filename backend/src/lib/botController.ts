/**
 * Bot Controller
 * Manages bot run lifecycle on the backend.
 * Links: symbol → tick stream → strategy → trade executor
 */

import { subscribeTicks, unsubscribeTicks, getTickWindowView, type TickData } from './tickStream';
import { calculateATR, evaluateStrategy, getRequiredTicks, type StrategyConfig, type TradeSignal } from './strategyEngine';
import { getRiskCache, initializeRiskCache } from './riskCache';
import { executeTradeServerFast } from '../trade';
import { getSupabaseAdmin } from './supabaseAdmin';
import { botLogger } from './logger';
import { metrics } from './metrics';
import { LATENCY_METRICS, createLatencyTrace, nowMs, recordLatency } from './latencyTracker';
import { ensureMarketData, getImbalanceTopN, getMarketDataMode, getShortHorizonMomentum, getSpread } from './marketData';
import { isKillSwitchActive, registerKillSwitchListener, triggerKillSwitch } from './riskManager';
import { preTradeGate } from './preTradeGate';
import { dropRiskConfig, primeRiskConfig } from './riskConfigCache';
import { persistenceQueue } from './persistenceQueue';
import type { TradeRiskConfig } from './riskConfig';

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
}

// Active bot runs: botRunId -> ActiveBotRun
const activeBotRuns = new Map<string, ActiveBotRun>();

const { client: supabaseAdmin } = getSupabaseAdmin();

const DEFAULT_MICROBATCH_SIZE = Math.max(1, Number(process.env.BOT_MICROBATCH_SIZE) || 1);
const DEFAULT_MICROBATCH_INTERVAL_MS = Math.max(0, Number(process.env.BOT_MICROBATCH_INTERVAL_MS) || 0);
const DEFAULT_STRATEGY_BUDGET_MS = Math.max(0, Number(process.env.STRATEGY_BUDGET_MS) || 1);
const ENABLE_STRATEGY_BUDGET = (process.env.ENABLE_STRATEGY_BUDGET || 'false') === 'true';

const symbolActors = new Map<string, SymbolActor>();

function getSymbolKey(accountId: string, symbol: string): string {
    return `${accountId}:${symbol}`;
}

class SymbolActor {
    private accountId: string;
    private token: string;
    private symbol: string;
    private key: string;
    private runIds = new Set<string>();
    private pendingTicks: TickData[] = [];
    private batchTimer: ReturnType<typeof setTimeout> | null = null;
    private batchSize = DEFAULT_MICROBATCH_SIZE;
    private batchIntervalMs = DEFAULT_MICROBATCH_INTERVAL_MS;
    private disposed = false;
    private tickListener: (tick: TickData) => void;

    constructor(accountId: string, token: string, symbol: string) {
        this.accountId = accountId;
        this.token = token;
        this.symbol = symbol;
        this.key = getSymbolKey(accountId, symbol);
        this.tickListener = (tick) => this.enqueueTick(tick);
    }

    async init(): Promise<void> {
        await subscribeTicks(this.accountId, this.token, this.symbol, this.tickListener);
        ensureMarketData(this.accountId, this.token, this.symbol).catch((error) => {
            botLogger.warn({ accountId: this.accountId, symbol: this.symbol, error }, 'Market data init failed');
        });
    }

    addRun(runId: string): void {
        this.runIds.add(runId);
        this.recomputeBatching();
    }

    removeRun(runId: string): void {
        this.runIds.delete(runId);
        this.recomputeBatching();
        if (this.runIds.size === 0) {
            this.dispose();
        }
    }

    private recomputeBatching(): void {
        let size = DEFAULT_MICROBATCH_SIZE;
        let interval = DEFAULT_MICROBATCH_INTERVAL_MS;
        for (const runId of this.runIds) {
            const run = activeBotRuns.get(runId);
            if (!run) continue;
            const perf = run.config.performance;
            if (typeof perf?.microBatchSize === 'number') {
                size = Math.min(size, perf.microBatchSize);
            }
            if (typeof perf?.microBatchIntervalMs === 'number') {
                interval = Math.min(interval, perf.microBatchIntervalMs);
            }
        }
        this.batchSize = Math.max(1, Math.floor(size));
        this.batchIntervalMs = Math.max(0, Math.floor(interval));
    }

    private enqueueTick(tick: TickData): void {
        if (this.disposed) return;

        if (this.batchSize <= 1 && this.batchIntervalMs === 0) {
            this.processTick(tick);
            return;
        }

        this.pendingTicks.push(tick);
        metrics.gauge('tick.batch_queue_depth', this.pendingTicks.length);

        if (!this.batchTimer) {
            this.batchTimer = setTimeout(() => {
                this.flushBatch();
            }, this.batchIntervalMs);
        }
    }

    private flushBatch(): void {
        if (this.disposed) return;
        this.batchTimer = null;
        const batch = this.pendingTicks.splice(0, this.batchSize);
        metrics.histogram('tick.batch_size', batch.length);
        metrics.counter('tick.batch_flush');
        metrics.gauge('tick.batch_queue_depth', this.pendingTicks.length);

        for (const tick of batch) {
            this.processTick(tick);
        }

        if (this.pendingTicks.length > 0) {
            this.batchTimer = setTimeout(() => {
                this.flushBatch();
            }, this.batchIntervalMs);
        }
    }

    private processTick(tick: TickData): void {
        if (this.disposed) return;
        if (this.runIds.size === 0) return;

        for (const runId of this.runIds) {
            const run = activeBotRuns.get(runId);
            if (!run || run.status !== 'running') continue;
            handleTickForRun(run, tick);
        }
    }

    private dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.batchTimer) {
            clearTimeout(this.batchTimer);
            this.batchTimer = null;
        }
        this.pendingTicks = [];
        unsubscribeTicks(this.accountId, this.symbol, this.tickListener);
        symbolActors.delete(this.key);
    }
}

async function getOrCreateSymbolActor(accountId: string, token: string, symbol: string): Promise<SymbolActor> {
    const key = getSymbolKey(accountId, symbol);
    const existing = symbolActors.get(key);
    if (existing) return existing;

    const actor = new SymbolActor(accountId, token, symbol);
    symbolActors.set(key, actor);
    try {
        await actor.init();
        return actor;
    } catch (error) {
        symbolActors.delete(key);
        throw error;
    }
}

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
    };

    activeBotRuns.set(botRunId, botRun);

    primeRiskConfig(botRunId, accountId, config.risk ?? null);

    try {
        const actor = await getOrCreateSymbolActor(accountId, token, config.symbol);
        actor.addRun(botRunId);
    } catch (error) {
        activeBotRuns.delete(botRunId);
        dropRiskConfig(botRunId);
        throw error;
    }

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

function shouldEnforceBudget(config: BotRunConfig): boolean {
    const flag = config.performance?.enableComputeBudget;
    if (typeof flag === 'boolean') return flag;
    return ENABLE_STRATEGY_BUDGET;
}

function getBudgetMs(config: BotRunConfig): number {
    const budget = config.performance?.strategyBudgetMs ?? DEFAULT_STRATEGY_BUDGET_MS;
    return Math.max(0, budget);
}

function queueBotLog(payload: {
    bot_run_id: string;
    account_id: string;
    level: 'trade' | 'error' | 'info' | 'signal' | 'result';
    message: string;
    data?: Record<string, unknown>;
}): void {
    if (!supabaseAdmin) return;
    persistenceQueue.enqueue(async () => {
        await supabaseAdmin.from('bot_logs').insert(payload);
    }).catch((error) => {
        botLogger.warn({ error, botRunId: payload.bot_run_id }, 'Bot log enqueue failed');
    });
}

/**
 * Enqueue incoming tick for micro-batching
 */
/**
 * Handle incoming tick for a bot run
 */
function handleTickForRun(botRun: ActiveBotRun, tick: TickData): void {
    if (botRun.status !== 'running') return;

    const { accountId, config } = botRun;
    if (isKillSwitchActive(accountId)) {
        pauseBotRun(botRun.id, 'Kill switch active').catch(() => undefined);
        return;
    }

    const requiredTicks = getRequiredTicks(config.strategyId, config.strategyConfig);
    const prices = getTickWindowView(accountId, config.symbol, requiredTicks);

    if (!prices || prices.length < requiredTicks) {
        return;
    }

    const volatilityThreshold = config.risk?.volatilityThreshold;
    if (typeof volatilityThreshold === 'number' && volatilityThreshold > 0) {
        const window = config.risk?.volatilityWindow ?? 20;
        const atr = calculateATR(prices, window);
        if (typeof atr === 'number' && atr > volatilityThreshold) {
            triggerKillSwitch(accountId, 'VOLATILITY_SPIKE', false);
            pauseBotRun(botRun.id, 'Volatility spike guard').catch(() => undefined);
            return;
        }
    }

    const now = Date.now();
    if (botRun.lastTradeAt && now - botRun.lastTradeAt < config.cooldownMs) {
        return;
    }

    const riskEntry = getRiskCache(accountId);
    const lossStreak = riskEntry?.lossStreak ?? 0;

    const latencyTrace = createLatencyTrace({
        tickReceivedTs: tick.receivedPerfMs,
    });

    const strategyStart = nowMs();
    latencyTrace.strategyStartTs = strategyStart;
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
    latencyTrace.strategyEndTs = strategyEnd;
    latencyTrace.decisionTs = strategyEnd;
    metrics.histogram('strategy.compute_ms', strategyEnd - strategyStart);
    metrics.counter('strategy.eval_count');
    recordLatency(LATENCY_METRICS.strategyCompute, strategyStart, strategyEnd);
    recordLatency(LATENCY_METRICS.tickToStrategy, tick.receivedPerfMs, strategyStart);
    recordLatency(LATENCY_METRICS.tickToDecision, tick.receivedPerfMs, strategyEnd);

    const budgetMs = getBudgetMs(config);
    if (shouldEnforceBudget(config) && budgetMs > 0 && (strategyEnd - strategyStart) > budgetMs) {
        metrics.counter('strategy.budget_overrun');
        return;
    }

    if (!evaluation.signal) return;

    metrics.counter(`strategy.signal.${evaluation.signal.toLowerCase()}`);

    let stake = config.stake;
    if (evaluation.stakeMultiplier) {
        stake = Math.max(0.35, stake * evaluation.stakeMultiplier);
    }

    let gateResult: { stake: number; risk: TradeRiskConfig } | undefined;
    try {
        const gate = preTradeGate({
            accountId,
            stake,
            botRunId: botRun.id,
            riskOverrides: config.risk,
        }, latencyTrace);
        stake = gate.stake;
        gateResult = gate;
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Risk gate rejected';
        if (message.toLowerCase().includes('daily loss') || message.toLowerCase().includes('drawdown') || message.toLowerCase().includes('risk halt')) {
            botLogger.warn({ botRunId: botRun.id, reason: message }, 'Bot risk halt');
            pauseBotRun(botRun.id, `Risk limit: ${message}`);
        }
        return;
    }

    recordLatency(LATENCY_METRICS.strategyToGate, latencyTrace.strategyEndTs, latencyTrace.gateStartTs);

    executeTradeForRun(
        botRun,
        evaluation.signal,
        stake,
        latencyTrace,
        evaluation.detail,
        evaluation.confidence,
        evaluation.reasonCodes,
        gateResult
    );
}

/**
 * Execute a trade for a bot run
 */
function executeTradeForRun(
    botRun: ActiveBotRun,
    signal: TradeSignal,
    stake: number,
    latencyTrace?: ReturnType<typeof createLatencyTrace>,
    detail?: string,
    confidence?: number,
    reasonCodes?: string[],
    preGate?: { stake: number; risk: TradeRiskConfig }
): void {
    if (botRun.status !== 'running') return;

    const { accountId, accountType, token, config, currency } = botRun;

    botRun.lastTradeAt = Date.now();

    executeTradeServerFast(
        signal,
        {
            symbol: config.symbol,
            stake,
            duration: config.duration,
            durationUnit: config.durationUnit,
            botId: config.strategyId,
            botRunId: botRun.id,
            entryMode: 'MARKET',
        },
        {
            token,
            accountId,
            accountType,
            accountCurrency: currency,
        },
        config.risk,
        latencyTrace,
        preGate
    ).then((result) => {
        botRun.tradesExecuted += 1;

        botLogger.info({
            botRunId: botRun.id,
            signal,
            contractId: result.contractId,
            executionTimeMs: result.executionTimeMs,
        }, 'Trade executed');

        queueBotLog({
            bot_run_id: botRun.id,
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
    }).catch((error) => {
        const message = error instanceof Error ? error.message : 'Trade failed';
        botLogger.error({ botRunId: botRun.id, signal, stake, error: message }, 'Trade failed');
        queueBotLog({
            bot_run_id: botRun.id,
            account_id: accountId,
            level: 'error',
            message: `Trade failed: ${message}`,
            data: { signal, stake, detail },
        });
    });
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

    const actorKey = getSymbolKey(botRun.accountId, botRun.config.symbol);
    const actor = symbolActors.get(actorKey);
    if (actor) {
        actor.removeRun(botRunId);
    }

    // Remove from active runs
    activeBotRuns.delete(botRunId);
    dropRiskConfig(botRunId);

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
 * Get the active backend bot run for an account (prefers running over paused).
 */
export function getActiveBackendRun(accountId: string): ActiveBotRun | null {
    let fallback: ActiveBotRun | null = null;
    for (const run of activeBotRuns.values()) {
        if (run.accountId !== accountId) continue;
        if (run.status === 'running') return run;
        if (!fallback) fallback = run;
    }
    return fallback;
}

/**
 * Stop the active backend bot run for an account, if any.
 */
export async function stopActiveBackendRun(accountId: string): Promise<ActiveBotRun | null> {
    const run = getActiveBackendRun(accountId);
    if (!run) return null;
    await stopBotRun(run.id);
    return run;
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
