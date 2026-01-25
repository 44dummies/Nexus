import { getOrCreateConnection, sendMessage } from './wsManager';
import { metrics } from './metrics';
import { nowMs } from './latencyTracker';
import { recordCancel } from './riskManager';

const APP_ID = process.env.DERIV_APP_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || '1089';

interface TokenBucketConfig {
    ratePerSec: number;
    burst: number;
}

export class ExecutionError extends Error {
    code: string;
    meta?: Record<string, unknown>;

    constructor(code: string, message: string, meta?: Record<string, unknown>) {
        super(message);
        this.code = code;
        this.meta = meta;
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

    tryConsume(amount: number = 1): boolean {
        const now = nowMs();
        const elapsed = now - this.lastRefill;
        if (elapsed > 0) {
            const refill = elapsed * this.refillPerMs;
            this.tokens = Math.min(this.capacity, this.tokens + refill);
            this.lastRefill = now;
        }
        if (this.tokens >= amount) {
            this.tokens -= amount;
            return true;
        }
        return false;
    }
}

interface AccountThrottle {
    proposalLimiter: TokenBucket;
    buyLimiter: TokenBucket;
}

const PROPOSAL_RATE = Math.max(1, Number(process.env.DERIV_PROPOSALS_PER_SEC) || 5);
const BUY_RATE = Math.max(1, Number(process.env.DERIV_BUYS_PER_SEC) || 2);
const PROPOSAL_BURST = Math.max(1, Number(process.env.DERIV_PROPOSAL_BURST) || 5);
const BUY_BURST = Math.max(1, Number(process.env.DERIV_BUY_BURST) || 2);
const THROTTLE_MAX_WAIT_MS = Math.max(0, Number(process.env.DERIV_THROTTLE_MAX_WAIT_MS) || 200);
const REQUOTE_MAX_ATTEMPTS = Math.max(0, Number(process.env.DERIV_REQUOTE_MAX_ATTEMPTS) || 2);
const REQUOTE_DELAY_MS = Math.max(0, Number(process.env.DERIV_REQUOTE_DELAY_MS) || 50);

const throttles = new Map<string, AccountThrottle>();

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
    while (nowMs() - start < THROTTLE_MAX_WAIT_MS) {
        await sleep(5);
        if (limiter.tryConsume()) {
            metrics.histogram(`${metricPrefix}.throttle_wait_ms`, nowMs() - start);
            return;
        }
    }
    metrics.counter(`${metricPrefix}.throttle_reject`);
    throw new ExecutionError('THROTTLE', 'Throttle limit reached');
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

    await getOrCreateConnection(token, accountId, APP_ID);
    const throttle = getThrottle(accountId);

    let attempt = 0;
    while (attempt <= requoteMaxAttempts) {
        attempt += 1;
        await throttleOrWait(throttle.proposalLimiter, 'execution.proposal');

        const proposalSentTs = nowMs();
        const proposalResponse = await sendMessage<{
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
        const proposalAckTs = nowMs();

        if (proposalResponse.error || !proposalResponse.proposal?.id) {
            metrics.counter('execution.proposal_reject');
            throw new ExecutionError('PROPOSAL_REJECT', proposalResponse.error?.message || 'Proposal rejected');
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
                    askPrice: checkPrice,
                    entryTargetPrice,
                    maxPrice,
                    slippagePct,
                    tolerancePct: entrySlippagePct,
                });
            }
        }

        await throttleOrWait(throttle.buyLimiter, 'execution.buy');
        const buySentTs = nowMs();
        const buyResponse = await sendMessage<{
            buy?: { contract_id: number; buy_price: number; payout?: number };
            error?: { message: string };
        }>(accountId, {
            buy: proposal.id,
            price: proposal.ask_price,
        }, buyTimeoutMs);
        const buyAckTs = nowMs();

        if (buyResponse.error || !buyResponse.buy?.contract_id) {
            metrics.counter('execution.buy_reject');
            throw new ExecutionError('BUY_REJECT', buyResponse.error?.message || 'Buy rejected');
        }

        metrics.histogram('execution.requote_attempts', attempt);
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

    throw new ExecutionError('REQUOTE_EXHAUSTED', 'Requote attempts exhausted');
}
