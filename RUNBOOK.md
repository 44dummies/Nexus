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
  - header: `x-risk-token` (if `RISK_ADMIN_TOKEN` set)
- Clear kill switch:
  - body: `{ "action": "clear", "scope": "account|global" }`
