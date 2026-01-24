import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import authRouter from './routes/auth';
import tradesRouter from './routes/trades';
import notificationsRouter from './routes/notifications';
import riskEventsRouter from './routes/risk-events';
import botRunsRouter from './routes/bot-runs';
import orderStatusRouter from './routes/order-status';
import logger from './lib/logger';

const app = express();

app.set('trust proxy', 1);

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

        // Allow Vercel preview deployments if main domain is allowed
        // Pattern: https://<project>-<hash>-<team>.vercel.app
        const vercelPreviewPattern = /^https:\/\/[\w-]+-[\w-]+-[\w-]+\.vercel\.app$/;
        if (vercelPreviewPattern.test(normalizedOrigin)) {
            // Check if any allowed origin is a vercel.app domain
            const hasVercelOrigin = allowedOrigins.some(o => o.includes('.vercel.app'));
            if (hasVercelOrigin) {
                return callback(null, true);
            }
        }

        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

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

        // Allow Vercel preview deployments if main domain is allowed
        const vercelPreviewPattern = /^https:\/\/[\w-]+-[\w-]+-[\w-]+\.vercel\.app$/;
        if (vercelPreviewPattern.test(checkOrigin)) {
            const hasVercelOrigin = allowedOrigins.some(o => o.includes('.vercel.app'));
            if (hasVercelOrigin) {
                return next();
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

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
    logger.info({ port, origins: allowedOrigins }, 'DerivNexus backend started');
});

