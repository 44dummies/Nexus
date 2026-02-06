import WebSocket from 'ws';
import { performance } from 'perf_hooks';
import { wsLogger } from './logger';
import { metrics } from './metrics';
import { setComponentStatus } from './healthStatus';
import { record as recordObstacle } from './obstacleLog';


export type WsErrorCode =
    | 'WS_TIMEOUT'
    | 'WS_AUTH'
    | 'WS_AUTH_TIMEOUT'
    | 'WS_HANDSHAKE'
    | 'WS_NETWORK'
    | 'WS_CLOSED'
    | 'WS_QUEUE_FULL'
    | 'WS_BACKPRESSURE_DROP'
    | 'WS_PARSE'
    | 'WS_DERIV_ERROR';

export class WsError extends Error {
    code: WsErrorCode;
    retryable: boolean;
    context?: Record<string, unknown>;
    cause?: Error;

    constructor(code: WsErrorCode, message: string, options?: { retryable?: boolean; context?: Record<string, unknown>; cause?: Error }) {
        super(message);
        this.code = code;
        this.retryable = options?.retryable ?? false;
        this.context = options?.context;
        this.cause = options?.cause;
    }
}

interface QueuedMessage {
    data: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    reqId: number;
    queuedAt: number;
    timeoutAt: number;
    priority: number;
}

export interface WSConnectionState {
    ws: WebSocket | null;
    authorized: boolean;
    token: string;
    accountId: string;
    pendingMessages: Map<number, QueuedMessage>;
    messageQueue: QueuedMessage[];
    reconnectAttempts: number;
    lastActivity: number;
    inboundInFlight: number;
    reconnecting?: boolean;
    lastAuthError?: string | null;
    connecting?: Promise<void> | null;
    reconnectPromise?: Promise<void> | null;
    shouldReconnect?: boolean;
    closed?: boolean;
    reconnectWindowStart?: number;
    reconnectWindowCount?: number;
    circuitOpenUntil?: number | null;
    lastConnectError?: string | null;
    pingTimer?: ReturnType<typeof setInterval> | null;
}

const MAX_QUEUE_DEPTH = Math.max(1, Number(process.env.WS_MAX_QUEUE_DEPTH) || 500);
const QUEUE_POLICY = (process.env.WS_QUEUE_POLICY || 'reject-new') as 'reject-new' | 'drop-oldest' | 'priority';
const DEFAULT_REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.WS_REQUEST_TIMEOUT_MS) || 30000);
const MAX_RECONNECT_ATTEMPTS = Math.max(1, Number(process.env.WS_MAX_RECONNECT_ATTEMPTS) || 25);
const RECONNECT_BASE_DELAY_MS = Math.max(250, Number(process.env.WS_RECONNECT_BASE_DELAY_MS) || 1000);
const RECONNECT_MAX_DELAY_MS = Math.max(RECONNECT_BASE_DELAY_MS, Number(process.env.WS_RECONNECT_MAX_DELAY_MS) || 30000);
const RECONNECT_JITTER_MS = Math.max(0, Number(process.env.WS_RECONNECT_JITTER_MS) || 250);
const RECONNECT_WINDOW_MS = Math.max(1000, Number(process.env.WS_RECONNECT_WINDOW_MS) || 60000);
const RECONNECT_STORM_LIMIT = Math.max(1, Number(process.env.WS_RECONNECT_STORM_LIMIT) || 8);
const RECONNECT_CIRCUIT_COOLDOWN_MS = Math.max(1000, Number(process.env.WS_RECONNECT_COOLDOWN_MS) || 15000);
const CONNECTION_TIMEOUT_MS = Math.max(1000, Number(process.env.WS_CONNECTION_TIMEOUT_MS) || 10000);
const IDLE_TIMEOUT_MS = Math.max(60000, Number(process.env.WS_IDLE_TIMEOUT_MS) || 30 * 60 * 1000); // 30 minutes
const PING_INTERVAL_MS = Math.max(10000, Number(process.env.WS_PING_INTERVAL_MS) || 30000); // 30 seconds
const PARSE_SAMPLE_BYTES = Math.max(128, Number(process.env.WS_PARSE_SAMPLE_BYTES) || 512);
const AUTH_RETRY_ATTEMPTS = Math.max(0, Number(process.env.WS_AUTH_RETRY_ATTEMPTS) || 2);
const AUTH_RETRY_DELAY_MS = Math.max(100, Number(process.env.WS_AUTH_RETRY_DELAY_MS) || 500);

