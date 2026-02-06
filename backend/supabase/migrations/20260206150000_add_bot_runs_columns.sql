-- Migration: Add missing bot_runs columns
-- Date: 2026-02-06
-- Priority: HIGH (DATA LOSS - paused_reason, trades_executed, total_profit never persisted)
-- Description: Adds 3 columns that botController.ts writes to but were missing from schema

-- paused_reason: stores why a bot run was paused (e.g., "Kill switch active")
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS paused_reason text;

-- trades_executed: final count of trades executed during this bot run
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS trades_executed integer DEFAULT 0;

-- total_profit: final cumulative P&L for this bot run
ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS total_profit numeric DEFAULT 0;
