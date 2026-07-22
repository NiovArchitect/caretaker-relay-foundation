# D. ACL Track 1 Phase 1 — Challenge Criteria Traceability

**Challenge:** 2026 ACL Caregiver AI Challenge, Track 1  
**Phase 1 deadline:** July 31, 2026, 5:00 PM ET  
**TRL target:** ≥ 3 (technical feasibility, not finished consumer product)

Sources: ACL caregiver AI challenge pages (use cases, judging criteria Track 1 Phase 1, definitions/FAQ, competition page).

---

## Responsiveness to Need

| Need | Feature | Evidence | Metric (target) |
| --- | --- | --- | --- |
| Reduce repeated explanations | Care summary + handoff | Olivia scenario handoff | Time to produce handoff ↓ |
| Forgotten tasks | Today “Needs you” | Scenario tasks | Missed tasks ↓ |
| Incomplete handoffs | Care Handoff surface | Demo path | Handoff comprehension score |
| Duplicated work | Shared care picture | Verify loop | Duplicate entries ↓ |
| Missed appointments | Appointment change extract + Today | PT 2:30 move | Appointment accuracy |
| Unclear responsibilities | Care Circle access | Access matrix | Role clarity self-report |
| Reporting burden | Voice/text → structured | Input→Verify | Steps per care update ≤ 3 confirms |
| Cognitive load | 4-surface IA | Kitchen 5-second test | Time to comprehension ≤ 5s |

## User-Centered Design

| Caregiver input status | Design decision | Testing |
| --- | --- | --- |
| Founder hypothesis (marked) | Kitchen / one-hand / tired caregiver | Usability metrics doc |
| Founder hypothesis | Voice-first same context as text | Voice success rate |
| Pending research | Research traceability system | `CAREGIVER_RESEARCH_TRACEABILITY.md` |

Do **not** fabricate caregiver interviews. Mark hypothesis vs research-backed vs user-validated.

## Implementation / Technical viability

| Element | Proof |
| --- | --- |
| Architecture | Foundation clone + care domain + app shell |
| Isolation | `tests/unit/isolation`, separate DB/ports/secrets |
| AI workflow | Input → Understand → Verify → Organize → Relay → Act → Continuity |
| Deployment plan | `render.yaml` caretaker-relay-api (separate) |
| TRL evidence | Working scenario + safety tests + docs |

## Usability and Integration

| Criterion | Product proof |
| --- | --- |
| Error prevention | Safety classes, med discrepancy UI, confirm before consequential |
| Transparency | SourceRef + “Why am I seeing this?” |
| Interoperability | FHIR map boundary (no false live claims) |
| Usability | 4 surfaces, large targets, plain language |

## Caregiver AI Principles

| Principle | Implementation |
| --- | --- |
| Privacy | Consent + access relationship + isolation |
| Human-in-the-loop | Verify step; high-class actions require confirmation |
| Burden reduction | Structured extract from one sentence |
| Human connection | Care Circle + updates to people (not bot replacement) |
| Personalization | Active care recipient context |
| Safety | Med rules, Protocol 9-Delta refusal, safety classes |
| Affordability | Architecture supports low-friction household use (pricing TBD) |

## Partnerships (targets — not fabricated)

| Stakeholder | Role | Status |
| --- | --- | --- |
| Family caregivers | Primary users | Scenario personas |
| Home-care agencies | Professional mode later | Architecture only |
| Area Agencies on Aging | Outreach target | Not claimed |
| Disability orgs | Meritorious later | Not claimed |
| Health systems / FHIR partners | Interop boundary | Map only |
| Assistive tech | Future bridge | Not claimed |

## Meritorious prize alignment (secondary)

Primary: family caregivers.  
Strong secondary: EMR/health interop boundary + multi-org collaboration architecture.  
Do not dilute core product for every prize category.

## Phase 1 judges want

Blueprint · technical viability · safety protocols · actionable AI workflow — not merely a polished shell.  
This matrix + running Olivia loop are the Phase 1 spine.
