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

function buildTokenCandidates(req: Request): TokenCandidate[] {
    const realToken = req.cookies?.deriv_token as string | undefined;
    const demoToken = req.cookies?.deriv_demo_token as string | undefined;
    const activeType = req.cookies?.deriv_active_type as 'real' | 'demo' | undefined;

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
            authLogger.warn({ error, requestId: req.requestId }, 'Authorization failed for active token');
            res.status(401).json({ error: 'User not authenticated' });
        }
    };
}

export const requireAuth = createAuthMiddleware(authorizeTokenCached);
