import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import WebSocket from 'ws';

export const runtime = 'nodejs';

const APP_ID = process.env.NEXT_PUBLIC_DERIV_APP_ID || '1089';
const AUTH_CACHE_TTL_MS = 30_000;
const authCache = new Map<string, { data: DerivAuthorizeResponse['authorize']; expiresAt: number }>();

interface DerivAuthorizeResponse {
    msg_type: 'authorize';
    authorize?: {
        loginid?: string;
        currency?: string;
        email?: string;
        balance?: number;
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

async function authorizeToken(token: string) {
    return new Promise<DerivAuthorizeResponse['authorize']>((resolve, reject) => {
        const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);
        const timeout = setTimeout(() => {
            ws.close();
            reject(new Error('Authorization timed out'));
        }, 8000);

        ws.on('open', () => {
            ws.send(JSON.stringify({ authorize: token, req_id: 1 }));
        });

        ws.on('message', (data) => {
            const response = JSON.parse(data.toString()) as DerivAuthorizeResponse;

            if (response.error) {
                clearTimeout(timeout);
                ws.close();
                reject(new Error(response.error.message));
                return;
            }

            if (response.msg_type === 'authorize') {
                clearTimeout(timeout);
                ws.close();
                resolve(response.authorize);
            }
        });

        ws.on('error', (err) => {
            clearTimeout(timeout);
            ws.close();
            reject(err);
        });
    });
}

async function authorizeTokenCached(token: string) {
    const cached = authCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }
    const data = await authorizeToken(token);
    authCache.set(token, { data, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    return data;
}

type CookieStore = Awaited<ReturnType<typeof cookies>>;

function buildCookieOptions() {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 60 * 60,
        path: '/',
        sameSite: 'strict' as const,
    };
}

function clearAuthCookies(cookieStore: CookieStore) {
    const expired = {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 0,
        path: '/',
        sameSite: 'strict' as const,
    };

    const keys = [
        'deriv_token',
        'deriv_account',
        'deriv_currency',
        'deriv_demo_token',
        'deriv_demo_account',
        'deriv_demo_currency',
        'deriv_active_type',
        'deriv_active_account',
        'deriv_active_currency',
    ];

    keys.forEach((key) => cookieStore.set(key, '', expired));
}

export async function GET(request: NextRequest) {
    const cookieStore = await cookies();

    const token = cookieStore.get('deriv_token')?.value;
    const account = cookieStore.get('deriv_account')?.value;
    const currency = cookieStore.get('deriv_currency')?.value;

    const demoToken = cookieStore.get('deriv_demo_token')?.value;
    const demoAccount = cookieStore.get('deriv_demo_account')?.value;
    const demoCurrency = cookieStore.get('deriv_demo_currency')?.value;

    const activeTypeCookie = cookieStore.get('deriv_active_type')?.value as 'real' | 'demo' | undefined;
    const activeAccountCookie = cookieStore.get('deriv_active_account')?.value || null;
    const activeCurrencyCookie = cookieStore.get('deriv_active_currency')?.value || null;

    const activeType = activeTypeCookie
        || (demoToken ? 'demo' : 'real');

    const activeToken = activeType === 'demo' ? demoToken : token;

    if (!activeToken) {
        return NextResponse.json({ authenticated: false }, { status: 401 });
    }

    try {
        const authorize = await authorizeTokenCached(activeToken);
        const accountList = authorize?.account_list?.map((acct) => ({
            id: acct.loginid,
            currency: acct.currency,
            type: acct.is_virtual ? 'demo' : 'real',
        })) || [];

        const derivedActiveAccount = activeAccountCookie
            || authorize?.loginid
            || (activeType === 'demo' ? demoAccount : account)
            || null;

        const derivedActiveCurrency = activeCurrencyCookie
            || authorize?.currency
            || (activeType === 'demo' ? demoCurrency : currency)
            || null;

        const balanceValue = authorize?.balance;
        const balance = typeof balanceValue === 'number'
            ? balanceValue
            : typeof balanceValue === 'string'
                ? Number(balanceValue)
                : null;

        return NextResponse.json({
            authenticated: true,
            email: authorize?.email || null,
            balance: Number.isFinite(balance as number) ? balance : null,
            account,
            currency,
            demoAccount,
            demoCurrency,
            accounts: accountList.length > 0 ? accountList : [
                ...(account ? [{ id: account, currency: currency || 'USD', type: account.startsWith('CR') ? 'real' : 'demo' }] : []),
                ...(demoAccount ? [{ id: demoAccount, currency: demoCurrency || 'USD', type: 'demo' as const }] : []),
            ],
            activeAccountId: derivedActiveAccount,
            activeAccountType: activeType,
            activeCurrency: derivedActiveCurrency,
        });
    } catch (error) {
        clearAuthCookies(cookieStore);
        return NextResponse.json({ authenticated: false, error: (error as Error).message }, { status: 401 });
    }
}

export async function POST(request: Request) {
    const cookieStore = await cookies();
    const body = await request.json().catch(() => ({}));
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'logout') {
        clearAuthCookies(cookieStore);
        return NextResponse.json({ success: true });
    }

    if (action === 'set-active-account') {
        const accountId = typeof body.accountId === 'string' ? body.accountId : '';
        const accountType = body.accountType === 'demo' || body.accountType === 'real' ? body.accountType : null;
        const currency = typeof body.currency === 'string' ? body.currency : null;

        if (!accountId || !accountType) {
            return NextResponse.json({ success: false, error: 'Invalid account selection' }, { status: 400 });
        }

        const realAccount = cookieStore.get('deriv_account')?.value;
        const demoAccount = cookieStore.get('deriv_demo_account')?.value;

        if (accountType === 'real' && accountId !== realAccount) {
            return NextResponse.json({ success: false, error: 'Real account mismatch' }, { status: 400 });
        }

        if (accountType === 'demo' && accountId !== demoAccount) {
            return NextResponse.json({ success: false, error: 'Demo account mismatch' }, { status: 400 });
        }

        const cookieOptions = buildCookieOptions();
        cookieStore.set('deriv_active_type', accountType, cookieOptions);
        cookieStore.set('deriv_active_account', accountId, cookieOptions);
        if (currency) {
            cookieStore.set('deriv_active_currency', currency, cookieOptions);
        }

        return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: 'Unsupported action' }, { status: 400 });
}
