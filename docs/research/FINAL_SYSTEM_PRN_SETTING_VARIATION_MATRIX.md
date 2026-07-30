# PRN setting variation matrix

| Dimension | Family home | DSP / DDS community | RCFE / assisted living | Clinical / hospital (accredited) | Relay model |
|-----------|-------------|---------------------|------------------------|----------------------------------|-------------|
| Who authorizes PRN order | Clinician / primary | Prescriber + org policy | Prescriber + facility | Privileged prescriber | `authorizedBy`, order source, active status |
| Who may administer / assist | Family, self, hired help | Trained DSP/DCS per policy | Designated staff; often assist self-admin | Licensed staff | `allowed action roles` / access evaluation |
| Charting medium | Often none / paper / app | PRN MAR + back side | MAR / eMAR | eMAR | Canonical episode + MAR-style med record row |
| Reason required | Best practice | Yes (DDS training) | Yes (compliance) | Yes | `symptom` / indication on episode |
| Result / reassessment | Best practice | Yes (results + time) | Effectiveness expected | Monitoring | `effect`, `severityAfter`, reassessment due |
| Interval enforcement | Label / clinician | Order + policy | Order + policy | Order + eMAR hard stops | `minIntervalHours` per order |
| OTC without order | Common gray area | Policy-restricted | Policy-restricted | Restricted | Unauthorized report, not plan activation |
| Handoff of incomplete result | Informal | Shift notes | Shift report | Clinical handoff | One open line on handoff + projections |

**Rule:** No single column is universal law for all Caretaker Relay care spaces.
