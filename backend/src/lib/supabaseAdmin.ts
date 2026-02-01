import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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
        return { client: cachedClient, keyType: cachedKeyType || keyType };
    }

    cachedUrl = url;
    cachedKey = key;
    cachedKeyType = keyType;
    cachedClient = createClient(url, key, {
        auth: { persistSession: false },
    });

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
        return {
            client: null,
            keyType: null,
            error: 'Supabase service role not configured - this operation requires SUPABASE_SERVICE_ROLE_KEY',
            missing,
        };
    }

    if (cachedClient && cachedUrl === url && cachedKey === serviceKey && cachedKeyType === 'service') {
        return { client: cachedClient, keyType: 'service' };
    }

    cachedUrl = url;
    cachedKey = serviceKey;
    cachedKeyType = 'service';
    cachedClient = createClient(url, serviceKey, {
        auth: { persistSession: false },
    });

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
        return {
            client: null,
            keyType: null,
            error: 'Supabase anon client not configured',
            missing,
        };
    }

    if (cachedAnonClient && cachedAnonUrl === url && cachedAnonKey === anonKey) {
        return { client: cachedAnonClient, keyType: 'anon' };
    }

    cachedAnonUrl = url;
    cachedAnonKey = anonKey;
    cachedAnonClient = createClient(url, anonKey, {
        auth: { persistSession: false },
    });

    return { client: cachedAnonClient, keyType: 'anon' };
}
