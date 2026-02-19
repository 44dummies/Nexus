import { Router } from 'express';
import crypto from 'crypto';
import type { Request, Response, RequestHandler } from 'express';
import { authorizeTokenCached } from '../lib/deriv';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { buildCookieOptions, buildStateCookieOptions, buildClearCookieOptions } from '../lib/requestUtils';
import { encryptToken } from '../lib/sessionCrypto';
import { authRateLimit } from '../lib/rateLimit';
import { warmRiskCache } from '../lib/riskCache';
import { authLogger } from '../lib/logger';

const router = Router();
const authRateLimitMiddleware: RequestHandler = authRateLimit;

const { client: supabaseAdmin } = getSupabaseAdmin();

const buildCookie = (maxAgeSeconds: number) => buildCookieOptions(maxAgeSeconds);

const persistSession = async (payload: {
    accountId: string;
    accountType: 'real' | 'demo';
    token: string;
    currency?: string | null;
}) => {
    if (!supabaseAdmin) return;
    const encrypted = encryptToken(payload.token);
    if (!encrypted) return;

    await supabaseAdmin.from('sessions').upsert({
        account_id: payload.accountId,
        account_type: payload.accountType,
        currency: payload.currency ?? null,
        token_encrypted: encrypted,
        last_seen: new Date().toISOString(),
    }, { onConflict: 'account_id' });
};

const persistAccount = async (payload: { accountId: string; accountType: 'real' | 'demo'; currency?: string | null }) => {
    if (!supabaseAdmin) return;
    await supabaseAdmin.from('accounts').upsert({
        deriv_account_id: payload.accountId,
        account_type: payload.accountType,
        currency: payload.currency ?? null,
    }, { onConflict: 'deriv_account_id' });
};

const persistRiskSnapshots = async (accountId: string, balance: number) => {
    if (!supabaseAdmin) return;
    const dateKey = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    await supabaseAdmin.from('settings').upsert({
        account_id: accountId,
        key: 'balance_snapshot',
        value: { balance, asOf: now },
        updated_at: now,
    }, { onConflict: 'account_id,key' });

    const { data } = await supabaseAdmin
        .from('settings')
        .select('id, value')
        .eq('account_id', accountId)
        .eq('key', 'risk_state')
        .maybeSingle();

    const existing = data?.value && typeof data.value === 'object' ? data.value as {
        date?: string;
        dailyStartEquity?: number;
        equityPeak?: number;
    } : null;

    const nextRiskState = {
        date: dateKey,
        dailyStartEquity: existing?.date === dateKey && typeof existing?.dailyStartEquity === 'number'
            ? existing.dailyStartEquity
            : balance,
        equityPeak: existing?.date === dateKey && typeof existing?.equityPeak === 'number'
            ? Math.max(existing.equityPeak, balance)
            : balance,
    };

    await supabaseAdmin.from('settings').upsert({
        account_id: accountId,
        key: 'risk_state',
        value: nextRiskState,
        updated_at: now,
    }, { onConflict: 'account_id,key' });
};

const clearAuthCookies = (res: Response) => {
    const options = buildClearCookieOptions();
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
    keys.forEach((key) => res.cookie(key, '', options));
};

const refreshAuthCookies = (req: Request, res: Response) => {
    const options = buildCookie(60 * 60);
    const cookie = req.cookies || {};
    const setIf = (key: string) => {
        if (cookie[key]) {
            res.cookie(key, cookie[key], options);
        }
    };

    setIf('deriv_token');
    setIf('deriv_account');
    setIf('deriv_currency');
    setIf('deriv_demo_token');
    setIf('deriv_demo_account');
    setIf('deriv_demo_currency');
    setIf('deriv_active_type');
    setIf('deriv_active_account');
    setIf('deriv_active_currency');
};

const resolveDevRedirect = (req: Request) => {
    const fallbackBase = (process.env.FRONTEND_URL || '').replace(/\/$/, '') || 'http://localhost:3000';
    const rawRedirect = typeof req.query.redirect === 'string' ? req.query.redirect : '';
    if (rawRedirect && rawRedirect.startsWith('/')) {
        return `${fallbackBase}${rawRedirect}`;
    }
    if (rawRedirect) {
        try {
            const url = new URL(rawRedirect);
            const host = url.hostname;
            const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
            if ((url.protocol === 'http:' || url.protocol === 'https:') && isLocalHost) {
                return url.toString();
            }
        } catch {
            // ignore invalid redirect values
        }
    }
    return `${fallbackBase}/dashboard`;
};

