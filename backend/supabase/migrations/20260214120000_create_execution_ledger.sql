-- Migration: Add execution_ledger for settlement atomicity and replay recovery.

CREATE TABLE IF NOT EXISTS execution_ledger (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    correlation_id text NOT NULL,
    account_id text NOT NULL,
    symbol text NOT NULL,
    state text NOT NULL CHECK (state IN ('PENDING', 'SETTLED', 'FAILED')),
    pnl numeric NOT NULL DEFAULT 0,
    fees numeric NOT NULL DEFAULT 0,
    timestamp_ms bigint NOT NULL,
    contract_id bigint NOT NULL,
    metadata jsonb,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (account_id, correlation_id)
);

CREATE INDEX IF NOT EXISTS idx_execution_ledger_state ON execution_ledger (state);
CREATE INDEX IF NOT EXISTS idx_execution_ledger_account_contract ON execution_ledger (account_id, contract_id);
CREATE INDEX IF NOT EXISTS idx_execution_ledger_timestamp ON execution_ledger (timestamp_ms DESC);

ALTER TABLE execution_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_execution_ledger" ON execution_ledger;
CREATE POLICY "service_role_execution_ledger" ON execution_ledger
    FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');
