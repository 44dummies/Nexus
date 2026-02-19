import type { NextFunction, Request, Response } from 'express';
import { authorizeTokenCached, type DerivAuthorizeResponse } from './deriv';
import { authLogger } from './logger';

export interface RequestAuth {
    accountId: string;
    accountType: 'real' | 'demo';
    token: string;
    currency?: string | null;
    email?: string | null;
}

type TokenCandidate = {
    token: string;
    hintedType: 'real' | 'demo';
    currencyHint?: string | null;
};

function extractBearerToken(authHeader: string | undefined): string | null {
    if (!authHeader) return null;
    const [scheme, ...rest] = authHeader.trim().split(/\s+/);
    if (!scheme || scheme.toLowerCase() !== 'bearer') return null;
    const token = rest.join(' ').trim();
    return token || null;
}

function parseAccountTypeHint(raw: string | undefined): 'real' | 'demo' | null {
    if (!raw) return null;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'real' || normalized === 'demo') return normalized;
    return null;
}

function validateTokenFormat(token: string): { ok: boolean; reason?: string } {
    const trimmed = token.trim();
    if (!trimmed) return { ok: false, reason: 'Token missing' };
    if (trimmed.length < 8) return { ok: false, reason: 'Token too short' };
    if (/\s/.test(trimmed)) return { ok: false, reason: 'Token contains whitespace' };
    return { ok: true };
}

function buildTokenCandidates(req: Request): TokenCandidate[] {
    const realToken = req.cookies?.deriv_token as string | undefined;
    const demoToken = req.cookies?.deriv_demo_token as string | undefined;
    const activeType = req.cookies?.deriv_active_type as 'real' | 'demo' | undefined;
    const bearerToken = extractBearerToken(req.get('authorization') || undefined);
    const headerTypeHint = parseAccountTypeHint(req.get('x-account-type') || undefined);

    const candidates: TokenCandidate[] = [];
    const pushCandidate = (token: string | undefined, hintedType: 'real' | 'demo') => {
        if (!token) return;
        candidates.push({
            token,
            hintedType,
            currencyHint: hintedType === 'demo'
                ? (req.cookies?.deriv_demo_currency as string | undefined)
                : (req.cookies?.deriv_currency as string | undefined),
        });
    };

    // Prefer explicit bearer token and do not silently cascade to cookie tokens.
    if (bearerToken) {
        const hintedType = headerTypeHint || activeType || 'real';
        candidates.push({
            token: bearerToken,
            hintedType,
            currencyHint: hintedType === 'demo'
                ? (req.cookies?.deriv_demo_currency as string | undefined)
                : (req.cookies?.deriv_currency as string | undefined),
        });
        return candidates;
    }

    if (activeType === 'demo') {
        pushCandidate(demoToken, 'demo');
        pushCandidate(realToken, 'real');
    } else if (activeType === 'real') {
        pushCandidate(realToken, 'real');
        pushCandidate(demoToken, 'demo');
    } else if (demoToken) {
        pushCandidate(demoToken, 'demo');
        pushCandidate(realToken, 'real');
    } else {
        pushCandidate(realToken, 'real');
    }

    return candidates;
}

function resolveAccountType(
    authorize: { loginid?: string; account_list?: Array<{ loginid: string; is_virtual: number | boolean; currency?: string }> } | null,
    hintedType: 'real' | 'demo'
): 'real' | 'demo' {
    const loginId = authorize?.loginid;
    if (loginId && Array.isArray(authorize?.account_list)) {
        const match = authorize?.account_list.find((acct) => acct.loginid === loginId);
        if (match) {
            return match.is_virtual ? 'demo' : 'real';
        }
    }
    return hintedType;
}

function resolveCurrency(
    authorize: { currency?: string; loginid?: string; account_list?: Array<{ loginid: string; currency?: string }> } | null,
    currencyHint?: string | null
): string | null {
    if (authorize?.currency) return authorize.currency;
    const loginId = authorize?.loginid;
    if (loginId && Array.isArray(authorize?.account_list)) {
        const match = authorize.account_list.find((acct) => acct.loginid === loginId);
        if (match?.currency) return match.currency;
    }
    return currencyHint ?? null;
}

export function createAuthMiddleware(
    authorizeFn: (token: string) => Promise<DerivAuthorizeResponse['authorize']>
) {
    return async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
        const candidates = buildTokenCandidates(req);
        if (candidates.length === 0) {
            res.status(401).json({ error: 'User not authenticated' });
            return;
        }

        // SEC: AUTH-03 - Only use the first (active) token, fail fast instead of cascade
        // This prevents silent account switches when the active token fails
        const candidate = candidates[0];
        const validation = validateTokenFormat(candidate.token);
        if (!validation.ok) {
            authLogger.warn({ requestId: req.requestId, reason: validation.reason }, 'Invalid auth token format');
            res.status(401).json({ error: 'User not authenticated', code: 'InvalidTokenFormat' });
            return;
        }
        
        try {
            const authorize = await authorizeFn(candidate.token);
            const accountId = authorize?.loginid;
            if (!accountId) {
                authLogger.warn({ requestId: req.requestId }, 'Authorization missing loginid');
                res.status(401).json({ error: 'User not authenticated' });
                return;
            }

            const accountType = resolveAccountType(authorize ?? null, candidate.hintedType);
            const currency = resolveCurrency(authorize ?? null, candidate.currencyHint ?? null);

            req.auth = {
                accountId,
                accountType,
                token: candidate.token,
                currency,
                email: authorize?.email ?? null,
            };
            return next();
        } catch (error) {
            const err = error as Error & { code?: string };
            if (err.code === 'Timeout' || err.code === 'NetworkError') {
                authLogger.warn({ error: err, requestId: req.requestId }, 'Authorization timed out');
                res.status(503).json({ error: 'Authorization service unavailable', code: err.code || 'TransientError', transient: true });
                return;
            }
            authLogger.warn({ error: err, requestId: req.requestId }, 'Authorization failed for active token');
            res.status(401).json({ error: 'User not authenticated' });
        }
    };
}

export const requireAuth = createAuthMiddleware(authorizeTokenCached);
