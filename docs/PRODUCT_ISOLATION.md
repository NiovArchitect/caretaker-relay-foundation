# Product Isolation — Caretaker Relay vs Otzar

## Non-negotiable rule

**Caretaker Relay data must never appear inside Otzar.  
Otzar data must never appear inside Caretaker Relay.**

There must be no accidental cross-product data path.

---

## Isolation dimensions

| Dimension | Caretaker Relay | Must not share with Otzar |
| --- | --- | --- |
| Git repositories | `caretaker-relay-foundation`, `caretaker-relay` | `niov-foundation`, `otzar-control-tower` |
| Package root name | `caretaker-relay-foundation` | `niov-foundation` |
| Product id | `caretaker-relay` | `otzar` |
| Database name (local) | `caretaker_relay_dev` | `foundation_test` / Otzar prod DBs |
| Postgres container | `cr-local-pg` | `niov-local-pg` |
| Redis / Valkey prefix | `cr:` | Otzar prefixes / DBs |
| Queue namespace | `cr.queues.*` | Otzar queues |
| Encryption namespace / key | Separate `ENCRYPTION_KEY` | Otzar keys |
| JWT secret | Separate `JWT_SECRET` | Otzar JWT |
| Organization / tenant IDs | Separate bootstrap orgs | Otzar production tenants |
| Audit namespace | `product_id=caretaker-relay` | Otzar audit streams |
| OAuth callbacks | Caretaker Relay domains | `app.otzar.ai` callbacks |
| Provider webhooks | Caretaker Relay URLs | Otzar webhook URLs |
| Object storage prefix | `cr/` or dedicated bucket | Otzar buckets |
| Email identity | Caretaker Relay sender | Otzar mail identity |
| Deploy services | `caretaker-relay-api` | `otzar-api` |
| Domains | Caretaker Relay (TBD) | `api.otzar.ai`, `app.otzar.ai` |
| Logs / telemetry | Separate service name + product tag | Otzar dashboards only |
| Test data | Olivia scenario fixtures | YC / Otzar synthetic orgs |

---

## Runtime constants

Canonical module: `packages/product-identity` / `config/product.ts`

```
PRODUCT_ID = "caretaker-relay"
PRODUCT_NAME = "Caretaker Relay"
PRODUCT_NAMESPACE = "cr"
FORBIDDEN_PEER_PRODUCT_IDS = ["otzar", "niov-otzar"]
```

---

## Isolation tests

- `tests/unit/isolation/product-isolation.test.ts` — asserts product identity and forbids Otzar service names in Caretaker deploy config.
- Application-level tests in `caretaker-relay` enforce care-recipient isolation and scenario boundaries.

---

## Operator checklist (new environment)

1. Create empty database `caretaker_relay_*` — never point at Otzar DB URLs.
2. Generate new JWT and encryption secrets.
3. Configure separate Redis DB index or instance with `cr:` key prefix.
4. Register OAuth apps with Caretaker Relay callback URLs only.
5. Use separate object storage bucket/prefix.
6. Tag all logs with `product_id=caretaker-relay`.
7. Run isolation tests in CI before deploy.
