import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import helmet from 'helmet';

import authRouter from './routes/auth';
import tradesRouter from './routes/trades';
import notificationsRouter from './routes/notifications';
import riskEventsRouter from './routes/risk-events';
import botRunsRouter from './routes/bot-runs';
import orderStatusRouter from './routes/order-status';
import logger from './lib/logger';
import { defaultRateLimit } from './lib/rateLimit';
import { startTradeBackfillJob } from './lib/tradeBackfill';
import metricsRouter from './routes/metrics';
import { initMetrics } from './lib/metrics';
import { initRiskManager } from './lib/riskManager';

const app = express();
initMetrics();

app.set('trust proxy', 1);
app.use(helmet());

const rawOrigins = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || '';
// Normalize origins: trim whitespace and remove trailing slashes
const allowedOrigins = rawOrigins
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Fail closed: reject if no origins configured
        if (allowedOrigins.length === 0) {
            logger.error({ origin }, 'CORS: No origins configured - set CORS_ORIGIN or FRONTEND_URL env var');
            return callback(new Error('CORS not configured - set CORS_ORIGIN or FRONTEND_URL'));
        }
        // Allow requests with no origin (same-origin, curl, etc.)
        if (!origin) {
            return callback(null, true);
        }
        // Normalize incoming origin (strip trailing slash)
        const normalizedOrigin = origin.replace(/\/+$/, '');

        // Check exact match first
        if (allowedOrigins.includes(normalizedOrigin)) {
            return callback(null, true);
        }

        // Allow Vercel deployments for the same project
        // Patterns:
        //   Production: https://<project>.vercel.app
        //   Preview:    https://<project>-<hash>-<team>.vercel.app
        //   Branch:     https://<project>-git-<branch>-<team>.vercel.app
        //   Custom:     https://<project>-<random>.vercel.app
        for (const allowedUrl of allowedOrigins) {
            const vercelMatch = allowedUrl.match(/^https:\/\/([a-z0-9-]+)\.vercel\.app$/i);
            if (vercelMatch) {
                const projectName = vercelMatch[1];
                // Match any Vercel deployment starting with the project name
                const vercelPattern = new RegExp(
                    `^https:\\/\\/${projectName}(-[a-z0-9-]+)?\\.vercel\\.app$`,
                    'i'
                );
                if (vercelPattern.test(normalizedOrigin)) {
                    logger.debug({ origin: normalizedOrigin, project: projectName }, 'CORS: Allowed Vercel preview deployment');
                    return callback(null, true);
                }
            }
        }

        // Log rejected origins to help debug CORS issues
        logger.warn({
            rejectedOrigin: normalizedOrigin,
            allowedOrigins,
            hint: 'Add this origin to CORS_ORIGIN env var if it should be allowed'
        }, 'CORS: Origin rejected');

        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Correlation/request ID middleware
app.use((req, res, next) => {
    const headerId = req.get('x-request-id') || req.get('x-correlation-id');
    const requestId = (typeof headerId === 'string' && headerId.trim().length > 0)
        ? headerId.trim()
        : crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    next();
});

// Rate limiting middleware (100 requests/minute per IP)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use(defaultRateLimit as any);

// CSRF protection middleware for state-changing requests
app.use((req, res, next) => {
    // Only check state-changing methods
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        return next();
    }

    const origin = req.get('origin');
    const referer = req.get('referer');

    // Allow if no origin/referer header (same-origin browser requests)
    if (!origin && !referer) {
        return next();
    }

    // Validate origin against allowed origins
    let checkOrigin: string | null = origin || null;
    if (!checkOrigin && referer) {
        try {
            checkOrigin = new URL(referer).origin;
        } catch {
            checkOrigin = null;
        }
    }

    if (checkOrigin) {
        // Check exact match first
        if (allowedOrigins.includes(checkOrigin)) {
            return next();
        }

        // Allow Vercel deployments for the same project (all patterns)
        for (const allowedUrl of allowedOrigins) {
            const vercelMatch = allowedUrl.match(/^https:\/\/([a-z0-9-]+)\.vercel\.app$/i);
            if (vercelMatch) {
                const projectName = vercelMatch[1];
                const vercelPattern = new RegExp(
                    `^https:\\/\\/${projectName}(-[a-z0-9-]+)?\\.vercel\\.app$`,
                    'i'
                );
                if (vercelPattern.test(checkOrigin)) {
                    return next();
                }
            }
        }
    }

    return res.status(403).json({ error: 'CSRF validation failed' });
});

app.get('/health', (_req, res) => {
    res.json({ ok: true });
});

app.use('/api/auth', authRouter);
app.use('/api/trades', tradesRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/risk-events', riskEventsRouter);
app.use('/api/bot-runs', botRunsRouter);
app.use('/api/order-status', orderStatusRouter);
app.use('/metrics', metricsRouter);

const port = Number(process.env.PORT) || 4000;

async function startServer() {
    await initRiskManager();
    app.listen(port, () => {
        logger.info({ port, origins: allowedOrigins }, 'DerivNexus backend started');
        startTradeBackfillJob();
    });
}

startServer().catch((error) => {
    logger.error({ error }, 'Failed to start DerivNexus backend');
    process.exit(1);
});
