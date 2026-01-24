-- Migration: Add backend_mode column to bot_runs
-- Run this in Supabase SQL Editor

ALTER TABLE bot_runs ADD COLUMN IF NOT EXISTS backend_mode boolean DEFAULT false;
