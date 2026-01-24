import { Router } from 'express';
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { authorizeTokenCached } from '../lib/deriv';
import { getSupabaseAdmin } from '../lib/supabaseAdmin';
import { buildCookieOptions, buildStateCookieOptions, buildClearCookieOptions } from '../lib/requestUtils';

const router = Router();

const SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY;

const { client: supabaseAdmin } = getSupabaseAdmin();

const buildCookie = (maxAgeSeconds: number) => buildCookieOptions(maxAgeSeconds);

const encryptToken = (token: string) => {
    if (!SESSION_ENCRYPTION_KEY) return null;
    const key = Buffer.from(SESSION_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
    };
};

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

router.post('/start', async (_req, res) => {
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

router.get('/callback', async (req, res) => {
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
    if (stateParam !== stateCookie) {
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
        console.error('Auth Error:', error);
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
    const activeAccountCookie = req.cookies?.deriv_active_account || null;
    const activeCurrencyCookie = req.cookies?.deriv_active_currency || null;

    const activeType = activeTypeCookie || (demoToken ? 'demo' : 'real');
    const activeToken = activeType === 'demo' ? demoToken : token;

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

        if (typeof balance === 'number' && Number.isFinite(balance)) {
            const accountIdForSnapshot = derivedActiveAccount || authorize?.loginid || null;
            if (accountIdForSnapshot) {
                persistRiskSnapshots(accountIdForSnapshot, balance).catch(() => undefined);
            }
        }

        refreshAuthCookies(req, res);

        return res.json({
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
        clearAuthCookies(res);
        return res.status(401).json({ authenticated: false, error: (error as Error).message });
    }
});

router.post('/session', async (req, res) => {
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
