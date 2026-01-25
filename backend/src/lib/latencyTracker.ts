import { performance } from 'perf_hooks';
import { metrics } from './metrics';

export const LATENCY_METRICS = {
    tickToDecision: 'latency.tick_to_decision_ms',
    decisionToSend: 'latency.decision_to_send_ms',
    sendToProposalAck: 'latency.send_to_proposal_ack_ms',
    sendToBuyAck: 'latency.send_to_buy_ack_ms',
    sendToFill: 'latency.send_to_fill_ms',
};

export interface LatencyTrace {
    traceId: string;
    tickReceivedTs?: number;
    decisionTs?: number;
    orderSentTs?: number;
    proposalAckTs?: number;
    buySentTs?: number;
    buyAckTs?: number;
    fillTs?: number;
}

let traceSeq = 0;

export function nowMs(): number {
    return performance.now();
}

export function createLatencyTrace(seed?: Partial<LatencyTrace>): LatencyTrace {
    traceSeq += 1;
    return {
        traceId: `trace_${traceSeq}`,
        ...seed,
    };
}

export function markTrace<T extends keyof LatencyTrace>(
    trace: LatencyTrace,
    key: T,
    ts: number = nowMs()
): number {
    trace[key] = ts as LatencyTrace[T];
    return ts;
}

export function recordLatency(metricName: string, start?: number, end?: number): void {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    if (typeof start !== 'number' || typeof end !== 'number') return;
    if (end < start) return;
    metrics.histogram(metricName, end - start);
}
