import crypto from 'crypto';
import { riskLogger } from './logger';
import { record as recordObstacle } from './obstacleLog';

// Timing-safe string comparison to prevent timing attacks (SEC: AUTH-07)
function timingSafeEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) {
        // Compare against a dummy of same length to maintain constant time
        const dummyLen = Math.max(bufB.length, 1);
        const dummy = crypto.randomBytes(dummyLen);
        const target = Buffer.alloc(dummyLen);
        bufB.copy(target, 0, 0, Math.min(bufB.length, dummyLen));
        crypto.timingSafeEqual(dummy, target);
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyKillSwitchConfig(): { configured: boolean; reason?: string } {
    const adminToken = process.env.KILL_SWITCH_ADMIN_TOKEN;
    if (!adminToken) {
        return { configured: false, reason: 'KILL_SWITCH_ADMIN_TOKEN missing' };
    }
    if (adminToken.length < 12) {
        return { configured: false, reason: 'KILL_SWITCH_ADMIN_TOKEN too short' };
    }
    return { configured: true };
}

export function assertKillSwitchAuthorization(scope: string, providedToken: string | undefined | null): { ok: boolean; status: number; error?: string } {
    const adminToken = process.env.KILL_SWITCH_ADMIN_TOKEN;
    if (!adminToken) {
        recordObstacle('auth', 'Kill switch auth', 'KILL_SWITCH_ADMIN_TOKEN missing', 'high', ['backend/src/lib/killSwitchAuth.ts']);
        riskLogger.error('Kill switch admin token missing - failing closed');
        return { ok: false, status: 503, error: 'Kill switch unavailable' };
    }
    
    const tokenToCheck = providedToken || '';
    if (!timingSafeEqual(tokenToCheck, adminToken)) {
        return { ok: false, status: 403, error: 'Unauthorized' };
    }
    
    return { ok: true, status: 200 };
}
