import type { Request } from 'express';

export function parseLimitParam(value: string | undefined, defaultLimit: number, maxLimit: number) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return defaultLimit;
    }

    return Math.min(Math.floor(parsed), maxLimit);
}

/**
 * @deprecated Use req.auth.accountId from auth middleware instead.
 */
export function getActiveAccountId(req: Request) {
    return req.auth?.accountId ?? null;
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
 * @deprecated Use req.auth.accountId from auth middleware instead.
 */
export function getValidatedAccountId(req: Request): string | null {
    return req.auth?.accountId ?? null;
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
