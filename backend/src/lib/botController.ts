/**
 * Bot Controller
 * Manages bot run lifecycle on the backend.
 * Links: symbol → tick stream → strategy → trade executor
 */

import { EventEmitter } from 'events';
import { subscribeTicks, unsubscribeTicks, getTickWindowView, type TickData } from './tickStream';
import { calculateATR, evaluateStrategy, getRequiredTicks, UnknownStrategyError, type StrategyConfig, type TradeSignal } from './strategyEngine';
import { getRiskCache, initializeRiskCache } from './riskCache';
import { executeTradeServerFast } from '../trade';
import { classifySupabaseError, getSupabaseAdmin, withSupabaseRetry } from './supabaseAdmin';
import { botLogger } from './logger';
import { metrics } from './metrics';
import { LATENCY_METRICS, createLatencyTrace, nowMs, recordLatency } from './latencyTracker';
import { ensureMarketData, getImbalanceTopN, getMarketDataMode, getShortHorizonMomentum, getSpread } from './marketData';
import { isKillSwitchActive, registerKillSwitchListener, triggerKillSwitch } from './riskManager';
import { ExecutionError } from './executionEngine';
import { preTradeGate, PreTradeGateError } from './preTradeGate';
import { dropRiskConfig, primeRiskConfig } from './riskConfigCache';
import { persistenceQueue } from './persistenceQueue';
import type { TradeRiskConfig } from './riskConfig';
import { writePersistenceFallback } from './persistenceFallback';
import { record as recordObstacle } from './obstacleLog';
import { SmartLayer } from './smartLayer';

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
    entry?: {
        profileId?: string;
        mode?: 'HYBRID_LIMIT_MARKET' | 'MARKET';
        timeoutMs?: number;
        pollingMs?: number;
        slippagePct?: number;
        aggressiveness?: number;
        minEdgePct?: number;
    };
    /** Enable Smart Layer auto mode: regime detection + strategy switching */
    autoMode?: boolean;
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

// Import profit attribution from separate module to avoid circular deps
import { registerBotContract, registerProfitCallback, unregisterProfitCallback } from './botProfitAttribution';

const { client: supabaseAdmin } = getSupabaseAdmin();

const DEFAULT_MICROBATCH_SIZE = Math.max(1, Number(process.env.BOT_MICROBATCH_SIZE) || 1);
const DEFAULT_MICROBATCH_INTERVAL_MS = Math.max(0, Number(process.env.BOT_MICROBATCH_INTERVAL_MS) || 0);
const DEFAULT_STRATEGY_BUDGET_MS = Math.max(0, Number(process.env.STRATEGY_BUDGET_MS) || 1);
const ENABLE_STRATEGY_BUDGET = (process.env.ENABLE_STRATEGY_BUDGET || 'false') === 'true';
const BOT_ZOMBIE_CLEANUP_ENABLED = (process.env.BOT_ZOMBIE_CLEANUP_ENABLED || 'false') === 'true';
const BOT_ZOMBIE_CLEANUP_INTERVAL_MS = Math.max(60_000, Number(process.env.BOT_ZOMBIE_CLEANUP_INTERVAL_MS) || 10 * 60 * 1000);
const BOT_ZOMBIE_STALE_MS = Math.max(60_000, Number(process.env.BOT_ZOMBIE_STALE_MS) || 15 * 60 * 1000);

const symbolActors = new Map<string, SymbolActor>();
const botEvents = new EventEmitter();
botEvents.setMaxListeners(200);

/**
 * Reconcile bot runs on server startup (SEC: BOT-01)
 * Marks any "running" backend bots as stopped since they died with the process
 */
export async function reconcileBotRunsOnStartup(): Promise<void> {
    if (!supabaseAdmin) {
        botLogger.warn('Supabase not configured - skipping bot run reconciliation');
        return;
    }

    try {
        const now = new Date().toISOString();
        const { data, error } = await withSupabaseRetry('bot_runs.reconcile', async (client) => await client
            .from('bot_runs')
            .update({
                run_status: 'stopped',
                stopped_at: now,
            })
            .eq('backend_mode', true)
            .eq('run_status', 'running')
            .select('id'));

        if (error) {
            botLogger.error({ error }, 'Failed to reconcile stale bot runs');
            return;
        }

        const count = data?.length ?? 0;
        if (count > 0) {
            const ids = Array.isArray(data) ? data.map((d: { id: string }) => d.id) : [];
            botLogger.info({ count, ids }, 'Reconciled stale backend bot runs from previous process');
        }
    } catch (err) {
        const info = classifySupabaseError(err);
        botLogger.error({ error: info.message, code: info.code, category: info.category }, 'Error during bot run reconciliation');
    }
}

