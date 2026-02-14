/**
 * Analytics API Routes
 * Performance analytics endpoints.
 */

import { Router } from 'express';
import { requireAuth } from '../lib/authMiddleware';
import {
    getTradeAnalytics,
    getEquityCurve,
    getStrategyBreakdown,
    getSymbolBreakdown,
} from '../lib/performanceAnalytics';
import { enforceAccountScope } from '../lib/requestUtils';

const router = Router();

/**
 * GET /api/analytics/:accountId
 * Full trade analytics
 */
router.get('/:accountId', requireAuth, async (req, res) => {
    try {
        const { accountId } = req.params;
        if (!enforceAccountScope(req, res, accountId)) {
            return;
        }
        const { startDate, endDate, symbol, strategy } = req.query;

        const analytics = await getTradeAnalytics(accountId, {
            startDate: startDate as string | undefined,
            endDate: endDate as string | undefined,
            symbol: symbol as string | undefined,
            strategy: strategy as string | undefined,
        });

        res.json(analytics);
    } catch (error) {
        res.status(500).json({ error: 'Failed to compute analytics' });
    }
});

/**
 * GET /api/analytics/:accountId/equity
 * Equity curve data
 */
router.get('/:accountId/equity', requireAuth, async (req, res) => {
    try {
        const { accountId } = req.params;
        if (!enforceAccountScope(req, res, accountId)) {
            return;
        }
        const { startDate, endDate } = req.query;

        const curve = await getEquityCurve(accountId, {
            startDate: startDate as string | undefined,
            endDate: endDate as string | undefined,
        });

        res.json({ equityCurve: curve });
    } catch (error) {
        res.status(500).json({ error: 'Failed to compute equity curve' });
    }
});

/**
 * GET /api/analytics/:accountId/strategies
 * Per-strategy performance breakdown
 */
router.get('/:accountId/strategies', requireAuth, async (req, res) => {
    try {
        const { accountId } = req.params;
        if (!enforceAccountScope(req, res, accountId)) {
            return;
        }
        const { startDate, endDate } = req.query;

        const breakdown = await getStrategyBreakdown(accountId, {
            startDate: startDate as string | undefined,
            endDate: endDate as string | undefined,
        });

        res.json({ strategies: breakdown });
    } catch (error) {
        res.status(500).json({ error: 'Failed to compute strategy breakdown' });
    }
});

/**
 * GET /api/analytics/:accountId/symbols
 * Per-symbol performance breakdown
 */
router.get('/:accountId/symbols', requireAuth, async (req, res) => {
    try {
        const { accountId } = req.params;
        if (!enforceAccountScope(req, res, accountId)) {
            return;
        }
        const { startDate, endDate } = req.query;

        const breakdown = await getSymbolBreakdown(accountId, {
            startDate: startDate as string | undefined,
            endDate: endDate as string | undefined,
        });

        res.json({ symbols: breakdown });
    } catch (error) {
        res.status(500).json({ error: 'Failed to compute symbol breakdown' });
    }
});

export default router;
