# Caretaker Relay — Risk Register

**Risk is first-class.**  
**Last updated:** 2026-07-22  
**Scoring:** Risk score = Probability (1–5) × Severity (1–5). Scale: 1–25.

| Score | Band |
| --- | --- |
| 1–6 | Low |
| 7–12 | Medium |
| 13–19 | High |
| 20–25 | Critical |

Residual risk is after mitigations **currently implemented**.

---

## Register

### R01 — Wrong care recipient

| Field | Content |
| --- | --- |
| CAUSE | Ambiguous pronouns; multi-recipient households; model guess |
| IMPACT | Care data filed to wrong person; safety/privacy harm |
| DETECTION | Context binding tests; recipient id checks |
| MITIGATION | Authenticated care context binds recipient; never free-form recipient invent |
| HUMAN GATE | Verify panel shows “For {name}” |
| TEST | `care-loop.e2e` correct recipient; app wiring |
| P×S | 2×5 = **10** → residual **6** |

### R02 — Cross-household leakage

| Field | Content |
| --- | --- |
| CAUSE | Missing household fence on queries |
| IMPACT | PHI/PII across families |
| DETECTION | Access suite household mismatch |
| MITIGATION | `householdId` checks on access + events |
| HUMAN GATE | n/a (hard deny) |
| TEST | `blocks cross-household access` |
| P×S | 2×5 = **10** → residual **4** |

### R03 — Unauthorized access

| Field | Content |
| --- | --- |
| CAUSE | No relationship/consent |
| IMPACT | Unauthorized view/update |
| DETECTION | Access denials audited |
| MITIGATION | `evaluateAccess` relationship required |
| HUMAN GATE | n/a |
| TEST | unauthorized family member |
| P×S | 3×5 = **15** → residual **6** |

### R04 — Revoked access still functioning

| Field | Content |
| --- | --- |
| CAUSE | Stale grants; cache; missing revoke path |
| IMPACT | Continued access after revocation |
| DETECTION | Revoke then propose |
| MITIGATION | Relationship + consent status `revoked` |
| HUMAN GATE | Care recipient/admin revoke |
| TEST | `revoked access no longer functions` |
| P×S | 3×5 = **15** → residual **6** |

### R05 — Hallucinated care event

| Field | Content |
| --- | --- |
| CAUSE | LLM over-extraction; filler misread |
| IMPACT | False care history |
| DETECTION | Golden filler case; metamorphic |
| MITIGATION | Candidates only; human confirm; fixture/LLM uncertainty |
| HUMAN GATE | Verify before persist |
| TEST | filler; golden cases |
| P×S | 3×4 = **12** → residual **8** |

### R06 — Fabricated clinical instruction

| Field | Content |
| --- | --- |
| CAUSE | Prompt injection; unknown protocol request |
| IMPACT | Dangerous invented care protocol |
| DETECTION | Protocol 9-Delta exhibit |
| MITIGATION | Refuse unknown protocols; no invent |
| HUMAN GATE | Require real document/source |
| TEST | Protocol 9-Delta; injection |
| P×S | 2×5 = **10** → residual **4** |

### R07 — Medication ambiguity

| Field | Content |
| --- | --- |
| CAUSE | Missing dose; ambiguous units |
| IMPACT | Wrong MAR |
| DETECTION | Dose parse; discrepancy path |
| MITIGATION | High class; confirm; no silent invent of dose |
| HUMAN GATE | Required for med events |
| TEST | med admin path |
| P×S | 3×5 = **15** → residual **9** |

### R08 — Duplicated medication administration

| Field | Content |
| --- | --- |
| CAUSE | Retries; double submit; partial execution |
| IMPACT | Double-documented dose |
| DETECTION | `detectDuplicateMedication` helper (partial) |
| MITIGATION | Human confirm; future idempotency keys |
| HUMAN GATE | Yes |
| TEST | Partial — residual high |
| P×S | 3×5 = **15** → residual **12** |

### R09 — Stale medication instruction

| Field | Content |
| --- | --- |
| CAUSE | Old authorized dose supersedes new |
| IMPACT | Wrong authorized comparison |
| DETECTION | Source timestamps on schedule |
| MITIGATION | Source-bound schedule; correction path |
| HUMAN GATE | Clinician/source update |
| TEST | Lab single schedule only |
| P×S | 3×5 = **15** → residual **12** |

### R10 — Appointment time/date error

| Field | Content |
| --- | --- |
| CAUSE | Ambiguous speech; partial parse |
| IMPACT | Missed care visit |
| DETECTION | Uncertain epistemic status |
| MITIGATION | Uncertain appointments not promoted to schedule truth |
| HUMAN GATE | Confirm before schedule update |
| TEST | might vs moved metamorphic |
| P×S | 3×4 = **12** → residual **8** |

### R11 — Timezone error

| Field | Content |
| --- | --- |
| CAUSE | Local labels vs UTC |
| IMPACT | Wrong appointment time |
| DETECTION | Not fully instrumented |
| MITIGATION | Labels + ISO fields; needs TZ policy |
| HUMAN GATE | Confirm times |
| TEST | Gap |
| P×S | 3×4 = **12** → residual **12** |

### R12 — Incorrect handoff

| Field | Content |
| --- | --- |
| CAUSE | Wrong recipient; incomplete whatChanged |
| IMPACT | Next caregiver misinformed |
| DETECTION | Handoff tests |
| MITIGATION | Built from confirmed candidates + sources |
| HUMAN GATE | Review handoff |
| TEST | handoff continuity |
| P×S | 3×4 = **12** → residual **8** |

### R13 — Correction not propagating

