# I. Care HTTP Runtime

## Entry points

| Entry | Purpose |
| --- | --- |
| `apps/api/src/care-app.ts` → `buildCareApp()` | Focused care Fastify app (tests + local port 3100) |
| `npm run care:api` / `npm --workspace @niov/api run care:start` | Start care API |
| `buildApp()` registration | Same `registerCareRoutes` on full Foundation server |

## Routes (`/api/v1/care/*`)

| Method | Path | Auth |
| --- | --- | --- |
| GET | `/health` | public |
| POST | `/auth/lab-login` | public (lab principals) |
| GET | `/context` | bearer |
| POST | `/understand` | bearer |
| POST | `/confirm` | bearer + idempotency_key |
| POST | `/corrections` | bearer |
| GET | `/recipients/:id/today` | bearer + access |
| GET | `/recipients/:id/state` | bearer + access |
| GET | `/recipients/:id/circle` | bearer + access |
| GET | `/recipients/:id/access` | bearer |
| POST | `/recipients/:id/access/revoke` | bearer (controlling) |
| GET | `/recipients/:id/handoffs` | bearer + access |
| GET | `/recipients/:id/timeline` | bearer + access |
| GET | `/recipients/:id/export` | bearer + access |

## Auth

- **Lab:** `CareAuthService` HS256 JWT (`iss=caretaker-relay-care-auth`)  
- **Production mapping:** Foundation `AuthService` entity_id → care principal directory (`mintFromFoundationEntity`)  
- **Authority ≠ relationship:** every data route still runs `evaluateAccess`

## Durability

- `FileCareStore` when `CARE_STORE_PATH` or `durable: true`  
- Survives API process restart (acceptance tested)  
- Prisma/Entity adapter remains future work behind same `CareStore` interface  

## Evidence honesty

- Fixture understand → `FIXTURE`  
- Confirm on durable store → `SYNTHETIC_FOUNDATION_BACKED`  
- Injected LLMProvider → `LIVE_FOUNDATION_BACKED`  
- Export claim: `FHIR_MAPPED_NOT_EMR_INTEGRATED`  