const extractBearerToken = (authorizationHeader: string | undefined): string | null => {
    if (!authorizationHeader) return null;
    const [scheme, ...rest] = authorizationHeader.trim().split(/\s+/);
    if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
    const token = rest.join(' ').trim();
    return token || null;
};

const resolveAuthorizedAccountType = (
    authorize: { loginid?: string; account_list?: Array<{ loginid: string; is_virtual: number | boolean }> } | null,
    fallbackType: 'real' | 'demo'
): 'real' | 'demo' => {
    const loginId = authorize?.loginid;
    if (loginId && Array.isArray(authorize?.account_list)) {
        const match = authorize.account_list.find((acct) => acct.loginid === loginId);
        if (match) {
            return match.is_virtual ? 'demo' : 'real';
        }
    }
    return fallbackType;
};

const isValidOAuthState = (provided: string | null, stored: string | undefined): boolean => {
    if (!provided || !stored) return false;
    if (provided.length !== stored.length) return false;
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(stored));
};

router.post('/start', authRateLimitMiddleware, async (_req, res) => {
    const appId = (process.env.DERIV_APP_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || '').trim();
    if (!appId) {
        return res.status(500).json({ error: 'Missing Deriv app id' });
    }

    const redirectUri = (process.env.DERIV_REDIRECT_URI || process.env.NEXT_PUBLIC_REDIRECT_URI || '').trim();
    const state = crypto.randomBytes(16).toString('hex');

    const url = new URL('https://oauth.deriv.com/oauth2/authorize');
    url.searchParams.set('app_id', appId);
    if (redirectUri) {
        url.searchParams.set('redirect_uri', redirectUri);
    }
    url.searchParams.set('l', 'EN');
    url.searchParams.set('state', state);

    res.cookie('deriv_oauth_state', state, buildStateCookieOptions());

    return res.json({ url: url.toString() });
});

router.get('/dev-session', authRateLimitMiddleware, async (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ error: 'Not found' });
    }

    const demoToken = (process.env.DEV_DEMO_TOKEN || '').trim();
    if (!demoToken) {
        return res.status(400).json({ error: 'DEV_DEMO_TOKEN not set' });
    }

    try {
        const authorize = await authorizeTokenCached(demoToken);
        const accountId = authorize?.loginid;
        if (!accountId) {
            return res.status(401).json({ error: 'Demo token invalid' });
        }

        const accountList = authorize?.account_list || [];
        const match = accountList.find((acct) => acct.loginid === accountId);
        const isVirtual = Boolean(match ? match.is_virtual : accountId.startsWith('V'));
        const accountType = isVirtual ? 'demo' : 'real';
        const currency = authorize?.currency || match?.currency || 'USD';

        const cookieOptions = buildCookie(60 * 60);
        if (accountType === 'demo') {
            res.cookie('deriv_demo_token', demoToken, cookieOptions);
            res.cookie('deriv_demo_account', accountId, cookieOptions);
            res.cookie('deriv_demo_currency', currency, cookieOptions);
        } else {
            res.cookie('deriv_token', demoToken, cookieOptions);
            res.cookie('deriv_account', accountId, cookieOptions);
            res.cookie('deriv_currency', currency, cookieOptions);
        }

        res.cookie('deriv_active_type', accountType, cookieOptions);
        res.cookie('deriv_active_account', accountId, cookieOptions);
        res.cookie('deriv_active_currency', currency, cookieOptions);

        await Promise.allSettled([
            persistSession({ accountId, accountType, token: demoToken, currency }),
            persistAccount({ accountId, accountType, currency }),
        ]);

        return res.redirect(resolveDevRedirect(req));
    } catch (error) {
        authLogger.error({ error }, 'Dev session failed');
        return res.status(500).json({ error: 'Failed to authorize demo token' });
    }
});

