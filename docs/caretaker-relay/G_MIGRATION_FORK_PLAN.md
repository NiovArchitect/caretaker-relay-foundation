# G. Migration / Fork Plan

## Done (slice 0)

1. Clean clone `niov-foundation` → `caretaker-relay-foundation` at `afe1491`
2. Provenance + porting + isolation docs
3. Product identity package + isolation tests
4. Care domain package
5. Docker / env / render retargeted off Otzar
6. Application repo `caretaker-relay` with four-surface shell + Olivia loop

## Near-term slices

| Slice | Outcome |
| --- | --- |
| 1 | App shell + scenario demo (this PR set) |
| 2 | Wire Understand/Verify to Foundation LLM with fixture fallback |
| 3 | Persist care events to isolated DB |
| 4 | Auth for caregivers (pattern reuse) |
| 5 | Consent / access UI |
| 6 | Handoff persistence + notifications |
| 7 | FHIR export boundary (read-only bundle) |
| 8 | Voice STT path (existing substrate) |
| 9 | Hidden-oracle + Protocol 9-Delta suite in CI |
| 10 | Phase 1 application evidence pack |

## Rules

- Do not modify `niov-foundation` or Otzar production for Caretaker work  
- No shared tenants or test data  
- Ports only per `UPSTREAM_PORTING_POLICY.md`  
- npm `@niov/*` rename is optional later; runtime isolation is mandatory now  

## Independent remotes (when publishing)

```
caretaker-relay-foundation → new GitHub repo (not niov-foundation)
caretaker-relay            → new GitHub repo (not otzar-control-tower)
foundation-upstream        → read-only reference for deliberate ports
```
