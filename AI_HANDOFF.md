# AI Handoff Contract – Trading System

This document defines the shared rules between AI agents working on this repo.

## Roles

### Codex (Code Owner)
- May modify source code and documentation.
- Must NOT run terminal commands or guess runtime metrics.
- Must implement changes in small phases with feature flags.
- Must provide clear run instructions and expected metrics per phase.

### Claude Opus (Antigravity – Executor)
- May run terminal commands, start servers, profile, and capture metrics.
- Must NOT perform large refactors or architectural changes.
- May apply minimal hotfixes ONLY to unblock execution.
- Any hotfix must be committed and clearly documented.

## Phase Handoff Contract

Every phase follows this flow:

### Codex → Claude (Phase Output Bundle)
Codex must provide:
1. Commit hash or diff
2. Summary of changes
3. How to run (exact commands)
4. New/changed env vars
5. Metrics endpoints to query
6. Metrics Claude must capture

### Claude → Codex (Phase Verification Bundle)
Claude must provide:
1. Commands executed
2. Server start status (success/failure)
3. Captured metrics (p50/p90/p99, lag, rejects)
4. Test results
5. Pass/Fail vs acceptance_criteria.md
6. Issues found + reproduction steps

## Hard Rules
- Instrumentation comes before optimization.
- Risk checks are always-on and never bypassed.
- Respect Deriv WS rate limits at all times.
- Prefer paper mode when available.
- No silent changes: everything is logged, measured, or documented.

## Source of Truth
If instructions conflict:
1. This file
2. acceptance_criteria.md
3. Phase instructions from Codex

