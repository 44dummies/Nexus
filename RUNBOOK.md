# RUNBOOK

Date: 2026-01-25

## Local Dev
1) Install deps: `cd backend && npm install`
2) Set env:
   - `CORS_ORIGIN=http://localhost`
   - `DERIV_APP_ID=1089`
   - `DERIV_TOKEN` cookies handled by frontend
3) Start backend: `npm run dev`
4) Health: `GET /health`
5) Metrics: `GET /metrics/snapshot`

## Paper Mode (Replay)
1) Record market data:
   - Set `MARKETDATA_RECORD_PATH=/tmp/marketdata.jsonl`
   - Run bots to collect ticks/order book
2) Replay:
   - Use `runReplay(filePath, config)` from `backend/src/lib/replayEngine.ts`
   - Evaluate PnL and latency metrics offline

## Prod
- Ensure `RISK_ADMIN_TOKEN` is set.
- Confirm throttles and kill switch thresholds.
- Use `backend/config/trading.json` for presets.

## Latency Metrics
Use `/metrics/snapshot`:
- `latency.tick_to_decision_ms`
- `latency.decision_to_send_ms`
- `latency.send_to_proposal_ack_ms`
- `latency.send_to_buy_ack_ms`
- `latency.send_to_fill_ms`
- `eventLoopLagMs.p99` / `eventLoopLagMs.max`

## Emergency Procedures
- Manual kill switch:
  - `POST /api/risk-events/kill-switch`
  - body: `{ "action": "activate", "reason": "manual", "scope": "account|global" }`
  - header: `x-risk-token` (requires `KILL_SWITCH_ADMIN_TOKEN`)
- Clear kill switch:
  - body: `{ "action": "clear", "scope": "account|global" }`

## Reliability Config (Env)
### WebSocket
- `WS_MAX_QUEUE_DEPTH`, `WS_QUEUE_POLICY` (reject-new|drop-oldest|priority)
- `WS_REQUEST_TIMEOUT_MS`, `WS_CONNECTION_TIMEOUT_MS`, `WS_IDLE_TIMEOUT_MS`
- `WS_MAX_RECONNECT_ATTEMPTS`, `WS_RECONNECT_BASE_DELAY_MS`, `WS_RECONNECT_MAX_DELAY_MS`, `WS_RECONNECT_JITTER_MS`
- `WS_RECONNECT_WINDOW_MS`, `WS_RECONNECT_STORM_LIMIT`, `WS_RECONNECT_COOLDOWN_MS`
- `WS_PARSE_SAMPLE_BYTES`, `WS_AUTH_RETRY_ATTEMPTS`, `WS_AUTH_RETRY_DELAY_MS`

### Execution
- `DERIV_THROTTLE_MAX_WAIT_MS`, `DERIV_PROPOSALS_PER_SEC`, `DERIV_BUYS_PER_SEC`
- `DERIV_PROPOSAL_BURST`, `DERIV_BUY_BURST`, `DERIV_REQUOTE_MAX_ATTEMPTS`, `DERIV_REQUOTE_DELAY_MS`

### Risk & Auth
- `KILL_SWITCH_ADMIN_TOKEN`, `KILL_SWITCH_FAIL_CLOSED`
- `SESSION_ENCRYPTION_KEY`, `CONFIG_DOCTOR_FAIL_FAST`

### Persistence / Supabase
- `SUPABASE_RETRY_ATTEMPTS`, `SUPABASE_RETRY_BASE_MS`, `SUPABASE_RETRY_MAX_MS`
- `PERSIST_FALLBACK_ENABLED`, `PERSIST_FALLBACK_PATH`, `PERSIST_FALLBACK_MAX_BYTES`
- `DEPENDENCY_READY_TIMEOUT_MS`, `DEPENDENCY_READY_INTERVAL_MS`, `SUPABASE_HEALTH_TABLE`

### System Resources
- `RESOURCE_MONITOR_INTERVAL_MS`, `RESOURCE_MAX_RSS_MB`
- `RESOURCE_EVENT_LOOP_P99_MS`, `RESOURCE_EVENT_LOOP_MAX_MS`
- `RESOURCE_MEMORY_GROWTH_MB`, `RESOURCE_MEMORY_GROWTH_WINDOW_MS`
- `RESOURCE_CIRCUIT_OPEN_MS`

### Settlement
- `SETTLEMENT_SUBSCRIBE_MAX_ATTEMPTS`, `SETTLEMENT_SUBSCRIBE_BASE_DELAY_MS`, `SETTLEMENT_SUBSCRIBE_MAX_DELAY_MS`
- `SETTLEMENT_RESUBSCRIBE_INTERVAL_MS`, `SETTLEMENT_RESUBSCRIBE_MAX_ATTEMPTS`, `SETTLEMENT_STALE_MS`
- `SETTLEMENT_BUFFER_MS`, `SETTLEMENT_MIN_TIMEOUT_MS`, `SETTLEMENT_MAX_TIMEOUT_MS`

### Startup & Recovery
- `SAFE_PORT`, `ALLOW_PRIVILEGED_PORT`
- `BOT_ZOMBIE_CLEANUP_ENABLED`, `BOT_ZOMBIE_CLEANUP_INTERVAL_MS`, `BOT_ZOMBIE_STALE_MS`
- `RECOVERY_INTERVAL_MS`, `RECOVERY_COOLDOWN_MS`

### Frontend
- `NEXT_PUBLIC_API_TIMEOUT_MS`, `NEXT_PUBLIC_API_RETRY_COUNT`, `NEXT_PUBLIC_API_RETRY_BASE_MS`
- `NEXT_PUBLIC_WS_RECONNECT_BASE_MS`, `NEXT_PUBLIC_WS_RECONNECT_MAX_MS`, `NEXT_PUBLIC_WS_RECONNECT_JITTER_MS`
