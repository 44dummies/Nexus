# Baseline Report (Phase 1 Instrumentation)

Date: 2026-01-25

## Environment
- Host: local dev
- Node: 20+
- Mode: instrumentation only (no optimizations)
- Notes: This report captures metrics from the new `/metrics` snapshot endpoint.

## Run Procedure
1) Start backend: `CORS_ORIGIN=http://localhost npm run dev`
2) Let the server run for ~60 seconds under representative traffic.
3) Query: `GET http://localhost:4000/metrics/snapshot`

## Execution Status
- Local server failed to bind in this environment: `listen EPERM: operation not permitted 0.0.0.0:4000`
- Retried on port 4001 during this run; same EPERM bind restriction.
- Metrics snapshot could not be collected here due to port bind restrictions.
- Re-run the steps above in a local environment with network binds enabled.

## Latency (p50 / p90 / p99)
tick→decision (ms): blocked (EPERM)
decision→send (ms): blocked (EPERM)
send→proposal ack (ms): blocked (EPERM)
send→buy ack (ms): blocked (EPERM)
send→fill (ms): blocked (EPERM)

## Event Loop Lag (ms)
p50: blocked (EPERM)
p90: blocked (EPERM)
p99: blocked (EPERM)
max: blocked (EPERM)

## WS Backlog / Queue
inbound_inflight: blocked (EPERM)
pending_requests: blocked (EPERM)
outbound_queue_depth: blocked (EPERM)

## Reject / Error Rates
proposal_reject: blocked (EPERM)
buy_reject: blocked (EPERM)
slippage_reject: blocked (EPERM)
trade_error: blocked (EPERM)

## CPU / Memory Snapshot
cpu_percent: blocked (EPERM)
memory_rss: blocked (EPERM)
heap_used: blocked (EPERM)

## Notes
- Populate this report after collecting real traffic. Metrics will appear once ticks/trades flow.

---

# Optimization Report (Phase 2: Tick Hot Path)

## Changes
- Replaced tick buffer with ring buffer (O(1) push, no shift).
- Added micro-batching queue (configurable size/interval).
- Added strategy compute budget guard (feature-flagged).
- Switched strategy evaluation to ring-buffer views (no per-tick array copy).

## Latency Delta vs Baseline
tick→decision (ms): blocked (EPERM)
decision→send (ms): blocked (EPERM)
send→proposal ack (ms): blocked (EPERM)
send→buy ack (ms): blocked (EPERM)
send→fill (ms): blocked (EPERM)

## Event Loop Lag Delta
p99: blocked (EPERM)
max: blocked (EPERM)

---

# Optimization Report (Phase 3: Market Data)

## Changes
- Order book subscription with synthetic fallback
- Market data unification (mid/spread/imbalance/momentum)

## Latency Delta vs Baseline
tick→decision (ms): blocked (EPERM)
decision→send (ms): blocked (EPERM)
send→proposal ack (ms): blocked (EPERM)
send→buy ack (ms): blocked (EPERM)
send→fill (ms): blocked (EPERM)

---

# Optimization Report (Phase 4: Microstructure Signals)

## Changes
- Imbalance and spread+momentum signals with confidence + reason codes
- Feature flags for microstructure signal toggles

## Latency Delta vs Baseline
tick→decision (ms): blocked (EPERM)
decision→send (ms): blocked (EPERM)
send→proposal ack (ms): blocked (EPERM)
send→buy ack (ms): blocked (EPERM)
send→fill (ms): blocked (EPERM)

---

# Optimization Report (Phase 5: Execution Engine + Throttles)

## Changes
- Execution engine wrapper with proposal/buy throttles and requote loop
- Cancel/replace semantics via re-quote

## Latency Delta vs Baseline
tick→decision (ms): blocked (EPERM)
decision→send (ms): blocked (EPERM)
send→proposal ack (ms): blocked (EPERM)
send→buy ack (ms): blocked (EPERM)
send→fill (ms): blocked (EPERM)

---

# Optimization Report (Phase 6: Risk Hardening)

## Changes
- Kill switch + anomaly triggers (latency blowout, reject spike, reconnect storm, slippage spike)
- Pre-trade risk caps expanded (order size/exposure/rate limits)
- Volatility spike guard

## Risk Outcomes
kill_switch_triggers: blocked (EPERM)
reject_spike: blocked (EPERM)
reconnect_storm: blocked (EPERM)
