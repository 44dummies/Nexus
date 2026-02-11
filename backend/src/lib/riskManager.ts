import { metrics } from './metrics';
import { classifySupabaseError, getSupabaseAdmin, withSupabaseRetry } from './supabaseAdmin';
import { riskLogger } from './logger';
import { clearPendingSettlement, recordSettlementUpdate, registerPendingSettlement } from './settlementSubscriptions';
import { decryptToken } from './sessionCrypto';
import { getOrCreateConnection, registerStreamingListener, sendMessage, sendMessageAsync, registerReconnectListener } from './wsManager';
import { getRiskCache, initializeRiskCache, recordTradeSettled, setOpenTradeState } from './riskCache';
import { record as recordObstacle } from './obstacleLog';
import { setComponentStatus } from './healthStatus';
import { isBehaviorBlocked } from './behaviorDetection';
import { auditRiskCheck } from './auditLogger';

interface RollingCounterConfig {
    windowMs: number;
}

class RollingCounter {
    private windowMs: number;
    private windowStart = 0;
    private count = 0;

    constructor(config: RollingCounterConfig) {
        this.windowMs = config.windowMs;
    }

    increment(now: number): number {
        if (now - this.windowStart > this.windowMs) {
            this.windowStart = now;
            this.count = 0;
        }
        this.count += 1;
        return this.count;
    }

    getCount(now: number): number {
        if (now - this.windowStart > this.windowMs) {
            this.windowStart = now;
            this.count = 0;
        }
        return this.count;
    }
}

export interface RiskLimits {
    maxOrderSize?: number;
    maxNotional?: number;
    maxExposure?: number;
    maxOrdersPerSecond?: number;
    maxOrdersPerMinute?: number;
    maxCancelsPerSecond?: number;
}

interface KillSwitchState {
    active: boolean;
    reason?: string;
    triggeredAt?: number;
    manual?: boolean;
}

type KillSwitchListener = (accountId: string | null, state: KillSwitchState) => void;

const perAccountOrderSec = new Map<string, RollingCounter>();
const perAccountOrderMin = new Map<string, RollingCounter>();
const perAccountCancelSec = new Map<string, RollingCounter>();
const perAccountRejectMin = new Map<string, RollingCounter>();
const perAccountReconnectMin = new Map<string, RollingCounter>();
const perAccountSlippageMin = new Map<string, RollingCounter>();

const killSwitchByAccount = new Map<string, KillSwitchState>();
const globalKillSwitch: KillSwitchState = { active: false };
const listeners = new Set<KillSwitchListener>();

const KILL_SWITCH_SETTINGS_KEY = 'kill_switch';
const KILL_SWITCH_GLOBAL_ACCOUNT = '__global__';

const REJECT_SPIKE_LIMIT = Math.max(1, Number(process.env.REJECT_SPIKE_LIMIT) || 5);
const RECONNECT_STORM_LIMIT = Math.max(1, Number(process.env.RECONNECT_STORM_LIMIT) || 10);
const SLIPPAGE_SPIKE_LIMIT = Math.max(1, Number(process.env.SLIPPAGE_SPIKE_LIMIT) || 5);
const DEFAULT_MAX_CANCELS_PER_SECOND = Math.max(1, Number(process.env.DEFAULT_MAX_CANCELS_PER_SECOND) || 20);
const KILL_SWITCH_AUTO_CLEAR_MS = Math.max(60000, Number(process.env.KILL_SWITCH_AUTO_CLEAR_MS) || 30 * 60 * 1000); // 30 min default

