# Acceptance Criteria

## Latency
- tick→decision p99 ≤ 2 ms
- decision→send p99 ≤ 5 ms
- send→proposal ack p99 ≤ 150 ms
- send→buy ack p99 ≤ 150 ms
- send→fill p99 ≤ duration + 2s
- event loop lag p99 ≤ 20 ms, max ≤ 50 ms

## Stability
- Reject rate (proposal + buy) < 1% over 15 min sample
- Reconnect storms do not exceed 5/min
- No memory growth > 10% over 30 min idle

## Risk
- Kill switch triggers on:
  - latency blowout, reject spike, reconnect storm, slippage spike, volatility spike
- Pre-trade checks enforce max order size, exposure, and rate limits
- Stuck order detection logs risk event

## Pass/Fail
- Pass when all latency and risk gates above are satisfied under representative load
- Fail if any kill switch triggers due to regressions or if p99 exceeds thresholds
