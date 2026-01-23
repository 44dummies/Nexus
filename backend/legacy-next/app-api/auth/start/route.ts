import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import crypto from 'crypto';

export const runtime = 'nodejs';

function buildCookieOptions() {
    return {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 5 * 60, // 5 minutes
        path: '/',
        sameSite: 'lax' as const,
    };
}

export async function POST() {
    const appId = process.env.NEXT_PUBLIC_DERIV_APP_ID?.trim();
    if (!appId) {
        return NextResponse.json({ error: 'Missing Deriv app id' }, { status: 500 });
    }

    const redirectUri = process.env.NEXT_PUBLIC_REDIRECT_URI?.trim();
    const state = crypto.randomBytes(16).toString('hex');

    const url = new URL('https://oauth.deriv.com/oauth2/authorize');
    url.searchParams.set('app_id', appId);
    if (redirectUri) {
        url.searchParams.set('redirect_uri', redirectUri);
    }
    url.searchParams.set('l', 'EN');
    url.searchParams.set('state', state);

    const cookieStore = await cookies();
    cookieStore.set('deriv_oauth_state', state, buildCookieOptions());

    return NextResponse.json({ url: url.toString() }, { headers: { 'Cache-Control': 'no-store' } });
}
