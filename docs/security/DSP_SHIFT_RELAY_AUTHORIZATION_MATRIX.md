# DSP Shift Relay Authorization Matrix

Live API base: authorization-before-retrieval (`authorizeRelayQuestion` + `resolveShiftRelayAccess`).

## States

| State | Relay answers? | Domains | Notes |
|-------|----------------|---------|-------|
| proposed | No | — | Assignment not issued |
| invited | No | — | INVITED_NOT_ACCEPTED |
| accepted / scheduled (before prep window) | No | — | BEFORE_PRE_SHIFT_WINDOW |
| pre_shift (≤2h before start) | Limited | prep domains | Handoff, schedule, preferences |
| active / ending | Yes | assignment domains | Observations, tasks, handoff, med admin if scoped |
| documentation_window (≤2h after end) | Limited | handoffs, own observations | No general med/status expansion |
| completed / expired / revoked / replaced | No | — | EXPIRED / REVOKED / SHIFT_REPLACED |

Constants: `PRE_SHIFT_WINDOW_MS`, `DOC_WINDOW_MS`, `ENDING_WINDOW_MS` in `shift-relay-access.ts`.

## Tests

`tests/unit/care/relay-dsp-shift-matrix.test.ts`
