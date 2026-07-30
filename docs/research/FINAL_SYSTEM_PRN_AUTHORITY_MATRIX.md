# PRN authority matrix (system-wide)

| Action | Care recipient (self) | Family caregiver | Professional / DSP | Clinician / reviewer | Coordinator | Unauthorized principal |
|--------|----------------------|------------------|--------------------|----------------------|-------------|------------------------|
| View authorized PRN orders | If permitted | If med plan view | If med plan view | Yes (scope) | Policy | No |
| Report symptom / need | Yes | Yes | Yes | Yes | Yes | No |
| Chart administration (confirm) | Self-admin path when allowed | When access allows | When access allows | When access allows | Usually no | No |
| Invent / recommend dose | No | No | No | Outside Relay chat | No | No |
| Activate new PRN order via chat | No | No | No | No (order upsert is separate authority) | No | No |
| Report unauthorized OTC | Report only | Report only | Report only | Review | — | No |
| Complete reassessment / result | When allowed | When allowed | When allowed | When allowed | Policy | No |
| Correct charted episode | Policy | Policy | Policy | Reviewer path | — | No |
| Cross-tenant read/write | No | No | No | No | No | No |

**Canonical center:** care recipient. Episode is not owned by the first reporter; any authorized principal with access may complete follow-up.
