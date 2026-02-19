import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createAuthMiddleware } from '../lib/authMiddleware';

function createMockRequest(options: {
    cookies?: Record<string, string>;
    headers?: Record<string, string>;
    requestId?: string;
}) {
    const headerMap = new Map<string, string>();
    for (const [key, value] of Object.entries(options.headers || {})) {
        headerMap.set(key.toLowerCase(), value);
    }

    return {
        cookies: options.cookies || {},
        requestId: options.requestId || 'req-test',
        get(name: string) {
            return headerMap.get(name.toLowerCase());
        },
    } as unknown as Request;
}

function createMockResponse() {
    let statusCode = 200;
    let body: unknown = null;
    const res = {
        status(code: number) {
            statusCode = code;
            return res;
        },
        json(payload: unknown) {
            body = payload;
            return res;
        },
    } as unknown as Response;
    return { res, getStatus: () => statusCode, getBody: () => body };
}

test('auth middleware ignores forged active account cookie', async () => {
    const middleware = createAuthMiddleware(async () => ({
        loginid: 'CR123456',
        currency: 'USD',
        account_list: [{
            loginid: 'CR123456',
            currency: 'USD',
            is_virtual: false,
        }],
        email: 'user@example.com',
    }));

    const req = createMockRequest({
        cookies: {
            deriv_token: 'token-real',
            deriv_active_account: 'CR999999',
            deriv_active_type: 'real',
            deriv_currency: 'USD',
        },
        requestId: 'req-1',
    });
    const { res, getStatus } = createMockResponse();

    let nextCalled = false;
    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(getStatus(), 200);
    assert.equal(req.auth?.accountId, 'CR123456');
});

test('auth middleware denies when no token present', async () => {
    const middleware = createAuthMiddleware(async () => undefined);
    const req = createMockRequest({ cookies: {} });
    const { res, getStatus, getBody } = createMockResponse();
    let nextCalled = false;

    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(getStatus(), 401);
    assert.deepEqual(getBody(), { error: 'User not authenticated' });
});

test('auth middleware prefers bearer token over cookies', async () => {
    const seenTokens: string[] = [];
    const middleware = createAuthMiddleware(async (token) => {
        seenTokens.push(token);
        return {
            loginid: 'CR333333',
            currency: 'USD',
            account_list: [{
                loginid: 'CR333333',
                currency: 'USD',
                is_virtual: false,
            }],
            email: 'bearer@example.com',
        };
    });

    const req = createMockRequest({
        cookies: {
            deriv_token: 'cookie-token-should-not-be-used',
            deriv_active_type: 'real',
            deriv_currency: 'USD',
        },
        headers: {
            authorization: 'Bearer bearer-token-abc123',
        },
        requestId: 'req-bearer',
    });
    const { res, getStatus } = createMockResponse();

    let nextCalled = false;
    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(getStatus(), 200);
    assert.deepEqual(seenTokens, ['bearer-token-abc123']);
    assert.equal(req.auth?.token, 'bearer-token-abc123');
    assert.equal(req.auth?.accountId, 'CR333333');
});

test('auth middleware does not fall back to cookie token when bearer auth fails', async () => {
    const seenTokens: string[] = [];
    const middleware = createAuthMiddleware(async (token) => {
        seenTokens.push(token);
        throw Object.assign(new Error('invalid token'), { code: 'AuthError' });
    });

    const req = createMockRequest({
        cookies: {
            deriv_token: 'cookie-token-fallback',
            deriv_active_type: 'real',
            deriv_currency: 'USD',
        },
        headers: {
            authorization: 'Bearer bearer-token-invalid',
        },
        requestId: 'req-no-fallback',
    });
    const { res, getStatus, getBody } = createMockResponse();

    let nextCalled = false;
    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(getStatus(), 401);
    assert.deepEqual(seenTokens, ['bearer-token-invalid']);
    assert.deepEqual(getBody(), { error: 'User not authenticated' });
});