export function subscribeToBotEvents(botRunId: string, callback: (event: any) => void): () => void {
    const handler = (payload: any) => {
        if (payload.botRunId === botRunId) {
            callback(payload);
        }
    };
    botEvents.on('event', handler);
    return () => botEvents.off('event', handler);
}

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
    private static readonly MAX_PENDING_TICKS = 50;
    private static readonly STALE_TICK_MS = 5000;
    private staleDropCount = 0;

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

        // --- Stale tick filter ---
        const tickAge = Date.now() - (tick.receivedAtMs ?? Date.now());
        if (tickAge > SymbolActor.STALE_TICK_MS) {
            this.staleDropCount++;
            metrics.counter('tick.stale_drop');
            if (this.staleDropCount % 10 === 1) {
                botLogger.warn({
                    accountId: this.accountId,
                    symbol: this.symbol,
                    tickAge,
                    staleDrops: this.staleDropCount,
                }, 'Stale tick dropped');
            }
            return;
        }

        if (this.batchSize <= 1 && this.batchIntervalMs === 0) {
            this.processTick(tick);
            return;
        }

        // --- Queue pressure bound ---
        if (this.pendingTicks.length >= SymbolActor.MAX_PENDING_TICKS) {
            // Drop oldest ticks to make room
            const dropped = this.pendingTicks.splice(0, this.pendingTicks.length - SymbolActor.MAX_PENDING_TICKS + 1);
            metrics.counter('tick.queue_overflow_drop', dropped.length);
            botLogger.warn({
                accountId: this.accountId,
                symbol: this.symbol,
                dropped: dropped.length,
                queueDepth: this.pendingTicks.length,
            }, 'Tick queue overflow — dropped oldest');
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
            pauseBotRun(run.id, `Kill switch: ${state.reason ?? 'unknown'}`).catch((error) => {
                botLogger.error({ error, botRunId: run.id }, 'Failed to pause bot run on kill switch');
            });
        }
        return;
    }
    for (const run of activeBotRuns.values()) {
        pauseBotRun(run.id, `Kill switch: ${state.reason ?? 'unknown'}`).catch((error) => {
            botLogger.error({ error, botRunId: run.id }, 'Failed to pause bot run on kill switch');
        });
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

    // Register profit attribution callback so settlements update totalProfit
    registerProfitCallback(botRunId, (contractId, profit) => {
        botRun.totalProfit += profit;

        // Feed settlement into recovery engine
        const riskEntryForRecovery = getRiskCache(accountId);
        SmartLayer.onSettlement(accountId, profit, config.stake, {
            equity: riskEntryForRecovery?.equity ?? 0,
            lossStreak: riskEntryForRecovery?.lossStreak ?? 0,
            recentWinRate: (() => {
                const tel = SmartLayer.getTelemetry(accountId);
                return tel?.winRate ?? 0;
            })(),
            regimeConfidence: SmartLayer.getInstance().getRegimeState(accountId, config.symbol)?.confidence ?? 0,
            volatilityRatio: null, // Not available in settlement context
            lastWinTimeMs: profit >= 0 ? Date.now() : null,
            drawdownPct: riskEntryForRecovery
                ? Math.max(0, (riskEntryForRecovery.equityPeak - riskEntryForRecovery.equity) / Math.max(1, riskEntryForRecovery.equityPeak))
                : 0,
        });

        // Update recovery telemetry
        const recoverySnap = SmartLayer.getRecoverySnapshot(accountId);
        if (recoverySnap) {
            SmartLayer.updateTelemetry(accountId, {
                recoveryMode: recoverySnap.mode,
                recoveryDeficit: recoverySnap.deficit,
                recoveryRecovered: recoverySnap.recovered,
                recoveryEpisodes: recoverySnap.failedEpisodes + recoverySnap.successfulEpisodes,
            });
        }

        botEvents.emit('event', {
            type: 'log',
            botRunId,
            data: {
                bot_run_id: botRunId,
                account_id: accountId,
                level: 'result',
                message: `Settlement: ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}`,
                data: { contractId, profit, totalProfit: botRun.totalProfit },
            },
        });
    });

    primeRiskConfig(botRunId, accountId, config.risk ?? null);

    // Initialize Smart Layer auto mode if enabled
    if (config.autoMode) {
        SmartLayer.getInstance().enableAutoMode(accountId, config.symbol);
        botLogger.info({ botRunId, symbol: config.symbol }, 'Smart Layer auto mode enabled');
    }

    try {
        const actor = await getOrCreateSymbolActor(accountId, token, config.symbol);
        actor.addRun(botRunId);
    } catch (error) {
        activeBotRuns.delete(botRunId);
        dropRiskConfig(botRunId);
        unregisterProfitCallback(botRunId);
        if (config.autoMode) {
            SmartLayer.getInstance().disableAutoMode(accountId, config.symbol);
        }
        throw error;
    }

    botLogger.info({ botRunId, strategyId: config.strategyId, symbol: config.symbol }, 'Bot run started');

    // Update database
    if (supabaseAdmin) {
        try {
            const { error } = await withSupabaseRetry('bot_runs.start', async (client) => await client
                .from('bot_runs')
                .update({
                    run_status: 'running',
                    backend_mode: true,
                    started_at: botRun.startedAt.toISOString(),
                })
                .eq('id', botRunId));
            if (error) {
                botLogger.error({ error, botRunId }, 'Bot run update failed');
            }
        } catch (error) {
            const info = classifySupabaseError(error);
            botLogger.error({ error: info.message, code: info.code, category: info.category, botRunId }, 'Bot run update failed');
        }
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
    if (!supabaseAdmin) {
        writePersistenceFallback({ type: 'bot_log', payload }).catch((error) => {
            botLogger.error({ error, botRunId: payload.bot_run_id }, 'Bot log fallback write failed');
        });
        return;
    }
    persistenceQueue.enqueue(async () => {
        try {
            const { error } = await withSupabaseRetry('bot_logs.insert', async (client) => await client.from('bot_logs').insert(payload));
            if (error) {
                throw error;
            }
            metrics.counter('bot.logs.persisted');
        } catch (error) {
            const info = classifySupabaseError(error);
            metrics.counter('bot.logs.persist_error');
            if (info.code === '42P01') {
                recordObstacle('database', 'bot_logs table missing', 'Create bot_logs table or disable bot log persistence', 'high', ['backend/src/lib/botController.ts']);
            }
            botLogger.error({ error: info.message, code: info.code, category: info.category, botRunId: payload.bot_run_id }, 'Bot log persistence failed');
            if (info.category === 'connectivity') {
                await writePersistenceFallback({ type: 'bot_log', payload, error: info });
            }
            throw error as Error;
        }
    }, 'persistBotLog').catch((error) => {
        botLogger.warn({ error, botRunId: payload.bot_run_id }, 'Bot log enqueue failed');
    });

    botEvents.emit('event', {
        type: 'log',
        botRunId: payload.bot_run_id,
        data: payload
    });
}

/**
 * Handle incoming tick for a bot run.
 * When autoMode is enabled, the Smart Layer orchestrates:
 *   features → regime → param suggestion → strategy selection → strategy eval
 * When autoMode is disabled, the original manual strategy path is used.
 */
function handleTickForRun(botRun: ActiveBotRun, tick: TickData): void {
    if (botRun.status !== 'running') return;

    const { accountId, config } = botRun;
    if (isKillSwitchActive(accountId)) {
        pauseBotRun(botRun.id, 'Kill switch active').catch((error) => {
            botLogger.error({ error, botRunId: botRun.id }, 'Failed to pause bot run on kill switch');
        });
        return;
    }

    // --- Determine strategy ID (auto mode may override) ---
    let activeStrategyId = config.strategyId;
    const useAutoMode = config.autoMode === true;
    let smartCycle: ReturnType<SmartLayer['executeCycle']> | null = null;

    let requiredTicks: number;
    try {
        requiredTicks = getRequiredTicks(activeStrategyId, config.strategyConfig);
    } catch (error) {
        if (error instanceof UnknownStrategyError) {
            metrics.counter('strategy.unknown');
            botLogger.error({ botRunId: botRun.id, strategyId: activeStrategyId }, 'Unknown strategy configured');
            return;
        }
        throw error;
    }
    const prices = getTickWindowView(accountId, config.symbol, requiredTicks);

    if (!prices || prices.length < requiredTicks) {
        return;
    }

    // --- Smart Layer cycle (when auto mode is on) ---
    if (useAutoMode) {
        const sl = SmartLayer.getInstance();
        try {
            smartCycle = sl.executeCycle({
                accountId,
                symbol: config.symbol,
                prices,
                lastPrice: prices.get(prices.length - 1),
                lossStreak: getRiskCache(accountId)?.lossStreak ?? 0,
                tick: { quote: tick.quote, epoch: tick.epoch, receivedPerfMs: tick.receivedPerfMs ?? Date.now() },
            });

            // Smart Layer gated → skip this tick
            if (smartCycle.gated) {
                metrics.counter('smartlayer.gated');
                botLogger.debug({ botRunId: botRun.id, reason: smartCycle.gateReason }, 'Smart Layer gated tick');
                return;
            }

            // Use auto-selected strategy
            activeStrategyId = smartCycle.backendStrategyId;

            // Emit switch events
            if (smartCycle.switchEvent) {
                metrics.counter('smartlayer.strategy_switch');
                botLogger.info({
                    botRunId: botRun.id,
                    from: smartCycle.switchEvent.from,
                    to: smartCycle.switchEvent.to,
                    reason: smartCycle.switchEvent.reason,
                }, 'Smart Layer strategy switch');
                queueBotLog({
                    bot_run_id: botRun.id,
                    account_id: accountId,
                    level: 'info',
                    message: `Strategy switch: ${smartCycle.switchEvent.from} → ${smartCycle.switchEvent.to}`,
                    data: {
                        correlationId: smartCycle.switchEvent.correlationId,
                        regimeConfidence: smartCycle.switchEvent.metrics.regimeConfidence,
                        stableCycles: smartCycle.switchEvent.metrics.stableCycles,
                    },
                });
            }

            // Emit regime/decision telemetry to SSE
            botEvents.emit('event', {
                type: 'smartlayer',
                botRunId: botRun.id,
                data: {
                    regime: smartCycle.regime.current,
                    regimeConfidence: smartCycle.regime.confidence,
                    strategyId: smartCycle.strategyId,
                    riskGate: smartCycle.decision.params.riskGate,
                    correlationId: smartCycle.decision.correlationId,
                    cooldownMs: smartCycle.decision.params.cooldownMs,
                    maxConcurrent: smartCycle.decision.params.maxConcurrentTrades,
                    confidenceThreshold: smartCycle.decision.params.signalConfidenceThreshold,
                    recoveryMode: smartCycle.recoveryMode,
                    recoveryOverrides: smartCycle.recoveryOverrides,
                },
            });
        } catch (error) {
            // Smart Layer failure is non-fatal — fall back to manual strategy
            botLogger.error({ error, botRunId: botRun.id }, 'Smart Layer cycle failed — falling back to manual strategy');
            metrics.counter('smartlayer.error');
            activeStrategyId = config.strategyId;
            smartCycle = null;
        }
    }

    // --- Volatility guard (original) ---
    const volatilityThreshold = config.risk?.volatilityThreshold;
    if (typeof volatilityThreshold === 'number' && volatilityThreshold > 0) {
        const window = config.risk?.volatilityWindow ?? 20;
        const atr = calculateATR(prices, window);
        if (typeof atr === 'number' && atr > volatilityThreshold) {
            triggerKillSwitch(accountId, 'VOLATILITY_SPIKE', false);
            pauseBotRun(botRun.id, 'Volatility spike guard').catch((error) => {
                botLogger.error({ error, botRunId: botRun.id }, 'Failed to pause bot run on volatility spike guard');
            });
            return;
        }
    }

    // --- Cooldown: use Smart Layer's dynamic cooldown or config's static cooldown ---
    // Recovery does NOT manipulate cooldown — trade at full speed
    const effectiveCooldownMs = smartCycle?.decision.params.cooldownMs ?? config.cooldownMs;
    const now = Date.now();
    if (botRun.lastTradeAt && now - botRun.lastTradeAt < effectiveCooldownMs) {
        return;
    }

    const riskEntry = getRiskCache(accountId);
    const lossStreak = riskEntry?.lossStreak ?? 0;

    const latencyTrace = createLatencyTrace({
        tickReceivedTs: tick.receivedPerfMs,
    });

    const strategyStart = nowMs();
    latencyTrace.strategyStartTs = strategyStart;
    const microContext = activeStrategyId === 'microstructure'
        ? {
            imbalance: getImbalanceTopN(accountId, config.symbol, config.strategyConfig?.imbalanceLevels ?? 10),
            spread: getSpread(accountId, config.symbol),
            momentum: getShortHorizonMomentum(accountId, config.symbol, config.strategyConfig?.momentumWindowMs ?? 500),
            mode: getMarketDataMode(accountId, config.symbol),
        }
        : undefined;

    let evaluation;
    try {
        evaluation = evaluateStrategy(
            activeStrategyId,
            prices,
            config.strategyConfig,
            lossStreak,
            microContext
        );
    } catch (error) {
        if (error instanceof UnknownStrategyError) {
            metrics.counter('strategy.unknown');
            botLogger.error({ botRunId: botRun.id, strategyId: activeStrategyId }, 'Unknown strategy evaluation blocked');
            return;
        }
        throw error;
    }
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

    // --- Signal confidence: treat undefined as 0.0 (BLOCK) ---
    // Every strategy MUST provide a confidence score. If missing, it is blocked.
    const signalConfidence = typeof evaluation.confidence === 'number' ? evaluation.confidence : 0;

    // --- Smart Layer confidence filter ---
    if (smartCycle) {
        const recoveryBoost = smartCycle.recoveryOverrides?.confidenceBoost ?? 0;
        const effectiveThreshold = smartCycle.decision.params.signalConfidenceThreshold + recoveryBoost;
        if (signalConfidence < effectiveThreshold) {
            metrics.counter('smartlayer.confidence_filter');
            return;
        }
    }

    // --- Recovery precision gate: hard-block low-quality signals during recovery ---
    if (smartCycle?.recoveryOverrides) {
        if (signalConfidence < smartCycle.recoveryOverrides.precisionThreshold) {
            metrics.counter('recovery.precision_gate');
            return;
        }
    }

    metrics.counter(`strategy.signal.${evaluation.signal.toLowerCase()}`);

    let stake = config.stake;
    if (evaluation.stakeMultiplier) {
        stake = Math.max(0.35, stake * evaluation.stakeMultiplier);
    }
    // Apply recovery stake multiplier (anti-martingale scaling during recovery)
    if (smartCycle?.recoveryOverrides) {
        stake = Math.max(0.35, stake * smartCycle.recoveryOverrides.stakeMultiplier);
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
        const gateError = error instanceof PreTradeGateError ? error : null;
        const message = error instanceof Error ? error.message : 'Risk gate rejected';
        const reasons = gateError?.reasons ?? [];
        queueBotLog({
            bot_run_id: botRun.id,
            account_id: accountId,
            level: 'error',
            message: `Pre-trade gate blocked: ${message}`,
            data: {
                signal: evaluation.signal,
                stake,
                code: 'RISK_REJECT',
                reasons,
                correlationId: latencyTrace?.traceId ?? null,
            },
        });
        const hasHardLimit = reasons.some((reason) => (
            reason === 'DAILY_LOSS_LIMIT'
            || reason === 'DRAWDOWN_LIMIT'
            || reason === 'RISK_HALT'
            || reason === 'STOP_LOSS_REACHED'
        ));
        if (hasHardLimit || message.toLowerCase().includes('daily loss') || message.toLowerCase().includes('drawdown') || message.toLowerCase().includes('risk halt') || message.toLowerCase().includes('stop-loss')) {
            botLogger.warn({ botRunId: botRun.id, reason: message }, 'Bot risk halt');
            pauseBotRun(botRun.id, `Risk limit: ${message}`);
        }
        return;
    }

    recordLatency(LATENCY_METRICS.strategyToGate, latencyTrace.strategyEndTs, latencyTrace.gateStartTs);

    // --- Mark order in-flight (blocks strategy switching) ---
    if (useAutoMode) {
        SmartLayer.getInstance().markOrderInFlight(accountId, config.symbol);
    }

    executeTradeForRun(
        botRun,
        evaluation.signal,
        stake,
        latencyTrace,
        evaluation.detail,
        evaluation.confidence,
        evaluation.reasonCodes,
        gateResult,
        prices.get(prices.length - 1)
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
    preGate?: { stake: number; risk: TradeRiskConfig },
    currentPrice?: number,
): void {
    if (botRun.status !== 'running') return;

    const { accountId, accountType, token, config, currency } = botRun;

    botRun.lastTradeAt = Date.now();

    const correlationId = latencyTrace?.traceId;
    executeTradeServerFast(
        signal,
        {
            symbol: config.symbol,
            stake,
            duration: config.duration,
            durationUnit: config.durationUnit,
            botId: config.strategyId,
            botRunId: botRun.id,
            entryMode: config.entry?.mode || 'MARKET',
            entrySlippagePct: config.entry?.slippagePct,
            entryTargetPrice: currentPrice,
            correlationId,
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
        // Track the open contract for profit attribution on settlement
        registerBotContract(result.contractId, botRun.id);

        // Clear order-in-flight (unblocks Smart Layer strategy switching)
        if (config.autoMode) {
            SmartLayer.getInstance().clearOrderInFlight(accountId, config.symbol);
        }

        // Update Smart Layer telemetry
        SmartLayer.updateTelemetry(accountId, {
            totalTradesSession: botRun.tradesExecuted,
            totalProfitSession: botRun.totalProfit,
            lastTradeTimeMs: Date.now(),
            avgLatencyMs: result.executionTimeMs,
        });

        botLogger.info({
            botRunId: botRun.id,
            signal,
            contractId: result.contractId,
            executionTimeMs: result.executionTimeMs,
            correlationId,
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
                correlationId,
            },
        });
    }).catch((error) => {
        // Clear order-in-flight even on failure
        if (config.autoMode) {
            SmartLayer.getInstance().clearOrderInFlight(accountId, config.symbol);
        }

        const message = error instanceof Error ? error.message : 'Trade failed';
        const errorCode = error instanceof ExecutionError ? error.code : 'UNKNOWN';
        botLogger.error({ botRunId: botRun.id, signal, stake, error: message, code: errorCode, correlationId }, 'Trade failed');

        // Track error rate in telemetry
        const currentTelemetry = SmartLayer.getTelemetry(accountId);
        const totalTrades = (currentTelemetry?.totalTradesSession ?? 0) + 1;
        SmartLayer.updateTelemetry(accountId, {
            errorRate: Math.min(1, ((currentTelemetry?.errorRate ?? 0) * (totalTrades - 1) + 1) / totalTrades),
        });

        queueBotLog({
            bot_run_id: botRun.id,
            account_id: accountId,
            level: 'error',
            message: `Trade failed [${errorCode}]: ${message}`,
            data: { signal, stake, detail, correlationId, code: errorCode },
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
    botEvents.emit('event', { type: 'status', botRunId, status: 'paused', reason });

    if (supabaseAdmin) {
        try {
            const { error } = await withSupabaseRetry('bot_runs.pause', async (client) => await client
                .from('bot_runs')
                .update({
                    run_status: 'paused',
                    paused_reason: reason,
                })
                .eq('id', botRunId));
            if (error) {
                botLogger.error({ error, botRunId }, 'Bot run pause update failed');
            }
        } catch (error) {
            const info = classifySupabaseError(error);
            botLogger.error({ error: info.message, code: info.code, category: info.category, botRunId }, 'Bot run pause update failed');
        }
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
    botEvents.emit('event', { type: 'status', botRunId, status: 'running' });

    if (supabaseAdmin) {
        try {
            const { error } = await withSupabaseRetry('bot_runs.resume', async (client) => await client
                .from('bot_runs')
                .update({
                    run_status: 'running',
                    paused_reason: null,
                })
                .eq('id', botRunId));
            if (error) {
                botLogger.error({ error, botRunId }, 'Bot run resume update failed');
            }
        } catch (error) {
            const info = classifySupabaseError(error);
            botLogger.error({ error: info.message, code: info.code, category: info.category, botRunId }, 'Bot run resume update failed');
        }
    }
}

/**
 * Stop a bot run
 */
export async function stopBotRun(botRunId: string): Promise<void> {
    const botRun = activeBotRuns.get(botRunId);
    if (!botRun) return;

    botRun.status = 'stopped';

    // Clean up Smart Layer auto mode state
    if (botRun.config.autoMode) {
        SmartLayer.getInstance().disableAutoMode(botRun.accountId, botRun.config.symbol);
    }

    const actorKey = getSymbolKey(botRun.accountId, botRun.config.symbol);
    const actor = symbolActors.get(actorKey);
    if (actor) {
        actor.removeRun(botRunId);
    }

    // Remove from active runs
    activeBotRuns.delete(botRunId);
    dropRiskConfig(botRunId);
    unregisterProfitCallback(botRunId);

    botLogger.info({
        botRunId,
        tradesExecuted: botRun.tradesExecuted,
        totalProfit: botRun.totalProfit,
    }, 'Bot run stopped');
    botEvents.emit('event', { type: 'status', botRunId, status: 'stopped' });

    if (supabaseAdmin) {
        try {
            const { error } = await withSupabaseRetry('bot_runs.stop', async (client) => await client
                .from('bot_runs')
                .update({
                    run_status: 'stopped',
                    stopped_at: new Date().toISOString(),
                    trades_executed: botRun.tradesExecuted,
                    total_profit: botRun.totalProfit,
                })
                .eq('id', botRunId));
            if (error) {
                botLogger.error({ error, botRunId }, 'Bot run stop update failed');
            }
        } catch (error) {
            const info = classifySupabaseError(error);
            botLogger.error({ error: info.message, code: info.code, category: info.category, botRunId }, 'Bot run stop update failed');
        }
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

export function startZombieCleanupJob(): void {
    if (!BOT_ZOMBIE_CLEANUP_ENABLED) return;
    if (!supabaseAdmin) {
        recordObstacle('startup', 'Zombie cleanup', 'Supabase not configured for zombie cleanup', 'medium', ['backend/src/lib/botController.ts']);
        return;
    }
    recordObstacle('startup', 'Zombie cleanup', 'Zombie cleanup enabled without instance scoping; ensure single backend instance', 'medium', ['backend/src/lib/botController.ts']);
    const zombieTimer = setInterval(() => {
        cleanupZombieRuns().catch((error) => {
            botLogger.error({ error }, 'Zombie cleanup failed');
        });
    }, BOT_ZOMBIE_CLEANUP_INTERVAL_MS);
    zombieTimer.unref();
}

async function cleanupZombieRuns(): Promise<void> {
    if (!supabaseAdmin) return;
    const cutoff = new Date(Date.now() - BOT_ZOMBIE_STALE_MS).toISOString();
    try {
        const { data, error } = await withSupabaseRetry('bot_runs.zombie_scan', async (client) => await client
            .from('bot_runs')
            .select('id, started_at')
            .eq('backend_mode', true)
            .eq('run_status', 'running')
            .lt('started_at', cutoff));
        if (error) {
            botLogger.error({ error }, 'Zombie cleanup scan failed');
            return;
        }
        const staleRuns = (data || []).filter((run: { id: string }) => !activeBotRuns.has(run.id));
        if (staleRuns.length === 0) return;
        const ids = staleRuns.map((run: { id: string }) => run.id);
        const { error: stopError } = await withSupabaseRetry('bot_runs.zombie_stop', async (client) => await client
            .from('bot_runs')
            .update({ run_status: 'stopped', stopped_at: new Date().toISOString() })
            .in('id', ids));
        if (stopError) {
            botLogger.error({ error: stopError, ids }, 'Zombie cleanup stop failed');
            return;
        }
        botLogger.warn({ ids }, 'Zombie bot runs cleaned up');
    } catch (error) {
        const info = classifySupabaseError(error);
        botLogger.error({ error: info.message, code: info.code, category: info.category }, 'Zombie cleanup failed');
    }
}

// Test helpers
export function setBotRunForTest(run: ActiveBotRun): void {
    activeBotRuns.set(run.id, run);
}

export function clearBotRunsForTest(): void {
    activeBotRuns.clear();
}
