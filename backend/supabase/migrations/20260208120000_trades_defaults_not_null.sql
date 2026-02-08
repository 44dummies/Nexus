-- Migration: Enforce non-null defaults for trades.symbol and trades.duration_unit
-- Backfills existing nulls to prevent UI crashes on display.

UPDATE trades SET duration_unit = 't' WHERE duration_unit IS NULL;
UPDATE trades SET symbol = 'UNKNOWN' WHERE symbol IS NULL;

ALTER TABLE trades ALTER COLUMN duration_unit SET DEFAULT 't';
ALTER TABLE trades ALTER COLUMN duration_unit SET NOT NULL;
ALTER TABLE trades ALTER COLUMN symbol SET DEFAULT 'UNKNOWN';
ALTER TABLE trades ALTER COLUMN symbol SET NOT NULL;
