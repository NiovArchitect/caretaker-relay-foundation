# Upstream Porting Policy

**Applies to:** `caretaker-relay-foundation` after fork from `niov-foundation@afe1491`  
**Upstream reference remote:** `foundation-upstream` (local path or future read-only remote)  
**Default stance:** Independent evolution. Port deliberately. Never auto-merge.

---

## Goals

1. Keep security and generic substrate fixes flowing when valuable.
2. Prevent Otzar domain assumptions, UI, and demo fixtures from contaminating Caretaker Relay.
3. Preserve a clear audit trail of every port (SHA, rationale, reviewer).

---

## May port (prefer cherry-pick)

These classes are generally safe when the patch is domain-agnostic:

- Security fixes (auth, session, JWT, CSRF, rate limits)
- Encryption and key-handling fixes
- Generic audit improvements
- Tenant / entity isolation fixes
- Provider reliability (LLM, voice STT/TTS transport)
- Generic AI safety (refusal paths, no-fabricate protocol tests)
- Queue / job reliability
- Generic data provenance machinery
- Generic permission engine fixes
- Dependency CVE upgrades that do not change product semantics
- Database driver / Prisma operational fixes that do not import Work OS models as requirements

**Process:** Cherry-pick or manually re-apply → run unit + isolation tests → document in `docs/ports/YYYY-MM-DD-<short-slug>.md`.

---

## Must review before porting

Do not land without an explicit care-domain review:

- Otzar organizational truth semantics (`OrgTruth*`, conflict sets)
- Work OS terminology and models (`WorkProject`, obligation-as-work)
- Enterprise hierarchy assumptions
- Admin / Control Tower workflows
- Organization-specific memory behavior tuned for employees
- AI Teammate / Twin role logic and ambient employee UX
- Otzar conversation product contracts that encode workplace copy
- Billing entitlements tied to Otzar SKUs
- Connector defaults aimed at workplace SaaS only

**Review questions:**

1. Does this change force Otzar nouns into caregiver surfaces?
2. Does it weaken care-recipient isolation or consent?
3. Does it change medication / health safety posture?
4. Can the same fix be reimplemented in care vocabulary instead?

---

## Do not automatically port

Never merge or bulk-sync:

- Otzar UI (Control Tower, ambient desktop, employee nav)
- Otzar copy, branding, domains (`otzar.ai`, YC demo language)
- YC / demo fixtures and synthetic organizations
- Otzar business workflows (sales, hiring, internal ops demos)
- Otzar synthetic orgs and seed data
- Render / deploy config pointing at Otzar services
- Secrets, entity IDs, or tenant IDs from Otzar environments

---

## Port log format

```markdown
# Port: <title>

- Date:
- Source SHA:
- Target SHA (Caretaker):
- Category: may-port | reviewed
- Rationale:
- Care domain impact:
- Tests run:
- Reviewer:
```

---

## Coupling rule

Caretaker Relay **knows its origin** (this document + `FOUNDATION_ORIGIN.md`)  
Caretaker Relay is **not coupled** to Otzar release trains.