function removeQueuedMessage(state: WSConnectionState, reqId: number): QueuedMessage | null {
    const idx = state.messageQueue.findIndex((msg) => msg.reqId === reqId);
    if (idx >= 0) {
        const [msg] = state.messageQueue.splice(idx, 1);
        metrics.gauge('ws.outbound_queue_depth', state.messageQueue.length);
        return msg ?? null;
    }
    return null;
}

// Global connection pool: accountId -> connection state
const connectionPool = new Map<string, WSConnectionState>();

let globalReqId = 1000;
const getReqId = () => globalReqId++;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function samplePayload(data: WebSocket.Data): string {
    try {
        const raw = typeof data === 'string' ? data : data.toString();
        if (raw.length <= PARSE_SAMPLE_BYTES) return raw;
        return `${raw.slice(0, PARSE_SAMPLE_BYTES)}...`;
    } catch {
        return '[unavailable]';
    }
}

function normalizeDerivError(error: unknown): { message: string; code?: string; retryable: boolean; isAuth: boolean } {
    const errObj = error as { message?: string; code?: string };
    const message = typeof errObj?.message === 'string' ? errObj.message : 'Deriv error';
    const code = typeof errObj?.code === 'string' ? errObj.code : undefined;
    const lowerMsg = message.toLowerCase();

    const isAuth = code === 'InvalidToken' || lowerMsg.includes('authorization') || lowerMsg.includes('invalid token');
    const retryable = !isAuth && (lowerMsg.includes('timeout') || lowerMsg.includes('network') || lowerMsg.includes('rate') || lowerMsg.includes('busy'));

    return { message, code, retryable, isAuth };
}

function enqueueMessage(state: WSConnectionState, queuedMsg: QueuedMessage): void {
    if (state.messageQueue.length >= MAX_QUEUE_DEPTH) {
        if (QUEUE_POLICY === 'drop-oldest') {
            const dropped = state.messageQueue.shift();
            if (dropped) {
                dropped.reject(new WsError('WS_BACKPRESSURE_DROP', 'Message dropped due to backpressure', {
                    retryable: true,
                    context: { policy: QUEUE_POLICY, accountId: state.accountId },
                }));
                metrics.counter('ws.queue_drop_oldest');
            }
        } else if (QUEUE_POLICY === 'priority') {
            const lowestIdx = state.messageQueue.reduce((acc, msg, idx) => {
                if (msg.priority < state.messageQueue[acc].priority) return idx;
                return acc;
            }, 0);
            const lowest = state.messageQueue[lowestIdx];
            if (lowest && queuedMsg.priority > lowest.priority) {
                state.messageQueue.splice(lowestIdx, 1);
                lowest.reject(new WsError('WS_BACKPRESSURE_DROP', 'Message dropped due to backpressure', {
                    retryable: true,
                    context: { policy: QUEUE_POLICY, accountId: state.accountId },
                }));
                metrics.counter('ws.queue_drop_priority');
            } else {
                metrics.counter('ws.queue_full');
                throw new WsError('WS_QUEUE_FULL', 'Message queue full', { retryable: true });
            }
        } else {
            metrics.counter('ws.queue_full');
            throw new WsError('WS_QUEUE_FULL', 'Message queue full', { retryable: true });
        }
    }

    if (QUEUE_POLICY === 'priority') {
        const index = state.messageQueue.findIndex((msg) => queuedMsg.priority > msg.priority);
        if (index === -1) {
            state.messageQueue.push(queuedMsg);
        } else {
            state.messageQueue.splice(index, 0, queuedMsg);
        }
    } else {
        state.messageQueue.push(queuedMsg);
    }

    metrics.gauge('ws.outbound_queue_depth', state.messageQueue.length);
}

