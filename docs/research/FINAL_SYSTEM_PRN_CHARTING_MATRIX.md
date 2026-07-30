# PRN charting matrix (reason → administration → result)

| Step | Required data | Durable object | Surfaces while open | Surfaces when complete |
|------|---------------|----------------|---------------------|------------------------|
| 1. Symptom / need | Symptom, optional severity | Episode (or preview) | Relay | — |
| 2. Order match | Order id, med, dose, route, indication | Links `prn_order_id` | Care As-needed | Care / inventory |
| 3. Eligibility / interval | Interval status | Episode checks | Relay preview | — |
| 4. Confirmation | Confirm language or API confirm | Episode `administered` / `reassessment_due` | Today, My Shift, Handoff, Attention | — |
| 5. Administration record | Dose, route, time, person | Episode + MAR-style med record | Care | History/MAR |
| 6. Reassessment due | Due time, owner via coverage | Same episode | Today (actionable only), Attention if overdue | — |
| 7. Result | Effect, optional severity after | Same episode completed | — | History/MAR, Relay retrieval |
| 8. Non-admin paths | Refused / withheld / unavailable | Episode outcome | Care / Attention | History |
| 9. Unauthorized OTC | Med + symptom as REPORTED | Episode `unauthorizedReport` | Flag / review | Not active order |

**One episode → many projections. Zero independent work/attention/handoff clones without lineage.**
