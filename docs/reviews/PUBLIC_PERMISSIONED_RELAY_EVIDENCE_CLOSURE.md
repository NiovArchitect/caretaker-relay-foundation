# Public Permissioned Relay Evidence Closure

**Date:** 2026-07-27

## Runtime

| Item | Value |
|------|-------|
| API repository HEAD | 6ede239daca2e5401082803e57f010815fa79a5c |
| API deploy | 6ede239daca2e5401082803e57f010815fa79a5c live |
| Prior preserved slice | fdabe428 (authz+shift matrices) |
| Repair on live defect | ensureAssignee domain merge + Care tasks domain map |
| App repository HEAD | 8e7a36d (docs-only after product) |
| App runtime source/deploy | 61ca1df / 61ca1df |
| Public health | ok, durable prisma, llm_ready false |
| lab_login_enabled flag | false (primary login still maps care_person_id) |

## Public matrix

- **1200** HTTP authorization evaluations (100 questions × 12 identity variants)
- unauthorized answers: **0**
- unauthorized domain answers: **0**
- hidden-recipient / cross-recipient / cross-tenant: **0**
- unsafe medication: **0**
- cancelled-as-next: **0**

### Counts

```
{
  "authorized_grounded": 359,
  "authorized_no_data": 101,
  "partial_scope_denial": 18,
  "full_denial": 722,
  "unauthorized_answers": 0,
  "unauthorized_domain_answers": 0,
  "hidden_recipient": 0,
  "cross_recipient": 0,
  "cross_tenant": 0,
  "unsafe_med": 0,
  "cancelled_as_next": 0
}
```

## Journeys (API-equivalent; browser video NOT_CAPTURED)

| Journey | Result |
|---------|--------|
| Active DSP status | PASS |
| Invitation before accept | PASS (0 care answers) |
| Active revocation follow-up+replay | PASS |
| Medication projection | PASS |
| Appointment next | PASS |
| Shift evolution questions | PASS |

## Product defects found

1. **Fixed:** Active DSP with pre-existing paid_caregiver relationship accepted shift but lacked observation domains for status (deployed in 6ede239).

## Freeze decision

Public multi-role HTTP matrix **PASS** (≥1000).  
Browser video multi-tab evidence **PARTIAL**.  

**PRODUCT FREEZE: NOT RESTORED** until full browser video journeys A–F are captured, unless operator accepts API-equivalent evidence.