function markReconnectWindow(state: WSConnectionState): boolean {
    const now = Date.now();
    if (!state.reconnectWindowStart || now - state.reconnectWindowStart > RECONNECT_WINDOW_MS) {
        state.reconnectWindowStart = now;
        state.reconnectWindowCount = 0;
    }
    state.reconnectWindowCount = (state.reconnectWindowCount ?? 0) + 1;
    if (state.reconnectWindowCount >= RECONNECT_STORM_LIMIT) {
        state.circuitOpenUntil = now + RECONNECT_CIRCUIT_COOLDOWN_MS;
        metrics.counter('ws.reconnect_circuit_open');
        recordObstacle('websocket', 'Reconnect storm', `Reconnects exceeded ${RECONNECT_STORM_LIMIT} within window`, 'medium', ['backend/src/lib/wsManager.ts']);
        return true;
    }
    return false;
}

function isActiveState(state: WSConnectionState): boolean {
    return connectionPool.get(state.accountId) === state && state.closed !== true;
}

function shouldAttemptReconnect(state: WSConnectionState): boolean {
    return state.shouldReconnect !== false;
}

function rejectPendingMessages(state: WSConnectionState, error: Error): void {
    for (const pending of state.pendingMessages.values()) {
        pending.reject(error);
    }
    state.pendingMessages.clear();
    metrics.gauge('ws.pending_requests', 0);
}

function rejectQueuedMessages(state: WSConnectionState, error: Error): void {
    for (const queued of state.messageQueue) {
        queued.reject(error);
    }
    state.messageQueue = [];
    metrics.gauge('ws.outbound_queue_depth', 0);
}

type ReconnectListener = (accountId: string) => void;
const reconnectListeners = new Set<ReconnectListener>();

export function registerReconnectListener(listener: ReconnectListener) {
    reconnectListeners.add(listener);
}

function notifyReconnect(accountId: string) {
    for (const listener of reconnectListeners) {
        try {
            listener(accountId);
        } catch (error) {
            wsLogger.error({ accountId, error }, 'Reconnect listener error');
        }
    }
}

type ConnectionReadyListener = (accountId: string, isReconnect: boolean) => void;
const connectionReadyListeners = new Map<string, Set<ConnectionReadyListener>>();

export function registerConnectionReadyListener(accountId: string, listener: ConnectionReadyListener) {
    let listeners = connectionReadyListeners.get(accountId);
    if (!listeners) {
        listeners = new Set();
        connectionReadyListeners.set(accountId, listeners);
    }
    listeners.add(listener);
}

export function unregisterConnectionReadyListener(accountId: string, listener: ConnectionReadyListener) {
    const listeners = connectionReadyListeners.get(accountId);
    if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
            connectionReadyListeners.delete(accountId);
        }
    }
}

function notifyConnectionReady(accountId: string, isReconnect: boolean) {
    const listeners = connectionReadyListeners.get(accountId);
    if (!listeners) return;
    for (const listener of listeners) {
        try {
            listener(accountId, isReconnect);
        } catch (error) {
            wsLogger.error({ accountId, error }, 'Connection ready listener error');
        }
    }
}

async function connectAndAuthorize(state: WSConnectionState, appId: string, isReconnect: boolean): Promise<void> {
    if (state.connecting) {
        return state.connecting;
    }
    if (!isActiveState(state)) {
        throw new Error('Connection closed');
    }

    const attempt = (async () => {
        state.authorized = false;
        state.lastAuthError = null;
        await connect(state, appId);
        if (!isActiveState(state)) {
            if (state.ws?.readyState === WebSocket.OPEN) {
                state.ws.close();
            }
            throw new Error('Connection superseded');
        }
        try {
            await authorize(state, isReconnect);
        } catch (error) {
            const wsErr = error as WsError;
            if (wsErr.code === 'WS_AUTH' && !wsErr.retryable) {
                state.shouldReconnect = false;
                metrics.counter('ws.auth_terminal');
                wsLogger.error({ accountId: state.accountId, error: wsErr.message }, 'Authorization failed - disabling reconnect');
            }
            throw error;
        }
    })();

    state.connecting = attempt;
    try {
        await attempt;
    } finally {
        if (state.connecting === attempt) {
            state.connecting = null;
        }
    }
}

