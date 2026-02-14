import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
// @ts-ignore
import type { Redis } from 'ioredis';
import { createRateLimit } from '../lib/rateLimit';

// Helpers
function createMockResponse() {
    const headers: Record<string, string | number> = {};
    let statusCode = 200;
    let body: unknown = null;
    const res = {
        setHeader(key: string, val: string | number) {
            headers[key] = val;
            return res;
        },
        status(code: number) {
            statusCode = code;
            return res;
        },
        json(payload: unknown) {
            body = payload;
            return res;
        },
    } as unknown as Response;
    return { res, headers, getStatus: () => statusCode, getBody: () => body };
}

// Mock Redis Client
function createMockRedis(status: string = 'ready', evalResult: any = [1, 1, Date.now() + 60000]) {
    return {
        status,
        eval: async () => evalResult,
    } as unknown as Redis;
}

test('distributed rate limit allows request when under limit', async () => {
    const mockRedis = createMockRedis('ready', [1, 5, 1234567890]);
    const limiter = createRateLimit({
        windowMs: 60000,
        maxRequests: 10,
        redis: mockRedis,
        prefix: 'test1'
    });

    const req = {
        path: '/api/trade',
        ip: '127.0.0.1',
        get: (name: string) => undefined
    } as unknown as Request;
    const { res, headers, getStatus } = createMockResponse();

    let nextCalled = false;
    await limiter(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(getStatus(), 200);
    assert.equal(headers['X-RateLimit-Limit'], 10);
    assert.equal(headers['X-RateLimit-Remaining'], 5); // 10 - 5
});

test('distributed rate limit rejects request when over limit', async () => {
    // [0, currentCount=11, resetTime=future]
    const resetTime = Date.now() + 5000;
    const mockRedis = createMockRedis('ready', [0, 11, resetTime]);
    const limiter = createRateLimit({
        windowMs: 60000,
        maxRequests: 10,
        redis: mockRedis,
    });

    const req = {
        path: '/api/trade',
        ip: '127.0.0.1',
        get: (name: string) => undefined
    } as unknown as Request;
    const { res, headers, getStatus, getBody } = createMockResponse();

    let nextCalled = false;
    await limiter(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(getStatus(), 429);
    assert.equal(headers['X-RateLimit-Remaining'], 0);
    assert.ok(headers['Retry-After']);
    assert.deepEqual(getBody(), {
        error: 'Too many requests',
        retryAfter: Math.ceil((resetTime - Date.now()) / 1000),
    });
});

test('falls back to in-memory when Redis is not ready', async () => {
    const mockRedis = createMockRedis('connecting', []);
    const limiter = createRateLimit({
        windowMs: 60000,
        maxRequests: 2, // Low limit for easy testing
        redis: mockRedis,
        prefix: 'test3'
    });

    const req = {
        path: '/api/fallback',
        ip: '127.0.0.1',
        get: (name: string) => undefined
    } as unknown as Request;
    const { res: res1 } = createMockResponse();

    // First request - should pass (Hit 1)
    let next1 = false;
    await limiter(req, res1, () => { next1 = true; });
    assert.equal(next1, true);

    // Second request - should pass (Hit 2)
    const { res: res2 } = createMockResponse();
    let next2 = false;
    await limiter(req, res2, () => { next2 = true; });
    assert.equal(next2, true);

    // Third request - should fail (Hit 3 > 2)
    const { res: res3, getStatus: getStatus3 } = createMockResponse();
    let next3 = false;
    await limiter(req, res3, () => { next3 = true; });

    assert.equal(next3, false);
    assert.equal(getStatus3(), 429);
});

test('falls back to in-memory when Redis eval throws', async () => {
    const mockRedis = {
        status: 'ready',
        eval: async () => { throw new Error('Redis connection lost'); },
    } as unknown as Redis;

    const limiter = createRateLimit({
        windowMs: 60000,
        maxRequests: 2,
        redis: mockRedis,
        prefix: 'test4'
    });

    const req = {
        path: '/api/error',
        ip: '127.0.0.1',
        get: (name: string) => undefined
    } as unknown as Request;
    const { res: res1 } = createMockResponse();

    // Should catch error and use in-memory
    let next1 = false;
    await limiter(req, res1, () => { next1 = true; });
    assert.equal(next1, true);
});
