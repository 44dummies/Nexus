import WebSocket from 'ws';
import { performance } from 'perf_hooks';
import { wsLogger } from './logger';
import { metrics } from './metrics';


interface QueuedMessage {
    data: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    reqId: number;
    queuedAt: number;
    timeoutAt: number;
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
}

const MAX_QUEUE_DEPTH = Math.max(1, Number(process.env.WS_MAX_QUEUE_DEPTH) || 500);
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_JITTER_MS = Math.max(0, Number(process.env.WS_RECONNECT_JITTER_MS) || 250);
const CONNECTION_TIMEOUT_MS = 10000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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
        await authorize(state, isReconnect);
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
    };

    connectionPool.set(accountId, state);

    try {
        await connectAndAuthorize(state, appId, false);
        return state;
    } catch (error) {
        cleanupConnection(accountId);
        throw error;
    }
}

/**
 * Establish WebSocket connection
 */
function connect(state: WSConnectionState, appId: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('WebSocket connection timeout'));
        }, CONNECTION_TIMEOUT_MS);

        const ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${appId}`);
        state.ws = ws;

        ws.on('open', () => {
            clearTimeout(timeout);
            state.ws = ws;
            state.reconnectAttempts = 0;
            setupMessageHandler(state);
            resolve();
        });

        ws.on('error', (error) => {
            clearTimeout(timeout);
            state.ws = null;
            reject(error);
        });

        ws.on('close', (code, reason) => {
            state.authorized = false;
            state.ws = null;
            state.lastActivity = Date.now();

            const closeReason = typeof reason === 'string' ? reason : reason?.toString();
            const intentional = !shouldAttemptReconnect(state) || !isActiveState(state);
            wsLogger.info({ accountId: state.accountId, code, reason: closeReason, intentional }, 'WebSocket closed');

            rejectPendingMessages(state, new Error('Connection closed'));

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
function authorize(state: WSConnectionState, isReconnect: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            reject(new Error('WebSocket not open'));
            return;
        }

        const reqId = getReqId();
        const timeout = setTimeout(() => {
            state.pendingMessages.delete(reqId);
            const err = new Error('Authorization timeout');
            state.lastAuthError = err.message;
            rejectQueuedMessages(state, err);
            reject(err);
        }, CONNECTION_TIMEOUT_MS);

        state.pendingMessages.set(reqId, {
            data: JSON.stringify({ authorize: state.token, req_id: reqId }),
            resolve: (response: unknown) => {
                clearTimeout(timeout);
                const res = response as { error?: { message: string }; authorize?: unknown };
                if (res.error) {
                    state.lastAuthError = res.error.message;
                    rejectQueuedMessages(state, new Error(`Authorization failed: ${res.error.message}`));
                    reject(new Error(res.error.message));
                } else {
                    state.authorized = true;
                    state.lastAuthError = null;
                    notifyConnectionReady(state.accountId, isReconnect);
                    // Process queued messages
                    const now = Date.now();
                    while (state.messageQueue.length > 0) {
                        const msg = state.messageQueue.shift();
                        if (msg) {
                            if (now > msg.timeoutAt) {
                                msg.reject(new Error('Message timeout'));
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
            const message = JSON.parse(data.toString()) as Record<string, unknown>;
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
                    const errorMsg = (message.error as any).message || 'Unknown error';
                    pending.reject(new Error(errorMsg));
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
            metrics.counter('ws.parse_error');
            wsLogger.error({ error }, 'WS message parse error');
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
            if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                wsLogger.error({ accountId: state.accountId, attempts: state.reconnectAttempts }, 'Max reconnect attempts reached');
                cleanupConnection(state.accountId);
                return;
            }

            state.reconnectAttempts += 1;
            metrics.counter('ws.reconnect_attempts');
            notifyReconnect(state.accountId);

            const baseDelay = RECONNECT_BASE_DELAY_MS * Math.pow(2, state.reconnectAttempts - 1);
            const jitter = RECONNECT_JITTER_MS > 0 ? Math.floor(Math.random() * RECONNECT_JITTER_MS) : 0;
            const delay = baseDelay + jitter;

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
    timeoutMs: number = 30000
): Promise<T> {
    const state = connectionPool.get(accountId);

    if (!state) {
        throw new Error(`No connection for account ${accountId}`);
    }
    if (state.lastAuthError && !state.authorized) {
        throw new Error(`Authorization failed: ${state.lastAuthError}`);
    }
    if (state.closed === true || state.shouldReconnect === false) {
        throw new Error('Connection closed');
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
                reject(new Error('Message timeout'));
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
        };

        if (state.ws?.readyState === WebSocket.OPEN && state.authorized) {
            state.ws.send(data);
            state.pendingMessages.set(reqId, queuedMsg);
        } else {
            if (state.messageQueue.length >= MAX_QUEUE_DEPTH) {
                clearTimeout(timeout);
                reject(new Error('Message queue full'));
                return;
            }

            // Queue for later when connection is ready
            state.messageQueue.push(queuedMsg);
            metrics.gauge('ws.outbound_queue_depth', state.messageQueue.length);
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

/**
 * Cleanup idle connections (call periodically)
 */
export function cleanupIdleConnections(): void {
    const now = Date.now();

    for (const [accountId, state] of connectionPool.entries()) {
        if (now - state.lastActivity > IDLE_TIMEOUT_MS) {
            wsLogger.info({ accountId }, 'Cleaning up idle connection');
            cleanupConnection(accountId);
        }
    }
}

// Cleanup idle connections every minute
setInterval(cleanupIdleConnections, 60000);

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
