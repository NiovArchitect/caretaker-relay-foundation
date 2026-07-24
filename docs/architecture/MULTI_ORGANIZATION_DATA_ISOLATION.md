# Multi-Organization Data Isolation

## Model

```text
tenant / organization_id
  → person membership (optional employment)
  → care recipient ownership/context
  → care-team relationship (recipient-specific)
  → external provider relationship (clinic org ≠ agency org)
  → authorization scope
  → data partition by careRecipientId + relationship
```

Person ≠ role ≠ permission ≠ organization.

## Fixture

`packages/care-domain/src/scenario/multi-tenant.ts`

| Tenant | Recipients | Notes |
|--------|------------|-------|
| Harbor Home Support (A) | cr-a-evelyn | External Dr. Shah at Coastal Family Medicine |
| Summit Care Agency (B) | cr-b-evelyn | Separate "Evelyn Carter" + separate Shah personId |
| Lakeside Family Care (C) | cr-c-robert | Dr. Cole; Daniel may also work here |

## Rules proven in tests

- Company A caregiver cannot access Company B/C recipients
- Same display names do not pool medications across companies
- External provider retains clinic organizationId
- Same professional can hold multiple org memberships with separate scopes

## Product implication

At scale, each company is its own Caretaker Relay customer. There is **no** shared pool of care data across companies just because names or cities match.
