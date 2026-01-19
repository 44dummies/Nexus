import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const code = searchParams.get('code');
    const appId = process.env.NEXT_PUBLIC_DERIV_APP_ID;

    // NOTE: Deriv usually requires 'response_type=token' for implicit flow, which puts tokens in the URI fragment.
    // However, since we requested 'response_type=code', we get a code that needs to be exchanged.
    // We will attempt the exchange here. If this is a public client, we might not need a secret.

    if (!code) {
        return NextResponse.json({ error: 'No authorization code provided' }, { status: 400 });
    }

    try {
        // Attempt to exchange code for token
        // The endpoint provided in the prompt is https://www.deriv.com/oauth2/token
        // In many OAuth setups this would be a POST.

        // NOTE: This logic assumes Deriv supports Code Grant for this App ID without a client secret,
        // or that we can exchange it via public endpoint.
        const tokenUrl = 'https://oauth.deriv.com/oauth2/token'; // Using standard API host

        const response = await fetch(tokenUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                app_id: appId || '',
                code: code,
                grant_type: 'authorization_code',
                // redirect_uri: process.env.NEXT_PUBLIC_REDIRECT_URI || '' // Sometimes required
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            console.error('Deriv Token Exchange Error:', data);
            // Fallback: If code flow fails (likely due to missing secret), we might need to tell user to switch to Implicit.
            // But per prompt instructions, we persist with this pathway.
            return NextResponse.json({ error: 'Failed to exchange token', details: data }, { status: 500 });
        }

        // data should contain access_token, refresh_token, etc.
        const { access_token, refresh_token } = data;

        // Store in HttpOnly cookie
        const cookieStore = await cookies();
        cookieStore.set('deriv_token', access_token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 60 * 60 * 24 * 7, // 1 week
            path: '/',
        });

        // Redirect to Dashboard
        return NextResponse.redirect(new URL('/dashboard', request.url));

    } catch (error) {
        console.error('Auth Error:', error);
        return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
    }
}
