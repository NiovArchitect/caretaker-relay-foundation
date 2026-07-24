# Rate Limit and Burst Diagnosis

**Date:** 2026-07-24  
**Public API:** https://caretaker-relay-care-api.onrender.com  
**Endpoint:** `POST /api/v1/care/recipients/cr-olivia/coordination`  
**Load:** 50 concurrent unique writes (Promise.all)

## Result

| Metric | Value |
|--------|-------|
| Total | 50 |
| HTTP 201 | 41 |
| HTTP 500 | 9 |
| HTTP 429 | 0 |
| Client network errors | 0 |
| Latency p50 (ok) | ~221s |

## Root cause (exact)

**Class: `PERMANENT_CONFLICT` → race on durable audit flush (not application rate limit)**

Failing responses:

```
code: P2002
message: Invalid `prisma.careAuditRow.upsert()` invocation
Unique constraint failed on the fields: (`id`)
```

### Mechanism

1. Care API uses a **shared** `PrismaCareStore` instance across concurrent requests.
2. Each coordination POST calls `writeAudit` then `flush()`.
3. Concurrent `flush()` loops walked the same audit set; two flushes could both
   attempt to **create** the same append-only `careAuditRow` id before
   `knownAuditIds` was updated.
4. Prisma raised **P2002**, the route returned **500**, and the client counted a failure.

**Not observed:**

- No `Retry-After`
- No `x-ratelimit-*` headers on failures
- No 429 from application gateway

So this was **not** intentional backpressure; it was a **transactional race**.

## Fix applied

1. **Serialize `flush()`** via an internal promise chain (one flush at a time).
2. **Audit insert** uses `create` with **P2002 treated as success** (idempotent append).
3. **Coordination idempotency** via `x-idempotency-key` / `idempotency_key` + durable
   `putIdempotent` so network retries after commit do not double-write.

## Correct reliability target

Not: “50 simultaneous 200s.”

Yes: **50 logical ops → 50 known final states, 0 silent losses, 0 duplicate durable effects**
under bounded concurrency + finite retries for true transients.
