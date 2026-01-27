import test from 'node:test';
import assert from 'node:assert/strict';
import { assertKillSwitchAuthorization } from '../lib/killSwitchAuth';

test('kill switch denied when admin token missing', () => {
    const original = process.env.KILL_SWITCH_ADMIN_TOKEN;
    delete process.env.KILL_SWITCH_ADMIN_TOKEN;

    const result = assertKillSwitchAuthorization('global', 'token');
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);

    if (original !== undefined) {
        process.env.KILL_SWITCH_ADMIN_TOKEN = original;
    }
});

test('kill switch global requires admin token', () => {
    const original = process.env.KILL_SWITCH_ADMIN_TOKEN;
    process.env.KILL_SWITCH_ADMIN_TOKEN = 'secret';

    const denied = assertKillSwitchAuthorization('global', 'wrong');
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);

    const allowed = assertKillSwitchAuthorization('global', 'secret');
    assert.equal(allowed.ok, true);

    if (original !== undefined) {
        process.env.KILL_SWITCH_ADMIN_TOKEN = original;
    } else {
        delete process.env.KILL_SWITCH_ADMIN_TOKEN;
    }
});
