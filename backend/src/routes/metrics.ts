import { Router } from 'express';
import crypto from 'crypto';
import { metrics } from '../lib/metrics';
import { getCircuitState, resetCircuitBreaker } from '../lib/executionCircuitBreaker';

const router = Router();

const ADMIN_SECRET = process.env.ADMIN_SECRET;

function timingSafeCompare(a: string, b: string): boolean {
    const aHash = crypto.createHash('sha256').update(a).digest();
    const bHash = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(aHash, bHash);
}

router.use((req, res, next) => {
    const authHeader = req.headers['x-admin-token'];
    if (ADMIN_SECRET && typeof authHeader === 'string' && timingSafeCompare(authHeader, ADMIN_SECRET)) {
        return next();
    }

    // Also allow if loopback?
    // const ip = req.ip || req.socket.remoteAddress;
    // if (ip === '127.0.0.1' || ip === '::1') return next();

    return res.status(403).json({ error: 'Forbidden' });
});

router.get('/', (_req, res) => {
    res.json(metrics.snapshot());
});

router.get('/snapshot', (_req, res) => {
    res.json(metrics.snapshot());
});

router.get('/circuit-breaker/:accountId', (req, res) => {
    const { accountId } = req.params;
    res.json(getCircuitState(accountId));
});

router.post('/circuit-breaker/:accountId/reset', (req, res) => {
    const { accountId } = req.params;
    resetCircuitBreaker(accountId);
    res.json({ ok: true, message: `Circuit breaker reset for ${accountId}` });
});

export default router;
