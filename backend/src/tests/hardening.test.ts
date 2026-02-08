import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createRateLimit } from '../lib/rateLimit';
import { ExecuteTradeParamsSchema, StartBotSchema } from '../lib/validation';

function createMockResponse() {
    let statusCode = 200;
    let body: unknown = null;
    const headers: Record<string, string | number> = {};
    const res = {
        status(code: number) {
            statusCode = code;
            return res;
        },
        json(payload: unknown) {
            body = payload;
            return res;
        },
        setHeader(name: string, value: string | number) {
            headers[name] = value;
        }
    } as unknown as Response;
    return { res, getStatus: () => statusCode, getBody: () => body, getHeaders: () => headers };
}

test('rate limit allow requests within limit', async () => {
    const limiter = createRateLimit({ windowMs: 1000, maxRequests: 2 });
    const req = { ip: '1.2.3.4', path: '/api/test', get: () => undefined } as unknown as Request;

    let nextCount = 0;
    const next = () => { nextCount++; };

    const { res } = createMockResponse();

    await limiter(req, res, next);
    await limiter(req, res, next);

    assert.equal(nextCount, 2);
});

test('rate limit blocks requests over limit', async () => {
    const limiter = createRateLimit({ windowMs: 1000, maxRequests: 2 });
    const req = { ip: '5.6.7.8', path: '/api/test', get: () => undefined } as unknown as Request;

    let nextCount = 0;
    const next = () => { nextCount++; };

    const { res, getStatus } = createMockResponse();

    await limiter(req, res, next);
    await limiter(req, res, next);
    await limiter(req, res, next); // Should fail

    assert.equal(nextCount, 2);
    assert.equal(getStatus(), 429);
});

test('ExecuteTradeParamsSchema validates strictness', () => {
    const valid = {
        stake: 10,
        symbol: 'R_100',
        duration: 1,
        durationUnit: 'm' as const,
    };

    const result = ExecuteTradeParamsSchema.safeParse(valid);
    assert.equal(result.success, true);

    const invalidExtra = {
        ...valid,
        extraForHack: 'true',
    };

    // Should fail due to strict parameters, unless allowed
    // We explicitly allowed 'signal' and 'useFast', checking other random keys
    const failures = ExecuteTradeParamsSchema.safeParse(invalidExtra);
    assert.equal(failures.success, false);
});

test('ExecuteTradeParamsSchema allows signal, useFast, and correlationId', () => {
    const validWithExtras = {
        stake: 10,
        symbol: 'R_100',
        signal: 'CALL',
        useFast: true,
        correlationId: 'corr-test-1',
    };

    const result = ExecuteTradeParamsSchema.safeParse(validWithExtras);
    assert.equal(result.success, true);
});

test('StartBotSchema validates structure', () => {
    const valid = {
        action: 'start',
        botId: 'rsi-1',
        config: { stopLoss: 10 },
    };
    const result = StartBotSchema.safeParse(valid);
    assert.equal(result.success, true);

    const invalidAction = {
        action: 'hack',
        botId: 'rsi-1',
    };
    const fail = StartBotSchema.safeParse(invalidAction);
    assert.equal(fail.success, false);
});