/**
 * Get or create a persistent WebSocket connection for an account
 */
export async function getOrCreateConnection(
    token: string,
    accountId: string,
    appId: string = process.env.DERIV_APP_ID || '1089'
): Promise<WSConnectionState> {
    const existing = connectionPool.get(accountId);

    if (existing) {
        if (existing.token !== token) {
            existing.token = token;
            existing.lastAuthError = null;
        }
        existing.lastActivity = Date.now();

        if (existing.ws?.readyState === WebSocket.OPEN && existing.authorized) {
            return existing;
        }

        if (existing.reconnectPromise) {
            try {
                await existing.reconnectPromise;
            } catch {
                // ignore and fall through to direct connect attempt
            }
            if (existing.ws?.readyState === WebSocket.OPEN && existing.authorized) {
                return existing;
            }
        }

        if (existing.connecting) {
            try {
                await existing.connecting;
            } catch {
                // ignore and fall through to direct connect attempt
            }
            if (existing.ws?.readyState === WebSocket.OPEN && existing.authorized) {
                return existing;
            }
        }

        try {
            await connectAndAuthorize(existing, appId, false);
            return existing;
        } catch (error) {
            if (isActiveState(existing)) {
                cleanupConnection(accountId);
            }
            throw error;
        }
    }

    // Create new connection
    const state: WSConnectionState = {
        ws: null,
        authorized: false,
        token,
        accountId,
        pendingMessages: new Map(),
        messageQueue: [],
        reconnectAttempts: 0,
        lastActivity: Date.now(),
        inboundInFlight: 0,
        reconnecting: false,
        lastAuthError: null,
        connecting: null,
        reconnectPromise: null,
        shouldReconnect: true,
        closed: false,
        reconnectWindowStart: Date.now(),
        reconnectWindowCount: 0,
        circuitOpenUntil: null,
        lastConnectError: null,
    };

    connectionPool.set(accountId, state);
    metrics.gauge('ws.connection_count', connectionPool.size);

    try {
        await connectAndAuthorize(state, appId, false);
        return state;
    } catch (error) {
        cleanupConnection(accountId);
        throw error;
    }
}

/**
 * Start a ping keepalive to prevent idle disconnection by Deriv
 */
function startPingKeepAlive(state: WSConnectionState): void {
    stopPingKeepAlive(state);
    state.pingTimer = setInterval(() => {
        if (state.ws?.readyState === WebSocket.OPEN) {
            try {
                state.ws.send(JSON.stringify({ ping: 1 }));
                state.lastActivity = Date.now();
                metrics.counter('ws.ping_sent');
            } catch {
                // If sending fails, the close handler will trigger reconnect
                metrics.counter('ws.ping_send_error');
            }
        } else {
            stopPingKeepAlive(state);
        }
    }, PING_INTERVAL_MS);
    // Don't block process exit
    if (state.pingTimer && typeof state.pingTimer === 'object' && 'unref' in state.pingTimer) {
        state.pingTimer.unref();
    }
}

function stopPingKeepAlive(state: WSConnectionState): void {
    if (state.pingTimer) {
        clearInterval(state.pingTimer);
        state.pingTimer = null;
    }
}

/**
 * Establish WebSocket connection
 */
