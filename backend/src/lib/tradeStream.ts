import type { Response } from 'express';

export interface TradeStreamPayload {
    id?: string | null;
    contractId?: number | null;
    profit?: number | null;
    createdAt?: string | null;
    symbol?: string | null;
    buyPrice?: number | null;
    payout?: number | null;
    direction?: 'CALL' | 'PUT' | null;
    stake?: number | null;
}

const listeners = new Map<string, Set<Response>>();
const HEARTBEAT_MS = 25_000;

export function subscribeTradeStream(accountId: string, res: Response) {
    let bucket = listeners.get(accountId);
    if (!bucket) {
        bucket = new Set<Response>();
        listeners.set(accountId, bucket);
    }
    bucket.add(res);

    const heartbeat = setInterval(() => {
        try {
            res.write(`event: ping\ndata: ${Date.now()}\n\n`);
        } catch {
            // ignore write errors on stale connections
        }
    }, HEARTBEAT_MS);
    heartbeat.unref();

    return () => {
        clearInterval(heartbeat);
        const set = listeners.get(accountId);
        if (set) {
            set.delete(res);
            if (set.size === 0) {
                listeners.delete(accountId);
            }
        }
    };
}

export function broadcastTrade(accountId: string, payload: TradeStreamPayload) {
    const bucket = listeners.get(accountId);
    if (!bucket || bucket.size === 0) return;

    const data = JSON.stringify(payload);
    const message = `event: trade\ndata: ${data}\n\n`;

    for (const res of bucket) {
        try {
            res.write(message);
        } catch {
            // ignore write errors
        }
    }
}
