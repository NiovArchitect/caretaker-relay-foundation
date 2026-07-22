# Affordability & Access

**Last updated:** 2026-07-22  
**Rule:** Do not invent final pricing.

## Architecture decisions that support affordability

| Decision | How it helps access |
| --- | --- |
| Commodity phone/browser first | No required specialized hardware |
| Progressive web UI (`caretaker-relay` Vite app) | Works on ordinary smartphones |
| Voice **+** text | Users without reliable STT can type |
| Progressive enhancement | Core loop works without premium devices |
| Accessible web interface targets | Large tap targets, calm UI, plain language |
| Localization-ready design | Language preference primitive; multilingual golden case noted |
| Core workflows without expensive devices | Care update → verify → handoff in browser |
| Isolated commodity stack | Postgres/Redis local compose; no proprietary care appliance |

## Safe personalization primitives (implemented or stubbed)

- Preferred summary length  
- Reminder timing  
- Language  
- Accessibility preferences  
- Handoff format  
- Communication preference  

Preferences must remain reviewable, editable, removable, provenance-aware.  
**Do not** silently infer sensitive traits.

## Unresolved cost drivers

| Driver | Notes |
| --- | --- |
| Model inference | LLM extraction cost per care update if live path used |
| STT / TTS | Voice providers (e.g. inherited Sesame/ElevenLabs paths) |
| Storage | Care events, audio, documents, audit retention |
| Interoperability | Future FHIR/EMR connectivity engineering + compliance |
| Messaging | SMS/push for handoffs and reminders |
| Support burden | Human support for non-technical caregivers |

## Explicit non-claims

- No price point is asserted.  
- No claim that free forever is funded.  
- No claim that all cost drivers are solved.  

## Next work

1. Rough cost model for fixture vs live LLM modes (internal)  
2. Offline-tolerant draft capture (optional)  
3. Export/portability to reduce lock-in costs for families  