router.get('/callback', authRateLimitMiddleware, async (req, res) => {
    const searchParams = req.query;
    const stateParam = typeof searchParams.state === 'string' ? searchParams.state : null;
    const stateCookie = req.cookies?.deriv_oauth_state;

    const token1 = typeof searchParams.token1 === 'string' ? searchParams.token1 : null;
    const acct1 = typeof searchParams.acct1 === 'string' ? searchParams.acct1 : null;
    const cur1 = typeof searchParams.cur1 === 'string' ? searchParams.cur1 : null;

    const token2 = typeof searchParams.token2 === 'string' ? searchParams.token2 : null;
    const acct2 = typeof searchParams.acct2 === 'string' ? searchParams.acct2 : null;
    const cur2 = typeof searchParams.cur2 === 'string' ? searchParams.cur2 : null;

    // SECURITY: State cookie must be present to prevent login CSRF attacks
    if (!stateCookie) {
        return res.status(400).json({ error: 'Missing OAuth state cookie. Please try logging in again.' });
    }

    // SECURITY: State param must match state cookie
    if (!isValidOAuthState(stateParam, stateCookie)) {
        res.cookie('deriv_oauth_state', '', buildClearCookieOptions());
        return res.status(400).json({ error: 'Invalid OAuth state' });
    }

    // Clear state cookie after validation
    res.cookie('deriv_oauth_state', '', buildClearCookieOptions());

    if (!token1) {
        const code = typeof searchParams.code === 'string' ? searchParams.code : null;
        if (!code) {
            return res.status(400).json({
                error: 'No token or authorization code provided',
                received: searchParams,
            });
        }
        return res.status(501).json({ error: 'Code flow not implemented' });
    }

    try {
        const cookieOptions = buildCookie(60 * 60);

        res.cookie('deriv_token', token1, cookieOptions);
        res.cookie('deriv_account', acct1 || '', cookieOptions);
        res.cookie('deriv_currency', cur1 || 'USD', cookieOptions);

        const demoAvailable = Boolean(token2 && acct2);
        const activeType = demoAvailable ? 'demo' : 'real';
        const activeAccount = demoAvailable ? acct2 : acct1;
        const activeCurrency = demoAvailable ? cur2 : cur1;

        if (token2) {
            res.cookie('deriv_demo_token', token2, cookieOptions);
            res.cookie('deriv_demo_account', acct2 || '', cookieOptions);
            res.cookie('deriv_demo_currency', cur2 || 'USD', cookieOptions);
        }

        res.cookie('deriv_active_type', activeType, cookieOptions);
        res.cookie('deriv_active_account', activeAccount || '', cookieOptions);
        res.cookie('deriv_active_currency', activeCurrency || 'USD', cookieOptions);

        const sessionWrites: Promise<unknown>[] = [];
        if (acct1 && token1) {
            sessionWrites.push(persistSession({ accountId: acct1, accountType: 'real', token: token1, currency: cur1 }));
            sessionWrites.push(persistAccount({ accountId: acct1, accountType: 'real', currency: cur1 }));
        }
        if (acct2 && token2) {
            sessionWrites.push(persistSession({ accountId: acct2, accountType: 'demo', token: token2, currency: cur2 }));
            sessionWrites.push(persistAccount({ accountId: acct2, accountType: 'demo', currency: cur2 }));
        }

        if (sessionWrites.length > 0) {
            await Promise.allSettled(sessionWrites);
        }

        const frontendUrl = (process.env.FRONTEND_URL || '').replace(/\/$/, '') || 'http://localhost:3000';
        return res.redirect(`${frontendUrl}/dashboard`);
    } catch (error) {
        authLogger.error({ error }, 'Auth callback failed');
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

router.get('/session', async (req, res) => {
    const token = req.cookies?.deriv_token;
    const account = req.cookies?.deriv_account;
    const currency = req.cookies?.deriv_currency;

    const demoToken = req.cookies?.deriv_demo_token;
    const demoAccount = req.cookies?.deriv_demo_account;
    const demoCurrency = req.cookies?.deriv_demo_currency;

    const activeTypeCookie = req.cookies?.deriv_active_type as 'real' | 'demo' | undefined;
    const activeCurrencyCookie = req.cookies?.deriv_active_currency || null;
    const bearerToken = extractBearerToken(req.get('authorization') || undefined);
    const usingBearerToken = Boolean(bearerToken);

    const cookieInferredType: 'real' | 'demo' = activeTypeCookie || (demoToken ? 'demo' : 'real');
    const activeType = cookieInferredType;
    const activeToken = bearerToken || (activeType === 'demo' ? demoToken : token);

    if (!activeToken) {
        clearAuthCookies(res);
        return res.status(401).json({ authenticated: false });
    }

    try {
        const authorize = await authorizeTokenCached(activeToken);
        const accountList = authorize?.account_list?.map((acct) => ({
            id: acct.loginid,
            currency: acct.currency,
            type: acct.is_virtual ? 'demo' : 'real',
        })) || [];

        const derivedActiveAccount = authorize?.loginid || null;
        const derivedActiveType = resolveAuthorizedAccountType(authorize ?? null, activeType);

        const derivedActiveCurrency = authorize?.currency
            || activeCurrencyCookie
            || null;

        const balanceValue = authorize?.balance;
        const balance = typeof balanceValue === 'number'
            ? balanceValue
            : typeof balanceValue === 'string'
                ? Number(balanceValue)
                : null;

        if (typeof balance === 'number' && Number.isFinite(balance)) {
            const accountIdForSnapshot = derivedActiveAccount || authorize?.loginid || null;
            if (accountIdForSnapshot) {
                persistRiskSnapshots(accountIdForSnapshot, balance).catch((error) => {
                    authLogger.error({ error, accountId: accountIdForSnapshot }, 'Persist risk snapshots failed');
                });
                warmRiskCache(accountIdForSnapshot, balance).catch((error) => {
                    authLogger.error({ error, accountId: accountIdForSnapshot }, 'Warm risk cache failed');
                });
            }
        }

        refreshAuthCookies(req, res);

        return res.json({
            authenticated: true,
            email: authorize?.email || null,
            balance: Number.isFinite(balance as number) ? balance : null,
            account: account || derivedActiveAccount,
            currency: currency || derivedActiveCurrency,
            demoAccount,
            demoCurrency,
            accounts: accountList,
            activeAccountId: derivedActiveAccount,
            activeAccountType: derivedActiveType,
            activeCurrency: derivedActiveCurrency,
        });
    } catch (error) {
        const err = error as Error & { code?: string };
        const code = err.code;

        // Only clear cookies if the token is definitely invalid
        if (!usingBearerToken && (code === 'InvalidToken' || err.message.includes('InvalidToken'))) {
            clearAuthCookies(res);
            return res.status(401).json({ authenticated: false, error: err.message, code: 'InvalidToken' });
        }

        // For timeouts or network errors, do NOT clear cookies.
        // The user might be valid, just the upstream is flaky.
        if (code === 'Timeout' || code === 'NetworkError') {
            console.warn('Auth session check timed out or failed network check', { code, error: err.message });
            return res.status(503).json({ authenticated: false, error: err.message, code: code || 'TransientError', transient: true });
        }

        // Default behavior for unknown errors: assume auth failed but maybe be conservative?
        // safest is to clear if we don't know. 
        // But the original issue was aggressive clearing.
        // Let's only clear if we are sure it's an auth error.

        // Actually, if we are not sure, maybe we should preserve?
        // Let's stick to the plan: only clear if we KNOW it's bad.
        // But if `authorizeToken` returns an error from Deriv that is NOT InvalidToken (e.g. `RateLimit`), we shouldn't clear.

        console.warn('Auth check failed with unknown error', { error: err.message, code });
        // Don't clear cookies for unknown errors to be safe against flakes.
        return res.status(401).json({ authenticated: false, error: err.message });
    }
});

router.post('/session', authRateLimitMiddleware, async (req, res) => {
    const action = typeof req.body?.action === 'string' ? req.body.action : '';

    if (action === 'logout') {
        clearAuthCookies(res);
        return res.json({ success: true });
    }

    if (action === 'set-active-account') {
        const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId : '';
        const accountType = req.body?.accountType === 'demo' || req.body?.accountType === 'real' ? req.body.accountType : null;
        const currency = typeof req.body?.currency === 'string' ? req.body.currency : null;

        if (!accountId || !accountType) {
            return res.status(400).json({ success: false, error: 'Invalid account selection' });
        }

        const realAccount = req.cookies?.deriv_account;
        const demoAccount = req.cookies?.deriv_demo_account;

        if (accountType === 'real' && accountId !== realAccount) {
            return res.status(400).json({ success: false, error: 'Real account mismatch' });
        }

        if (accountType === 'demo' && accountId !== demoAccount) {
            return res.status(400).json({ success: false, error: 'Demo account mismatch' });
        }

        const cookieOptions = buildCookie(60 * 60);
        res.cookie('deriv_active_type', accountType, cookieOptions);
        res.cookie('deriv_active_account', accountId, cookieOptions);
        if (currency) {
            res.cookie('deriv_active_currency', currency, cookieOptions);
        }

        return res.json({ success: true });
    }

    return res.status(400).json({ success: false, error: 'Unsupported action' });
});

export default router;
