import { getOrCreateConnection, sendMessage, WsError } from './wsManager';
import { metrics } from './metrics';
import { nowMs } from './latencyTracker';
import { recordCancel } from './riskManager';
import { setComponentStatus } from './healthStatus';

const APP_ID = process.env.DERIV_APP_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || '1089';
const LOW_LATENCY_MODE = (process.env.LOW_LATENCY_MODE || 'false') === 'true';

interface TokenBucketConfig {
    ratePerSec: number;
    burst: number;
}

export type ExecutionErrorCode =
    | 'THROTTLE'
    | 'PROPOSAL_REJECT'
    | 'BUY_REJECT'
    | 'SLIPPAGE_EXCEEDED'
    | 'REQUOTE_EXHAUSTED'
    | 'WS_TIMEOUT'
    | 'WS_AUTH'
    | 'WS_NETWORK'
    | 'UNKNOWN';

export class ExecutionError extends Error {
    code: ExecutionErrorCode;
    retryable: boolean;
    context?: Record<string, unknown>;
    cause?: Error;

    constructor(code: ExecutionErrorCode, message: string, options?: { retryable?: boolean; context?: Record<string, unknown>; cause?: Error }) {
        super(message);
        this.code = code;
        this.retryable = options?.retryable ?? false;
        this.context = options?.context;
        this.cause = options?.cause;
    }
}

class TokenBucket {
    private capacity: number;
    private tokens: number;
    private refillPerMs: number;
    private lastRefill: number;

    constructor(config: TokenBucketConfig) {
        this.capacity = Math.max(1, config.burst);
        this.tokens = this.capacity;
        this.refillPerMs = Math.max(0.0001, config.ratePerSec / 1000);
        this.lastRefill = nowMs();
    }

    private refill(now: number): void {
        const elapsed = now - this.lastRefill;
        if (elapsed <= 0) return;
        const refill = elapsed * this.refillPerMs;
        this.tokens = Math.min(this.capacity, this.tokens + refill);
        this.lastRefill = now;
    }

    tryConsume(amount: number = 1, now: number = nowMs()): boolean {
        this.refill(now);
        if (this.tokens >= amount) {
            this.tokens -= amount;
            return true;
        }
        return false;
    }

    nextAvailableAt(amount: number = 1, now: number = nowMs()): number {
        this.refill(now);
        if (this.tokens >= amount) return now;
        if (this.refillPerMs <= 0) return Number.POSITIVE_INFINITY;
        const deficit = amount - this.tokens;
        return now + (deficit / this.refillPerMs);
    }
}

interface AccountThrottle {
    proposalLimiter: TokenBucket;
    buyLimiter: TokenBucket;
}

const PROPOSAL_RATE = Math.max(1, Number(process.env.DERIV_PROPOSALS_PER_SEC) || (LOW_LATENCY_MODE ? 20 : 5));
const BUY_RATE = Math.max(1, Number(process.env.DERIV_BUYS_PER_SEC) || (LOW_LATENCY_MODE ? 10 : 2));
const PROPOSAL_BURST = Math.max(1, Number(process.env.DERIV_PROPOSAL_BURST) || (LOW_LATENCY_MODE ? 20 : 5));
const BUY_BURST = Math.max(1, Number(process.env.DERIV_BUY_BURST) || (LOW_LATENCY_MODE ? 10 : 2));
const THROTTLE_MAX_WAIT_MS = Math.max(0, Number(process.env.DERIV_THROTTLE_MAX_WAIT_MS) || (LOW_LATENCY_MODE ? 0 : 200));
const REQUOTE_MAX_ATTEMPTS = Math.max(0, Number(process.env.DERIV_REQUOTE_MAX_ATTEMPTS) || (LOW_LATENCY_MODE ? 0 : 2));
const REQUOTE_DELAY_MS = Math.max(0, Number(process.env.DERIV_REQUOTE_DELAY_MS) || (LOW_LATENCY_MODE ? 0 : 50));

const throttles = new Map<string, AccountThrottle>();

export function setThrottleForTest(accountId: string, throttle: AccountThrottle): void {
    throttles.set(accountId, throttle);
}

export function clearThrottleForTest(): void {
    throttles.clear();
}

type WsDeps = {
    getOrCreateConnection: typeof getOrCreateConnection;
    sendMessage: typeof sendMessage;
};

let wsDeps: WsDeps = {
    getOrCreateConnection,
    sendMessage,
};

