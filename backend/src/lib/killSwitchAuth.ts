import crypto from 'crypto';

// Timing-safe string comparison to prevent timing attacks (SEC: AUTH-07)
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        // Compare against a dummy to maintain constant time
        const dummy = crypto.randomBytes(b.length).toString('hex');
        crypto.timingSafeEqual(Buffer.from(dummy), Buffer.from(b));
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function assertKillSwitchAuthorization(scope: string, providedToken: string | undefined | null): { ok: boolean; status: number; error?: string } {
    const adminToken = process.env.KILL_SWITCH_ADMIN_TOKEN;
    if (!adminToken) {
        return { ok: false, status: 503, error: 'Kill switch unavailable' };
    }
    
    if (scope === 'global') {
        const tokenToCheck = providedToken || '';
        if (!timingSafeEqual(tokenToCheck, adminToken)) {
            return { ok: false, status: 403, error: 'Unauthorized' };
        }
    }
    
    return { ok: true, status: 200 };
}
