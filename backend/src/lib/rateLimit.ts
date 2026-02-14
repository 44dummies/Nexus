import type { Request, Response, NextFunction } from 'express';
import Redis from 'ioredis';
import { redisClient as defaultRedisClient } from './redis';
import { randomUUID } from 'crypto';

/**
 * Validated distributed rate limiting middleware with fallback
 * algorithm: Sliding Window Log (via Redis Sorted Sets)
 */

interface RateLimitEntry {
    hits: number[];
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up old entries every 5 minutes
const rateLimitCleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
        entry.hits = entry.hits.filter((ts) => now - ts <= 60000);
        if (entry.hits.length === 0) {
            rateLimitStore.delete(key);
        }
    }
}, 5 * 60 * 1000);
rateLimitCleanup.unref();

interface RateLimitOptions {
    windowMs?: number;      // Window duration in ms (default: 60000 = 1 minute)
    maxRequests?: number;   // Max requests per window (default: 100)
    skipPaths?: string[];   // Paths to skip rate limiting
    keyGenerator?: (req: Request) => string; // Custom key generator
    prefix?: string;        // Redis key prefix (default: 'ratelimit')
    redis?: Redis | null;   // Optional Redis client for testing/DI
}

// Lua script for atomic sliding window
// RETURNS: [allowed (0/1), currentCount, resetTimeMs]
const SLIDING_WINDOW_SCRIPT = `
    local key = KEYS[1]
    local windowMs = tonumber(ARGV[1])
    local maxRequests = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local requestId = ARGV[4]

    local windowStart = now - windowMs

    -- 1. Remove old entries
    redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)

    -- 2. Count current entries
    local currentCount = redis.call('ZCARD', key)

    if currentCount >= maxRequests then
        -- Reject
        local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
        local resetTime = now + windowMs
        if #oldest > 1 then
            resetTime = tonumber(oldest[2]) + windowMs
        end
        return { 0, currentCount, resetTime }
    else
        -- Accept
        redis.call('ZADD', key, now, requestId)
        redis.call('PEXPIRE', key, windowMs)
        return { 1, currentCount + 1, now + windowMs }
    end
`;

/**
 * Create rate limiting middleware
 */
export function createRateLimit(options: RateLimitOptions = {}) {
    const windowMs = options.windowMs || 60000;
    const maxRequests = options.maxRequests || 100;
    const skipPaths = new Set(options.skipPaths || ['/health']);
    const keyGenerator = options.keyGenerator || ((req: Request) => req.ip || req.get('x-forwarded-for') || 'unknown');
    const prefix = options.prefix || 'ratelimit';
    const redis = options.redis !== undefined ? options.redis : defaultRedisClient;

    return async function rateLimit(req: Request, res: Response, next: NextFunction) {
        // Skip rate limiting for certain paths
        if (skipPaths.has(req.path)) {
            return next();
        }

        const keySuffix = keyGenerator(req);
        // Ensure final key follows "ratelimit:{id}" pattern
        const key = `${prefix}:${keySuffix}`;
        const now = Date.now();

        try {
            if (redis && redis.status === 'ready') {
                // Distributed (Redis) Path
                const requestId = randomUUID();

                const result = await redis.eval(
                    SLIDING_WINDOW_SCRIPT,
                    1,
                    key,
                    windowMs,
                    maxRequests,
                    now,
                    requestId
                ) as [number, number, number];

                const [allowed, currentCount, resetTime] = result;
                const remaining = Math.max(0, maxRequests - currentCount);

                res.setHeader('X-RateLimit-Limit', maxRequests);
                res.setHeader('X-RateLimit-Remaining', remaining);
                res.setHeader('X-RateLimit-Reset', Math.ceil(resetTime / 1000));

                if (allowed === 0) {
                    const retryAfter = Math.ceil((resetTime - now) / 1000);
                    res.setHeader('Retry-After', retryAfter);
                    return res.status(429).json({
                        error: 'Too many requests',
                        retryAfter,
                    });
                }

                return next();
            }
        } catch (error) {
            console.warn('Redis rate limit error, falling back to in-memory', error);
            // Fallthrough to in-memory on error
        }

        // --- In-Memory Fallback ---

        const windowStart = now - windowMs;

        let entry = rateLimitStore.get(key);
        if (!entry) {
            entry = { hits: [] };
            rateLimitStore.set(key, entry);
        }

        // Sliding window: prune old hits and evaluate current request.
        entry.hits = entry.hits.filter((ts) => ts > windowStart);

        const currentCount = entry.hits.length;
        const remainingBefore = Math.max(0, maxRequests - currentCount);
        const oldestHit = entry.hits[0] ?? now;
        const resetTime = oldestHit + windowMs;

        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', remainingBefore);
        res.setHeader('X-RateLimit-Reset', Math.ceil(resetTime / 1000));

        if (currentCount >= maxRequests) {
            const retryAfter = Math.ceil((resetTime - now) / 1000);
            res.setHeader('Retry-After', retryAfter);
            return res.status(429).json({
                error: 'Too many requests',
                retryAfter,
            });
        }

        entry.hits.push(now);

        next();
    };
}

/**
 * Default rate limiter: 300 requests per minute
 */
export const defaultRateLimit = createRateLimit({
    windowMs: 60000,
    maxRequests: 300,
    skipPaths: ['/health'],
});

/**
 * Strict rate limiter for Auth routes: 5 requests per minute per IP
 */
export const authRateLimit = createRateLimit({
    windowMs: 60000,
    maxRequests: 20,
    prefix: 'ratelimit:auth'
});

/**
 * Moderate rate limiter for Trading: 50 requests per minute per Account ID
 * Falls back to IP if not authenticated
 */
export const tradeRateLimit = createRateLimit({
    windowMs: 60000,
    maxRequests: 50,
    keyGenerator: (req: Request) => {
        // Use accountId + route when available to match distributed key design.
        const base = (req as any).auth?.accountId || req.ip || 'unknown';
        return `${base}:${req.path}`; // Result: ratelimit:trading:{accountId}:{path} if prefix is set
    },
    prefix: 'ratelimit'
});
