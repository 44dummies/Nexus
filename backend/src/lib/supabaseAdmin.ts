import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { setComponentStatus } from './healthStatus';
import { recordObstacle } from './obstacleLog';

export type SupabaseErrorCategory = 'permission' | 'connectivity' | 'query' | 'unknown';

export interface SupabaseErrorInfo {
    category: SupabaseErrorCategory;
    code?: string;
    status?: number;
    message: string;
}

export type SupabaseKeyType = 'service' | 'anon';

interface SupabaseAdminResult {
    client: SupabaseClient | null;
    keyType: SupabaseKeyType | null;
    error?: string;
    missing?: string[];
}

let cachedClient: SupabaseClient | null = null;
let cachedUrl: string | null = null;
let cachedKey: string | null = null;
let cachedKeyType: SupabaseKeyType | null = null;

let cachedAnonClient: SupabaseClient | null = null;
let cachedAnonUrl: string | null = null;
let cachedAnonKey: string | null = null;

function resolveSupabaseConfig() {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const key = serviceKey || anonKey || '';
    const keyType: SupabaseKeyType | null = serviceKey ? 'service' : anonKey ? 'anon' : null;

    return { url, key, keyType, serviceKey, anonKey };
}

export function getSupabaseAdmin(): SupabaseAdminResult {
    const { url, key, keyType } = resolveSupabaseConfig();
    const missing: string[] = [];

    if (!url) {
        missing.push('SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL');
    }
    if (!keyType) {
        missing.push('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY/NEXT_PUBLIC_SUPABASE_ANON_KEY');
    }

    if (!url || !key || !keyType) {
        setComponentStatus('db', 'error', 'Supabase not configured');
        return {
            client: null,
            keyType: null,
            error: 'Supabase not configured',
            missing,
        };
    }
    
    // SEC: DATA-02 - Warn in production if using anon key for admin operations
    if (keyType === 'anon' && process.env.NODE_ENV === 'production') {
        console.warn('[SECURITY WARNING] Using anon key for admin operations. Set SUPABASE_SERVICE_ROLE_KEY for proper permissions.');
    }

    if (cachedClient && cachedUrl === url && cachedKey === key) {
        setComponentStatus('db', 'ok');
        return { client: cachedClient, keyType: cachedKeyType || keyType };
    }

    cachedUrl = url;
    cachedKey = key;
    cachedKeyType = keyType;
    cachedClient = createClient(url, key, {
        auth: { persistSession: false },
    });

    setComponentStatus('db', 'ok');
    return { client: cachedClient, keyType };
}

/**
 * Get Supabase admin client with explicit service key requirement (SEC: DATA-02)
 * Use this for operations that MUST have service-level access
 */
export function getSupabaseServiceAdmin(): SupabaseAdminResult {
    const { url, serviceKey } = resolveSupabaseConfig();
    const missing: string[] = [];

    if (!url) {
        missing.push('SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL');
    }
    if (!serviceKey) {
        missing.push('SUPABASE_SERVICE_ROLE_KEY');
    }

    if (!url || !serviceKey) {
        setComponentStatus('db', 'error', 'Supabase service role not configured');
        return {
            client: null,
            keyType: null,
            error: 'Supabase service role not configured - this operation requires SUPABASE_SERVICE_ROLE_KEY',
            missing,
        };
    }

    if (cachedClient && cachedUrl === url && cachedKey === serviceKey && cachedKeyType === 'service') {
        setComponentStatus('db', 'ok');
        return { client: cachedClient, keyType: 'service' };
    }

    cachedUrl = url;
    cachedKey = serviceKey;
    cachedKeyType = 'service';
    cachedClient = createClient(url, serviceKey, {
        auth: { persistSession: false },
    });

    setComponentStatus('db', 'ok');
    return { client: cachedClient, keyType: 'service' };
}

export function getSupabaseClient(): SupabaseAdminResult {
    const { url, anonKey } = resolveSupabaseConfig();
    const missing: string[] = [];

    if (!url) {
        missing.push('SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL');
    }
    if (!anonKey) {
        missing.push('SUPABASE_ANON_KEY or NEXT_PUBLIC_SUPABASE_ANON_KEY');
    }

    if (!url || !anonKey) {
        setComponentStatus('db', 'error', 'Supabase anon client not configured');
        return {
            client: null,
            keyType: null,
            error: 'Supabase anon client not configured',
            missing,
        };
    }

    if (cachedAnonClient && cachedAnonUrl === url && cachedAnonKey === anonKey) {
        setComponentStatus('db', 'ok');
        return { client: cachedAnonClient, keyType: 'anon' };
    }

    cachedAnonUrl = url;
    cachedAnonKey = anonKey;
    cachedAnonClient = createClient(url, anonKey, {
        auth: { persistSession: false },
    });

    setComponentStatus('db', 'ok');
    return { client: cachedAnonClient, keyType: 'anon' };
}

export function classifySupabaseError(error: any): SupabaseErrorInfo {
    const message = typeof error?.message === 'string' ? error.message : 'Supabase error';
    const code = typeof error?.code === 'string' ? error.code : undefined;
    const status = typeof error?.status === 'number' ? error.status : undefined;

    if (status === 401 || status === 403 || message.toLowerCase().includes('permission')) {
        return { category: 'permission', code, status, message };
    }

    if (message.toLowerCase().includes('network') || message.toLowerCase().includes('timeout')) {
        return { category: 'connectivity', code, status, message };
    }

    if (code && ['42501', '28P01', 'PGRST301'].includes(code)) {
        return { category: 'permission', code, status, message };
    }

    if (code && ['PGRST000', 'PGRST116'].includes(code)) {
        return { category: 'query', code, status, message };
    }

    return { category: 'unknown', code, status, message };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withSupabaseRetry<T = any>(
    taskName: string,
    operation: (client: SupabaseClient) => Promise<T>,
    options?: { attempts?: number; baseDelayMs?: number; maxDelayMs?: number }
): Promise<T> {
    const { client, error, missing } = getSupabaseAdmin();
    if (!client) {
        const detail = error || 'Supabase not configured';
        recordObstacle('database', taskName, detail, 'high', ['backend/src/lib/supabaseAdmin.ts']);
        throw new Error(detail + (missing?.length ? ` Missing: ${missing.join(', ')}` : ''));
    }

    const attempts = Math.max(1, (options?.attempts ?? Number(process.env.SUPABASE_RETRY_ATTEMPTS)) || 3);
    const baseDelayMs = Math.max(100, (options?.baseDelayMs ?? Number(process.env.SUPABASE_RETRY_BASE_MS)) || 200);
    const maxDelayMs = Math.max(baseDelayMs, (options?.maxDelayMs ?? Number(process.env.SUPABASE_RETRY_MAX_MS)) || 2000);

    let attempt = 0;
    while (attempt < attempts) {
        attempt += 1;
        try {
            return await operation(client);
        } catch (err) {
            const info = classifySupabaseError(err);
            if (info.category !== 'connectivity' || attempt >= attempts) {
                throw err;
            }
            const delay = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1));
            await sleep(delay);
        }
    }

    throw new Error('Supabase retry attempts exhausted');
}

// Test helpers
export function setSupabaseClientForTest(client: SupabaseClient, url: string, key: string, keyType: SupabaseKeyType = 'service'): void {
    cachedClient = client;
    cachedUrl = url;
    cachedKey = key;
    cachedKeyType = keyType;
}

export function clearSupabaseClientForTest(): void {
    cachedClient = null;
    cachedUrl = null;
    cachedKey = null;
    cachedKeyType = null;
}