const LATENCY_BLOWOUT_P99_MS = Math.max(1, Number(process.env.LATENCY_BLOWOUT_P99_MS) || 500);
const LATENCY_BLOWOUT_WINDOW_MS = Math.max(1000, Number(process.env.LATENCY_BLOWOUT_WINDOW_MS) || 10000);
const LATENCY_BLOWOUT_BREACHES = Math.max(1, Number(process.env.LATENCY_BLOWOUT_BREACHES) || 3);
const RECONCILE_PORTFOLIO_TIMEOUT_MS = Math.max(1000, Number(process.env.RECONCILE_PORTFOLIO_TIMEOUT_MS) || 10000);
const KILL_SWITCH_FAIL_CLOSED = (process.env.KILL_SWITCH_FAIL_CLOSED || (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true';

const reconciledOpenContracts = new Map<string, Map<number, number>>();
const reconciliationListeners = new Set<string>();

let latencyBreaches = 0;

function getCounter(map: Map<string, RollingCounter>, key: string, windowMs: number) {
    let counter = map.get(key);
    if (!counter) {
        counter = new RollingCounter({ windowMs });
        map.set(key, counter);
    }
    return counter;
}

async function recordRiskEvent(accountId: string | null, eventType: string, detail?: string, metadata?: Record<string, unknown>) {
    try {
        await withSupabaseRetry('risk_events.insert', async (client) => await client.from('risk_events').insert({
            account_id: accountId,
            event_type: eventType,
            detail,
            metadata,
        }));
        metrics.counter('risk.event_persisted');
    } catch (error) {
        const info = classifySupabaseError(error);
        metrics.counter('risk.event_persist_error');
        riskLogger.error({ error: info.message, code: info.code, category: info.category }, 'Risk event persist failed');
    }
}

function toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function getKillSwitchSettingsAccountId(accountId: string | null): string {
    return accountId ?? KILL_SWITCH_GLOBAL_ACCOUNT;
}

async function persistKillSwitchState(accountId: string | null, state: KillSwitchState): Promise<void> {
    try {
        const now = new Date().toISOString();
        await withSupabaseRetry('settings.upsert.kill_switch', async (client) => await client.from('settings').upsert({
            account_id: getKillSwitchSettingsAccountId(accountId),
            key: KILL_SWITCH_SETTINGS_KEY,
            value: {
                active: state.active,
                reason: state.reason ?? null,
                triggeredAt: state.triggeredAt ?? null,
                manual: state.manual ?? null,
                clearedAt: state.active ? null : Date.now(),
            },
            updated_at: now,
        }, { onConflict: 'account_id,key' }));
        metrics.counter('risk.kill_switch_persisted');
    } catch (error) {
        const info = classifySupabaseError(error);
        metrics.counter('risk.kill_switch_persist_error');
        riskLogger.error({ error: info.message, code: info.code, category: info.category }, 'Kill switch persist failed');
    }
}

async function restoreKillSwitchState(): Promise<void> {
    const { client: supabaseAdmin } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        const detail = 'Kill switch restore skipped: Supabase not configured';
        riskLogger.warn(detail);
        recordObstacle('risk', 'Kill switch restore', detail, 'high', ['backend/src/lib/riskManager.ts']);
        if (KILL_SWITCH_FAIL_CLOSED) {
            triggerKillSwitch(null, 'KILL_SWITCH_STATE_UNKNOWN', false);
        }
        return;
    }

    const { data, error } = await supabaseAdmin
        .from('settings')
        .select('account_id, value')
        .eq('key', KILL_SWITCH_SETTINGS_KEY);

    if (error) {
        riskLogger.error({ error }, 'Kill switch restore failed');
        recordObstacle('risk', 'Kill switch restore', 'Supabase query failed', 'high', ['backend/src/lib/riskManager.ts']);
        if (KILL_SWITCH_FAIL_CLOSED) {
            triggerKillSwitch(null, 'KILL_SWITCH_STATE_UNKNOWN', false);
        }
        return;
    }

    const now = Date.now();
    for (const row of data || []) {
        const state = row.value && typeof row.value === 'object' ? row.value as KillSwitchState : null;
        if (!state?.active) continue;

        // Auto-expire non-manual kill switches older than TTL
        const age = typeof state.triggeredAt === 'number' ? now - state.triggeredAt : Infinity;
        if (!state.manual && age > KILL_SWITCH_AUTO_CLEAR_MS) {
            const accountId = row.account_id === KILL_SWITCH_GLOBAL_ACCOUNT ? null : row.account_id;
            riskLogger.info({ accountId: row.account_id, reason: state.reason, ageMs: age }, 'Auto-clearing expired kill switch on restore');
            persistKillSwitchState(accountId, { active: false }).catch((error) => {
                riskLogger.error({ error, accountId: row.account_id }, 'Expired kill switch clear persist failed');
            });
            continue;
        }

        if (row.account_id === KILL_SWITCH_GLOBAL_ACCOUNT) {
            Object.assign(globalKillSwitch, state);
            notifyKillSwitch(null, state);
        } else {
            killSwitchByAccount.set(row.account_id, state);
            notifyKillSwitch(row.account_id, state);
        }
    }
}

async function ensureRiskCacheEntry(accountId: string): Promise<void> {
    const existing = getRiskCache(accountId);
    if (existing) return;

    let balance = 10000;
    const { client: supabaseAdmin } = getSupabaseAdmin();
    if (supabaseAdmin) {
        const { data } = await supabaseAdmin
            .from('settings')
            .select('value')
            .eq('account_id', accountId)
            .eq('key', 'balance_snapshot')
            .maybeSingle();
        const snapshot = data?.value && typeof data.value === 'object'
            ? data.value as { balance?: number }
            : null;
        if (typeof snapshot?.balance === 'number') {
            balance = snapshot.balance;
        }
    }

    initializeRiskCache(accountId, { equity: balance });
}

function ensureReconciliationListener(accountId: string): void {
    if (reconciliationListeners.has(accountId)) return;

    const listener = (_accId: string, message: Record<string, unknown>) => {
        if (message.msg_type !== 'proposal_open_contract') return;
        const contract = message.proposal_open_contract as {
            contract_id?: number;
            is_sold?: boolean;
            profit?: number;
        };
        const contractId = typeof contract?.contract_id === 'number' ? contract.contract_id : null;
        if (contractId) {
            recordSettlementUpdate(accountId, contractId);
        }
        if (!contract?.is_sold) return;
        if (!contractId) return;
        const stake = reconciledOpenContracts.get(accountId)?.get(contractId);
        if (stake === undefined) return;
        const profit = toNumber(contract.profit) ?? 0;
        recordTradeSettled(accountId, stake, profit);
        reconciledOpenContracts.get(accountId)?.delete(contractId);
        clearPendingSettlement(accountId, contractId);
    };

    registerStreamingListener(accountId, listener);
    reconciliationListeners.add(accountId);
}

function updateReconciledSubscriptions(
    accountId: string,
    contracts: Array<{ contractId: number; stake: number }>
): void {
    const previous = reconciledOpenContracts.get(accountId);
    if (previous) {
        for (const contractId of previous.keys()) {
            clearPendingSettlement(accountId, contractId);
        }
    }

    if (contracts.length === 0) {
        reconciledOpenContracts.delete(accountId);
        return;
    }

    const map = new Map<number, number>();
    for (const contract of contracts) {
        map.set(contract.contractId, contract.stake);
    }
    reconciledOpenContracts.set(accountId, map);
    ensureReconciliationListener(accountId);

    for (const contractId of map.keys()) {
        registerPendingSettlement(accountId, contractId);
        sendMessageAsync(accountId, {
            proposal_open_contract: 1,
            contract_id: contractId,
            subscribe: 1,
        });
    }
}

async function reconcileOpenContracts(): Promise<void> {
    const { client: supabaseAdmin } = getSupabaseAdmin();
    if (!supabaseAdmin) {
        riskLogger.warn('Open contract reconciliation skipped: Supabase not configured');
        return;
    }

    const { data: sessions, error } = await supabaseAdmin
        .from('sessions')
        .select('account_id, token_encrypted');

    if (error) {
        riskLogger.error({ error }, 'Open contract reconciliation failed to load sessions');
        return;
    }

    for (const session of sessions || []) {
        const accountId = session.account_id as string | null;
        if (!accountId) continue;
        const token = decryptToken(session.token_encrypted as { iv?: string; tag?: string; ciphertext?: string } | null);
        if (!token) continue;

        await ensureRiskCacheEntry(accountId);

        try {
            await getOrCreateConnection(token, accountId);
        } catch (error) {
            riskLogger.warn({ accountId, error }, 'Open contract reconciliation: connection failed');
            continue;
        }

        try {
            const response = await sendMessage<{
                portfolio?: { contracts?: Array<{ contract_id?: number; is_sold?: boolean; buy_price?: number; purchase_price?: number; profit?: number }> };
                error?: { message: string };
            }>(accountId, { portfolio: 1 }, RECONCILE_PORTFOLIO_TIMEOUT_MS);

            if (response.error) {
                riskLogger.warn({ accountId, error: response.error.message }, 'Open contract reconciliation: portfolio error');
                continue;
            }

            const contracts = response.portfolio?.contracts ?? [];
            const openContracts: Array<{ contractId: number; stake: number }> = [];
            let openExposure = 0;

            for (const contract of contracts) {
                if (!contract || contract.is_sold) continue;
                const contractId = toNumber(contract.contract_id);
                if (contractId === null) continue;
                const stake = toNumber(contract.buy_price)
                    ?? toNumber(contract.purchase_price)
                    ?? 0;
                openContracts.push({ contractId, stake });
                openExposure += stake;
            }

            setOpenTradeState(accountId, openContracts.length, openExposure);
            updateReconciledSubscriptions(accountId, openContracts);
        } catch (error) {
            riskLogger.warn({ accountId, error }, 'Open contract reconciliation: portfolio request failed');
        }
    }
}

export function registerKillSwitchListener(listener: KillSwitchListener): void {
    listeners.add(listener);
}

function notifyKillSwitch(accountId: string | null, state: KillSwitchState): void {
    for (const listener of listeners) {
        try {
            listener(accountId, state);
        } catch (error) {
            riskLogger.error({ error }, 'Kill switch listener failed');
        }
    }
}

export function triggerKillSwitch(accountId: string | null, reason: string, manual: boolean = false): void {
    const existing = accountId ? killSwitchByAccount.get(accountId) : globalKillSwitch;
    if (existing?.active && existing.reason === reason) {
        return;
    }
    const state = {
        active: true,
        reason,
        triggeredAt: Date.now(),
        manual,
    };
    if (accountId) {
        killSwitchByAccount.set(accountId, state);
    } else {
        Object.assign(globalKillSwitch, state);
    }
    setComponentStatus('risk', 'error', `kill switch: ${reason}`);
    recordRiskEvent(accountId, 'kill_switch', reason, { manual }).catch((error) => {
        riskLogger.error({ error, accountId, reason }, 'Kill switch event persist failed');
    });
    persistKillSwitchState(accountId, state).catch((error) => {
        riskLogger.error({ error, accountId, reason }, 'Kill switch state persist failed');
    });
    metrics.counter('risk.kill_switch_triggered');
    notifyKillSwitch(accountId, state);
}

export function clearKillSwitch(accountId: string | null): void {
    if (accountId) {
        killSwitchByAccount.delete(accountId);
    } else {
        globalKillSwitch.active = false;
        globalKillSwitch.reason = undefined;
        globalKillSwitch.triggeredAt = undefined;
        globalKillSwitch.manual = undefined;
    }
    persistKillSwitchState(accountId, { active: false }).catch((error) => {
        riskLogger.error({ error, accountId }, 'Kill switch clear persist failed');
    });
    metrics.counter('risk.kill_switch_cleared');
    setComponentStatus('risk', 'ok');
    notifyKillSwitch(accountId, { active: false });
}

export function isKillSwitchActive(accountId: string): boolean {
    const now = Date.now();

    // Check account-level kill switch with inline TTL expiry
    const accountState = killSwitchByAccount.get(accountId);
    if (accountState?.active && !accountState.manual) {
        const age = typeof accountState.triggeredAt === 'number' ? now - accountState.triggeredAt : 0;
        if (age > KILL_SWITCH_AUTO_CLEAR_MS) {
            // Expired — clear asynchronously, don't block this trade
            clearKillSwitch(accountId);
            recordRiskEvent(accountId, 'kill_switch_auto_clear', accountState.reason ?? 'unknown', { ageMs: age }).catch(() => { });
            return globalKillSwitch.active === true;
        }
    }

    // Check global kill switch with inline TTL expiry
    if (globalKillSwitch.active && !globalKillSwitch.manual) {
        const age = typeof globalKillSwitch.triggeredAt === 'number' ? now - globalKillSwitch.triggeredAt : 0;
        if (age > KILL_SWITCH_AUTO_CLEAR_MS) {
            clearKillSwitch(null);
            recordRiskEvent(null, 'kill_switch_auto_clear', globalKillSwitch.reason ?? 'unknown', { ageMs: age }).catch(() => { });
            return accountState?.active === true;
        }
    }

    return globalKillSwitch.active || (accountState?.active ?? false);
}

export function preTradeCheck(accountId: string, stake: number, limits: RiskLimits): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const entry = getRiskCache(accountId);

    // Behavior detection: block if overtrading/revenge pause is active
    const behavior = isBehaviorBlocked(accountId);
    if (behavior.blocked) {
        auditRiskCheck(accountId, { allowed: false, reason: behavior.reason, stake, checks: { behaviorBlock: true } });
        return { allowed: false, reason: behavior.reason };
    }

    if (limits.maxOrderSize && stake > limits.maxOrderSize) {
        return { allowed: false, reason: 'MAX_ORDER_SIZE' };
    }

    if (limits.maxNotional && stake > limits.maxNotional) {
        return { allowed: false, reason: 'MAX_NOTIONAL' };
    }

    if (limits.maxExposure && entry?.openExposure !== undefined) {
        if (entry.openExposure + stake > limits.maxExposure) {
            return { allowed: false, reason: 'MAX_EXPOSURE' };
        }
    }

    if (limits.maxOrdersPerSecond) {
        const count = getCounter(perAccountOrderSec, accountId, 1000).increment(now);
        if (count > limits.maxOrdersPerSecond) {
            return { allowed: false, reason: 'ORDERS_PER_SECOND' };
        }
    }

    if (limits.maxOrdersPerMinute) {
        const count = getCounter(perAccountOrderMin, accountId, 60000).increment(now);
        if (count > limits.maxOrdersPerMinute) {
            return { allowed: false, reason: 'ORDERS_PER_MINUTE' };
        }
    }

    return { allowed: true };
}

