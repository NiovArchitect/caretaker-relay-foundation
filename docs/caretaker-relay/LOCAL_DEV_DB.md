# Local development database (5434)

## Isolation

| Stack | Host port | DB name | Container |
| --- | --- | --- | --- |
| **Caretaker Relay dev** | **5434** | **caretaker_relay_dev** | `cr-local-pg` |
| Foundation unit tests | 5433 | foundation_test | `niov-foundation-test-db` |
| Otzar | never | never | never |

## Startup

```bash
export DOCKER_HOST=unix://$HOME/.colima/default/docker.sock
cd caretaker-relay-foundation

# 1. Postgres only (no full API image build required)
docker compose -f docker-compose.local.yml up -d postgres

# 2. Schema + client
export DATABASE_URL='postgresql://caretaker:caretaker_local_only@localhost:5434/caretaker_relay_dev?schema=public'
export DIRECT_URL="$DATABASE_URL"
docker exec cr-local-pg psql -U caretaker -d caretaker_relay_dev -c 'CREATE EXTENSION IF NOT EXISTS vector;'
npx prisma db push --schema=packages/database/prisma/schema.prisma
npm --workspace @niov/database run db:generate

# 3. Care API (Prisma backend)
export JWT_SECRET=cr-local-dev-jwt-secret-not-for-production-32b
export CARE_STORE_BACKEND=prisma
export CARE_UNDERSTAND_MODE=fixture
npm run care:api
# → http://localhost:3100/api/v1/care/health
```

## App

```bash
cd caretaker-relay
VITE_CARE_TRANSPORT=http VITE_CARE_API_URL=http://localhost:3100 npm run dev
# → http://localhost:5180
```

## Prove independence

- Test suite continues to use `.env.test` → port **5433**.
- Dev API uses **5434** / `caretaker_relay_dev`.
- Dropping test DB must not affect `cr-local-pg`.
