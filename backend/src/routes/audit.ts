/**
 * Audit Log API Routes
 * Query audit events from in-memory buffer or Supabase.
 */

import { Router } from 'express';
import { requireAuth } from '../lib/authMiddleware';
import { getRecentAuditEvents, queryAuditEvents } from '../lib/auditLogger';
import type { AuditEventType } from '../lib/auditLogger';
import { enforceAccountScope } from '../lib/requestUtils';

const router = Router();

/**
 * GET /api/audit/:accountId
 * Query audit events. Uses in-memory buffer by default; Supabase if ?source=db.
 */
router.get('/:accountId', requireAuth, (req, res) => {
    const { accountId } = req.params;
    if (!enforceAccountScope(req, res, accountId)) {
        return;
    }
    const { eventType, limit, since, source, startDate, endDate, offset } = req.query;

    if (source === 'db') {
        queryAuditEvents(accountId, {
            eventType: eventType as AuditEventType | undefined,
            startDate: startDate as string | undefined,
            endDate: endDate as string | undefined,
            limit: limit ? Number(limit) : undefined,
            offset: offset ? Number(offset) : undefined,
        })
            .then(result => res.json(result))
            .catch(() => res.status(500).json({ error: 'Failed to query audit log' }));
        return;
    }

    const events = getRecentAuditEvents({
        accountId,
        eventType: eventType as AuditEventType | undefined,
        limit: limit ? Number(limit) : undefined,
        since: since ? Number(since) : undefined,
    });

    res.json({ events, total: events.length });
});

export default router;
