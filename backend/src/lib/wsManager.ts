import WebSocket from 'ws';
import { performance } from 'perf_hooks';
import { wsLogger } from './logger';
import { metrics } from './metrics';
import { recordReconnect } from './riskManager';

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
}

const MAX_QUEUE_DEPTH = Math.max(1, Number(process.env.WS_MAX_QUEUE_DEPTH) || 500);
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
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

/**
 * Get or create a persistent WebSocket connection for an account
 */
export async function getOrCreateConnection(
    token: string,
    accountId: string,
    appId: string = process.env.DERIV_APP_ID || '1089'
): Promise<WSConnectionState> {
    const existing = connectionPool.get(accountId);

    if (existing && existing.ws?.readyState === WebSocket.OPEN && existing.authorized) {
        existing.lastActivity = Date.now();
        return existing;
    }

    // Clean up stale connection if exists
    if (existing) {
        cleanupConnection(accountId);
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
    };

    connectionPool.set(accountId, state);

    try {
        await connect(state, appId);
        await authorize(state, false);
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

        ws.on('open', () => {
            clearTimeout(timeout);
            state.ws = ws;
            state.reconnectAttempts = 0;
            setupMessageHandler(state);
            resolve();
        });

        ws.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });

        ws.on('close', () => {
            state.authorized = false;
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
            reject(new Error('Authorization timeout'));
        }, CONNECTION_TIMEOUT_MS);

        state.pendingMessages.set(reqId, {
            data: JSON.stringify({ authorize: state.token, req_id: reqId }),
            resolve: (response: unknown) => {
                clearTimeout(timeout);
                const res = response as { error?: { message: string }; authorize?: unknown };
                if (res.error) {
                    reject(new Error(res.error.message));
                } else {
                    state.authorized = true;
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
    if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        wsLogger.error({ accountId: state.accountId, attempts: state.reconnectAttempts }, 'Max reconnect attempts reached');
        cleanupConnection(state.accountId);
        return;
    }

    state.reconnectAttempts++;
    metrics.counter('ws.reconnect_attempts');
    recordReconnect(state.accountId);
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, state.reconnectAttempts - 1);

    wsLogger.info({ accountId: state.accountId, delay, attempt: state.reconnectAttempts }, 'Reconnecting WebSocket');

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
        await connect(state, appId);
        await authorize(state, true);
    } catch (error) {
        wsLogger.error({ accountId: state.accountId, error }, 'Reconnect failed');
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
        // Reject all pending messages
        for (const pending of state.pendingMessages.values()) {
            pending.reject(new Error('Connection closed'));
        }
        state.pendingMessages.clear();
        for (const queued of state.messageQueue) {
            queued.reject(new Error('Connection closed'));
        }
        state.messageQueue = [];
        metrics.gauge('ws.outbound_queue_depth', 0);

        if (state.ws) {
            state.ws.removeAllListeners();
            if (state.ws.readyState === WebSocket.OPEN) {
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
