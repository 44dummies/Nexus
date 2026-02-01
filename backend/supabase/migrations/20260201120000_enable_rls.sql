-- Migration: Enable Row Level Security on all tables
-- Date: 2026-02-01
-- Priority: CRITICAL (DATA-01)
-- Description: Enables RLS and adds account_id isolation policies

-- ============================================================================
-- ENABLE RLS ON ALL TABLES
-- ============================================================================

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE risk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- Note: 'users', 'accounts', and 'bots' tables don't have account_id column
-- They require different policies or are reference tables

-- ============================================================================
-- RLS POLICIES FOR SESSIONS
-- ============================================================================

CREATE POLICY "sessions_select_own" ON sessions
    FOR SELECT
    USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "sessions_insert_own" ON sessions
    FOR INSERT
    WITH CHECK (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "sessions_update_own" ON sessions
    FOR UPDATE
    USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "sessions_delete_own" ON sessions
    FOR DELETE
    USING (account_id = current_setting('app.current_account_id', true));

-- ============================================================================
-- RLS POLICIES FOR BOT_RUNS
-- ============================================================================

CREATE POLICY "bot_runs_select_own" ON bot_runs
    FOR SELECT
    USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "bot_runs_insert_own" ON bot_runs
    FOR INSERT
    WITH CHECK (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "bot_runs_update_own" ON bot_runs
    FOR UPDATE
    USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "bot_runs_delete_own" ON bot_runs
    FOR DELETE
    USING (account_id = current_setting('app.current_account_id', true));

-- ============================================================================
-- RLS POLICIES FOR TRADES
-- ============================================================================

CREATE POLICY "trades_select_own" ON trades
    FOR SELECT
    USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "trades_insert_own" ON trades
    FOR INSERT
    WITH CHECK (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "trades_update_own" ON trades
    FOR UPDATE
    USING (account_id = current_setting('app.current_account_id', true));

-- No delete policy for trades - immutable audit trail

-- ============================================================================
-- RLS POLICIES FOR ORDER_STATUS
-- ============================================================================

CREATE POLICY "order_status_select_own" ON order_status
    FOR SELECT
    USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "order_status_insert_own" ON order_status
    FOR INSERT
    WITH CHECK (account_id = current_setting('app.current_account_id', true));

-- No update/delete for order_status - immutable audit trail

-- ============================================================================
-- RLS POLICIES FOR NOTIFICATIONS
-- ============================================================================

CREATE POLICY "notifications_select_own" ON notifications
    FOR SELECT
    USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "notifications_insert_own" ON notifications
    FOR INSERT
    WITH CHECK (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "notifications_update_own" ON notifications
    FOR UPDATE
    USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "notifications_delete_own" ON notifications
    FOR DELETE
    USING (account_id = current_setting('app.current_account_id', true));

-- ============================================================================
-- RLS POLICIES FOR RISK_EVENTS
-- ============================================================================

CREATE POLICY "risk_events_select_own" ON risk_events
    FOR SELECT
    USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "risk_events_insert_own" ON risk_events
    FOR INSERT
    WITH CHECK (account_id = current_setting('app.current_account_id', true));

-- No update/delete for risk_events - immutable audit trail

-- ============================================================================
-- RLS POLICIES FOR SETTINGS
-- ============================================================================

CREATE POLICY "settings_select_own" ON settings
    FOR SELECT
    USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "settings_insert_own" ON settings
    FOR INSERT
    WITH CHECK (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "settings_update_own" ON settings
    FOR UPDATE
    USING (account_id = current_setting('app.current_account_id', true));

CREATE POLICY "settings_delete_own" ON settings
    FOR DELETE
    USING (account_id = current_setting('app.current_account_id', true));

-- ============================================================================
-- SERVICE ROLE BYPASS POLICIES
-- These allow the service role (backend) to access all data
-- ============================================================================

CREATE POLICY "service_role_sessions" ON sessions
    FOR ALL
    USING (current_setting('role', true) = 'service_role');

CREATE POLICY "service_role_bot_runs" ON bot_runs
    FOR ALL
    USING (current_setting('role', true) = 'service_role');

CREATE POLICY "service_role_trades" ON trades
    FOR ALL
    USING (current_setting('role', true) = 'service_role');

CREATE POLICY "service_role_order_status" ON order_status
    FOR ALL
    USING (current_setting('role', true) = 'service_role');

CREATE POLICY "service_role_notifications" ON notifications
    FOR ALL
    USING (current_setting('role', true) = 'service_role');

CREATE POLICY "service_role_risk_events" ON risk_events
    FOR ALL
    USING (current_setting('role', true) = 'service_role');

CREATE POLICY "service_role_settings" ON settings
    FOR ALL
    USING (current_setting('role', true) = 'service_role');

-- ============================================================================
-- HELPER FUNCTION TO SET CURRENT ACCOUNT
-- Call this before queries when using anon key
-- ============================================================================

CREATE OR REPLACE FUNCTION set_current_account(account_id text)
RETURNS void AS $$
BEGIN
    PERFORM set_config('app.current_account_id', account_id, true);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
