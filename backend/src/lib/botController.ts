/**
 * Bot Controller
 * Manages bot run lifecycle on the backend.
 * Links: symbol → tick stream → strategy → trade executor
 */

import { subscribeTicks, unsubscribeAll, getTickBuffer, getLastTick } from './tickStream';
import { evaluateStrategy, getRequiredTicks, getStrategyName, type StrategyConfig, type TradeSignal } from './strategyEngine';
import { getRiskCache, initializeRiskCache, evaluateCachedRisk, recordTradeOpened } from './riskCache';
import { executeTradeServerFast, type TradeResultFast } from '../trade';
import { getSupabaseAdmin } from './supabaseAdmin';
import { botLogger } from './logger';

interface BotRunConfig {
    strategyId: string;
    symbol: string;
    stake: number;
    maxStake?: number;
    duration: number;
    durationUnit: 't' | 's' | 'm' | 'h' | 'd';
    cooldownMs: number;
    strategyConfig?: StrategyConfig;
    risk?: {
        dailyLossLimitPct?: number;
        drawdownLimitPct?: number;
        maxConsecutiveLosses?: number;
        maxConcurrentTrades?: number;
        lossCooldownMs?: number;
    };
}

interface ActiveBotRun {
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

// Cleanup timeout handles
const cleanupHandles = new Map<string, ReturnType<typeof setTimeout>>();

const { client: supabaseAdmin } = getSupabaseAdmin();

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

    // Subscribe to tick stream
    await subscribeTicks(accountId, token, config.symbol, (tick) => {
        handleTick(botRunId, tick.quote);
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

/**
 * Handle incoming tick for a bot run
 */
function handleTick(botRunId: string, price: number): void {
    const botRun = activeBotRuns.get(botRunId);
    if (!botRun || botRun.status !== 'running') return;

    const { accountId, config } = botRun;
    const prices = getTickBuffer(accountId, config.symbol);

    // Check if we have enough ticks
    const requiredTicks = getRequiredTicks(config.strategyId, config.strategyConfig);
    if (prices.length < requiredTicks) {
        return;
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
    const evaluation = evaluateStrategy(
        config.strategyId,
        prices,
        config.strategyConfig,
        lossStreak
    );

    if (!evaluation.signal) return;

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
    executeTrade(botRunId, evaluation.signal, stake, evaluation.detail);
}

/**
 * Execute a trade for a bot run
 */
async function executeTrade(
    botRunId: string,
    signal: TradeSignal,
    stake: number,
    detail?: string
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
            }
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
