# Risk Report

Date: 2026-01-25

## Always-on Pre-trade Checks
- Max order size / notional (`risk.maxOrderSize`, `risk.maxNotional`)
- Max exposure (`risk.maxExposure`) using cached open exposure
- Orders per second / minute (`risk.maxOrdersPerSecond`, `risk.maxOrdersPerMinute`)
- Existing cached limits: daily loss, drawdown, loss streak, cooldown, max concurrent trades

## Runtime Guards
- Volatility spike guard: ATR window > threshold triggers kill switch
- Reject spike guard: proposal/buy rejects in window trigger kill switch
- Reconnect storm guard: reconnect spikes trigger kill switch
- Latency blowout guard: p99 send→buy ack exceeds threshold for consecutive windows triggers global kill switch
- Slippage spike guard: slippage rejects in window trigger kill switch
- Stuck order detection: settlement timeout records risk event

## Kill Switch
- Manual endpoint: `POST /api/risk-events/kill-switch` with `action=activate|clear`
  - Optional `scope=global` to trigger global kill switch
  - If `RISK_ADMIN_TOKEN` is set, requires `x-risk-token` header
- Automatic triggers:
  - `LATENCY_BLOWOUT` (p99 latency threshold)
  - `RECONNECT_STORM`
  - `REJECT_SPIKE`
  - `SLIPPAGE_SPIKE`
  - `VOLATILITY_SPIKE`
  - `CANCEL_RATE_SPIKE`

## Operational Notes
- Kill switch is checked before trade execution and pauses bot runs.
- Risk events are persisted to `risk_events` when Supabase is configured.
