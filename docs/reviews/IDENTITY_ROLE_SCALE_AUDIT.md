# Identity / Role / Scale Audit

## How Relay knows “Dr. Shah is Evelyn’s physician”

| Layer | Source | Authority? |
|-------|--------|------------|
| Person record | `Person` id + displayName | Identity only |
| Professional kind | `Person.kind = provider` | Classification |
| Care-team membership | `CareRelationship` on recipient | **Yes — membership** |
| Role label | `role` / `roleLabel` e.g. Primary care physician | Role within team |
| Organization | `organizationId` / `organizationName` | Org boundary |
| Scope | `access.informationCategories` / `allowedActions` | Permission |
| Effective dates | `startDate` / `endDate` + `status` | Currency |
| Resolution API | `resolveCurrentProvider(store, careRecipientId)` | Data-driven |

## Removed / avoided business hardcoding

- Provider escalation offers use `resolveEscalationTarget` / `resolveCurrentProvider` — not `if (name === "Dr. Shah")`.
- Adversarial wrong-provider checks match **named provider against care-team + instructions**, not a single ID.
- Technical IDs (`p-dr-shah`) identify rows; meaning comes from relationship rows.

## Residual seed IDs

Lab fixtures still use stable technical IDs (`p-dr-shah`, `cr-olivia`) for continuity. Display names are synthetic. Authority decisions go through relationships.

## Scale fixture

`scenario/agency-scale.ts`:

- 2 organizations (North Coast / Bay Care)
- 5 DSPs + 5 recipients with assignment matrix
- Revoked DSP loses access
- Name collision: two “Dr. Priya Shah” / two “DSP Avery Chen” different org IDs