export function setExecutionDepsForTest(overrides: Partial<WsDeps>): void {
    wsDeps = { ...wsDeps, ...overrides };
}

export function resetExecutionDepsForTest(): void {
    wsDeps = { getOrCreateConnection, sendMessage };
}

function getThrottle(accountId: string): AccountThrottle {
    let throttle = throttles.get(accountId);
    if (!throttle) {
        throttle = {
            proposalLimiter: new TokenBucket({ ratePerSec: PROPOSAL_RATE, burst: PROPOSAL_BURST }),
            buyLimiter: new TokenBucket({ ratePerSec: BUY_RATE, burst: BUY_BURST }),
        };
        throttles.set(accountId, throttle);
    }
    return throttle;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function throttleOrWait(limiter: TokenBucket, metricPrefix: string): Promise<void> {
    if (limiter.tryConsume()) return;
    const start = nowMs();
    const deadline = start + THROTTLE_MAX_WAIT_MS;

    while (true) {
        const now = nowMs();
        const nextAt = limiter.nextAvailableAt(1, now);
        if (!Number.isFinite(nextAt) || nextAt > deadline) {
            const retryAfterMs = Math.max(0, nextAt - now);
            metrics.counter(`${metricPrefix}.throttle_reject`);
            throw new ExecutionError('THROTTLE', 'Throttle limit reached', {
                retryable: true,
                context: { retryAfterMs, maxWaitMs: THROTTLE_MAX_WAIT_MS },
            });
        }
        const delay = Math.max(1, Math.min(nextAt - now, deadline - now));
        await sleep(delay);
        if (limiter.tryConsume()) {
            metrics.histogram(`${metricPrefix}.throttle_wait_ms`, nowMs() - start);
            return;
        }
        if (nowMs() >= deadline) {
            metrics.counter(`${metricPrefix}.throttle_reject`);
            throw new ExecutionError('THROTTLE', 'Throttle limit reached', {
                retryable: true,
                context: { maxWaitMs: THROTTLE_MAX_WAIT_MS },
            });
        }
    }
}

export interface ExecutionRequest {
    accountId: string;
    token: string;
    signal: 'CALL' | 'PUT';
    stake: number;
    symbol: string;
    duration: number;
    durationUnit: 't' | 's' | 'm' | 'h' | 'd';
    currency: string;
    entryMode?: 'HYBRID_LIMIT_MARKET' | 'MARKET';
    entryTargetPrice?: number;
    entrySlippagePct?: number;
    proposalTimeoutMs?: number;
    buyTimeoutMs?: number;
    requoteMaxAttempts?: number;
    requoteDelayMs?: number;
}

export interface ExecutionResult {
    proposal: {
        id: string;
        ask_price: number;
        spot?: number;
        payout?: number;
    };
    buy: {
        contract_id: number;
        buy_price: number;
        payout?: number;
    };
    proposalSentTs: number;
    proposalAckTs: number;
    buySentTs: number;
    buyAckTs: number;
    attempts: number;
}

export async function executeProposalAndBuy(request: ExecutionRequest): Promise<ExecutionResult> {
    const {
        accountId,
        token,
        signal,
        stake,
        symbol,
        duration,
        durationUnit,
        currency,
        entryMode = 'MARKET',
        entryTargetPrice,
        entrySlippagePct = 1.5,
        proposalTimeoutMs = 5000,
        buyTimeoutMs = 10000,
        requoteMaxAttempts = REQUOTE_MAX_ATTEMPTS,
        requoteDelayMs = REQUOTE_DELAY_MS,
    } = request;

    await wsDeps.getOrCreateConnection(token, accountId, APP_ID);
    const throttle = getThrottle(accountId);

    let attempt = 0;
    while (attempt <= requoteMaxAttempts) {
        attempt += 1;
        await throttleOrWait(throttle.proposalLimiter, 'execution.proposal');

        const proposalSentTs = nowMs();
        let proposalResponse: {
            proposal?: { id: string; ask_price: number; spot?: number; payout?: number };
            error?: { message: string };
        };
        try {
            proposalResponse = await wsDeps.sendMessage<{
                proposal?: { id: string; ask_price: number; spot?: number; payout?: number };
                error?: { message: string };
            }>(accountId, {
                proposal: 1,
                amount: stake,
                basis: 'stake',
                contract_type: signal,
                currency,
                duration,
                duration_unit: durationUnit,
                symbol,
            }, proposalTimeoutMs);
        } catch (error) {
            const wsErr = error as WsError;
            if (wsErr instanceof WsError) {
                metrics.counter('execution.proposal_ws_error');
                setComponentStatus('execution', 'degraded', wsErr.message);
                throw new ExecutionError(
                    wsErr.code === 'WS_AUTH' ? 'WS_AUTH' : wsErr.code === 'WS_TIMEOUT' ? 'WS_TIMEOUT' : 'WS_NETWORK',
                    wsErr.message,
                    { retryable: wsErr.retryable, context: wsErr.context, cause: wsErr }
                );
            }
            setComponentStatus('execution', 'degraded', 'proposal request failed');
            throw new ExecutionError('UNKNOWN', 'Proposal request failed', { cause: error as Error, retryable: true });
        }
        const proposalAckTs = nowMs();

        if (proposalResponse.error || !proposalResponse.proposal?.id) {
            metrics.counter('execution.proposal_reject');
            throw new ExecutionError('PROPOSAL_REJECT', proposalResponse.error?.message || 'Proposal rejected', {
                retryable: false,
                context: { error: proposalResponse.error?.message || null },
            });
        }

        const proposal = proposalResponse.proposal;

        if (
            entryMode === 'HYBRID_LIMIT_MARKET' &&
            typeof entryTargetPrice === 'number' &&
            Number.isFinite(entryTargetPrice) &&
            entryTargetPrice > 0
        ) {
            const checkPrice = proposal.ask_price;
            const maxPrice = entryTargetPrice * (1 + entrySlippagePct / 100);
            if (checkPrice > maxPrice) {
                metrics.counter('execution.requote');
                recordCancel(accountId);
                if (attempt <= requoteMaxAttempts) {
                    await sleep(requoteDelayMs);
                    continue;
                }
                const slippagePct = ((checkPrice - entryTargetPrice) / entryTargetPrice) * 100;
                throw new ExecutionError('SLIPPAGE_EXCEEDED', 'Slippage exceeded tolerance', {
                    retryable: false,
                    context: {
                        askPrice: checkPrice,
                        entryTargetPrice,
                        maxPrice,
                        slippagePct,
                        tolerancePct: entrySlippagePct,
                        quoteSnapshot: {
                            askPrice: proposal.ask_price,
                            spot: proposal.spot,
                            payout: proposal.payout,
                        },
                    },
                });
            }
        }

        await throttleOrWait(throttle.buyLimiter, 'execution.buy');
        const buySentTs = nowMs();
        let buyResponse: {
            buy?: { contract_id: number; buy_price: number; payout?: number };
            error?: { message: string };
        };
        try {
            buyResponse = await wsDeps.sendMessage<{
                buy?: { contract_id: number; buy_price: number; payout?: number };
                error?: { message: string };
            }>(accountId, {
                buy: proposal.id,
                price: proposal.ask_price,
            }, buyTimeoutMs);
        } catch (error) {
            const wsErr = error as WsError;
            if (wsErr instanceof WsError) {
                metrics.counter('execution.buy_ws_error');
                setComponentStatus('execution', 'degraded', wsErr.message);
                throw new ExecutionError(
                    wsErr.code === 'WS_AUTH' ? 'WS_AUTH' : wsErr.code === 'WS_TIMEOUT' ? 'WS_TIMEOUT' : 'WS_NETWORK',
                    wsErr.message,
                    { retryable: wsErr.retryable, context: wsErr.context, cause: wsErr }
                );
            }
            setComponentStatus('execution', 'degraded', 'buy request failed');
            throw new ExecutionError('UNKNOWN', 'Buy request failed', { cause: error as Error, retryable: true });
        }
        const buyAckTs = nowMs();

        if (buyResponse.error || !buyResponse.buy?.contract_id) {
            metrics.counter('execution.buy_reject');
            throw new ExecutionError('BUY_REJECT', buyResponse.error?.message || 'Buy rejected', {
                retryable: false,
                context: { error: buyResponse.error?.message || null },
            });
        }

        metrics.histogram('execution.requote_attempts', attempt);
        setComponentStatus('execution', 'ok');
        return {
            proposal,
            buy: buyResponse.buy,
            proposalSentTs,
            proposalAckTs,
            buySentTs,
            buyAckTs,
            attempts: attempt,
        };
    }

    metrics.counter('execution.requote_exhausted');
    setComponentStatus('execution', 'degraded', 'requote exhausted');
    throw new ExecutionError('REQUOTE_EXHAUSTED', 'Requote attempts exhausted', { retryable: true });
}
