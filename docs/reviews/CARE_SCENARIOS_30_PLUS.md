# Care Scenarios 30+

Harness: `caretaker-relay/scripts/scenarios-30-plus.mjs`

| ID | Category | Flow |
|----|----------|------|
| S01–S06 | Family | med due, Maya attribution, false double dose, what changed, waiting-on, appointment |
| S07–S11 | DSP | status, Daniel→Marcus coord, handoff Q, Robert isolation, idempotent retry |
| S12–S16 | Provider/safety | causal no Dx, Shah loop, Shah on Robert wrong, role assert, injection |
| S17–S21 | Orchestration | Maya verify, reject, open loops, appointment reminders, server notifs |
| S22–S26 | Isolation/sloppy | Robert isolation, cross-recipient, Maya not on Robert, insulin false, sloppy NL |
| S27–S32 | Judge | guess refuse, delete refuse, need-now, temporal, no fake SMS, mark-done refuse |

Run:

```bash
CARE_API_URL=https://caretaker-relay-care-api.onrender.com node scripts/scenarios-30-plus.mjs
```
