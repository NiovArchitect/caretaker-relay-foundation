# Caretaker Relay — TRL Card

**Living engineering artifact.** Do not fabricate results.  
**Last updated:** 2026-07-22  
**Product version:** `caretaker-relay@0.1.0`  
**Foundation package version:** `caretaker-relay-foundation@0.1.0` / `@caretaker-relay/care-domain@0.1.0`

---

## TECHNOLOGY

**Caretaker Relay** — voice-first care coordination companion for family and professional caregivers (ACL Caregiver AI Challenge Track 1).

## SYSTEM READINESS

| Field | Value |
| --- | --- |
| **Current defensible TRL (overall caregiver system)** | **TRL 3 (partial → approaching solid TRL 3)** |
| Overclaim guard | Not TRL 4 for the full system |
| Least-mature critical path | Live Postgres/API process wiring; live STT; real caregiver validation |

**Rationale:** Prototype-caliber care domain, interfaces, dataflow, unit/integration tests, docs, versioning, and safety gates exist. The care application **calls** `@caretaker-relay/care-domain` inside `caretaker-relay-foundation`. Persistence is an in-process CareStore that **maps to** Foundation primitives but is **not yet** the full Prisma/Entity/AuditEvent production path. That limits overall system TRL even when inherited Foundation components are more mature.

## SOURCE SUBSTRATE

| Field | Value |
| --- | --- |
| Authoritative Foundation repo (origin) | `niov-foundation` |
| Source SHA | `afe1491d882cbca4b0ce95db6f85ec0ad85dd16f` |
| Active substrate repo | `caretaker-relay-foundation` |
| Product isolation | `PRODUCT_ID=caretaker-relay`; no Otzar shared tenants/DB/secrets |

## VERSION

| Artifact | Version / pin |
| --- | --- |
| Caretaker Relay app | `0.1.0` |
| Caretaker Relay Foundation | `0.1.0` |
| Care domain package | `0.1.0` |
| Golden dataset | `1.0.0` (synthetic) |
| Foundation origin SHA | `afe1491d882cbca4b0ce95db6f85ec0ad85dd16f` |

## SYSTEM COMPONENTS

| Component | Maturity | Current TRL | Inherited/new | Verification | Limitation |
| --- | --- | --- | --- | --- | --- |
| Foundation clone / product identity | High substrate inheritance | N/A (infra) | Inherited + isolated | Isolation tests | Not the caregiver app itself |
| Care domain model | Prototype solid | **3** | New | Unit + e2e care tests | In-memory store, not Prisma yet |
| Care API boundary (package) | Prototype solid | **3** | New | App wiring tests | HTTP routes not yet registered on Fastify |
| Understand (fixture) | Lab-ready | **3** (lab) | New | Golden + loop tests | Explicit FIXTURE mode — not production LLM |
| Understand (LLM abstraction) | Wired | **2–3** | Reuses Foundation LLMProvider shape | Scripted provider test | No CI live Anthropic/OpenAI for care extraction yet |
| Auth care context | Prototype | **3** | New (maps to Session/Entity) | Access tests | Lab session IDs, not full JWT session service |
| Access / consent isolation | Prototype solid | **3** | New on Permission/Consent concepts | Access suite | Not TAR/ABAC full engine |
| Medication safety gate | Prototype solid | **3** | New | Discrepancy + refusal tests | Lab schedules only |
| Handoff continuity | Prototype solid | **3** | New on Handoff primitive map | Handoff tests | In-memory continuity |
| Correction / provenance | Prototype solid | **3** | New on audit/correction map | Correction tests | Not chain-hash AuditEvent yet |
| FHIR mapping | Design + unit map | **3** (mapping only) | New | FHIR stub tests | **Not** EMR integration |
| Four-surface UI shell | Prototype | **2–3** | New | Manual + build | Presentation still partly DEMO_ONLY seeds |
| Voice STT/TTS | Not productized for care | **1–2** | Inherited capability exists | — | Not wired in care loop |
| Caregiver validation | None yet | **n/a** | — | — | No real caregiver study |

## DATA

| Dataset | Source | Version | Assumptions | Representative? | Known gaps |
| --- | --- | --- | --- | --- | --- |
| Olivia controlled scenario | Synthetic lab | scenario seed | One household, English-primary | Lab-representative only | Not real PHI; not multi-site |
| Golden caregiver dataset | Synthetic | `1.0.0` | 20 cases; hidden oracle | Diverse **synthetic** speech patterns | Multilingual partial; no real accents/audio |
| Authorized med schedule | Synthetic Dr. Shah instruction | lab | 2.5 mg lunch | Lab only | No eRx feed |

