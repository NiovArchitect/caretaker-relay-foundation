# Hang diagnostic + resolution (2026-07-22)

## Snapshot while “10+ minute” runner was active (~12:02–12:11 local)

| Question | Finding |
| --- | --- |
| **Last completed CR-STRESS ID (observable)** | Could **not** be known at hang time — **no per-scenario progress log existed** |
| **Current CR-STRESS ID** | Unknown at hang time; later evidence: Maya **revoked** at `19:04:39Z` ⇒ **CR-STRESS-012 completed** early in that run (~2 min after start) |
| **Elapsed for current scenario** | Unknown without progress log |
| **Stdout advancing?** | **No useful advance** — only Vitest `RUN` header (buffered through `tee \| tail`) |
| **DB healthy?** | **Yes** — `pg_isready` OK |
| **API/Vite ports?** | **3100/5180 free** (inject-only suite; not listening servers) |
| **Waiting on request timeout?** | **No** single HTTP hang; process mostly `kevent` wait with **12–66% CPU** |
| **DB lock?** | **`idle in transaction`** on `cr_care_audits` SELECT (ClientRead) — long multi-statement flush transaction, not a blocked lock wait |
| **Vitest open handle?** | Worker alive ~8–9 min; **not** stuck in afterAll |
| **Cleanup wait?** | **No** |
| **Maya restoration completed?** | **No for that run’s mid-state** — consent **revoked** (expected after 012). Prior `beforeAll` double-rebuild was inefficient; SQL restore outside harness was a smell |

### Table sizes at hang

- ~**790** `cr_care_audits`, ~**220** `cr_care_events`

### Event counts over 15s (during hang investigation)

- events 220 stable; audits 791→792 → **very slow forward progress**, not hard deadlock

---

## Why timeout went 240_000 → 420_000 (and 300_000 → 600_000)

| Option | Verdict |
| --- | --- |
| **A. Scenario legitimately needs longer** | **No** for identity/med blocks (~1–8s/scenario after fix). Restart blocks were expensive due to architecture, not “business logic needs 7 minutes”. |
| **B. Suite inefficient** | **YES — primary.** Every `confirm` flushed **all** audit rows (O(n) upserts). Growing lab DB + full `buildCareApp` reloads ×2 in `beforeAll` + restarts 049/050 amplified cost. |
| **C. Unbounded/hanging operation** | **Partially.** Not infinite loop; **bounded but O(n²) wall time** as audits accumulate. `idle in transaction` during bulk flush. |
| **D. Timeout increase merely masks a bug** | **YES.** Raising 240→420 (and 300→600) **masked flush inefficiency**, did not fix root cause. |

---

## Root-cause fixes applied

1. **PrismaCareStore flush**: skip already-persisted **append-only audits** and unchanged idempotency keys (`knownAuditIds` / `knownIdempotencyKeys`) — O(delta) instead of O(all audits) per confirm.
2. **Harness SETUP/RESET**:
   - `ensureMayaActive` / `ensureMayaRevoked` via **in-memory store + flush** (no double `buildCareApp` for Maya).
   - Seed no longer re-activates revoked Maya consent (product safety).
   - `afterAll` restores Maya active.
3. **Progress**: `PROGRESS.jsonl` + console `[stress]` lines per scenario with **elapsed ms**.
4. **Timeouts rolled back** toward finite values (med 180s, correction 240s) after efficiency fix.
5. **Terminated** hung finite runner cleanly; preserved this diagnostic.

---

## Proof after fix

| Run | Result |
| --- | --- |
| Narrow `identity/tenant\|medication red` | **PASS** in ~**70s**; 001–038 visible in PROGRESS |
| Full suite 001–068 | **PASS** in ~**147s** (5 vitest blocks); EXIT 0 |
| Maya after afterAll | **active** |
| Ports 3100/5180 | free |

### Harness contract now

```
SETUP/RESET known principal state (ensureMayaActive/Revoked)
→ RUN scenario
→ ASSERT + log progress
→ CLEANUP (afterAll: Maya active)
```

No manual SQL required between runs for Maya baseline.
