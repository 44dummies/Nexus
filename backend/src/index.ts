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
import marketsRouter from './routes/markets';
import logger from './lib/logger';
import { defaultRateLimit } from './lib/rateLimit';
import { startTradeBackfillJob } from './lib/tradeBackfill';
import metricsRouter from './routes/metrics';
import auditRouter from './routes/audit';
import analyticsRouter from './routes/analytics';
import backtestRouter from './routes/backtest';
import { initMetrics, metrics } from './lib/metrics';
import { initRiskManager } from './lib/riskManager';
import { reconcileBotRunsOnStartup, startZombieCleanupJob } from './lib/botController';
import { initObstacleLog } from './lib/obstacleLog';
import { getHealthSnapshot, setComponentStatus } from './lib/healthStatus';
import { initResourceMonitor } from './lib/resourceMonitor';
import { printConfigDoctorReport, runConfigDoctor, waitForSupabaseReady } from './lib/configDoctor';
import { initRecoveryManager } from './lib/recoveryManager';

const app = express();
initMetrics();
initObstacleLog();
initResourceMonitor();
initRecoveryManager();

app.set('trust proxy', 1);
app.use(helmet());

const rawOrigins = process.env.CORS_ORIGIN || process.env.FRONTEND_URL || '';
// Normalize origins: trim whitespace and remove trailing slashes
const allowedOrigins = rawOrigins
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
const allowLocalhostOrigins = (process.env.CORS_ALLOW_LOCALHOST || '').toLowerCase() === 'true'
    || process.env.NODE_ENV !== 'production';

function isLocalhostOrigin(origin: string) {
    try {
        const url = new URL(origin);
        const host = url.hostname;
        return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
    } catch {
        return false;
    }
}

app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (same-origin, curl, etc.)
        if (!origin) {
            return callback(null, true);
        }
        // Normalize incoming origin (strip trailing slash)
        const normalizedOrigin = origin.replace(/\/+$/, '');

        if (allowLocalhostOrigins && isLocalhostOrigin(normalizedOrigin)) {
            return callback(null, true);
        }

        // Fail closed: reject if no origins configured
        if (allowedOrigins.length === 0) {
            logger.error({ origin }, 'CORS: No origins configured - set CORS_ORIGIN or FRONTEND_URL env var');
            return callback(new Error('CORS not configured - set CORS_ORIGIN or FRONTEND_URL'));
        }

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

let inFlight = 0;
app.use((req, res, next) => {
    const start = Date.now();
    inFlight += 1;
    setComponentStatus('http', 'ok');
    res.on('finish', () => {
        inFlight = Math.max(0, inFlight - 1);
        const duration = Date.now() - start;
        metrics.histogram('http.request_ms', duration);
        metrics.gauge('http.in_flight', inFlight);
        metrics.counter(`http.status.${res.statusCode}`);
    });
    res.on('close', () => {
        inFlight = Math.max(0, inFlight - 1);
        metrics.gauge('http.in_flight', inFlight);
    });
    next();
});

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
    res.json(getHealthSnapshot());
});

app.use('/api/auth', authRouter);
app.use('/api/trades', tradesRouter);
app.use('/api/markets', marketsRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/risk-events', riskEventsRouter);
app.use('/api/bot-runs', botRunsRouter);
app.use('/api/order-status', orderStatusRouter);
app.use('/metrics', metricsRouter);
app.use('/api/audit', auditRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/backtest', backtestRouter);

const rawPort = Number(process.env.PORT);
const SAFE_PORT = Number(process.env.SAFE_PORT) || 8080;
const ALLOW_PRIVILEGED_PORT = (process.env.ALLOW_PRIVILEGED_PORT || 'false') === 'true';
const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 4000;

function resolvePort(): number {
    if (port < 1024 && !ALLOW_PRIVILEGED_PORT) {
        logger.warn({ port, safePort: SAFE_PORT }, 'Privileged port configured; falling back to safe port');
        return SAFE_PORT;
    }
    return port;
}

async function startServer() {
    const config = runConfigDoctor();
    printConfigDoctorReport(config.issues);
    const hasErrors = config.issues.some((issue) => issue.severity === 'error');
    const failFast = (process.env.CONFIG_DOCTOR_FAIL_FAST || (process.env.NODE_ENV === 'production' ? 'true' : 'false')) === 'true';
    if (hasErrors && failFast) {
        logger.error('Config doctor detected fatal issues. Exiting.');
        process.exit(1);
    }

    await waitForSupabaseReady();
    await initRiskManager();
    await reconcileBotRunsOnStartup();
    startZombieCleanupJob();
    const bindPort = resolvePort();
    const server = app.listen(bindPort, () => {
        if (bindPort !== port) {
            logger.warn({ configuredPort: port, bindPort }, 'Using safe port due to privileged port restriction');
        }
        logger.info({ port: bindPort, origins: allowedOrigins }, '44dummies backend started');
        startTradeBackfillJob();
    });
    server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EACCES') {
            logger.error({ port: bindPort }, 'Permission denied binding port. Use a port >=1024 or set ALLOW_PRIVILEGED_PORT=true with proper privileges.');
        } else if (error.code === 'EADDRINUSE') {
            logger.error({ port: bindPort }, 'Port already in use. Set PORT to a free port.');
        } else {
            logger.error({ error }, 'Server failed to bind');
        }
        process.exit(1);
    });
}

startServer().catch((error) => {
    logger.error({ error }, 'Failed to start 44dummies backend');
    process.exit(1);
});
