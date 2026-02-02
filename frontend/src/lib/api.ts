const isServer = typeof window === 'undefined';
export const API_BASE_URL = isServer
    ? (process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '')
    : '';

const DEFAULT_TIMEOUT_MS = Number(process.env.NEXT_PUBLIC_API_TIMEOUT_MS || 10_000);
const DEFAULT_RETRIES = Number(process.env.NEXT_PUBLIC_API_RETRY_COUNT || 2);
const RETRY_BASE_MS = Number(process.env.NEXT_PUBLIC_API_RETRY_BASE_MS || 400);

export class ApiError extends Error {
    status?: number;
    code?: string;
    details?: unknown;

    constructor(message: string, options?: { status?: number; code?: string; details?: unknown }) {
        super(message);
        this.status = options?.status;
        this.code = options?.code;
        this.details = options?.details;
    }
}

export function apiUrl(path: string) {
    if (!API_BASE_URL) return path;
    if (!path.startsWith('/')) return `${API_BASE_URL}/${path}`;
    return `${API_BASE_URL}${path}`;
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isIdempotent(method?: string) {
    const verb = (method || 'GET').toUpperCase();
    return verb === 'GET' || verb === 'HEAD';
}

function shouldRetryStatus(status: number) {
    return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

let authRefreshPromise: Promise<void> | null = null;

async function refreshAuthOnce(): Promise<void> {
    if (authRefreshPromise) return authRefreshPromise;
    authRefreshPromise = fetch(apiUrl('/api/auth/session'), {
        credentials: 'include',
        headers: { 'x-refresh': '1' },
    })
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
            authRefreshPromise = null;
        });
    return authRefreshPromise;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, {
            ...init,
            signal: controller.signal,
            credentials: 'include',
        });
    } finally {
        clearTimeout(timeout);
    }
}

export async function apiFetch(
    path: string,
    init: RequestInit = {},
    options?: { timeoutMs?: number; retries?: number; retryAuth?: boolean }
) {
    const url = apiUrl(path);
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retryAuth = options?.retryAuth ?? true;
    const maxRetries = options?.retries ?? (isIdempotent(init.method) ? DEFAULT_RETRIES : 0);

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            const res = await fetchWithTimeout(url, init, timeoutMs);

            if (res.status === 401 && retryAuth && !url.includes('/api/auth/session')) {
                await refreshAuthOnce();
                return fetchWithTimeout(url, init, timeoutMs);
            }

            if (attempt < maxRetries && shouldRetryStatus(res.status)) {
                const delay = Math.min(2000, RETRY_BASE_MS * Math.pow(2, attempt));
                await sleep(delay);
                continue;
            }

            return res;
        } catch (error: any) {
            const isAbort = error?.name === 'AbortError';
            const canRetry = attempt < maxRetries && isIdempotent(init.method);
            if (!canRetry) {
                throw error;
            }
            const delay = Math.min(2000, RETRY_BASE_MS * Math.pow(2, attempt));
            await sleep(delay);
            if (isAbort && attempt >= maxRetries) {
                throw error;
            }
        }
    }

    return fetchWithTimeout(url, init, timeoutMs);
}

export async function apiJson<T>(path: string, init: RequestInit = {}, options?: { timeoutMs?: number; retries?: number }) {
    const res = await apiFetch(path, init, options);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
        const message = typeof payload?.error === 'string' ? payload.error : 'Request failed';
        const code = typeof payload?.code === 'string' ? payload.code : undefined;
        throw new ApiError(message, { status: res.status, code, details: payload });
    }
    return payload as T;
}

export async function executeTradeApi<TResponse>(body: Record<string, unknown>) {
    return apiJson<TResponse>('/api/trades/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }, { timeoutMs: 15_000, retries: 0 });
}
