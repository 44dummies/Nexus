import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const rateLimit = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 60 * 1000;
const LIMIT = 60;

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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

export async function middleware(request: NextRequest) {
    // Rate limit for /api routes
    if (request.nextUrl.pathname.startsWith('/api')) {
        const forwardedFor = request.headers.get('x-forwarded-for');
        const forwardedIp = forwardedFor ? forwardedFor.split(',')[0]?.trim() : null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ip = forwardedIp || (request as any).ip || '0.0.0.0';
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
        return response;
    }

    return NextResponse.next();
}

export const config = {
    matcher: '/api/:path*',
};
