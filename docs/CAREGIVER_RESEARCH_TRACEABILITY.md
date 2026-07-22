# Caregiver Research Traceability

ACL judging assesses whether design decisions trace to caregiver needs.  
**Hard rule: Do not claim caregiver validation unless a real caregiver produced it.**

**Last updated:** 2026-07-22

## Status tags (required)

| Tag | Meaning |
| --- | --- |
| `[CHALLENGE REQUIREMENT]` | From ACL Caregiver AI Challenge principles/materials |
| `[FOUNDER HYPOTHESIS]` | Internal design assumption, not caregiver-validated |
| `[LITERATURE / EXTERNAL EVIDENCE]` | Published research or external evidence (cite) |
| `[CAREGIVER INPUT]` | Real caregiver contribution |
| `[CARE RECIPIENT INPUT]` | Real care recipient contribution |
| `[LAB RESULT]` | Measured in controlled lab/synthetic scenario |
| `[VALIDATED]` | Confirmed with appropriate real participants |

## Decision log

| Caregiver need | Tag(s) | Observation | Design decision | Implementation | Test | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Reduce cognitive load while multitasking | `[FOUNDER HYPOTHESIS]` | Caregivers often one-handed / interrupted | Four surfaces; Today in seconds | App shell Today | Kitchen comprehension (planned) | Not caregiver-validated |
| Hate re-explaining the day | `[FOUNDER HYPOTHESIS]` `[CHALLENGE REQUIREMENT]` | Handoffs incomplete | Signature handoff | CareLoopService handoff + panel | Handoff continuity lab | Lab only |
| Fear of wrong med documentation | `[FOUNDER HYPOTHESIS]` `[CHALLENGE REQUIREMENT]` | Dose conflicts happen | Never auto-resolve meds; show source | Med discrepancy + safety review | Med safety tests | Lab only |
| Distrust of black-box AI | `[CHALLENGE REQUIREMENT]` | Users need control | Verify before consequential act | I got this / Looks right | Loop e2e | Challenge-aligned; not interview |
| Voice while hands busy | `[CHALLENGE REQUIREMENT]` | Hands full in kitchen | Voice-first composer same as text | Composer mic affordance | Voice STT not live | Challenge framing |
| Privacy, dignity, choice | `[CHALLENGE REQUIREMENT]` | Sensitive care data | Household isolation; who can see what | access.ts + tests | Access suite | Lab only |
| Care recipient control of data | `[CHALLENGE REQUIREMENT]` | Controlling subject | Recipient self-access; consent records | evaluateAccess self path | Partial | Not full legal UX |
| Human override / accountability | `[CHALLENGE REQUIREMENT]` | AI must not act alone | Risk-based HITL | safety.ts + confirm | High/moderate gates | Lab only |
| Reduce caregiver burden | `[CHALLENGE REQUIREMENT]` `[FOUNDER HYPOTHESIS]` | Coordination tax is high | Automate organize/handoff after verify | BurdenMetrics lab | steps=3 lab | **Not** caregiver-validated result |
| Supplement not replace human connection | `[CHALLENGE REQUIREMENT]` | Risk of AI companionship framing | Coordinate, don’t companion | Product contract + docs | Traceability review | Doctrine |
| Personalized flexible care | `[CHALLENGE REQUIREMENT]` | One size fails | Safe preference primitives only | CarePreferences type | Partial | Not learned traits |
| Safety reliability transparency | `[CHALLENGE REQUIREMENT]` | Errors harm | Uncertainty, sources, audit | EpistemicStatus + audit | Multiple tests | Lab only |
| Avoid biased/harmful behavior | `[CHALLENGE REQUIREMENT]` | Unequal performance risk | Bias doc; refusal; no fairness claim | BIAS_AND_REPRESENTATION.md | Synthetic only | Not proven fair |
| Affordability and access | `[CHALLENGE REQUIREMENT]` | Specialized hardware excludes | Phone/browser first | AFFORDABILITY_ACCESS.md | Architecture | No pricing claimed |
| Active caregiver involvement in design | `[CHALLENGE REQUIREMENT]` | Required for Track 1 credibility | Traceability tags block false validation | This document | Process | **No caregiver sessions yet** |
| Real-world usability | `[CHALLENGE REQUIREMENT]` | Lab ≠ field | TRL card separates lab vs validated | TRL card metrics | — | Not field-tested |
| Foundation-backed loop (engineering) | `[LAB RESULT]` | Prior state was UI-only | Care domain in foundation | @caretaker-relay/care-domain | 25+9 tests | Lab engineering result |
| Protocol 9-Delta refusal | `[CHALLENGE REQUIREMENT]` `[LAB RESULT]` | Hallucination exhibit | Refuse unknown protocol | safety.ts | adversarial tests | Lab |

## ACL principle → evidence matrix (summary)

| # | Principle | Evidence in product | Tag honesty |
| --- | --- | --- | --- |
| 1 | Privacy, dignity, choice | Access model, revoke, household fence | Challenge + lab |
| 2 | Care recipient control | Self-access; consent records | Partial implementation |
| 3 | Limits on collection/use/visibility | Categories + actions on relationships | Lab |
| 4 | Data portability | Documents surface + affordability doc intent | **Gap** (export API) |
| 5 | Human-in-the-loop | Verify panel; high/moderate gates | Lab |
| 6 | Caregiver verification/override | Looks right / Correct; correction service | Lab |
| 7 | Reduce burden | BurdenMetrics LAB only | **Not validated** |
| 8 | Fit daily care | Canonical day scenario Olivia | Synthetic |
| 9 | Supplement human connection | Doctrine; handoff frees time | Doctrine |
| 10 | Personalized flexible | Preferences primitives | Limited |
| 11 | Safety reliability transparency | Epistemic status, sources, audit | Lab |
| 12 | Avoid bias/harm | Bias doc; refusals | Not proven |
| 13 | Evidence/best practice | MLTRL TRL card; risk register | Engineering |
| 14 | Affordability/access | Architecture choices documented | No pricing |
| 15 | Caregiver involvement in design | Traceability process | **Sessions not yet run** |
| 16 | Real-world usability | Explicit non-claim until field | Gap |

## Process

For every major UX/product change, add a row with honest tags.  
If no caregiver input exists, use `[FOUNDER HYPOTHESIS]` or `[CHALLENGE REQUIREMENT]` — never `[VALIDATED]` or `[CAREGIVER INPUT]`.