export function recordCancel(accountId: string, limits?: RiskLimits): void {
    const maxCancels = limits?.maxCancelsPerSecond ?? DEFAULT_MAX_CANCELS_PER_SECOND;
    if (!maxCancels) return;
    const now = Date.now();
    const count = getCounter(perAccountCancelSec, accountId, 1000).increment(now);
    if (count > maxCancels) {
        metrics.counter('risk.cancel_spike');
        triggerKillSwitch(accountId, 'CANCEL_RATE_SPIKE', false);
    }
}

export function recordReject(accountId: string): void {
    const now = Date.now();
    const count = getCounter(perAccountRejectMin, accountId, 60000).increment(now);
    metrics.counter('risk.reject');
    if (count >= REJECT_SPIKE_LIMIT) {
        triggerKillSwitch(accountId, 'REJECT_SPIKE', false);
    }
}

export function recordSlippageReject(accountId: string): void {
    const now = Date.now();
    const count = getCounter(perAccountSlippageMin, accountId, 60000).increment(now);
    metrics.counter('risk.slippage_reject');
    if (count >= SLIPPAGE_SPIKE_LIMIT) {
        triggerKillSwitch(accountId, 'SLIPPAGE_SPIKE', false);
    }
}

export function recordReconnect(accountId: string): void {
    const now = Date.now();
    const count = getCounter(perAccountReconnectMin, accountId, 60000).increment(now);
    metrics.counter('risk.reconnect');
    if (count >= RECONNECT_STORM_LIMIT) {
        triggerKillSwitch(accountId, 'RECONNECT_STORM', false);
    }
}

