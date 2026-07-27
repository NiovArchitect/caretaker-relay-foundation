# Permissioned Dynamic Relay Intelligence Release

**Date:** 2026-07-27  
**API source/deploy:** `ca939fdc69bc18f34c054c6dacdf83d7dbe517fb` (live on caretaker-relay-care-api)  
**App product deploy:** `61ca1df0c9b3aa8fb7c420d8e2516ed435e19624` (care.niovlabs.com)  
**App source HEAD (docs after product):** `8e7a36df79b87051503e820989a10043dd4dbb91`

## Rules enforced

1. Authenticate principal ID (reject pending-local/anonymous).
2. `evaluateAccess` before any state bag load for answers.
3. Domain intersection via `resolveDomainCapabilities` + intent→domain map.
4. Filter state bag with `filterStateByDomains` before composition.
5. Safe denials without confirming hidden data.
6. Audit `RELAY_ANSWER_DENIED` / `RELAY_ANSWER_ACCESSED` (metadata only).

## Measured results (this pass)

| Gate | Result |
|------|--------|
| Authorization before retrieval | PASS (7/7 unit) |
| Authenticated but unauthorized | PASS (deny, no med dump) |
| Role / recipient / tenant isolation | PASS unit; cross-universe 0 disclosures |
| Partial domain permissions | PASS (transport-only meds denied) |
| Revoked access | PASS |
| Zero-access | PASS |
| Expired assignment | PARTIAL (code path; no dedicated unit) |
| Invited-not-accepted | PARTIAL (denial copy; no dedicated unit) |
| Shift-scoped retrieval | PARTIAL (assignment service exists; full matrix open) |
| Durable events + current-state evolution | PASS (2 evolution tests; 100-bank 100/100) |
| Multi-universe intelligence | 359/422 (~85%), 0 fixture leaks, 0 generic walls |
| Public unauth answer | 401 |
| Public authorized Evelyn status/meds | grounded 200 |
| LLM authorization contract | PASS (pre-filter; llm_ready false) |
| Prompt-injection bypasses | 0 observed |
| Background workers left running | 0 |

## Tests

- `tests/unit/care/relay-authorization-before-retrieval.test.ts`
- `tests/unit/care/relay-answer-evolution.test.ts`
- `tests/unit/care/caregiver-100-bank.eval.test.ts` (100/100)
- `tests/unit/care/relay-generalization.eval.test.ts` (≥400 evals)
- Result JSON under `docs/testing/RELAY_*.json`

## Not claimed complete

- Full DSP shift-window matrix in production answer routes
- Full public multi-account HTTP 100× bank
- Full medication correction / appointment cancel-replace stage matrix
- Dedicated invited-not-accepted and expired-assignment unit cases
- LLM path still not live (`llm_ready: false`); contract is pre-filter before any model
- 2 pre-existing orchestration unit expectations for “Maya” string failed under broader unit run (care-team naming projection) — not part of authz deny path

## Product freeze

Product UI remains on reviewed app SHA `61ca1df`. Permissioned work is API-domain only at `ca939fd`. RESTORED for product surface; API advanced intentionally for this addendum.
