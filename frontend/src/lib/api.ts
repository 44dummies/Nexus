const isServer = typeof window === 'undefined';
export const API_BASE_URL = isServer
    ? (process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || '').replace(/\/$/, '')
    : '';

export function apiUrl(path: string) {
    if (!API_BASE_URL) return path;
    if (!path.startsWith('/')) return `${API_BASE_URL}/${path}`;
    return `${API_BASE_URL}${path}`;
}

export async function apiFetch(path: string, init: RequestInit = {}) {
    return fetch(apiUrl(path), {
        ...init,
        credentials: 'include',
    });
}

export async function apiJson<T>(path: string, init: RequestInit = {}) {
    const res = await apiFetch(path, init);
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
        const message = typeof payload?.error === 'string' ? payload.error : 'Request failed';
        throw new Error(message);
    }
    return payload as T;
}

export async function executeTradeApi<TResponse>(body: Record<string, unknown>) {
    return apiJson<TResponse>('/api/trades/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}
