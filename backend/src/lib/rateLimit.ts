import type { Request, Response, NextFunction } from 'express';

/**
 * Simple in-memory rate limiting middleware
 * For production, consider using Redis-based rate limiting
 */

interface RateLimitEntry {
    count: number;
    windowStart: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up old entries every 5 minutes
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitStore.entries()) {
        if (now - entry.windowStart > 60000) {
            rateLimitStore.delete(key);
        }
    }
}, 5 * 60 * 1000);

interface RateLimitOptions {
    windowMs?: number;      // Window duration in ms (default: 60000 = 1 minute)
    maxRequests?: number;   // Max requests per window (default: 100)
    skipPaths?: string[];   // Paths to skip rate limiting
    keyGenerator?: (req: Request) => string; // Custom key generator
}

/**
 * Create rate limiting middleware
 */
export function createRateLimit(options: RateLimitOptions = {}) {
    const windowMs = options.windowMs || 60000;
    const maxRequests = options.maxRequests || 100;
    const skipPaths = new Set(options.skipPaths || ['/health']);
    const keyGenerator = options.keyGenerator || ((req: Request) => req.ip || req.get('x-forwarded-for') || 'unknown');

    return function rateLimit(req: Request, res: Response, next: NextFunction) {
        // Skip rate limiting for certain paths
        if (skipPaths.has(req.path)) {
            return next();
        }

        const key = keyGenerator(req);
        const now = Date.now();

        let entry = rateLimitStore.get(key);

        if (!entry || now - entry.windowStart >= windowMs) {
            // Start new window
            entry = { count: 1, windowStart: now };
            rateLimitStore.set(key, entry);
        } else {
            entry.count++;
        }

        // Set rate limit headers
        const remaining = Math.max(0, maxRequests - entry.count);
        const resetTime = entry.windowStart + windowMs;

        res.setHeader('X-RateLimit-Limit', maxRequests);
        res.setHeader('X-RateLimit-Remaining', remaining);
        res.setHeader('X-RateLimit-Reset', Math.ceil(resetTime / 1000));

        if (entry.count > maxRequests) {
            const retryAfter = Math.ceil((resetTime - now) / 1000);
            res.setHeader('Retry-After', retryAfter);
            return res.status(429).json({
                error: 'Too many requests',
                retryAfter,
            });
        }

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
    maxRequests: 5,
});

/**
 * Moderate rate limiter for Trading: 50 requests per minute per Account ID
 * Falls back to IP if not authenticated
 */
export const tradeRateLimit = createRateLimit({
    windowMs: 60000,
    maxRequests: 50,
    keyGenerator: (req: Request) => {
        // Use accountId if available (from authMiddleware), else IP
        return req.auth?.accountId || req.ip || 'unknown';
    }
});
