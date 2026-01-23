import { NextRequest, NextResponse } from 'next/server';

const getBackendBaseUrl = () => {
    const base = process.env.NEXT_PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '';
    return base.replace(/\/$/, '');
};

export function GET(request: NextRequest) {
    const backendBaseUrl = getBackendBaseUrl();
    if (!backendBaseUrl) {
        return NextResponse.json({ error: 'Missing API base URL' }, { status: 500 });
    }

    const callbackUrl = new URL('/api/auth/callback', backendBaseUrl);
    callbackUrl.search = request.nextUrl.search;
    return NextResponse.redirect(callbackUrl.toString(), 307);
}
