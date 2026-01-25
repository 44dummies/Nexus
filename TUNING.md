# TUNING

## Parameters to Tune
- Micro-batching: `BOT_MICROBATCH_SIZE`, `BOT_MICROBATCH_INTERVAL_MS`
- Strategy budget: `STRATEGY_BUDGET_MS`, `ENABLE_STRATEGY_BUDGET`
- Microstructure thresholds: imbalance, spread, momentum window/threshold
- Execution: `DERIV_PROPOSALS_PER_SEC`, `DERIV_BUYS_PER_SEC`, `DERIV_REQUOTE_MAX_ATTEMPTS`, `DERIV_REQUOTE_DELAY_MS`
- Risk: `maxOrdersPerSecond`, `maxOrdersPerMinute`, `maxExposure`, `volatilityThreshold`

## Suggested Workflow
1) Capture baseline metrics via `/metrics/snapshot`.
2) Change one parameter group at a time.
3) Record p50/p90/p99 and PnL stability.
4) Roll back any change that increases variance or reject rates.

## Experiments
1) batch sizes 1/4/8
2) synthetic depth 20/50/100 vs real order_book
3) imbalance N=5/10/20
4) spread+momo thresholds vs freq/slippage
5) budget 0.5/1/2ms skip-on-overrun
6) re-quote cadence 100/250/500ms
7) aggressiveness 0.2/0.5/0.8
8) WS throttle limits vs rejects
9) risk cap sensitivity vs stability
10) kill-switch thresholds vs false positives
