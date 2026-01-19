import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;

    // Deriv uses IMPLICIT flow - tokens come directly in URL params
    // Format: ?acct1=CR123&token1=xxx&cur1=USD&acct2=VRTC456&token2=yyy&cur2=USD

    const token1 = searchParams.get('token1');
    const acct1 = searchParams.get('acct1');
    const cur1 = searchParams.get('cur1');

    // Optional: Second account (usually demo)
    const token2 = searchParams.get('token2');
    const acct2 = searchParams.get('acct2');
    const cur2 = searchParams.get('cur2');

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
        const cookieStore = await cookies();

        // Store primary token
        cookieStore.set('deriv_token', token1, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 60 * 60 * 24 * 7, // 1 week
            path: '/',
            sameSite: 'lax',
        });

        // Store account info for reference
        cookieStore.set('deriv_account', acct1 || '', {
            httpOnly: false, // Allow client access
            secure: process.env.NODE_ENV === 'production',
            maxAge: 60 * 60 * 24 * 7,
            path: '/',
            sameSite: 'lax',
        });

        cookieStore.set('deriv_currency', cur1 || 'USD', {
            httpOnly: false,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 60 * 60 * 24 * 7,
            path: '/',
            sameSite: 'lax',
        });

        // If user has demo account, store that too
        if (token2) {
            cookieStore.set('deriv_demo_token', token2, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                maxAge: 60 * 60 * 24 * 7,
                path: '/',
                sameSite: 'lax',
            });
            cookieStore.set('deriv_demo_account', acct2 || '', {
                httpOnly: false,
                secure: process.env.NODE_ENV === 'production',
                maxAge: 60 * 60 * 24 * 7,
                path: '/',
                sameSite: 'lax',
            });
            cookieStore.set('deriv_demo_currency', cur2 || 'USD', {
                httpOnly: false,
                secure: process.env.NODE_ENV === 'production',
                maxAge: 60 * 60 * 24 * 7,
                path: '/',
                sameSite: 'lax',
            });
        }

        // Redirect to Dashboard
        return NextResponse.redirect(new URL('/dashboard', request.url));

    } catch (error) {
        console.error('Auth Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
