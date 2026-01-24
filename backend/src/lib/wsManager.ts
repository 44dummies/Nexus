import WebSocket from 'ws';

interface QueuedMessage {
    data: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    reqId: number;
}

interface WSConnectionState {
    ws: WebSocket | null;
    authorized: boolean;
    token: string;
    accountId: string;
    pendingMessages: Map<number, QueuedMessage>;
    messageQueue: QueuedMessage[];
    reconnectAttempts: number;
    lastActivity: number;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;
const CONNECTION_TIMEOUT_MS = 10000;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Global connection pool: accountId -> connection state
const connectionPool = new Map<string, WSConnectionState>();

let globalReqId = 1000;
const getReqId = () => globalReqId++;

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
    };

    connectionPool.set(accountId, state);

    try {
        await connect(state, appId);
        await authorize(state);
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
function authorize(state: WSConnectionState): Promise<void> {
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
                    // Process queued messages
                    while (state.messageQueue.length > 0) {
                        const msg = state.messageQueue.shift();
                        if (msg) {
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
        });

        state.ws.send(JSON.stringify({ authorize: state.token, req_id: reqId }));
    });
}

/**
 * Setup message handler for incoming messages
 */
function setupMessageHandler(state: WSConnectionState): void {
    if (!state.ws) return;

    state.ws.on('message', (data: WebSocket.Data) => {
        try {
            const message = JSON.parse(data.toString());
            const reqId = message.req_id;

            if (reqId && state.pendingMessages.has(reqId)) {
                const pending = state.pendingMessages.get(reqId)!;
                state.pendingMessages.delete(reqId);

                if (message.error) {
                    pending.reject(new Error(message.error.message));
                } else {
                    pending.resolve(message);
                }
            }

            state.lastActivity = Date.now();
        } catch (error) {
            console.error('WS message parse error:', error);
        }
    });
}

/**
 * Handle reconnection with exponential backoff
 */
async function handleReconnect(state: WSConnectionState, appId: string): Promise<void> {
    if (state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`Max reconnect attempts reached for ${state.accountId}`);
        cleanupConnection(state.accountId);
        return;
    }

    state.reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, state.reconnectAttempts - 1);

    console.log(`Reconnecting ${state.accountId} in ${delay}ms (attempt ${state.reconnectAttempts})`);

    await new Promise(resolve => setTimeout(resolve, delay));

    try {
        await connect(state, appId);
        await authorize(state);
    } catch (error) {
        console.error(`Reconnect failed for ${state.accountId}:`, error);
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
        const timeout = setTimeout(() => {
            state.pendingMessages.delete(reqId);
            reject(new Error('Message timeout'));
        }, timeoutMs);

        const queuedMsg: QueuedMessage = {
            data,
            resolve: (response) => {
                clearTimeout(timeout);
                resolve(response as T);
            },
            reject: (error) => {
                clearTimeout(timeout);
                reject(error);
            },
            reqId,
        };

        if (state.ws?.readyState === WebSocket.OPEN && state.authorized) {
            state.ws.send(data);
            state.pendingMessages.set(reqId, queuedMsg);
        } else {
            // Queue for later when connection is ready
            state.messageQueue.push(queuedMsg);
        }

        state.lastActivity = Date.now();
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
        console.error(`Cannot send async message: no connection for ${accountId}`);
        return;
    }

    const reqId = getReqId();
    state.ws.send(JSON.stringify({ ...message, req_id: reqId }));
    state.lastActivity = Date.now();
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
        state.messageQueue = [];

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
            console.log(`Cleaning up idle connection for ${accountId}`);
            cleanupConnection(accountId);
        }
    }
}

// Cleanup idle connections every minute
setInterval(cleanupIdleConnections, 60000);
