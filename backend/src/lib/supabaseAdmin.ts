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

function resolveSupabaseConfig() {
    const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
    const key = serviceKey || anonKey || '';
    const keyType: SupabaseKeyType | null = serviceKey ? 'service' : anonKey ? 'anon' : null;

    return { url, key, keyType };
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
