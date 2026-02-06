-- Migration: Add buy_price, payout, direction to trades table for PnL correctness
-- These fields are available at execution/settlement but were not persisted
-- Enables post-trade analysis, fee auditing, and win-rate by direction

ALTER TABLE trades ADD COLUMN IF NOT EXISTS buy_price numeric;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS payout numeric;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS direction text;

-- Index for direction-based queries (strategy performance by direction)
CREATE INDEX IF NOT EXISTS idx_trades_direction ON trades (direction);

-- Index for efficient daily PnL aggregation
CREATE INDEX IF NOT EXISTS idx_trades_account_created ON trades (account_id, created_at DESC);
