# Care Data Pipeline End-to-End Audit

## Pipeline principle

```text
RAW HUMAN INPUT
  → IMMUTABLE / DURABLE EVIDENCE
  → STRUCTURED CANDIDATE
  → AUTHORITY / VERIFICATION
  → CURRENT CARE TRUTH
  → PROJECTIONS
  → RELAY / NOTIFICATIONS / HANDOFF / DOCUMENTS
```

Relay answers are **not** care truth. Coordination is **not** automatic current truth.

## Source type matrix

| Origin | Raw evidence | Structured derivation | Authority | Promotion | Downstream |
|--------|--------------|----------------------|-----------|-----------|------------|
| Family observation | CareUpdate / CareEvent | understand candidate | REPORTED | confirm if consequential | Today, Relay, handoff |
| DSP observation | same | same | REPORTED | same | same |
| Caregiver coordination | encodeCoordinationUpdate | message + notif | human message | never auto-truth | notifications |
| Clarification response | CLARIFY_RESP_V1 | OrchCareCandidate | caregiver_reported / professional | confirmCandidate | MAR / PROVIDER_GUIDANCE_V1 |
| Medication admin | MedicationAdministrationRecord | dose compare | CONFIRMED after verify | addMedRecord | reminders resolve, projections |
| Provider instruction | schedule.source | CURRENT_MEDICATIONS | professional | schedule upsert | med due, Relay |
| Appointment | CareAppointment | reminders | CONFIRMED | reschedule | reminders supersede |
| Correction | Correction rows | supersede prior | CONFIRMED | supersedeEvent | projections |
| Notification | CARE_NOTIF_V1 | state machine | private to principal | seen/ack/resolve | Today inbox |
| Document | CARE_DOC_V1 | freshness | prepared | mark stale on truth change | Documents UI |
| Handoff | CareHandoff | whatChanged | fixture/reported | refresh on confirm | Handoff page |
| Relay turn | RELAY_TURN_V1 | conversation only | private | never truth | memory only |

## Proven loops

1. **Daniel observation → Marcus notif** (coordination write + notification)
2. **Marcus ask Maya → response → candidate → verify → MAR → Relay answer changes**
3. **Marcus ask provider → Shah respond → guidance confirm → handoff/doc refresh**
4. **Appointment reschedule → old reminders superseded → new leave-by**

## Invariants

- Original human text preserved on candidates (`originalEvidence`) and MAR `source.rawExcerpt`
- Epistemic labels: REPORTED / CONFIRMED / UNCERTAIN / SUPERSEDED
- Cross-tenant: relationships scoped by careRecipientId + organizationId
