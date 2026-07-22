# Caretaker Relay Foundation

**Care coordination substrate** for [Caretaker Relay](../caretaker-relay), built for the **2026 ACL Caregiver AI Challenge (Track 1)**.

> Clone the intelligence substrate. Rebuild the experience around caregiving.

## Origin

Clean clone of `niov-foundation` at:

```
afe1491d882cbca4b0ce95db6f85ec0ad85dd16f
```

See [`docs/FOUNDATION_ORIGIN.md`](docs/FOUNDATION_ORIGIN.md).

**This repository is not Otzar.** Do not deploy against Otzar databases, tenants, secrets, or domains.

## Separation

| | Caretaker Relay | Otzar |
| --- | --- | --- |
| Foundation repo | `caretaker-relay-foundation` | `niov-foundation` |
| App repo | `caretaker-relay` | `otzar-control-tower` |
| Local DB | `caretaker_relay_dev` :5434 | separate |
| Product id | `caretaker-relay` | `otzar` |

Details: [`docs/PRODUCT_ISOLATION.md`](docs/PRODUCT_ISOLATION.md)  
Upstream ports: [`docs/UPSTREAM_PORTING_POLICY.md`](docs/UPSTREAM_PORTING_POLICY.md)

## Packages

- `@caretaker-relay/product-identity` — isolation constants
- `@caretaker-relay/care-domain` — caregiver domain model
- `@niov/database`, `@niov/auth`, `@niov/api` — inherited substrate packages (runtime namespaces are Caretaker-specific; gradual rename planned)

## Quick isolation check

```bash
npm install
npm run test:isolation
```

## Product docs

Under `docs/caretaker-relay/`:

- Capability reuse map
- Domain model
- Information architecture
- ACL Track 1 traceability
- Safety model
- UI wireframe map
- Migration / fork plan

## North star loop

**Input → Understand → Verify → Organize → Relay → Act → Continuity**

## Deadline

ACL Phase 1 application: **July 31, 2026, 5:00 PM ET**.
