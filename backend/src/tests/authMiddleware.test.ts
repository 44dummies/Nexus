import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { createAuthMiddleware } from '../lib/authMiddleware';

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

    const req = {
        cookies: {
            deriv_token: 'token-real',
            deriv_active_account: 'CR999999',
            deriv_active_type: 'real',
            deriv_currency: 'USD',
        },
        requestId: 'req-1',
    } as unknown as Request;
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
    const req = { cookies: {} } as unknown as Request;
    const { res, getStatus, getBody } = createMockResponse();
    let nextCalled = false;

    await middleware(req, res, () => {
        nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(getStatus(), 401);
    assert.deepEqual(getBody(), { error: 'User not authenticated' });
});
