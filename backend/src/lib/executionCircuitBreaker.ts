/**
 * Execution Circuit Breaker
 *
 * Prevents runaway trade execution failures from hammering the Deriv API
 * when the system is in a degraded state (e.g., network issues, API outage).
 *
 * States:
 * - CLOSED: Normal operation, trades flow through
 * - OPEN: Failures exceeded threshold, all trades blocked
 * - HALF_OPEN: After cooldown, allow a single probe trade to test recovery
 *
 * Transitions:
 *   CLOSED → OPEN: consecutiveFailures >= failureThreshold
 *   OPEN → HALF_OPEN: after cooldownMs elapsed
 *   HALF_OPEN → CLOSED: probe trade succeeds
 *   HALF_OPEN → OPEN: probe trade fails (resets cooldown)
 */

import { metrics } from './metrics';
import { tradeLogger } from './logger';
import { recordObstacle } from './obstacleLog';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface CircuitBreakerState {
    state: CircuitState;
    consecutiveFailures: number;
    totalFailures: number;
    totalSuccesses: number;
    lastFailureTime: number | null;
    lastSuccessTime: number | null;
    openedAt: number | null;
    halfOpenAt: number | null;
}

interface CircuitBreakerConfig {
    /** Number of consecutive failures before opening circuit */
    failureThreshold: number;
    /** How long to stay open before allowing a probe (ms) */
    cooldownMs: number;
    /** How long a failure is considered "recent" for threshold counting (ms) */
    failureWindowMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
    failureThreshold: Math.max(2, Number(process.env.EXEC_CB_FAILURE_THRESHOLD) || 5),
    cooldownMs: Math.max(5000, Number(process.env.EXEC_CB_COOLDOWN_MS) || 30_000),
    failureWindowMs: Math.max(10_000, Number(process.env.EXEC_CB_FAILURE_WINDOW_MS) || 120_000),
};

// Per-account circuit breakers
const breakers = new Map<string, CircuitBreakerState>();

function getOrCreate(accountId: string): CircuitBreakerState {
    let cb = breakers.get(accountId);
    if (!cb) {
        cb = {
            state: 'CLOSED',
            consecutiveFailures: 0,
            totalFailures: 0,
            totalSuccesses: 0,
            lastFailureTime: null,
            lastSuccessTime: null,
            openedAt: null,
            halfOpenAt: null,
        };
        breakers.set(accountId, cb);
    }
    return cb;
}

/**
 * Check if a trade should be allowed through the circuit breaker.
 * Returns { allowed: true } or { allowed: false, reason, retryAfterMs }.
 */
export function checkExecutionCircuit(
    accountId: string,
    config: CircuitBreakerConfig = DEFAULT_CONFIG
): { allowed: true } | { allowed: false; reason: string; state: CircuitState; retryAfterMs: number } {
    const cb = getOrCreate(accountId);
    const now = Date.now();

    switch (cb.state) {
        case 'CLOSED':
            return { allowed: true };

        case 'OPEN': {
            const elapsed = now - (cb.openedAt ?? now);
            if (elapsed >= config.cooldownMs) {
                // Transition to HALF_OPEN
                cb.state = 'HALF_OPEN';
                cb.halfOpenAt = now;
                metrics.counter('execution_cb.half_open');
                tradeLogger.info({ accountId }, 'Execution circuit breaker → HALF_OPEN (probe allowed)');
                return { allowed: true };
            }
            const retryAfterMs = config.cooldownMs - elapsed;
            return {
                allowed: false,
                reason: `Execution circuit OPEN — ${cb.consecutiveFailures} consecutive failures. Retry in ${Math.ceil(retryAfterMs / 1000)}s`,
                state: 'OPEN',
                retryAfterMs,
            };
        }

        case 'HALF_OPEN':
            // Allow single probe trade through
            return { allowed: true };
    }
}

/**
 * Record a successful execution (resets circuit to CLOSED)
 */
export function recordExecutionSuccess(accountId: string): void {
    const cb = getOrCreate(accountId);
    const prevState = cb.state;

    cb.consecutiveFailures = 0;
    cb.totalSuccesses += 1;
    cb.lastSuccessTime = Date.now();

    if (prevState !== 'CLOSED') {
        cb.state = 'CLOSED';
        cb.openedAt = null;
        cb.halfOpenAt = null;
        metrics.counter('execution_cb.closed');
        tradeLogger.info({ accountId, prevState }, 'Execution circuit breaker → CLOSED (success)');
    }
}

/**
 * Record an execution failure
 */
export function recordExecutionFailure(
    accountId: string,
    errorCode?: string,
    config: CircuitBreakerConfig = DEFAULT_CONFIG
): void {
    const cb = getOrCreate(accountId);
    const now = Date.now();

    cb.totalFailures += 1;
    cb.lastFailureTime = now;

    // If failure window expired, reset consecutive counter
    if (cb.lastSuccessTime && (now - cb.lastSuccessTime) < config.failureWindowMs) {
        cb.consecutiveFailures += 1;
    } else if (!cb.lastSuccessTime) {
        cb.consecutiveFailures += 1;
    } else {
        // Last success was outside window — this might be a fresh failure run
        cb.consecutiveFailures += 1;
    }

    metrics.counter('execution_cb.failure');

    switch (cb.state) {
        case 'CLOSED':
            if (cb.consecutiveFailures >= config.failureThreshold) {
                cb.state = 'OPEN';
                cb.openedAt = now;
                metrics.counter('execution_cb.open');
                tradeLogger.warn({
                    accountId,
                    consecutiveFailures: cb.consecutiveFailures,
                    errorCode,
                    threshold: config.failureThreshold,
                }, 'Execution circuit breaker → OPEN');

                recordObstacle(
                    'execution',
                    'Circuit Breaker Opened',
                    `Execution circuit opened after ${cb.consecutiveFailures} consecutive failures (code: ${errorCode ?? 'unknown'})`,
                    'high'
                );
            }
            break;

        case 'HALF_OPEN':
            // Probe failed — back to OPEN with fresh cooldown
            cb.state = 'OPEN';
            cb.openedAt = now;
            metrics.counter('execution_cb.probe_failed');
            tradeLogger.warn({ accountId, errorCode }, 'Execution circuit breaker probe failed → OPEN');
            break;

        // Already OPEN — do nothing
    }
}

/**
 * Get the current circuit breaker state for an account
 */
export function getCircuitState(accountId: string): CircuitBreakerState & { config: CircuitBreakerConfig } {
    return { ...getOrCreate(accountId), config: DEFAULT_CONFIG };
}

/**
 * Reset the circuit breaker for an account (e.g., manual override)
 */
export function resetCircuitBreaker(accountId: string): void {
    breakers.delete(accountId);
    metrics.counter('execution_cb.manual_reset');
    tradeLogger.info({ accountId }, 'Execution circuit breaker manually reset');
}

/**
 * Reset all circuit breakers
 */
export function resetAllCircuitBreakers(): void {
    breakers.clear();
}

// ==================== EXPORTS FOR TESTING ====================

export const __test = {
    breakers,
    DEFAULT_CONFIG,
    getOrCreate,
};
