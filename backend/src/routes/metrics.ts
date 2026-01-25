import { Router } from 'express';
import { metrics } from '../lib/metrics';

const router = Router();

router.get('/', (_req, res) => {
    res.json(metrics.snapshot());
});

router.get('/snapshot', (_req, res) => {
    res.json(metrics.snapshot());
});

export default router;
