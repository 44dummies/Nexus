import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const rateLimit = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60 * 1000;
const LIMIT = 60;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function buildCspHeaderValue() {
    const scriptSrc = IS_PRODUCTION
        ? "script-src 'self' https://va.vercel-scripts.com;"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://va.vercel-scripts.com;";

    return [
        "default-src 'self';",
        scriptSrc,
        "style-src 'self' 'unsafe-inline';",
        "img-src 'self' data: blob:;",
        "font-src 'self' data:;",
        "connect-src 'self' https://*.deriv.com https://*.derivws.com https://*.supabase.co wss://*.deriv.com wss://*.derivws.com wss://*.binaryws.com wss://*.supabase.co;",
        "object-src 'none';",
        "base-uri 'self';",
        "frame-ancestors 'self';",
    ].join(' ');
}

async function incrementUpstash(ip: string) {
    if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) return null;
    const windowId = Math.floor(Date.now() / WINDOW_MS);
    const key = `ratelimit:${ip}:${windowId}`;
    const headers = { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` };

    const incrRes = await fetch(`${UPSTASH_REDIS_REST_URL}/INCR/${key}`, { headers });
    const incrJson = await incrRes.json().catch(() => ({}));
    const count = typeof incrJson.result === 'number' ? incrJson.result : Number(incrJson.result);
    if (count === 1) {
        await fetch(`${UPSTASH_REDIS_REST_URL}/EXPIRE/${key}/${Math.ceil(WINDOW_MS / 1000)}`, { headers });
    }
    return Number.isFinite(count) ? count : null;
}

function getClientIp(request: NextRequest): string {
    const forwardedFor = request.headers.get('x-forwarded-for');
    if (forwardedFor) {
        const first = forwardedFor.split(',')[0]?.trim();
        if (first) return first;
    }

    const realIp = request.headers.get('x-real-ip');
    if (realIp) return realIp;

    return '0.0.0.0';
}

export async function middleware(request: NextRequest) {
    // Rate limit for /api routes
    if (request.nextUrl.pathname.startsWith('/api')) {
        const ip = getClientIp(request);
        let count: number | null = null;
        const now = Date.now();

        if (rateLimit.size > 5000) {
            for (const [key, entry] of rateLimit.entries()) {
                if (now > entry.resetAt) {
                    rateLimit.delete(key);
                }
            }
        }

        if (UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN) {
            try {
                count = await incrementUpstash(ip);
            } catch {
                count = null;
            }
        }

        if (count === null) {
            const entry = rateLimit.get(ip);
            if (!entry || now > entry.resetAt) {
                rateLimit.set(ip, { count: 1, resetAt: now + WINDOW_MS });
                count = 1;
            } else {
                entry.count += 1;
                count = entry.count;
            }
        }

        if (count > LIMIT) {
            return new NextResponse('Too Many Requests', {
                status: 429,
                headers: {
                    'Retry-After': '60',
                    'X-RateLimit-Limit': LIMIT.toString(),
                    'X-RateLimit-Remaining': '0',
                }
            });
        }

        const response = NextResponse.next();
        response.headers.set('X-RateLimit-Limit', LIMIT.toString());
        response.headers.set('X-RateLimit-Remaining', Math.max(0, LIMIT - (count || 0)).toString());
        // Security: Add CSP header
        response.headers.set(
            'Content-Security-Policy',
            buildCspHeaderValue()
        );
        return response;
    }

    const response = NextResponse.next();
    // Security: Add CSP header for non-API routes too
    response.headers.set(
        'Content-Security-Policy',
        buildCspHeaderValue()
    );
    return response;
}

export const config = {
    matcher: '/:path*',
};