**All current care datasets are synthetic.** No caregiver-validated field data claimed.

## AI / MODEL

| Field | Value |
| --- | --- |
| Abstraction | Foundation-compatible `LLMProvider` (`generateResponse`) |
| Intended role | Structured **candidate** extraction only |
| Prohibited role | Diagnosis, prescribing, autonomous clinical decisions, fabricating protocols |
| Default lab path | Fixture extractor — **EvidenceMode: FIXTURE** |
| LLM path | Injected provider — **EvidenceMode: LIVE_FOUNDATION_BACKED** when used |
| Known uncertainty | Soft observations, ambiguous times, multilingual |
| Failure modes | Provider outage → uncertain note; invalid JSON → uncertain note; injection → refusal |

## INTENDED USE

Direct support for caregivers coordinating home/community care: capture updates, verify, organize tasks/appointments/handoffs, preserve provenance, respect access boundaries.

## NOT INTENDED FOR

- Diagnosis  
- Treatment selection  
- Prescribing  
- Autonomous clinical decisions  
- Replacement of emergency services  
- Replacement of professional medical judgment  
- AI companionship as the answer to caregiver burden  

## HUMAN-IN-LOOP

| Class | Confirmation |
| --- | --- |
| LOW | May proceed after understand (still auditable) |
| MODERATE | Policy requires confirmation (family updates, schedule, tasks) |
| HIGH | **Mandatory** human verification (meds, discrepancy, clinical share, emergencies) |

Always offers correction/override. Model never executes consequential actions directly.

## PRIVACY

| Control | Status |
| --- | --- |
| Household isolation | Implemented in care store access checks |
| Relationship + consent | Implemented (active/revoked) |
| Who can see what semantic model | Implemented (`whoCanSeeWhat`) |
| Cross-household denial | Tested |
| Revoked access denial | Tested |
| Care recipient as controlling subject | Modeled; full legal UX incomplete |
| Data portability export API | Documented intent; not fully implemented |
| Encryption / separate secrets | Product isolation policy; deploy hardening ongoing |

## METRICS

**Measured values only (lab):**

| Metric | Value | Classification |
| --- | --- | --- |
| Steps to record update (lab path) | 3 (input → verify → confirm) | LAB_MEASUREMENT |
| Manual messages avoided (canonical demo) | ≥1 (Maya update prepared) | LAB_MEASUREMENT |
| Tasks/events organized after verify | ≥4 events + handoff | LAB_MEASUREMENT |
| Care e2e unit tests (foundation) | 25 passing | LAB |
| App wiring + loop tests | 9 passing | LAB |
| Golden cases | 20 synthetic | LAB |
| Caregiver-validated burden reduction | **Not measured** | — |

## RISKS

See `docs/CARETAKER_RELAY_RISK_REGISTER.md`.

## KNOWN EDGE CASES

- “Maya” false-positive on uncertain appointment language (mitigated with word boundaries)  
- Multilingual inputs may be partial under fixture path  
- Pronoun resolution depends on authenticated care context  
- Negated medication statements must not create MAR=given  
- Uncertain appointment changes must not become schedule truth  

## LIMITATIONS

1. CareStore is in-process memory, not Postgres-backed Entity/MemoryCapsule.  
2. Care HTTP routes not yet mounted on Foundation Fastify `buildApp`.  
3. No live voice STT in the care loop.  
4. No real caregiver or care-recipient validation studies.  
5. FHIR is a mapping boundary, not an integrated EMR.  
6. Fixture understand is not the production intelligence path.  

## V&V STATUS

| Area | Status |
| --- | --- |
| Unit / integration (care domain) | **Pass** (25 tests) |
| App → foundation wiring | **Pass** (3 tests) |
| Legacy understand-loop tests | **Pass** (5 tests) |
| Product isolation | **Pass** |
| Hidden-oracle golden | Partial (canonical + metamorphic + adversarial) |
| Real-LLM care fixtures | Not yet recorded for care extraction |
| Human subject evaluation | Not started |

## NEXT GATE

To **declare solid TRL 3 complete** for Caretaker Relay as a caregiver system:

1. Register care routes on Foundation API + authenticated session  
2. Optional Prisma/adapter persistence preserving CareStore interface  
3. Expand golden + metamorphic suite CI gate  
4. Complete TRL 3 criterion checklist sign-off (see Phase 1 evidence)  

To **approach TRL 4** for selected components (not whole system):

1. Controlled multi-actor day-of-care scenario with application metrics  
2. Representative (still synthetic or consented) multi-turn data  
3. Privacy/security review note  
4. Explicit limitations published with metrics  

---

*This card is an exhibit candidate for the ACL Phase 1 application. Update after every material slice.*
