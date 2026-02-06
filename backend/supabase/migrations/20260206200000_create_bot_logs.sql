-- Create the bot_logs table for persisting per-bot-run activity logs
-- This table is referenced by botController.queueBotLog but was never created,
-- causing PGRST205 errors on every trade execution in production.

CREATE TABLE IF NOT EXISTS bot_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_run_id uuid NOT NULL REFERENCES bot_runs(id) ON DELETE CASCADE,
    account_id text NOT NULL,
    level text NOT NULL DEFAULT 'info',
    message text NOT NULL DEFAULT '',
    data jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for querying logs by bot run
CREATE INDEX IF NOT EXISTS idx_bot_logs_bot_run_id ON bot_logs(bot_run_id);

-- Index for querying logs by account
CREATE INDEX IF NOT EXISTS idx_bot_logs_account_id ON bot_logs(account_id);

-- Index for time-based queries and cleanup
CREATE INDEX IF NOT EXISTS idx_bot_logs_created_at ON bot_logs(created_at);

-- Enable RLS (consistent with other tables)
ALTER TABLE bot_logs ENABLE ROW LEVEL SECURITY;

-- RLS policy: service role has full access (backend uses service role key)
CREATE POLICY "Service role full access on bot_logs"
    ON bot_logs
    FOR ALL
    USING (true)
    WITH CHECK (true);
