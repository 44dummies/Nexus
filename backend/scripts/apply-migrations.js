#!/usr/bin/env node
/**
 * Apply pending SQL migrations to production Supabase.
 * Uses the Supabase Management API (pg_query via REST).
 * 
 * Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/apply-migrations.js
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const PROJECT_REF = SUPABASE_URL.replace('https://', '').split('.')[0];

const MIGRATIONS = [
    {
        name: '20260206150000_add_bot_runs_columns',
        sql: `
            ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS paused_reason text;
            ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS trades_executed integer DEFAULT 0;
            ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS total_profit numeric DEFAULT 0;
        `,
    },
    {
        name: '20260206200000_create_bot_logs',
        sql: `
            CREATE TABLE IF NOT EXISTS bot_logs (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                bot_run_id uuid NOT NULL REFERENCES bot_runs(id) ON DELETE CASCADE,
                account_id text NOT NULL,
                level text NOT NULL DEFAULT 'info',
                message text NOT NULL DEFAULT '',
                data jsonb,
                created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE INDEX IF NOT EXISTS idx_bot_logs_bot_run_id ON bot_logs(bot_run_id);
            CREATE INDEX IF NOT EXISTS idx_bot_logs_account_id ON bot_logs(account_id);
            CREATE INDEX IF NOT EXISTS idx_bot_logs_created_at ON bot_logs(created_at);
            ALTER TABLE bot_logs ENABLE ROW LEVEL SECURITY;
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_policies WHERE tablename = 'bot_logs' AND policyname = 'Service role full access on bot_logs'
                ) THEN
                    CREATE POLICY "Service role full access on bot_logs"
                        ON bot_logs FOR ALL
                        USING (true) WITH CHECK (true);
                END IF;
            END $$;
        `,
    },
    {
        name: '20260207100000_enrich_trades_pnl',
        sql: `
            ALTER TABLE trades ADD COLUMN IF NOT EXISTS buy_price numeric;
            ALTER TABLE trades ADD COLUMN IF NOT EXISTS payout numeric;
            ALTER TABLE trades ADD COLUMN IF NOT EXISTS direction text;
            CREATE INDEX IF NOT EXISTS idx_trades_direction ON trades (direction);
            CREATE INDEX IF NOT EXISTS idx_trades_account_created ON trades (account_id, created_at DESC);
        `,
    },
];

async function runSQL(sql) {
    // Use the PostgREST rpc endpoint — we need a function for raw SQL.
    // Supabase doesn't expose raw SQL via REST. Instead, use the pg_net approach
    // or create a temporary function. Let's use the simplest approach:
    // Call the supabase-js client with a raw query via .rpc()

    // Actually, the cleanest way is to use fetch to the Supabase Management API
    // But that requires a management token. Let's use the PostgREST approach
    // by creating a temporary function.

    // Simplest: use the pg_query endpoint available on newer Supabase
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/`, {
        method: 'POST',
        headers: {
            'apikey': SERVICE_KEY,
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
    });

    // If pg_query doesn't exist, fall back to creating a temp function
    return response;
}

async function applyViaTempFunction(sql) {
    // Step 1: Create a temp function that executes the SQL
    const createFn = `
        CREATE OR REPLACE FUNCTION _temp_migration() RETURNS void AS $$
        BEGIN
            ${sql.replace(/'/g, "''")}
        END;
        $$ LANGUAGE plpgsql SECURITY DEFINER;
    `;

    // This won't work via REST either — we need raw DB access.
    // Let's use the @supabase/supabase-js with .rpc() 
    // But that only works for existing functions.
    
    // The real solution: use the Supabase SQL API endpoint
    const response = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${SERVICE_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
    });
    
    return response;
}

async function applyMigrations() {
    console.log(`Applying ${MIGRATIONS.length} migrations to ${PROJECT_REF}...\n`);
    
    for (const migration of MIGRATIONS) {
        console.log(`→ ${migration.name}`);
        try {
            // Try the Management API approach
            const res = await applyViaTempFunction(migration.sql);
            const text = await res.text();
            
            if (res.ok) {
                console.log(`  ✓ Applied successfully`);
            } else {
                console.log(`  ✗ HTTP ${res.status}: ${text.slice(0, 200)}`);
                
                // If the management API doesn't work, print the SQL for manual execution
                console.log(`  → Run this SQL manually in Supabase Dashboard → SQL Editor:`);
                console.log(`  ${migration.sql.trim().split('\n').join('\n  ')}\n`);
            }
        } catch (error) {
            console.error(`  ✗ Error: ${error.message}`);
            console.log(`  → Run this SQL manually in Supabase Dashboard → SQL Editor:`);
            console.log(`  ${migration.sql.trim().split('\n').join('\n  ')}\n`);
        }
    }
}

applyMigrations().catch(console.error);
