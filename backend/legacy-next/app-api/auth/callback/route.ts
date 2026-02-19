import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import crypto from 'crypto';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

const SESSION_ENCRYPTION_KEY = process.env.SESSION_ENCRYPTION_KEY;
const LEGACY_API_ENABLED = process.env.ENABLE_LEGACY_NEXT_API === 'true';

const { client: supabaseAdmin } = getSupabaseAdmin();

const buildCookieOptions = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60, // 1 hour
    path: '/',
    sameSite: 'strict' as const,
});

const buildStateClearOptions = () => ({
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 0,
    path: '/',
    sameSite: 'strict' as const,
});

const isValidOAuthState = (provided: string | null, stored: string | undefined): boolean => {
    if (!provided || !stored) return false;
    if (provided.length !== stored.length) return false;
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(stored));
};

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

export async function GET(request: NextRequest) {
    if (!LEGACY_API_ENABLED) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const searchParams = request.nextUrl.searchParams;
    const cookieStore = await cookies();
    const stateParam = searchParams.get('state');
    const stateCookie = cookieStore.get('deriv_oauth_state')?.value;

    // Deriv uses IMPLICIT flow - tokens come directly in URL params
    // Format: ?acct1=CR123&token1=xxx&cur1=USD&acct2=VRTC456&token2=yyy&cur2=USD

    const token1 = searchParams.get('token1');
    const acct1 = searchParams.get('acct1');
    const cur1 = searchParams.get('cur1');

    // Optional: Second account (usually demo)
    const token2 = searchParams.get('token2');
    const acct2 = searchParams.get('acct2');
    const cur2 = searchParams.get('cur2');

    if (!stateCookie) {
        return NextResponse.json({ error: 'Missing OAuth state cookie' }, { status: 400 });
    }

    if (!isValidOAuthState(stateParam, stateCookie)) {
        cookieStore.set('deriv_oauth_state', '', buildStateClearOptions());
        return NextResponse.json({ error: 'Invalid OAuth state' }, { status: 400 });
    }

    cookieStore.set('deriv_oauth_state', '', buildStateClearOptions());

    if (!token1) {
        // Fallback: Check for authorization code (Code flow)
        const code = searchParams.get('code');
        if (!code) {
            return NextResponse.json({
                error: 'No token or authorization code provided',
                received: Object.fromEntries(searchParams.entries())
            }, { status: 400 });
        }

        // Handle code exchange if needed (currently Deriv doesn't use this)
        return NextResponse.json({ error: 'Code flow not implemented' }, { status: 501 });
    }

    try {
        // Store the first token (real account) in HttpOnly cookie
        // Store primary token
        // Store primary token
        const cookieOptions = buildCookieOptions();

        cookieStore.set('deriv_token', token1, cookieOptions);

        // Store account info for reference
        cookieStore.set('deriv_account', acct1 || '', cookieOptions);

        cookieStore.set('deriv_currency', cur1 || 'USD', cookieOptions);

        const demoAvailable = Boolean(token2 && acct2);
        const activeType = demoAvailable ? 'demo' : 'real';
        const activeAccount = demoAvailable ? acct2 : acct1;
        const activeCurrency = demoAvailable ? cur2 : cur1;

        // If user has demo account, store that too
        if (token2) {
            cookieStore.set('deriv_demo_token', token2, cookieOptions);
            cookieStore.set('deriv_demo_account', acct2 || '', cookieOptions);
            cookieStore.set('deriv_demo_currency', cur2 || 'USD', cookieOptions);
        }

        // Active account defaults to demo when available
        cookieStore.set('deriv_active_type', activeType, cookieOptions);
        cookieStore.set('deriv_active_account', activeAccount || '', cookieOptions);
        cookieStore.set('deriv_active_currency', activeCurrency || 'USD', cookieOptions);

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

        // Redirect to Dashboard
        return NextResponse.redirect(new URL('/dashboard', request.url));

    } catch (error) {
        console.error('Auth Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
