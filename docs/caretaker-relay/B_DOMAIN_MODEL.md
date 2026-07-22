# B. Caretaker Relay Domain Model

## North star

A voice-first **care coordination companion** — not a medical chatbot, not a generic dashboard.

Identity is **care** (meals, transport, routines, companionship, meds, appointments, handoffs), not “health app” alone.

## Core concepts

| Concept | Definition |
| --- | --- |
| Care Recipient | Person receiving support (e.g. Olivia) |
| Caregiver | Family or informal caregiver (e.g. Sadeil, Maya) |
| Care Circle | People + orgs involved in care |
| Care Plan | Living plan of support (not EHR dump as UI) |
| Care Task | Action someone should take |
| Care Event | Something that happened in care |
| Observation | Noted condition/behavior (e.g. fatigue) |
| Appointment | Scheduled care/health activity |
| Medication Schedule | Authorized schedule + dose (source-bound) |
| Medication Administration Record | Caregiver-confirmed administration |
| Care Instruction | Instruction with provenance |
| Care Handoff | Structured shift/person transition |
| Care Update | Message/update to circle member |
| Consent | Permission for access |
| Access Relationship | Role + allowed info/actions (≠ family hierarchy) |
| Provider/Professional | Clinician or paid professional |
| Care Organization | Household, agency, home health, clinic |
| Care Summary | Period summary for continuity |
| Source | Provenance of an assertion |
| Correction | First-class fix preserving prior evidence |
| Safety Review | Human verification for higher-risk actions |

## Relationship model

A care recipient may be linked to spouse, parent, adult child, sibling, friend, neighbor, paid caregiver, DSP, nurse, physician, therapist, care coordinator, agency, home health org.

Each relationship has: role, responsibility, allowed information, allowed actions, start/end, tasks, schedules, contact preference, escalation ability, authority limits.

**Family hierarchy ≠ authority.**

## Safety classes

| Class | Examples | Default |
| --- | --- | --- |
| Low | Summaries, organize notes, ordinary household task complete | May auto-execute |
| Moderate | Family update, appointment reschedule, routine plan update | Confirm by policy |
| High | Med discrepancy, health-data sharing, provider comms, care-plan change, emergency | Explicit human verification |

## Medication safety (hard rules)

May: store authorized schedule, remind, record confirmed admin, flag contradictions, show source, request verification.  
Must not: recommend dosage, infer dose changes, resolve conflicting med instructions, generate treatment.

## FHIR boundary (interop only)

Patient, RelatedPerson, Practitioner, CareTeam, CarePlan, Task, Observation, Appointment, MedicationRequest, MedicationAdministration, Communication, Consent, DocumentReference, Provenance.

FHIR is **not** the internal UI model. See `FHIR_CONCEPT_MAP` in `@caretaker-relay/care-domain`.

## TypeScript authority

`packages/care-domain/src/index.ts`
