import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { enforceAccountScope } from '../lib/requestUtils';

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

test('idor_block_test: analytics accountId mismatch returns 403', () => {
    const req = {
        auth: {
            accountId: 'CR_REAL_1',
            accountType: 'real',
            token: 'token',
        },
        params: {
            accountId: 'CR_OTHER_2',
        },
    } as unknown as Request;
    const { res, getStatus, getBody } = createMockResponse();

    const allowed = enforceAccountScope(req, res, req.params.accountId);

    assert.equal(allowed, false);
    assert.equal(getStatus(), 403);
    assert.deepEqual(getBody(), { error: 'Forbidden', code: 'ACCOUNT_SCOPE_MISMATCH' });
});
