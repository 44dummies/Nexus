import { metrics } from './metrics';
import { setComponentStatus } from './healthStatus';
import logger from './logger';
import { recordObstacle } from './obstacleLog';

interface ResourceState {
    circuitOpen: boolean;
    reason?: string;
    openedAt?: number;
    openUntil?: number;
    lastSnapshotAt?: number;
    baselineRss?: number;
    baselineAt?: number;
}

const state: ResourceState = {
    circuitOpen: false,
};

const MONITOR_INTERVAL_MS = Math.max(1000, Number(process.env.RESOURCE_MONITOR_INTERVAL_MS) || 5000);
const MAX_RSS_MB = Math.max(128, Number(process.env.RESOURCE_MAX_RSS_MB) || 1024);
const MAX_EVENT_LOOP_P99_MS = Math.max(10, Number(process.env.RESOURCE_EVENT_LOOP_P99_MS) || 200);
const MAX_EVENT_LOOP_MAX_MS = Math.max(50, Number(process.env.RESOURCE_EVENT_LOOP_MAX_MS) || 1000);
const MEMORY_GROWTH_MB = Math.max(64, Number(process.env.RESOURCE_MEMORY_GROWTH_MB) || 256);
const MEMORY_GROWTH_WINDOW_MS = Math.max(10_000, Number(process.env.RESOURCE_MEMORY_GROWTH_WINDOW_MS) || 60_000);
const CIRCUIT_OPEN_MS = Math.max(5000, Number(process.env.RESOURCE_CIRCUIT_OPEN_MS) || 20_000);

function bytesToMb(bytes: number): number {
    return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function openCircuit(reason: string): void {
    if (state.circuitOpen) return;
    state.circuitOpen = true;
    state.reason = reason;
    state.openedAt = Date.now();
    state.openUntil = Date.now() + CIRCUIT_OPEN_MS;
    metrics.counter('resource.circuit_open');
    setComponentStatus('resources', 'degraded', reason);
    logger.warn({ reason }, 'Resource circuit opened');
}

function closeCircuit(): void {
    if (!state.circuitOpen) return;
    state.circuitOpen = false;
    state.reason = undefined;
    state.openedAt = undefined;
    state.openUntil = undefined;
    metrics.counter('resource.circuit_close');
    setComponentStatus('resources', 'ok');
    logger.info('Resource circuit closed');
}

function evaluateSnapshot(): void {
    const snapshot = metrics.snapshot();
    state.lastSnapshotAt = Date.now();

    const rssMb = bytesToMb(snapshot.memory.rss || 0);
    metrics.gauge('resource.rss_mb', rssMb);

    if (!state.baselineRss || !state.baselineAt) {
        state.baselineRss = rssMb;
        state.baselineAt = Date.now();
    } else if (Date.now() - state.baselineAt > MEMORY_GROWTH_WINDOW_MS) {
        state.baselineRss = rssMb;
        state.baselineAt = Date.now();
    }

    const growth = rssMb - (state.baselineRss || rssMb);
    metrics.gauge('resource.rss_growth_mb', growth);

    if (rssMb > MAX_RSS_MB) {
        openCircuit(`RSS ${rssMb}MB exceeds limit ${MAX_RSS_MB}MB`);
    }

    if (growth > MEMORY_GROWTH_MB) {
        openCircuit(`Memory growth ${growth}MB exceeds ${MEMORY_GROWTH_MB}MB over window`);
    }

    const p99 = snapshot.eventLoopLagMs?.p99 ?? 0;
    const max = snapshot.eventLoopLagMs?.max ?? 0;
    metrics.gauge('resource.event_loop_p99_ms', p99);
    metrics.gauge('resource.event_loop_max_ms', max);

    if (p99 > MAX_EVENT_LOOP_P99_MS || max > MAX_EVENT_LOOP_MAX_MS) {
        openCircuit(`Event loop lag p99 ${p99}ms max ${max}ms`);
    }

    if (state.circuitOpen && state.openUntil && Date.now() > state.openUntil) {
        closeCircuit();
    }
}

export function initResourceMonitor(): void {
    try {
        evaluateSnapshot();
    } catch (error) {
        recordObstacle('resources', 'Resource monitor init failed', (error as Error).message, 'medium', ['backend/src/lib/resourceMonitor.ts']);
    }
    const monitorTimer = setInterval(() => {
        try {
            evaluateSnapshot();
        } catch (error) {
            logger.warn({ error }, 'Resource monitor tick failed');
        }
    }, MONITOR_INTERVAL_MS);
    monitorTimer.unref();
}

export function shouldAcceptWork(): { ok: boolean; reason?: string } {
    if (!state.circuitOpen) return { ok: true };
    return { ok: false, reason: state.reason || 'Resource circuit open' };
}

export function getResourceStatus(): { circuitOpen: boolean; reason?: string } {
    return { circuitOpen: state.circuitOpen, reason: state.reason };
}
