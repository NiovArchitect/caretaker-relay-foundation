# Care Orchestration Engine

## Purpose

Relay coordinates care around a recipient. It is not only Q&A.

```
Question / observation
  → current truth
  → missing information
  → best human contact
  → collaborate (clarification)
  → human response (evidence)
  → structured candidate
  → verification when consequential
  → governed care truth
  → downstream (handoff, attention, notifications)
  → closed loop
```

## System of record

- `CARE_ORCH_V1:` CareUpdate rows — orchestration state
- `CARE_CAND_V1:` CareUpdate rows — interpreted candidates
- `CLARIFY_REQ_V1:` / `CLARIFY_RESP_V1:` — human communications
- `CARE_NOTIF_V1:` — durable notifications
- MedicationAdministrationRecord — confirmed MAR only after verify
- `PROVIDER_GUIDANCE_V1:` — professional guidance after acceptance

Browser localStorage is never authority.

## Module

`packages/care-domain/src/services/orchestration.ts`

Key APIs:

- `startClarificationOrchestration`
- `advanceOrchestrationOnResponse`
- `confirmCandidate` / `rejectCandidate`
- `summarizeOpenLoops`
- `selectBestContact`
- `listProviderGuidance`

HTTP:

- `POST /api/v1/care/clarifications` → starts orchestration
- `POST /api/v1/care/clarifications/respond` → candidate + notify
- `POST /api/v1/care/orchestration/candidates/:id/action`
- `GET /api/v1/care/recipients/:id/orchestration`

## Authority rules

| Source | Authority | Auto care truth? |
|--------|-----------|------------------|
| Family/caregiver reply | caregiver_reported | No — needs verification for MAR |
| Physician reply | professional | Stored as guidance after accept; not silent regimen rewrite |
| Confirmed MAR | CONFIRMED | Yes after human confirm |

## Non-goals

- No autonomous clinical decisions
- No emergency triage invention
- No external SMS/email faking
- No over-orchestration of simple known answers
