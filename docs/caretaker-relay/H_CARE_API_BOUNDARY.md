# H. Care API / Domain Boundary

## Rule

Do **not** build a second mini-backend inside the React app.  
Care domain lives in `packages/care-domain` (`@caretaker-relay/care-domain`).

## Public surface (caregiver nouns only)

| Capability | Entry |
| --- | --- |
| Runtime factory | `createCareRuntime()` |
| Loop | `CareLoopService.proposeFromInput` / `confirmAndPersist` / `applyCorrection` |
| Access | `evaluateAccess`, `whoCanSeeWhat`, `filterCurrentStateForViewer` |
| Understand | `understandCareInput` (mode: `fixture` \| `llm`) |
| Store | `CareStore` / `MemoryCareStore` |
| Scenario | `seedOliviaScenario`, `sadeilContext` |
| Golden | `GOLDEN_CASES`, `goldenSummary` |
| FHIR map | `map*` helpers + `FHIR_CONCEPT_MAP` |

## Foundation primitive mapping (internal)

See `FOUNDATION_PRIMITIVE_MAP` in types. Backend may use Entity, MemoryCapsule, AuditEvent, ConsentGrant, Handoff, LLMProvider — **never expose Otzar/Work OS nouns to the frontend.**

## Evidence modes

Every meaningful result carries `EvidenceMode`:

- `LIVE_FOUNDATION_BACKED`
- `SYNTHETIC_FOUNDATION_BACKED`
- `FIXTURE`
- `DEMO_ONLY`

## HTTP routes (next)

Planned Fastify registration (not yet mounted):

- `POST /api/v1/care/understand`
- `POST /api/v1/care/confirm`
- `GET /api/v1/care/recipients/:id/state`
- `GET /api/v1/care/recipients/:id/access`
- `POST /api/v1/care/corrections`
- `GET /api/v1/care/recipients/:id/handoffs`

App currently imports the package directly (same process boundary for Phase 1 lab). Production should prefer HTTP + session auth.
