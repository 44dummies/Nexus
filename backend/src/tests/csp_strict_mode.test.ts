import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { attachCspNonce, buildHelmetSecurityOptions } from '../lib/securityHeaders';

test('csp strict mode attaches request nonce', () => {
    const req = {} as Request;
    const res = {} as Response;
    let called = false;

    attachCspNonce(req, res, () => {
        called = true;
    });

    assert.equal(called, true);
    const nonce = (req as Request & { cspNonce?: string }).cspNonce;
    assert.ok(typeof nonce === 'string' && nonce.length > 0);
});

test('csp strict mode excludes unsafe-inline and unsafe-eval', () => {
    const options = buildHelmetSecurityOptions();
    assert.ok(options.contentSecurityPolicy && typeof options.contentSecurityPolicy === 'object');
    const directives = (options.contentSecurityPolicy as { directives: Record<string, unknown> }).directives;
    const scriptSrc = directives.scriptSrc as readonly (string | ((req: Request) => string))[];
    const styleSrc = directives.styleSrc as readonly string[];

    const scriptLiterals = scriptSrc.filter((entry): entry is string => typeof entry === 'string');
    assert.equal(scriptLiterals.includes("'unsafe-inline'"), false);
    assert.equal(scriptLiterals.includes("'unsafe-eval'"), false);
    assert.equal(styleSrc.includes("'unsafe-inline'"), false);
    assert.equal(styleSrc.includes("'unsafe-eval'"), false);
});

test('csp strict mode emits nonce-based script policy', () => {
    const options = buildHelmetSecurityOptions();
    assert.ok(options.contentSecurityPolicy && typeof options.contentSecurityPolicy === 'object');
    const directives = (options.contentSecurityPolicy as { directives: Record<string, unknown> }).directives;
    const scriptSrc = directives.scriptSrc as readonly (string | ((req: Request) => string))[];
    const nonceBuilder = scriptSrc.find((entry) => typeof entry === 'function') as ((req: Request) => string) | undefined;
    assert.ok(nonceBuilder);

    const req = { cspNonce: 'nonce-abc-123' } as Request & { cspNonce?: string };
    const nonceToken = nonceBuilder?.(req as Request);
    assert.equal(nonceToken, "'nonce-nonce-abc-123'");
});
