# Phase 1 V&V Evidence Snapshot

**Date:** 2026-07-22  
**No inflated claims.**

## Test totals

| Suite | Location | Count | Result |
| --- | --- | --- | --- |
| Care domain e2e / access / med / golden / FHIR / LLM inject | `caretaker-relay-foundation/tests/unit/care/care-loop.e2e.test.ts` | 25 | Pass |
| Product isolation | `caretaker-relay-foundation/tests/unit/isolation/` | 9 | Pass |
| App foundation wiring | `caretaker-relay/tests/foundation-wiring.test.ts` | 3 | Pass |
| App understand loop | `caretaker-relay/tests/understand-loop.test.ts` | 5 | Pass |
| App product isolation | `caretaker-relay/tests/product-isolation.test.ts` | 1 | Pass |
| **Total material care-related** | | **43** | **Pass** |

## By category

| Category | Tests (approx) |
| --- | --- |
| Architecture / wiring | 4 |
| Canonical loop / persistence | 3 |
| Correction / current state | 1 |
| Handoff continuity | 1 |
| Access / privacy | 7 |
| Medication / safety / refusal | 5 |
| Golden / metamorphic / adversarial | 6 |
| LLM provider abstraction | 1 |
| FHIR mapping | 1 |
| Product isolation | 10 |
| App UI-path understand | 5 |

## Failures and skips

- Failures: **0** (at snapshot)  
- Skips: **0**  
- Real-LLM live care extraction: **not run** (no care-specific recorded fixtures yet)  
- Postgres-backed care adapter: **not tested** (not implemented)  

## Evidence modes in use

| Mode | Meaning | Used for |
| --- | --- | --- |
| FIXTURE | Deterministic understand extractor | Default lab understand |
| SYNTHETIC_FOUNDATION_BACKED | Foundation package store after confirm | Persisted loop |
| LIVE_FOUNDATION_BACKED | Injected LLMProvider path | Scripted provider test |
| DEMO_ONLY | Static UI seeds | Pre-loop Today seeds until refreshed from store |

## Golden dataset

- Version: `1.0.0`  
- Synthetic: **true**  
- Size: **20** cases  
- Composition: concise, rambling, incomplete, date ambiguity, pronoun, wrong-person, medication, negation, appointment, typo, professional, family, multilingual, adversarial×3, metamorphic, filler  

## TRL 3 gate (caregiver system)

| Criterion | Result | Notes |
| --- | --- | --- |
| Architecture: app calls foundation | **MET** | `@caretaker-relay/care-domain` |
| Interfaces: care API boundary | **MET (package)** | HTTP Fastify routes not yet |
| Dataflow documented | **MET** | Loop service + TRL card |
| Prototype-caliber code | **MET** | Not fixture-only architecture |
| Unit + integration tests | **MET** | 43 care-related |
| Interoperability boundary | **MET (mapping)** | Not EMR live |
| Reliability considered | **PARTIAL** | Fail-closed LLM; retries incomplete |
| Maintainability | **MET** | Clear care-domain package |
| Extensibility | **MET** | Not Olivia-hardcoded store |
| Scalability considerations | **PARTIAL** | Memory store single-process |
| Documentation | **MET** | TRL, risks, bias, affordability, traceability |
| Versioning | **MET** | code + golden + origin SHA |
| Safety HITL + uncertainty + permissions | **MET** | Tested |

**Overall:** Defensible **partial-to-solid TRL 3**. Not full TRL 4 system.
