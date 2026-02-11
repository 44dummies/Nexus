/**
 * Deep Audit Logger
 * Structured, non-blocking audit trail for every decision in the trading pipeline.
 * Uses Pino for structured logging + optional Supabase persistence for queryable history.
 */

import { logger } from './logger';
import { persistenceQueue } from './persistenceQueue';
import { withSupabaseRetry, classifySupabaseError } from './supabaseAdmin';
import { metrics } from './metrics';

// ==================== TYPES ====================

export type AuditEventType =
    | 'strategy_decision'
    | 'risk_check'
    | 'trade_execution'
    | 'settlement'
    | 'param_change'
    | 'kill_switch'
    | 'config_change'
    | 'behavior_alert'
    | 'recovery_event'
    | 'backtest_run';

export interface AuditEvent {
    eventType: AuditEventType;
    accountId: string | null;
    timestamp: number;
    data: Record<string, unknown>;
    outcome: 'success' | 'failure' | 'skipped' | 'blocked' | 'info';
    requestId?: string;
    botRunId?: string | null;
    durationMs?: number;
    /** Optional error details if outcome is failure */
    error?: { message: string; code?: string; stack?: string };
}

// ==================== CONFIG ====================

const PERSIST_TO_DB = (process.env.AUDIT_PERSIST_DB || 'false') === 'true';
const LOG_LEVEL = process.env.AUDIT_LOG_LEVEL || 'info';

// ==================== LOGGER ====================

const auditLog = logger.child({ module: 'audit' });

// ==================== IN-MEMORY RING BUFFER ====================

const BUFFER_SIZE = 500;
const recentEvents: AuditEvent[] = [];

function addToBuffer(event: AuditEvent): void {
    recentEvents.push(event);
    if (recentEvents.length > BUFFER_SIZE) {
        recentEvents.shift();
    }
}

// ==================== CORE API ====================

/**
 * Record an audit event. Non-blocking — logs immediately and optionally persists to DB.
 */
export function audit(event: AuditEvent): void {
    const enriched: AuditEvent = {
        ...event,
        timestamp: event.timestamp || Date.now(),
    };

    // Structured log (always)
    const logData = {
        eventType: enriched.eventType,
        accountId: enriched.accountId,
        outcome: enriched.outcome,
        botRunId: enriched.botRunId,
        requestId: enriched.requestId,
        durationMs: enriched.durationMs,
        ...enriched.data,
    };

    if (enriched.outcome === 'failure' && enriched.error) {
        auditLog.error({ ...logData, error: enriched.error }, `AUDIT:${enriched.eventType}`);
    } else if (LOG_LEVEL === 'debug') {
        auditLog.debug(logData, `AUDIT:${enriched.eventType}`);
    } else {
        auditLog.info(logData, `AUDIT:${enriched.eventType}`);
    }

    addToBuffer(enriched);
    metrics.counter(`audit.${enriched.eventType}`);

    // Optional DB persistence (fire-and-forget)
    if (PERSIST_TO_DB) {
        persistAuditEvent(enriched);
    }
}

/**
 * Convenience: audit a strategy decision
 */
export function auditStrategyDecision(
    accountId: string,
    data: {
        strategy: string;
        signal: string | null;
        confidence: number | undefined;
        detail?: string;
        blocked?: boolean;
        blockReason?: string;
    },
    botRunId?: string | null,
): void {
    audit({
        eventType: 'strategy_decision',
        accountId,
        timestamp: Date.now(),
        data,
        outcome: data.blocked ? 'blocked' : data.signal ? 'success' : 'skipped',
        botRunId,
    });
}

/**
 * Convenience: audit a risk check
 */
export function auditRiskCheck(
    accountId: string,
    data: {
        allowed: boolean;
        reason?: string;
        stake: number;
        checks: Record<string, unknown>;
    },
): void {
    audit({
        eventType: 'risk_check',
        accountId,
        timestamp: Date.now(),
        data,
        outcome: data.allowed ? 'success' : 'blocked',
    });
}

/**
 * Convenience: audit a trade settlement
 */
export function auditSettlement(
    accountId: string,
    data: {
        contractId: number;
        profit: number;
        symbol?: string;
        direction?: string;
        stake?: number;
    },
    botRunId?: string | null,
): void {
    audit({
        eventType: 'settlement',
        accountId,
        timestamp: Date.now(),
        data,
        outcome: data.profit >= 0 ? 'success' : 'failure',
        botRunId,
    });
}

/**
 * Get recent audit events (from in-memory buffer)
 */
export function getRecentAuditEvents(
    filters?: {
        accountId?: string;
        eventType?: AuditEventType;
        limit?: number;
        since?: number;
    },
): AuditEvent[] {
    let events = [...recentEvents];

    if (filters?.accountId) {
        events = events.filter(e => e.accountId === filters.accountId);
    }
    if (filters?.eventType) {
        events = events.filter(e => e.eventType === filters.eventType);
    }
    if (filters?.since) {
        events = events.filter(e => e.timestamp >= filters.since!);
    }

    // Most recent first
    events.reverse();

    const limit = filters?.limit ?? 100;
    return events.slice(0, limit);
}

/**
 * Query audit events from Supabase (if persistence is enabled)
 */
export async function queryAuditEvents(
    accountId: string,
    filters?: {
        eventType?: AuditEventType;
        startDate?: string;
        endDate?: string;
        limit?: number;
        offset?: number;
    },
): Promise<{ events: Record<string, unknown>[]; total: number }> {
    try {
        const { data, error, count } = await withSupabaseRetry('audit_log.select', async (client) => {
            let query = client
                .from('audit_log')
                .select('*', { count: 'exact' })
                .eq('account_id', accountId)
                .order('created_at', { ascending: false });

            if (filters?.eventType) {
                query = query.eq('event_type', filters.eventType);
            }
            if (filters?.startDate) {
                query = query.gte('created_at', filters.startDate);
            }
            if (filters?.endDate) {
                query = query.lte('created_at', filters.endDate);
            }

            const limit = filters?.limit ?? 50;
            const offset = filters?.offset ?? 0;
            query = query.range(offset, offset + limit - 1);

            return await query;
        });

        if (error) throw error;
        return { events: (data as Record<string, unknown>[]) ?? [], total: count ?? 0 };
    } catch (error) {
        const info = classifySupabaseError(error);
        auditLog.error({ error: info.message }, 'Failed to query audit log');
        return { events: [], total: 0 };
    }
}

// ==================== INTERNAL ====================

function persistAuditEvent(event: AuditEvent): void {
    // Fire-and-forget via persistence queue
    persistenceQueue.enqueue(async () => {
        try {
            const { error } = await withSupabaseRetry('audit_log.insert', async (client) =>
                await client.from('audit_log').insert({
                    account_id: event.accountId,
                    event_type: event.eventType,
                    outcome: event.outcome,
                    data: event.data,
                    error_info: event.error ?? null,
                    bot_run_id: event.botRunId ?? null,
                    request_id: event.requestId ?? null,
                    duration_ms: event.durationMs ?? null,
                    created_at: new Date(event.timestamp).toISOString(),
                })
            );
            if (error) throw error;
            metrics.counter('audit.persist_ok');
        } catch (error) {
            const info = classifySupabaseError(error);
            metrics.counter('audit.persist_error');
            auditLog.warn({ error: info.message }, 'Audit log persistence failed (non-fatal)');
        }
    }, 'persistAuditEvent').catch(() => {
        // Swallow — audit persistence must never crash the system
    });
}

// ==================== EXPORTS FOR TESTING ====================

export const __test = {
    recentEvents,
    addToBuffer,
    BUFFER_SIZE,
};