function connect(state: WSConnectionState, appId: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (state.circuitOpenUntil && Date.now() < state.circuitOpenUntil) {
            const err = new WsError('WS_HANDSHAKE', 'Reconnect circuit open', { retryable: true, context: { until: state.circuitOpenUntil } });
            reject(err);
            return;
        }
        const timeout = setTimeout(() => {
            try {
                ws.close();
            } catch {
                // ignore
            }
            const err = new WsError('WS_TIMEOUT', 'WebSocket connection timeout', { retryable: true });
            metrics.counter('ws.connect_timeout');
            setComponentStatus('ws', 'degraded', 'connect timeout');
            reject(err);
        }, CONNECTION_TIMEOUT_MS);

        const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId}`);
        state.ws = ws;
        let opened = false;

        ws.on('open', () => {
            clearTimeout(timeout);
            state.ws = ws;
            state.reconnectAttempts = 0;
            setupMessageHandler(state);
            startPingKeepAlive(state);
            opened = true;
            state.lastConnectError = null;
            setComponentStatus('ws', 'ok');
            metrics.counter('ws.connect_success');
            resolve();
        });

        ws.on('error', (error) => {
            clearTimeout(timeout);
            state.ws = null;
            const err = error instanceof Error ? error : new Error('WebSocket error');
            const wsErr = new WsError(opened ? 'WS_NETWORK' : 'WS_HANDSHAKE', err.message, { retryable: true, cause: err });
            state.lastConnectError = err.message;
            metrics.counter('ws.connect_error');
            setComponentStatus('ws', 'degraded', err.message);
            reject(wsErr);
        });

        ws.on('close', (code, reason) => {
            state.authorized = false;
            state.ws = null;
            state.lastActivity = Date.now();
            stopPingKeepAlive(state);

            const closeReason = typeof reason === 'string' ? reason : reason?.toString();
            const intentional = !shouldAttemptReconnect(state) || !isActiveState(state);
            wsLogger.info({ accountId: state.accountId, code, reason: closeReason, intentional }, 'WebSocket closed');

            rejectPendingMessages(state, new WsError('WS_CLOSED', 'Connection closed', {
                retryable: true,
                context: { code, reason: closeReason },
            }));
            setComponentStatus('ws', 'degraded', `closed:${code}`);

            if (intentional) {
                return;
            }
            handleReconnect(state, appId);
        });
    });
}

/**
 * Authorize the connection with token
 */
async function authorize(state: WSConnectionState, isReconnect: boolean): Promise<void> {
    const maxAttempts = Math.max(1, AUTH_RETRY_ATTEMPTS + 1);
    let attempt = 0;
    let lastError: Error | null = null;

    while (attempt < maxAttempts) {
        attempt += 1;
        try {
            await authorizeOnce(state, isReconnect);
            return;
        } catch (error) {
            lastError = error as Error;
            const wsErr = error as WsError;
            if (wsErr.code === 'WS_AUTH' && !wsErr.retryable) {
                metrics.counter('ws.auth_fail');
                throw wsErr;
            }

            if (attempt >= maxAttempts) {
                metrics.counter('ws.auth_fail');
                throw error;
            }

            metrics.counter('ws.auth_retry');
            await sleep(AUTH_RETRY_DELAY_MS * attempt);
        }
    }

    throw lastError ?? new WsError('WS_AUTH', 'Authorization failed', { retryable: false });
}

function authorizeOnce(state: WSConnectionState, isReconnect: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            reject(new WsError('WS_HANDSHAKE', 'WebSocket not open', { retryable: true }));
            return;
        }

        const reqId = getReqId();
        const timeout = setTimeout(() => {
            state.pendingMessages.delete(reqId);
            const err = new WsError('WS_AUTH_TIMEOUT', 'Authorization timeout', { retryable: true });
            state.lastAuthError = err.message;
            rejectQueuedMessages(state, err);
            metrics.counter('ws.auth_timeout');
            reject(err);
        }, CONNECTION_TIMEOUT_MS);

        state.pendingMessages.set(reqId, {
            data: JSON.stringify({ authorize: state.token, req_id: reqId }),
            resolve: (response: unknown) => {
                clearTimeout(timeout);
                const res = response as { error?: { message: string; code?: string }; authorize?: unknown };
                if (res.error) {
                    const normalized = normalizeDerivError(res.error);
                    const err = new WsError(
                        normalized.isAuth ? 'WS_AUTH' : 'WS_DERIV_ERROR',
                        `Authorization failed: ${normalized.message}`,
                        { retryable: normalized.retryable, context: { code: normalized.code } }
                    );
                    state.lastAuthError = normalized.message;
                    rejectQueuedMessages(state, err);
                    metrics.counter('ws.auth_error');
                    reject(err);
                } else {
                    state.authorized = true;
                    state.lastAuthError = null;
                    metrics.counter('ws.auth_success');
                    notifyConnectionReady(state.accountId, isReconnect);
                    // Process queued messages
                    const now = Date.now();
                    while (state.messageQueue.length > 0) {
                        const msg = state.messageQueue.shift();
                        if (msg) {
                            if (now > msg.timeoutAt) {
                                msg.reject(new WsError('WS_TIMEOUT', 'Message timeout', { retryable: true }));
                                continue;
                            }
                            state.ws?.send(msg.data);
                            state.pendingMessages.set(msg.reqId, msg);
                        }
                    }
                    resolve();
                }
            },
            reject: (error: Error) => {
                clearTimeout(timeout);
                reject(error);
            },
            reqId,
            queuedAt: Date.now(),
            timeoutAt: Date.now() + CONNECTION_TIMEOUT_MS,
            priority: 0,
        });

        state.ws.send(JSON.stringify({ authorize: state.token, req_id: reqId }));
    });
}

/**
 * Streaming message listeners per account
 * Key: accountId, Value: Set of listener callbacks
 */
type StreamingListener = (accountId: string, message: Record<string, unknown>) => void;
const streamingListeners = new Map<string, Set<StreamingListener>>();

/**
 * Register a streaming message listener for an account
 */
export function registerStreamingListener(
    accountId: string,
    listener: StreamingListener
): void {
    let listeners = streamingListeners.get(accountId);
    if (!listeners) {
        listeners = new Set();
        streamingListeners.set(accountId, listeners);
    }
    listeners.add(listener);
}

/**
 * Unregister a streaming message listener
 */
export function unregisterStreamingListener(
    accountId: string,
    listener: StreamingListener
): void {
    const listeners = streamingListeners.get(accountId);
    if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
            streamingListeners.delete(accountId);
        }
    }
}

/**
 * Setup message handler for incoming messages
 */
function setupMessageHandler(state: WSConnectionState): void {
    if (!state.ws) return;

    state.ws.on('message', (data: WebSocket.Data) => {
        const recvPerfTs = performance.now();
        const recvWallTs = Date.now();
        state.inboundInFlight += 1;
        metrics.counter('ws.msg_received');
        metrics.gauge('ws.inbound_inflight', state.inboundInFlight);
        try {
            const parseStart = performance.now();
            let message: Record<string, unknown>;
            try {
                message = JSON.parse(data.toString()) as Record<string, unknown>;
            } catch (error) {
                metrics.counter('ws.parse_error');
                const sample = samplePayload(data);
                wsLogger.error({ error, sample }, 'WS message parse error');
                return;
            }
            const parseEnd = performance.now();
            metrics.histogram('ws.json_parse_ms', parseEnd - parseStart);
            message.__recvPerfTs = recvPerfTs;
            message.__recvWallTs = recvWallTs;
            const reqId = typeof message.req_id === 'number' ? message.req_id : undefined;

            // Handle pending request-response messages
            if (reqId && state.pendingMessages.has(reqId)) {
                const pending = state.pendingMessages.get(reqId)!;
                state.pendingMessages.delete(reqId);

                if (message.error && typeof message.error === 'object') {
                    const derivError = normalizeDerivError(message.error);
                    const err = new WsError('WS_DERIV_ERROR', derivError.message, {
                        retryable: derivError.retryable,
                        context: { code: derivError.code },
                    });
                    pending.reject(err);
                } else {
                    pending.resolve(message);
                }
            }

            // Dispatch streaming messages (tick, proposal_open_contract, etc.)
            // These are subscription updates that don't have matching req_id
            const fanoutStart = performance.now();
            const msgType = message.msg_type;
            if (msgType === 'tick' || msgType === 'proposal_open_contract' || msgType === 'ohlc' || msgType === 'order_book') {
                const listeners = streamingListeners.get(state.accountId);
                if (listeners) {
                    for (const listener of listeners) {
                        try {
                            listener(state.accountId, message);
                        } catch (listenerError) {
                            wsLogger.error({ error: listenerError, msgType }, 'Streaming listener error');
                        }
                    }
                }
            }
            const fanoutEnd = performance.now();
            metrics.histogram('ws.fanout_ms', fanoutEnd - fanoutStart);

            state.lastActivity = Date.now();
        } catch (error) {
            metrics.counter('ws.msg_handler_error');
            wsLogger.error({ error }, 'WS message handler error');
        } finally {
            state.inboundInFlight = Math.max(0, state.inboundInFlight - 1);
            metrics.gauge('ws.inbound_inflight', state.inboundInFlight);
            metrics.gauge('ws.pending_requests', state.pendingMessages.size);
            metrics.gauge('ws.outbound_queue_depth', state.messageQueue.length);
        }
    });
}

/**
 * Handle reconnection with exponential backoff
 */
async function handleReconnect(state: WSConnectionState, appId: string): Promise<void> {
    if (state.reconnecting) {
        return state.reconnectPromise ?? Promise.resolve();
    }
    if (!isActiveState(state) || !shouldAttemptReconnect(state)) {
        return;
    }

    const loop = (async () => {
        while (isActiveState(state) && shouldAttemptReconnect(state)) {
            if (state.circuitOpenUntil && Date.now() < state.circuitOpenUntil) {
                const waitMs = state.circuitOpenUntil - Date.now();
                wsLogger.warn({ accountId: state.accountId, waitMs }, 'Reconnect circuit open - delaying reconnect');
                metrics.counter('ws.reconnect_circuit_wait');
                await sleep(waitMs);
            }
            if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                wsLogger.error({ accountId: state.accountId, attempts: state.reconnectAttempts }, 'Max reconnect attempts reached');
                cleanupConnection(state.accountId);
                return;
            }

            state.reconnectAttempts += 1;
            metrics.counter('ws.reconnect_attempts');
            notifyReconnect(state.accountId);
            if (markReconnectWindow(state)) {
                wsLogger.error({ accountId: state.accountId }, 'Reconnect storm detected - opening circuit');
                continue;
            }

            const baseDelay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, state.reconnectAttempts - 1));
            const jitter = RECONNECT_JITTER_MS > 0 ? Math.floor(Math.random() * RECONNECT_JITTER_MS) : 0;
            const delay = Math.min(RECONNECT_MAX_DELAY_MS, baseDelay + jitter);

            wsLogger.info({ accountId: state.accountId, delay, attempt: state.reconnectAttempts }, 'Reconnecting WebSocket');

            await sleep(delay);

            if (!isActiveState(state) || !shouldAttemptReconnect(state)) {
                return;
            }

            try {
                await connectAndAuthorize(state, appId, true);
                return;
            } catch (error) {
                wsLogger.error({ accountId: state.accountId, error }, 'Reconnect failed');
            }
        }
    })();

    state.reconnecting = true;
    state.reconnectPromise = loop;
    try {
        await loop;
    } finally {
        state.reconnecting = false;
        if (state.reconnectPromise === loop) {
            state.reconnectPromise = null;
        }
    }
}

/**
 * Send a message and wait for response
 */
export async function sendMessage<T = unknown>(
    accountId: string,
    message: Record<string, unknown>,
    timeoutMsOrOptions: number | { timeoutMs?: number; priority?: number } = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<T> {
    const state = connectionPool.get(accountId);
    const timeoutMs = typeof timeoutMsOrOptions === 'number'
        ? timeoutMsOrOptions
        : timeoutMsOrOptions.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const priority = typeof timeoutMsOrOptions === 'number'
        ? 0
        : timeoutMsOrOptions.priority ?? 0;

    if (!state) {
        throw new WsError('WS_CLOSED', `No connection for account ${accountId}`, { retryable: true });
    }
    if (state.lastAuthError && !state.authorized) {
        throw new WsError('WS_AUTH', `Authorization failed: ${state.lastAuthError}`, { retryable: false });
    }
    if (state.closed === true || state.shouldReconnect === false) {
        throw new WsError('WS_CLOSED', 'Connection closed', { retryable: true });
    }

    const reqId = getReqId();
    const data = JSON.stringify({ ...message, req_id: reqId });

    return new Promise((resolve, reject) => {
        let settled = false;
        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
        };

        const timeout = setTimeout(() => {
            settle(() => {
                if (state.pendingMessages.has(reqId)) {
                    state.pendingMessages.delete(reqId);
                } else {
                    removeQueuedMessage(state, reqId);
                }
                reject(new WsError('WS_TIMEOUT', 'Message timeout', { retryable: true }));
            });
        }, timeoutMs);

        const resolveOnce = (response: unknown) => {
            settle(() => {
                clearTimeout(timeout);
                resolve(response as T);
            });
        };

        const rejectOnce = (error: Error) => {
            settle(() => {
                clearTimeout(timeout);
                reject(error);
            });
        };

        const queuedMsg: QueuedMessage = {
            data,
            resolve: resolveOnce,
            reject: rejectOnce,
            reqId,
            queuedAt: Date.now(),
            timeoutAt: Date.now() + timeoutMs,
            priority,
        };

        if (state.ws?.readyState === WebSocket.OPEN && state.authorized) {
            state.ws.send(data);
            state.pendingMessages.set(reqId, queuedMsg);
        } else {
            try {
                enqueueMessage(state, queuedMsg);
            } catch (error) {
                clearTimeout(timeout);
                reject(error as Error);
                return;
            }
        }

        state.lastActivity = Date.now();
        metrics.gauge('ws.pending_requests', state.pendingMessages.size);
    });
}

/**
 * Send a message without waiting for response (fire-and-forget)
 */
export function sendMessageAsync(
    accountId: string,
    message: Record<string, unknown>
): void {
    const state = connectionPool.get(accountId);

    if (!state || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
        metrics.counter('ws.async_send_skipped');
        wsLogger.warn({ accountId }, 'Cannot send async message: no connection');
        return;
    }

    const reqId = getReqId();
    state.ws.send(JSON.stringify({ ...message, req_id: reqId }));
    state.lastActivity = Date.now();
    metrics.gauge('ws.pending_requests', state.pendingMessages.size);
}

/**
 * Cleanup connection for an account
 */
export function cleanupConnection(accountId: string): void {
    const state = connectionPool.get(accountId);

    if (state) {
        state.shouldReconnect = false;
        state.closed = true;
        state.reconnecting = false;
        state.connecting = null;
        state.reconnectPromise = null;
        stopPingKeepAlive(state);

        // Reject all pending/queued messages
        rejectPendingMessages(state, new Error('Connection closed'));
        rejectQueuedMessages(state, new Error('Connection closed'));

        if (state.ws) {
            state.ws.removeAllListeners();
            if (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING) {
                state.ws.close();
            }
        }

        connectionPool.delete(accountId);
        metrics.gauge('ws.connection_count', connectionPool.size);
        metrics.counter('ws.connection_cleanup');
        setComponentStatus('ws', 'degraded', 'connection cleaned');
    }
}

/**
 * Get connection status for an account
 */
export function getConnectionStatus(accountId: string): {
    connected: boolean;
    authorized: boolean;
    pendingMessages: number;
} {
    const state = connectionPool.get(accountId);

    return {
        connected: state?.ws?.readyState === WebSocket.OPEN || false,
        authorized: state?.authorized || false,
        pendingMessages: state?.pendingMessages.size || 0,
    };
}

export function cleanupAllConnections(): void {
    for (const accountId of connectionPool.keys()) {
        cleanupConnection(accountId);
    }
}

export function getConnectionCount(): number {
    return connectionPool.size;
}

/**
 * Cleanup idle connections (call periodically)
 */
export function cleanupIdleConnections(): void {
    const now = Date.now();

    for (const [accountId, state] of connectionPool.entries()) {
        if (now - state.lastActivity > IDLE_TIMEOUT_MS) {
            wsLogger.info({ accountId }, 'Cleaning up idle connection');
            cleanupConnection(accountId);
            metrics.counter('ws.idle_cleanup');
        }
    }
}

// Cleanup idle connections every minute
const idleCleanupTimer = setInterval(cleanupIdleConnections, 60000);
idleCleanupTimer.unref();

// Test helpers
export function setConnectionStateForTest(accountId: string, state: WSConnectionState): void {
    connectionPool.set(accountId, state);
}

export function getConnectionStateForTest(accountId: string): WSConnectionState | null {
    return connectionPool.get(accountId) ?? null;
}

export function clearConnectionStateForTest(accountId?: string): void {
    if (accountId) {
        connectionPool.delete(accountId);
    } else {
        connectionPool.clear();
    }
}