export function recordStuckOrder(accountId: string, contractId: number): void {
    metrics.counter('risk.stuck_order');
    recordRiskEvent(accountId, 'stuck_order', 'Settlement timeout', { contractId }).catch((error) => {
        riskLogger.error({ error, accountId, contractId }, 'Stuck order event persist failed');
    });
}

export async function initRiskManager(): Promise<void> {
    await restoreKillSwitchState();
    await reconcileOpenContracts();
    setComponentStatus('risk', 'ok');

    const latencyTimer = setInterval(() => {
        const snapshot = metrics.snapshot();
        const latency = snapshot.histograms[LATENCY_METRICS_KEY]?.p99;
        if (typeof latency === 'number' && latency > LATENCY_BLOWOUT_P99_MS) {
            latencyBreaches += 1;
        } else {
            latencyBreaches = 0;
        }
        if (typeof latency === 'number') {
            metrics.histogram('risk.latency_p99_ms', latency);
        }
        metrics.gauge('risk.latency_breaches', latencyBreaches);
        if (latencyBreaches >= LATENCY_BLOWOUT_BREACHES) {
            triggerKillSwitch(null, 'LATENCY_BLOWOUT', false);
            latencyBreaches = 0;
        }
    }, LATENCY_BLOWOUT_WINDOW_MS);
    latencyTimer.unref();

    // Periodic auto-clear sweep for non-manual kill switches that exceeded TTL
    const autoClearTimer = setInterval(() => {
        const now = Date.now();
        for (const [accountId, state] of killSwitchByAccount.entries()) {
            if (!state.active || state.manual) continue;
            const age = typeof state.triggeredAt === 'number' ? now - state.triggeredAt : 0;
            if (age > KILL_SWITCH_AUTO_CLEAR_MS) {
                riskLogger.info({ accountId, reason: state.reason, ageMs: age }, 'Auto-clearing expired kill switch');
                clearKillSwitch(accountId);
                recordRiskEvent(accountId, 'kill_switch_auto_clear', state.reason ?? 'unknown', { ageMs: age }).catch(() => { });
            }
        }
        if (globalKillSwitch.active && !globalKillSwitch.manual) {
            const age = typeof globalKillSwitch.triggeredAt === 'number' ? now - globalKillSwitch.triggeredAt : 0;
            if (age > KILL_SWITCH_AUTO_CLEAR_MS) {
                riskLogger.info({ reason: globalKillSwitch.reason, ageMs: age }, 'Auto-clearing expired global kill switch');
                clearKillSwitch(null);
                recordRiskEvent(null, 'kill_switch_auto_clear', globalKillSwitch.reason ?? 'unknown', { ageMs: age }).catch(() => { });
            }
        }
    }, 60000); // Check every minute
    autoClearTimer.unref();

    registerReconnectListener((accountId) => {
        recordReconnect(accountId);
    });
}

const LATENCY_METRICS_KEY = 'latency.send_to_buy_ack_ms';
