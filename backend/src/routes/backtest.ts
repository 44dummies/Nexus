/**
 * Backtest API Routes
 */

import { Router } from 'express';
import { requireAuth } from '../lib/authMiddleware';
import { runBacktest } from '../lib/backtestEngine';
import type { BacktestConfig } from '../lib/backtestEngine';

const router = Router();

/**
 * POST /api/backtest/run
 * Execute a backtest simulation
 * Body: { symbol, startTs, endTs, stake, tradeDurationTicks?, confidenceThreshold?, slippageFraction?, commissionFlat?, strategy? }
 */
router.post('/run', requireAuth, async (req, res) => {
    try {
        const {
            symbol,
            startTs,
            endTs,
            stake,
            tradeDurationTicks = 5,
            confidenceThreshold = 0.6,
            slippageFraction = 0.0001,
            commissionFlat = 0,
            strategy,
        } = req.body;

        if (!symbol || !startTs || !endTs || !stake) {
            res.status(400).json({ error: 'Missing required fields: symbol, startTs, endTs, stake' });
            return;
        }

        if (typeof startTs !== 'number' || typeof endTs !== 'number' || endTs <= startTs) {
            res.status(400).json({ error: 'Invalid time range: endTs must be greater than startTs' });
            return;
        }

        if (typeof stake !== 'number' || stake <= 0) {
            res.status(400).json({ error: 'Invalid stake: must be a positive number' });
            return;
        }

        // Limit backtest range to 30 days
        const maxRangeSeconds = 30 * 24 * 60 * 60;
        if (endTs - startTs > maxRangeSeconds) {
            res.status(400).json({ error: 'Backtest range too large: maximum 30 days' });
            return;
        }

        const accountId = req.auth?.accountId;
        if (!accountId) {
            res.status(401).json({ error: 'Account not identified' });
            return;
        }

        const config: BacktestConfig = {
            symbol,
            startTs,
            endTs,
            stake,
            tradeDurationTicks,
            confidenceThreshold,
            slippageFraction,
            commissionFlat,
            strategy,
        };

        const result = await runBacktest(accountId, config);
        res.json(result);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Backtest failed';
        res.status(500).json({ error: message });
    }
});

export default router;
