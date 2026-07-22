# Caretaker Relay Foundation — Memory

**Last updated:** 2026-07-22

## What this repo is

Clean Foundation substrate clone for **Caretaker Relay**, isolated from Otzar.

- Origin: `niov-foundation` @ `afe1491d882cbca4b0ce95db6f85ec0ad85dd16f`
- Product id: `caretaker-relay`
- Care domain package: `packages/care-domain` → `@caretaker-relay/care-domain`

## Care domain (live for Phase 1 lab)

Implements:

- Care loop service (propose → confirm → persist → handoff → audit)
- Access/consent isolation
- Medication safety + adversarial refusals
- Epistemic uncertainty propagation
- Golden dataset v1.0.0
- FHIR mapping stubs
- Foundation LLMProvider-compatible understand path

Persistence today: **MemoryCareStore** (interface-ready for Prisma adapter).  
HTTP routes: **not yet mounted** on Fastify (see `docs/caretaker-relay/H_CARE_API_BOUNDARY.md`).

## Tests

```bash
npx vitest --config vitest.unit.config.ts --run tests/unit/care/ tests/unit/isolation/
```

## Do not

- Merge Otzar product concerns into care UI nouns
- Claim TRL 4 for the whole caregiver system
- Claim caregiver validation without real participants
- Expose Foundation/Otzar terminology to the frontend
