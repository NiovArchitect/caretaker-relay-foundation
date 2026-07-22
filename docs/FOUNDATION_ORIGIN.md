# Foundation Origin — Caretaker Relay

**Product:** Caretaker Relay  
**Substrate clone:** `caretaker-relay-foundation`  
**Clone date:** 2026-07-22  
**Principle:** Clone the intelligence substrate. Rebuild the experience around caregiving.

---

## Source repository

| Field | Value |
| --- | --- |
| Source repository | `niov-foundation` |
| Source remote (at clone) | `https://github.com/NiovArchitect/niov-foundation.git` |
| Exact source SHA | `afe1491d882cbca4b0ce95db6f85ec0ad85dd16f` |
| Source tip commit | `[work-os] YC RC trust: create idempotency + intent ledger visibility (#732)` |
| Local clone remote name | `foundation-upstream` (read-only reference; no automatic merge) |

**Original Foundation was not modified during this clone.**

---

## Active schema and migrations

| Field | Value |
| --- | --- |
| Prisma schema | `packages/database/prisma/schema.prisma` |
| Approximate model count at clone | 114 models |
| Database provider | PostgreSQL + `pgvector` extension |
| Schema authority | Prisma schema push / migrate via `@niov/database` |
| Elixir migrations | `apps/cosmp_router/priv/repo/migrations` (BEAM COSMP) |
| Active schema version label | Inherited Foundation schema at SHA above; Caretaker Relay will introduce a care-domain schema layer without rewriting Otzar Work OS tables in place |

Core inherited tables (not exhaustive): Entity, Wallet, MemoryCapsule, TokenAttributeRepository, Session, AuditEvent / AuditLog, Permission, ConsentGrant, Handoff, Obligation, Action / ActionPolicy / ActionAttempt, TruthEvidenceSnapshot, ConnectorBinding, VoiceAccessLog, ConversationMemoryScope.

---

## Relevant ADRs (inherited)

Authority lives under `docs/architecture/decisions/`. Especially relevant to caregiving substrate reuse:

| ADR | Topic | Caretaker relevance |
| --- | --- | --- |
| 0030 | Phase 2 Elixir/BEAM implementation | Coordination runtime |
| 0037 | CAR / jurisdiction | Sovereignty anchors |
| 0070 | Regulator-ready foundation doctrine | Audit + compliance posture |
| 0071 | Cross-scope audit verify chain | Provenance / verify loop |
| 0078–0079 | Conversation context + transcript policy | Relay conversation substrate |
| 0085 | Voice-first product doctrine | Voice-first care entry |
| 0089 | Sesame CSM-1B voice provider readiness | STT/TTS path |
| 0090 | Python intelligence runtime | Understand / extract path |
| 0092 | DMW runtime expansion | Memory wallet / care memory |
| 0094 | Governed agent transaction standard | Safety-bounded AI actions |

Otzar-specific ADRs (Work OS, Twin proactivity, playground consumer contracts) are **historical inheritance only** — not product requirements for Caretaker Relay UI or domain nouns.

---

## Security contracts (inherited)

- Tenant / entity isolation via Entity + membership + permission checks
- Append-only audit events with chain-of-custody posture
- Encryption key material via `ENCRYPTION_KEY` (must use **separate** secrets for Caretaker Relay)
- JWT session secrets (must use **separate** secrets)
- Consent grants and high-sensitivity review paths
- Connector credentials three-tier separation (platform vs tenant)
- No-leak test guards (`test:no-leak`)

---

## Relevant test suites (inherited)

| Path | Purpose |
| --- | --- |
| `tests/unit/` | Unit substrate tests |
| `tests/integration/` | Integration paths |
| `tests/real-llm/` | Real LLM contracts (optional CI) |
| `tests/unit/no-leak-guard.test.ts` | Secret / leak guards |
| `vitest.unit.config.ts` / `vitest.integration.config.ts` | Test runners |

Caretaker Relay adds **product isolation tests** under `tests/unit/isolation/` and care-domain tests in the application repository.

---

## Provider integrations (inherited capability surface)

Present as Foundation services (enable only with Caretaker-specific credentials and callbacks):

- LLM: Anthropic, OpenAI (and Azure OpenAI patterns)
- Voice: ElevenLabs STT, text-only fallback, CSM-1B readiness path
- Connectors: generic connector rails (do not claim care integrations that do not exist)
- Python intelligence runtime
- BEAM collaboration supervisor
- Email / activation (must use Caretaker Relay identity, not Otzar)

---

## Foundation health state at clone

| Check | State |
| --- | --- |
| Git tip | `afe1491` on main lineage |
| Working tree at clone | Clean product clone (no Otzar production secrets copied) |
| Secrets policy | `.env` not used as deploy source; `.env.example` rewritten for Caretaker Relay namespaces |
| Deploy blueprint | `render.yaml` retargeted away from `api.otzar.ai` / `otzar-api` |
| Cross-product data path | Forbidden — see isolation tests and `PRODUCT_ISOLATION.md` |

---

## Inherited architecture (what we keep)

| Layer | Keep | Translate for caregivers |
| --- | --- | --- |
| Identity / Entity | Yes | Caregiver, care recipient, professional as entities |
| DMW / Memory capsules | Yes | Care memory, observations, summaries |
| Audit / provenance | Yes | “Where this came from” |
| RBAC / ABAC / TAR / decision rights | Yes | “Who can see this” / “Needs your confirmation” |
| Handoff / obligation primitives | Yes | Care handoff, care tasks (new domain mapping) |
| Governed actions | Yes | Safety classes (low / moderate / high) |
| Corrections + evidence snapshots | Yes | First-class “That’s wrong” |
| Voice + conversation substrate | Yes | Relay surface |
| Connectors | Boundary only | FHIR / calendar / health-system later |

---

## Caretaker Relay divergence rules

1. **Independent lifecycle** — Caretaker Relay Foundation evolves independently of Otzar Foundation after this SHA.
2. **No shared tenants, DBs, Redis, queues, secrets, or object storage** with Otzar production or Otzar staging.
3. **No Otzar business nouns in the caregiver UI** — no Work Project, Obligation, Org Truth, AI Teammate as primary labels.
4. **Care domain layer is first-class** — new concepts live above Foundation; do not rename `Project → Patient`.
5. **Ports are deliberate** — see `docs/UPSTREAM_PORTING_POLICY.md`. No automatic merge from Otzar/Foundation main.
6. **Do not modify `niov-foundation` or Otzar Control Tower to ship Caretaker Relay.**
7. **Brand, domains, OAuth callbacks, email identity, and telemetry must be product-specific.**

---

## Product identity constants

See `packages/product-identity/` and `config/product.ts`:

- Product id: `caretaker-relay`
- Product name: `Caretaker Relay`
- Namespace prefix: `cr`
- Default local DB: `caretaker_relay_dev`
- Forbidden peer product ids: `otzar`, `niov-otzar`
