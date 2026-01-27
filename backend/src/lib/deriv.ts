import WebSocket from 'ws';

export interface DerivAuthorizeResponse {
    msg_type: 'authorize';
    authorize?: {
        loginid?: string;
        currency?: string;
        email?: string;
        balance?: number | string;
        account_list?: Array<{
            loginid: string;
            currency: string;
            is_virtual: number | boolean;
        }>;
    };
    error?: {
        message: string;
        code: string;
    };
}

const APP_ID = process.env.DERIV_APP_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || '1089';
const AUTH_CACHE_TTL_MS = 30_000;
const authCache = new Map<string, { data: DerivAuthorizeResponse['authorize']; expiresAt: number }>();

function authorizeToken(token: string) {
    return new Promise<DerivAuthorizeResponse['authorize']>((resolve, reject) => {
        const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);
        const timeout = setTimeout(() => {
            ws.close();
            const err = new Error('Authorization timed out');
            (err as any).code = 'Timeout';
            reject(err);
        }, 8000);

        ws.on('open', () => {
            ws.send(JSON.stringify({ authorize: token, req_id: 1 }));
        });

        ws.on('message', (data) => {
            let response: DerivAuthorizeResponse;
            try {
                response = JSON.parse(data.toString()) as DerivAuthorizeResponse;
            } catch {
                return;
            }

            if (response.error) {
                clearTimeout(timeout);
                ws.close();
                const err = new Error(response.error.message);
                (err as any).code = response.error.code;
                reject(err);
                return;
            }

            // ... inside successful response ...
            if (response.msg_type === 'authorize') {
                clearTimeout(timeout);
                ws.close();
                resolve(response.authorize);
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timeout);
            ws.close();
            (err as any).code = 'NetworkError';
            reject(err);
        });
    });
}

export async function authorizeTokenCached(token: string) {
    const cached = authCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }
    const data = await authorizeToken(token);
    authCache.set(token, { data, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    return data;
}
