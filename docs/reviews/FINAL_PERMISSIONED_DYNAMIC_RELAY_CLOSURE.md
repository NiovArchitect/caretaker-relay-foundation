# Final Permissioned Dynamic Relay Closure

**Date:** 2026-07-27

## Preserved

Authorization-before-retrieval from `ca939fd` remains the gate. This release extends shift windows, invited-not-accepted, correction/appointment awareness, and ≥600 permissioned bank evaluations.

## Hard gates (local)

| Gate | Result |
|------|--------|
| Shift-scoped retrieval | PASS |
| Before / active / post-shift doc window | PASS |
| Expired / invited-not-accepted | PASS |
| Shift evolution | PASS (0 static after change) |
| Medication correction | PASS |
| Appointment cancel/replace | PASS |
| Active revocation | PASS |
| Permission bank | ≥600, 0 unauthorized |
| Maya expectations | RECONCILED (store-derived actor name) |

## Deploy

API source/deploy must match after push of this commit.
App product remains `61ca1df` unless a separate app change is reviewed.

## Freeze

Restore product freeze only when public HTTP bank + deploy parity are confirmed for this commit.
