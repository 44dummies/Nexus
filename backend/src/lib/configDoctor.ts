import { recordObstacle } from './obstacleLog';
import logger from './logger';
import { getSupabaseAdmin } from './supabaseAdmin';

export interface ConfigIssue {
    key: string;
    message: string;
    severity: 'info' | 'warn' | 'error';
    remediation?: string;
}

const REQUIRED_ENV = [
    { key: 'DERIV_APP_ID', severity: 'error', message: 'Missing Deriv app id', remediation: 'Set DERIV_APP_ID (or NEXT_PUBLIC_DERIV_APP_ID for frontend).' },
];

const RECOMMENDED_ENV = [
    { key: 'DERIV_WS_URL', severity: 'warn', message: 'Missing Deriv WebSocket URL', remediation: 'Set DERIV_WS_URL if using a custom endpoint.' },
    { key: 'SUPABASE_URL', severity: 'warn', message: 'Missing Supabase URL', remediation: 'Set SUPABASE_URL for persistence.' },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', severity: 'warn', message: 'Missing Supabase service role key', remediation: 'Set SUPABASE_SERVICE_ROLE_KEY for admin writes.' },
    { key: 'KILL_SWITCH_ADMIN_TOKEN', severity: 'warn', message: 'Missing kill-switch admin token', remediation: 'Set KILL_SWITCH_ADMIN_TOKEN to enable kill-switch admin actions.' },
    { key: 'ADMIN_SECRET', severity: 'warn', message: 'Missing ADMIN_SECRET for metrics access', remediation: 'Set ADMIN_SECRET to protect /metrics.' },
    { key: 'CORS_ORIGIN', severity: 'warn', message: 'Missing CORS_ORIGIN', remediation: 'Set CORS_ORIGIN or FRONTEND_URL to allow browser access.' },
];

export function runConfigDoctor(): { issues: ConfigIssue[] } {
    const issues: ConfigIssue[] = [];

    for (const required of REQUIRED_ENV) {
        const value = (process.env[required.key] || '').trim();
        if (!value) {
            issues.push({
                key: required.key,
                message: required.message,
                severity: required.severity as 'error',
                remediation: required.remediation,
            });
        }
    }

    for (const rec of RECOMMENDED_ENV) {
        const value = (process.env[rec.key] || '').trim();
        if (!value) {
            issues.push({
                key: rec.key,
                message: rec.message,
                severity: rec.severity as 'warn',
                remediation: rec.remediation,
            });
        }
    }

    if (process.env.NODE_ENV === 'production') {
        const encryptionKey = (process.env.SESSION_ENCRYPTION_KEY || '').trim();
        if (!encryptionKey) {
            issues.push({
                key: 'SESSION_ENCRYPTION_KEY',
                message: 'Missing session encryption key',
                severity: 'error',
                remediation: 'Set SESSION_ENCRYPTION_KEY (32-byte base64) for token encryption.',
            });
        }
    }

    const { error: supabaseError, missing } = getSupabaseAdmin();
    if (supabaseError) {
        issues.push({
            key: 'SUPABASE',
            message: supabaseError,
            severity: 'warn',
            remediation: missing?.join(', ') || 'Configure Supabase env vars.',
        });
    }

    if (issues.length > 0) {
        for (const issue of issues) {
            if (issue.severity === 'error') {
                recordObstacle('startup', issue.key, issue.message, 'high', ['backend/src/lib/configDoctor.ts']);
            }
        }
    }

    return { issues };
}

export function printConfigDoctorReport(issues: ConfigIssue[]): void {
    if (issues.length === 0) {
        logger.info('Config doctor: no issues detected');
        return;
    }

    logger.warn({ count: issues.length }, 'Config doctor detected issues');
    for (const issue of issues) {
        const detail = issue.remediation ? `${issue.message} Remediation: ${issue.remediation}` : issue.message;
        if (issue.severity === 'error') {
            logger.error({ key: issue.key }, detail);
        } else {
            logger.warn({ key: issue.key }, detail);
        }
    }
}

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForSupabaseReady(): Promise<boolean> {
    const { client: supabaseAdmin, error } = getSupabaseAdmin();
    const timeoutMs = Math.max(1000, Number(process.env.DEPENDENCY_READY_TIMEOUT_MS) || 10_000);
    const intervalMs = Math.max(250, Number(process.env.DEPENDENCY_READY_INTERVAL_MS) || 1000);
    const table = process.env.SUPABASE_HEALTH_TABLE || 'settings';

    if (!supabaseAdmin) {
        recordObstacle('startup', 'Supabase missing', error || 'Supabase not configured', 'high', ['backend/src/lib/supabaseAdmin.ts']);
        return false;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const { error: pingError } = await supabaseAdmin.from(table).select('id').limit(1);
            if (!pingError) {
                return true;
            }
            logger.warn({ table, error: pingError }, 'Supabase readiness check failed');
        } catch (err) {
            logger.warn({ error: err }, 'Supabase readiness exception');
        }
        await sleep(intervalMs);
    }

    recordObstacle('startup', 'Supabase readiness', `Timed out waiting for Supabase table ${table}`, 'high', ['backend/src/lib/configDoctor.ts']);
    return false;
}
