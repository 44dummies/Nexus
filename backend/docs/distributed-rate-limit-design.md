# Distributed Rate Limit Design (Redis Sliding Window)

## Goal
- Replace in-process limiter with a distributed limiter that remains correct across replicas.
- Key format: `ratelimit:{accountId}:{route}`.
- Algorithm: sliding window (not fixed window) for smoother fairness.

## Redis Data Model
- Use sorted sets:
  - Key: `ratelimit:{accountId}:{route}`
  - Member: request UUID
  - Score: request timestamp (ms)
- Per request:
  1. `ZREMRANGEBYSCORE key -inf (now-windowMs)`
  2. `ZCARD key`
  3. Reject if count >= maxRequests
  4. `ZADD key now requestId`
  5. `PEXPIRE key windowMs`

## Atomicity
- Wrap the above in one Lua script to avoid race conditions under high concurrency.

## Headers
- Keep current headers:
  - `X-RateLimit-Limit`
  - `X-RateLimit-Remaining`
  - `X-RateLimit-Reset`
  - `Retry-After` on 429

## Fallback
- If Redis is unavailable:
  - Fail open for low-risk read routes.
  - Fail closed for high-risk mutation routes (`/api/trades/execute`).
  - Emit `rate_limit.redis_unavailable` counter.

## Rollout
1. Ship dual-path (Redis + in-memory fallback), gated by `RATE_LIMIT_REDIS_URL`.
2. Shadow mode metrics only.
3. Enable enforcement for trade routes.
4. Expand to auth routes and other mutations.
