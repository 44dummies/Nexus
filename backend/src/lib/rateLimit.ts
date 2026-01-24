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
}

/**
 * Create rate limiting middleware
 */
export function createRateLimit(options: RateLimitOptions = {}) {
    const windowMs = options.windowMs || 60000;
    const maxRequests = options.maxRequests || 100;
    const skipPaths = new Set(options.skipPaths || ['/health']);

    return function rateLimit(
        req: { ip?: string; get: (header: string) => string | undefined; path: string },
        res: { status: (code: number) => { json: (data: unknown) => void }; setHeader: (name: string, value: string | number) => void },
        next: () => void
    ) {
        // Skip rate limiting for certain paths
        if (skipPaths.has(req.path)) {
            return next();
        }

        // Get client identifier (IP or forwarded IP)
        const clientId = req.get('x-forwarded-for')?.split(',')[0].trim() || req.ip || 'unknown';
        const now = Date.now();

        let entry = rateLimitStore.get(clientId);

        if (!entry || now - entry.windowStart >= windowMs) {
            // Start new window
            entry = { count: 1, windowStart: now };
            rateLimitStore.set(clientId, entry);
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
 * Default rate limiter: 100 requests per minute
 */
export const defaultRateLimit = createRateLimit({
    windowMs: 60000,
    maxRequests: 100,
    skipPaths: ['/health'],
});
