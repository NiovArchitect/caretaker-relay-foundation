# Permissioned Dynamic Relay Intelligence Release

**Date:** 2026-07-27  
**API:** authorization-before-retrieval on `answerRelayQuestion`

## Rules enforced

1. Authenticate principal ID (reject pending-local/anonymous).
2. `evaluateAccess` before any state bag load for answers.
3. Domain intersection via `resolveDomainCapabilities` + intent→domain map.
4. Filter state bag with `filterStateByDomains` before composition.
5. Safe denials without confirming hidden data.
6. Audit `RELAY_ANSWER_DENIED` / `RELAY_ANSWER_ACCESSED` (metadata only).

## Tests

- `tests/unit/care/relay-authorization-before-retrieval.test.ts`
- `tests/unit/care/relay-answer-evolution.test.ts`
- Existing multi-universe + 100-bank evals still green

## Not claimed complete

- Full DSP shift-window matrix in production routes
- Full public multi-account HTTP 100× bank
- LLM path still fixture mode (`llm_ready: false`); contract is pre-filter before any model
