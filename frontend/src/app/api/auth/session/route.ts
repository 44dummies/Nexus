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

    const sessionUrl = new URL('/api/auth/session', backendBaseUrl);
    const correlationId = request.headers.get('x-correlation-id') || request.headers.get('x-request-id');
    const authorization = request.headers.get('authorization');

    try {
        const backendResponse = await fetch(sessionUrl, {
            method: 'GET',
            headers: {
                cookie: request.headers.get('cookie') || '',
                ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
                ...(authorization ? { authorization } : {}),
            },
            cache: 'no-store',
        });

        const body = await backendResponse.text();
        const response = new NextResponse(body, {
            status: backendResponse.status,
            headers: {
                'Content-Type': 'application/json',
            },
        });

        backendResponse.headers.forEach((value, key) => {
            if (key.toLowerCase() === 'set-cookie') return;
            if (key.toLowerCase() === 'content-type') return;
            response.headers.set(key, value);
        });
        applySetCookieHeaders(response, backendResponse.headers);

        return response;
    } catch (error) {
        return NextResponse.json(
            { error: 'Auth session proxy failed', details: (error as Error).message },
            { status: 502 }
        );
    }
}

export async function POST(request: NextRequest) {
    const backendBaseUrl = getBackendBaseUrl();
    if (!backendBaseUrl) {
        return NextResponse.json({ error: 'Missing API base URL' }, { status: 500 });
    }

    const sessionUrl = new URL('/api/auth/session', backendBaseUrl);
    const correlationId = request.headers.get('x-correlation-id') || request.headers.get('x-request-id');
    const authorization = request.headers.get('authorization');

    try {
        const body = await request.text();
        const backendResponse = await fetch(sessionUrl, {
            method: 'POST',
            headers: {
                cookie: request.headers.get('cookie') || '',
                'Content-Type': 'application/json',
                ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
                ...(authorization ? { authorization } : {}),
            },
            body,
            cache: 'no-store',
        });

        const responseBody = await backendResponse.text();
        const response = new NextResponse(responseBody, {
            status: backendResponse.status,
            headers: {
                'Content-Type': 'application/json',
            },
        });

        backendResponse.headers.forEach((value, key) => {
            if (key.toLowerCase() === 'set-cookie') return;
            if (key.toLowerCase() === 'content-type') return;
            response.headers.set(key, value);
        });
        applySetCookieHeaders(response, backendResponse.headers);

        return response;
    } catch (error) {
        return NextResponse.json(
            { error: 'Auth session proxy failed', details: (error as Error).message },
            { status: 502 }
        );
    }
}
