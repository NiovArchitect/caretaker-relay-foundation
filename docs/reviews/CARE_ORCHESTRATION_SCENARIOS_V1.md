# Care Orchestration Scenarios V1

Harness: `caretaker-relay/scripts/scenario-orchestration.mjs`

| ID | Scenario |
|----|----------|
| S1 | Marcus → Maya full loop: request → wait → respond → verify → MAR → follow-up answer |
| S2 | Marcus → Dr Shah full loop: offer → request → Shah notif → respond → Marcus notif → guidance confirm |
| S3 | No auto-promote MAR after Maya reply |
| S4 | Daniel coordination → Marcus notification |
| S5 | Open loops endpoint |
| S6 | Reject candidate |
| S7 | Robert isolation; Maya not valid Robert target |
| S8 | Handoff refresh after confirm |
| S9 | Dr Shah lab principal + auth |
| S10 | What changed after orchestration activity |

Run:

```bash
CARE_API_URL=https://caretaker-relay-care-api.onrender.com node scripts/scenario-orchestration.mjs
```
