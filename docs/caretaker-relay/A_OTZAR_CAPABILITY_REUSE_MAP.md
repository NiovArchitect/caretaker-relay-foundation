# A. Otzar / Foundation Capability Reuse Map

**Principle:** Reuse proven substrate. Do not inherit Otzar information architecture or business nouns.

| Capability | Source | Reuse mode | Caregiver translation |
| --- | --- | --- | --- |
| Entity / identity | Foundation `Entity`, sessions, API keys | Direct substrate | Caregiver, care recipient, professional as entities |
| Auth shell patterns | Foundation auth + CT session patterns | Pattern only | Simple caregiver login; no enterprise console |
| DMW / memory capsules | Foundation wallet + capsules | Direct | Care memory, observations, summaries |
| Audit / provenance | AuditEvent, TruthEvidenceSnapshot | Direct | “Where this came from” / “Why am I seeing this?” |
| RBAC / ABAC / TAR | Permission, decision rights | Direct engine | “Who can see this”, access relationships |
| Consent | ConsentGrant | Direct | Who can see what; care recipient dignity |
| Handoff primitives | Handoff, HandoffObligation | Map domain | Care handoff experience |
| Governed actions | Action, ActionPolicy, attempts | Direct | Safety classes low/moderate/high |
| Corrections | TwinCorrectionMemory patterns | Map domain | First-class “That’s wrong” |
| Conversation substrate | OtzarConversation* tables (rename later) | Substrate only | Relay surface — not workplace Twin copy |
| Voice STT/TTS | voice services, ElevenLabs, CSM readiness | Direct | Voice-first care entry |
| LLM routing | llm services | Direct | Understand / summarize with safety |
| Connectors rails | connector-rails | Boundary | FHIR, calendar later — no false claims |
| Notifications | notification services | Map | Care updates, needs attention |
| Queues / jobs | infrastructure | Namespace `cr.queues.*` | Background relay / handoff jobs |
| BEAM coordination | collaboration_supervisor | Optional | Multi-caregiver coordination later |
| Python intelligence | python-intelligence | Optional | Extraction / ranking with fixtures |
| Work OS (projects, etc.) | work-os services | **Do not reuse as UI** | Replace with care domain |
| Org truth / employee Twin UX | otzar services, CT nav | **Do not reuse** | Care instructions disagree, Today/Care/Circle/Relay |
| Admin Control Tower IA | otzar-control-tower | **Inventory only** | Minimal settings: privacy, connections, circle |
| YC demo fixtures | Otzar seeds | **Forbidden** | Olivia care scenario only |

## Frontend technical reuse (inventory — not a UI fork)

| Component class | Reuse? | Notes |
| --- | --- | --- |
| Auth shell / secure session | Yes (patterns) | Rebuild screens for caregivers |
| API client / error handling | Yes | New base URL + product headers |
| Accessibility primitives | Yes | Large targets, SR support |
| Modal / drawer patterns | Yes | Confirm / correct flows |
| Voice infrastructure hooks | Yes | Same care context as text |
| Enterprise nav, Work OS pages, dark neon branding | No | Care-first IA and palette |

## Substrate packages (inherited npm names)

`@niov/auth`, `@niov/database`, `@niov/api` remain technical package names at fork. Runtime product identity is `@caretaker-relay/*` + `PRODUCT_ID=caretaker-relay`. Gradual package rename is allowed later without Otzar coupling.
