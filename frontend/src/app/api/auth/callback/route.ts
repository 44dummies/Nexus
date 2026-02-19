import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const getBackendBaseUrl = () => {
    const base = process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || '';
    return base.replace(/\/$/, '');
};

function applySetCookieHeaders(target: NextResponse, source: Headers) {
    const getSetCookie = (source as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const setCookies = typeof getSetCookie === 'function' ? getSetCookie.call(source) : null;

    if (Array.isArray(setCookies) && setCookies.length > 0) {
        setCookies.forEach((cookie) => target.headers.append('set-cookie', cookie));
        return;
    }

    const fallback = source.get('set-cookie');
    if (fallback) {
        target.headers.set('set-cookie', fallback);
    }
}

export async function GET(request: NextRequest) {
    const backendBaseUrl = getBackendBaseUrl();
    if (!backendBaseUrl) {
        return NextResponse.json({ error: 'Missing API base URL' }, { status: 500 });
    }

    const callbackUrl = new URL('/api/auth/callback', backendBaseUrl);
    callbackUrl.search = request.nextUrl.search;
    const correlationId = request.headers.get('x-correlation-id') || request.headers.get('x-request-id');
    const authorization = request.headers.get('authorization');

    try {
        const backendResponse = await fetch(callbackUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: {
                cookie: request.headers.get('cookie') || '',
                ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
                ...(authorization ? { authorization } : {}),
            },
            cache: 'no-store',
        });

        const response = new NextResponse(backendResponse.body, {
            status: backendResponse.status,
        });

        backendResponse.headers.forEach((value, key) => {
            if (key.toLowerCase() === 'set-cookie') return;
            response.headers.set(key, value);
        });
        applySetCookieHeaders(response, backendResponse.headers);

        return response;
    } catch (error) {
        return NextResponse.json(
            { error: 'Auth callback proxy failed', details: (error as Error).message },
            { status: 502 }
        );
    }
}
