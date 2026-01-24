import type { Request } from 'express';

export function parseLimitParam(value: string | undefined, defaultLimit: number, maxLimit: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return defaultLimit;
    }

    return Math.min(Math.floor(parsed), maxLimit);
}

export function getActiveAccountId(req: Request) {
    return req.cookies?.deriv_active_account
        || req.cookies?.deriv_demo_account
        || req.cookies?.deriv_account
        || null;
}

export function cookieSettings() {
    const secure = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
    const sameSiteEnv = (process.env.COOKIE_SAMESITE || '').toLowerCase();
    const sameSite = (sameSiteEnv === 'none' || sameSiteEnv === 'strict' || sameSiteEnv === 'lax')
        ? sameSiteEnv
        : (secure ? 'none' : 'lax');

    return { secure, sameSite } as { secure: boolean; sameSite: 'lax' | 'strict' | 'none' };
}

export function buildCookieOptions(maxAgeSeconds: number) {
    const { secure, sameSite } = cookieSettings();
    return {
        httpOnly: true,
        secure,
        sameSite,
        maxAge: maxAgeSeconds * 1000, // Express expects milliseconds
        path: '/',
    } as const;
}

export function buildStateCookieOptions() {
    const { secure, sameSite } = cookieSettings();
    return {
        httpOnly: true,
        secure,
        sameSite: sameSite === 'none' ? 'none' : 'lax',
        maxAge: 5 * 60 * 1000, // 5 minutes in milliseconds
        path: '/',
    } as const;
}

/**
 * Returns the active account ID only if it matches one of the authenticated account cookies.
 * This prevents spoofing by validating the active account against known session tokens.
 */
export function getValidatedAccountId(req: Request): string | null {
    const activeAccount = req.cookies?.deriv_active_account;
    const realAccount = req.cookies?.deriv_account;
    const demoAccount = req.cookies?.deriv_demo_account;

    // Only return if active account matches one of the authenticated accounts
    if (activeAccount && (activeAccount === realAccount || activeAccount === demoAccount)) {
        return activeAccount;
    }

    // Fallback to the first available authenticated account
    return realAccount || demoAccount || null;
}

export function buildClearCookieOptions() {
    const { secure, sameSite } = cookieSettings();
    return {
        httpOnly: true,
        secure,
        sameSite,
        maxAge: 0,
        path: '/',
    } as const;
}