| Field | Content |
| --- | --- |
| CAUSE | UI state vs store divergence |
| IMPACT | Stale truth continues |
| DETECTION | Correction tests; SUPERSEDED filter |
| MITIGATION | Supersede prior; preserve evidence; audit |
| HUMAN GATE | Correction flow |
| TEST | correction suite |
| P×S | 2×4 = **8** → residual **5** |

### R14 — Old information superseding current

| Field | Content |
| --- | --- |
| CAUSE | Replay; unordered events |
| IMPACT | Current state wrong |
| DETECTION | Epistemic SUPERSEDED |
| MITIGATION | Current state filters superseded |
| HUMAN GATE | Correction |
| TEST | correction current-state |
| P×S | 2×4 = **8** → residual **5** |

### R15 — Weak evidence as certainty

| Field | Content |
| --- | --- |
| CAUSE | Flattening REPORTED → clinical fact |
| IMPACT | Overconfidence; clinical misuse |
| DETECTION | Observation epistemic asserts |
| MITIGATION | EpistemicStatus enum; soft language retained |
| HUMAN GATE | Verify labels status |
| TEST | observation remains REPORTED |
| P×S | 3×4 = **12** → residual **6** |

### R16 — Model/provider outage

| Field | Content |
| --- | --- |
| CAUSE | LLM provider down |
| IMPACT | Care update path fails |
| DETECTION | LLMResult ok:false |
| MITIGATION | Fail to uncertain note; Foundation circuit breaker available when wired live |
| HUMAN GATE | Manual note |
| TEST | scripted provider path |
| P×S | 3×3 = **9** → residual **7** |

### R17 — Partial provider execution

| Field | Content |
| --- | --- |
| CAUSE | Incomplete multi-effect persist |
| IMPACT | Half-applied care state |
| DETECTION | Audit of persisted ids |
| MITIGATION | Single confirm transaction in memory store; DB transactions future |
| HUMAN GATE | Review current state |
| TEST | Partial |
| P×S | 2×4 = **8** → residual **7** |

### R18 — Retries causing duplicate action

| Field | Content |
| --- | --- |
| CAUSE | Double-click confirm; network retry |
| IMPACT | Duplicate events/messages |
| DETECTION | Not fully guarded |
| MITIGATION | Future idempotency; UI busy flag partial |
| HUMAN GATE | Yes |
| TEST | Gap (UI busy only) |
| P×S | 3×3 = **9** → residual **9** |

### R19 — Voice transcription error

| Field | Content |
| --- | --- |
| CAUSE | STT errors (not live yet) |
| IMPACT | Wrong content understood |
| DETECTION | Future STT evals |
| MITIGATION | Text confirm path; not wired STT |
| HUMAN GATE | Always verify |
| TEST | n/a live |
| P×S | 4×4 = **16** → residual **16** (when STT enabled) |

### R20 — Language translation error

| Field | Content |
| --- | --- |
| CAUSE | Multilingual partial support |
| IMPACT | Missed/wrong events |
| DETECTION | Golden multilingual case |
| MITIGATION | Uncertainty; localization-ready design |
| HUMAN GATE | Confirm |
| TEST | g-013 partial |
| P×S | 3×4 = **12** → residual **11** |

### R21 — Caregiver misunderstanding

| Field | Content |
| --- | --- |
| CAUSE | Unclear verify UX |
| IMPACT | Confirming wrong content |
| DETECTION | Future usability tests |
| MITIGATION | Plain language verify; correction |
| HUMAN GATE | Looks right / Correct |
| TEST | No caregiver study yet |
| P×S | 3×4 = **12** → residual **12** |

### R22 — Over-reliance on AI

| Field | Content |
| --- | --- |
| CAUSE | Product framing as autonomous |
| IMPACT | Skipped human judgment |
| DETECTION | Product contract reviews |
| MITIGATION | Human-in-loop; not clinician; no companionship default |
| HUMAN GATE | Always for moderate/high |
| TEST | Policy docs + tests |
| P×S | 3×4 = **12** → residual **8** |

### R23 — Hidden bias

| Field | Content |
| --- | --- |
| CAUSE | Dataset/model skew (age, language, literacy, accent) |
| IMPACT | Unequal quality of care coordination |
| DETECTION | Bias doc; synthetic diversity limited |
| MITIGATION | Document gaps; future participant eval |
| HUMAN GATE | Override always |
| TEST | See BIAS_AND_REPRESENTATION.md |
| P×S | 3×4 = **12** → residual **12** |

### R24 — Data portability failure

| Field | Content |
| --- | --- |
| CAUSE | Export not implemented |
| IMPACT | Lock-in; ACL principle gap |
| DETECTION | Feature gap |
| MITIGATION | Documented requirement; Documents surface placeholder |
| HUMAN GATE | n/a |
| TEST | Gap |
| P×S | 4×3 = **12** → residual **12** |

### R25 — Deletion/revocation failure

| Field | Content |
| --- | --- |
| CAUSE | Incomplete delete paths |
| IMPACT | Data remains after revoke request |
| DETECTION | Revoke access tested; full deletion not |
| MITIGATION | Revoke access works; hard-delete policy TBD |
| HUMAN GATE | Admin/recipient |
| TEST | revoke access (not full erasure) |
| P×S | 3×4 = **12** → residual **10** |

---

## Open high residual risks (priority)

1. Voice transcription (when enabled) — R19  
2. Duplicate medication / retries — R08, R18  
3. Stale med instructions — R09  
4. Timezone policy — R11  
5. Caregiver misunderstanding without usability study — R21  
6. Data portability — R24  
7. Bias evaluation with real participants — R23  
