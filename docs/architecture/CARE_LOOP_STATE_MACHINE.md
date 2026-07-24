# Care Loop State Machine

Conceptual states (not all exposed in UI):

| State | Meaning |
|-------|---------|
| ANSWERED | Known answer; no collab needed |
| MISSING_INFORMATION | Truth gap detected |
| CLARIFICATION_PROPOSED | Relay offered to ask someone |
| CLARIFICATION_SENT | Request persisted + notification |
| WAITING_FOR_RESPONSE | Open loop on target human |
| RESPONSE_RECEIVED | Human replied |
| NEEDS_VERIFICATION | Candidate requires confirm |
| VERIFICATION_REQUESTED | Explicit verify prompt sent |
| VERIFIED | Human confirmed candidate |
| REJECTED | Candidate declined |
| CARE_TRUTH_UPDATED | MAR / guidance written |
| DOWNSTREAM_UPDATED | Handoff / attention refreshed |
| NOTIFICATIONS_SENT | Affected people notified |
| RESOLVED | Loop closed |

## Transitions (primary path)

```
MISSING → PROPOSED → SENT/WAITING → RESPONSE → NEEDS_VERIFICATION
  → VERIFIED → CARE_TRUTH_UPDATED → DOWNSTREAM → RESOLVED
```

Provider path may skip MAR and write `PROVIDER_GUIDANCE_V1` on confirm.

## Waiting-on query

Relay intents `WAITING_ON` / `OPEN_LOOP_STATUS` read open orchestrations and answer:

“Are we still waiting on anyone?”

without chasing people manually.
