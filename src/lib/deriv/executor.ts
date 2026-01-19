import { useTradingStore } from '@/store/tradingStore';
import type { TradeSignal } from '@/lib/bot/types';

type DurationUnit = 't' | 'm' | 's' | 'h' | 'd';

interface ExecuteTradeParams {
    ws: WebSocket;
    stake: number;
    symbol: string;
    duration?: number;
    durationUnit?: DurationUnit;
    currency?: string;
}

interface ProposalResponse {
    msg_type: 'proposal';
    proposal: {
        id: string;
        ask_price: number;
        payout: number;
    };
    error?: {
        message?: string;
        code?: string;
    };
}

interface BuyResponse {
    msg_type: 'buy';
    buy: {
        contract_id: number;
        buy_price: number;
        payout: number;
    };
    error?: {
        message?: string;
        code?: string;
    };
}

let nextReqId = 1;
const settledContracts = new Set<number>();

function getNextReqId() {
    const reqId = nextReqId;
    nextReqId += 1;
    return reqId;
}

function sendDerivRequest<T>(
    ws: WebSocket,
    payload: Record<string, unknown>,
    expectedMsgType: string,
    timeoutMs = 10_000
): Promise<T> {
    const reqId = getNextReqId();
    const request = { ...payload, req_id: reqId };

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('Deriv request timed out.'));
        }, timeoutMs);

        const handleMessage = (event: MessageEvent) => {
            let data: { req_id?: number; msg_type?: string; error?: { message?: string; code?: string } };
            try {
                data = JSON.parse(event.data);
            } catch {
                return;
            }

            if (data.req_id !== reqId) return;

            cleanup();

            if (data.error) {
                reject(new Error(data.error.message || data.error.code || 'Deriv API error.'));
                return;
            }

            if (expectedMsgType && data.msg_type !== expectedMsgType) {
                reject(new Error(`Unexpected message type: ${data.msg_type}`));
                return;
            }

            resolve(data as T);
        };

        const cleanup = () => {
            clearTimeout(timeout);
            ws.removeEventListener('message', handleMessage);
        };

        ws.addEventListener('message', handleMessage);
        ws.send(JSON.stringify(request));
    });
}

function subscribeToContract(ws: WebSocket, contractId: number) {
    if (!Number.isFinite(contractId) || settledContracts.has(contractId)) return;

    ws.send(JSON.stringify({
        proposal_open_contract: 1,
        contract_id: contractId,
        subscribe: 1,
        req_id: getNextReqId(),
    }));

    let subscriptionId: string | null = null;

    const handleMessage = (event: MessageEvent) => {
        let data: {
            msg_type?: string;
            proposal_open_contract?: { contract_id?: number; is_sold?: boolean; profit?: number };
            subscription?: { id?: string };
        };

        try {
            data = JSON.parse(event.data);
        } catch {
            return;
        }

        if (data.msg_type !== 'proposal_open_contract') return;
        if (data.proposal_open_contract?.contract_id !== contractId) return;

        if (data.subscription?.id) {
            subscriptionId = data.subscription.id;
        }

        const isSold = data.proposal_open_contract?.is_sold;
        if (!isSold || settledContracts.has(contractId)) return;

        settledContracts.add(contractId);

        const profit = Number(data.proposal_open_contract?.profit ?? 0);
        useTradingStore.getState().recordTradeResult(profit);

        if (subscriptionId) {
            ws.send(JSON.stringify({ forget: subscriptionId }));
        }

        ws.removeEventListener('message', handleMessage);
    };

    ws.addEventListener('message', handleMessage);
}

export async function executeTrade(signal: TradeSignal, params: ExecuteTradeParams) {
    if (params.ws.readyState !== WebSocket.OPEN) {
        throw new Error('WebSocket is not open.');
    }

    if (!Number.isFinite(params.stake) || params.stake <= 0) {
        throw new Error('Invalid stake amount.');
    }

    if (!params.symbol) {
        throw new Error('Symbol is required.');
    }

    const currency = params.currency || useTradingStore.getState().currency || 'USD';
    const duration = params.duration ?? 5;
    const durationUnit = params.durationUnit ?? 't';

    const proposalResponse = await sendDerivRequest<ProposalResponse>(params.ws, {
        proposal: 1,
        amount: params.stake,
        basis: 'stake',
        contract_type: signal,
        currency,
        duration,
        duration_unit: durationUnit,
        symbol: params.symbol,
    }, 'proposal');

    const proposalId = proposalResponse.proposal?.id;
    const askPrice = Number(proposalResponse.proposal?.ask_price);
    const payout = Number(proposalResponse.proposal?.payout);

    if (!proposalId || !Number.isFinite(askPrice) || !Number.isFinite(payout) || askPrice <= 0 || payout <= 0) {
        throw new Error('Invalid proposal response.');
    }

    const buyResponse = await sendDerivRequest<BuyResponse>(params.ws, {
        buy: proposalId,
        price: askPrice,
    }, 'buy');

    const contractId = Number(buyResponse.buy?.contract_id);
    if (!Number.isFinite(contractId)) {
        throw new Error('Invalid buy response.');
    }

    const potentialProfit = payout - askPrice;

    const store = useTradingStore.getState();
    store.setTradeInfo(contractId, potentialProfit);
    store.setLastTradeTime(Date.now());

    subscribeToContract(params.ws, contractId);

    return { contractId, potentialProfit };
}
