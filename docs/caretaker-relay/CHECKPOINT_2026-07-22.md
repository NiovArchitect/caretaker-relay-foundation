# Emergency Checkpoint — Caretaker Relay Foundation working copy — 2026-07-22

See also the app recovery doc in the sibling repo:

`caretaker-relay/docs/CHECKPOINT_2026-07-22.md`

## Purpose

Preserve care-domain, Care API, Prisma care store, stress harness, medication unit P1 fix, and lifecycle tooling on **remote Git** before Track 1 Product Constitution work.

## Crash recovery note (same day)

Post-crash inventory found this repo already committed and pushed on `checkpoint/caretaker-relay-track1-2026-07-22` with a clean working tree. Local HEAD matched `origin` after fetch. No filesystem care work was discarded.

## This repository is NOT original niov-foundation

| Item | Value |
| --- | --- |
| Path | `/Users/genghishameha/dev/NIOV Labs/github/caretaker-relay-foundation` |
| Relation | Forked/working copy used for Caretaker Relay care runtime |
| Original `niov-foundation` | **Unmodified** by this campaign; do not push Caretaker work onto it by default |
| Checkpoint branch | `checkpoint/caretaker-relay-track1-2026-07-22` |
| Product checkpoint SHA | `fed2f594f7a39c02961d3ecdbe8f60d26363c255` |
| Recovery tip SHA | `434cd4ff8292f50199062047298387ec85bfeafc` (docs verification) |
| Remote origin | GitHub private `NiovArchitect/caretaker-relay-foundation` |
| Remote branch | `origin/checkpoint/caretaker-relay-track1-2026-07-22` |
| Push verified | **YES** (local HEAD == remote SHA after fetch) |
| Legacy remote | `foundation-upstream` → local path to `niov-foundation` (not used for this push) |

## Validated architecture (summary)

- Real HTTP care runtime (`care-app`, care routes, care-runtime service)
- Foundation-backed care auth
- Isolated Prisma care store / Postgres lab DB
- Canonical care loop, audit/provenance, handoff, corrections
- Medication idempotency + dose-units normalization
- Brutal real-stack stress harness + founder smoke + finite service lifecycle

## Brutal stress / medication P1

| Item | Status |
| --- | --- |
| Brutal stress | 68 scenarios campaign; unresolved P0/P1 = **0** post med-unit closure |
| CR-STRESS-030 | **CLOSED** — strong `expectDisc: true` for `2.5 grams` after `dose-units` product fix |
| Evidence | `docs/caretaker-relay/evidence/brutal-real-stack-v1/` including `CR-STRESS-030-after-product-fix.json` |
| Live model | **BLOCKED_CREDENTIALS** (not claimed as validated) |
| Physical mic | **MANUAL_NOT_AUTOMATABLE** (app campaign boundary) |
| Real caregiver validation | **NOT occurred** |
| Defensible TRL | **TRL 3** |

## Strategic product decision

**ACL Caregiver AI Challenge — TRACK 1 — AI Tools to Support Caregivers — PHASE 1 — Design**

Track 1 and Track 2 are separate concurrent tracks. Caretaker Relay must **NOT** drift into Track 2 workforce-management. Foundation may remain extensible, but Track 2 workflows must not be exposed merely because Foundation can support them.

The Track 1 Product Constitution has **NOT** yet been supplied.

## NEXT INTENDED ACTION

**WAIT FOR THE ACL TRACK 1 PRODUCT CONSTITUTION / TRACK 2 FIREWALL BEFORE NEW PRODUCT OR UI DEVELOPMENT.**

No redesign, no Track 2, no production deploy, no new brutal campaign as part of this checkpoint.
