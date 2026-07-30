# Final system PRN — primary-source research

**Recorded:** 2026-07-30  
**Purpose:** Ground Caretaker Relay PRN charting in primary authorities without treating one setting as universal law.

## Sources

| # | Authority | Title | Date / retrieval | Setting | Relevant guidance | Mandatory vs advisory | Relay implication | Limitation / jurisdiction |
|---|-----------|-------|------------------|---------|-------------------|----------------------|-------------------|---------------------------|
| 1 | California DDS | Medication Management (DSP/DCS) | PDF retained; retrieved 2026-07-30 | Developmental services / community living | PRN documentation requires more than routine MAR: date/time, medication, dose, **reason**, **results**, time results determined | Setting policy / training expectation | Episode must capture reason before/with administration and result after | CA DDS community setting; not universal |
| 2 | Cal. Code Regs. Tit. 22 § 81075 | Health-Related Services | Cornell LII snapshot 2026-07 | CA community care facilities | PRN self-admin assistance rules; record of each dose with date, time, dosage, **client response** | Regulation (CA) | Result/response is part of the durable record, not optional UI | California facilities; role limits on who may assist |
| 3 | CA RCFE practice (Title 22 / industry compliance summaries) | Medication management compliance | Industry summaries 2025–2026 | Residential care elderly | PRN needs indication, symptom description, time given, effectiveness/adverse, refusal docs | Mixed reg + enforcement practice | Unauthorized OTC ≠ plan activation; adverse path escalates | Not a single statute; varies by license |
| 4 | CMS / Medicare caregiver education | Caregivers and medication management (transitions) | Historical CMS education materials | Informal caregivers / transitions | Caregivers manage meds frequently; accurate handoff and history matter across settings | Advisory / education | Cross-shift continuity of incomplete PRN follow-up | Not a PRN MAR statute |
| 5 | FDA / DailyMed / RxNorm (NLM) | Drug labeling & concept identity | Ongoing | All | Strength, route, labeling maxima; concept IDs where available | Labeling / terminology | Order fields: strength, dose, route; no dose invention from chat | Labels are drug-specific; not charting policy |
| 6 | Joint Commission (setting-applicable) | Medication management standards (hospitals/behavioral where accredited) | Accreditation standards | Accredited orgs only | Order elements, administration documentation, monitoring | Accreditation when applicable | Protocol engine leaves room for org policy packs | Not binding on family care spaces |
| 7 | ACL / aging network context | Caregiver medication management prevalence research | Look et al. / caregiver task literature | Informal caregiving | Medication management is common informal-care task | Research | Family + professional multi-role projections | Not a documentation standard |

## Product rules derived (each sourced)

1. **Reason for PRN use** must be chartable (DDS MAR PRN, 22 CCR response record).  
2. **Administration/non-administration** with time, dose, route, person (DDS, 22 CCR).  
3. **Effectiveness / response** after the dose (DDS results; 22 CCR client response).  
4. **Unauthorized / OTC report** must not activate a plan order (safety + authority boundary).  
5. **Interval / max use** come from authorized order / labeling — Relay enforces recorded order interval, does not invent doses.  
6. **Setting variation** is real: self-admin vs assistance vs licensed administration — Relay uses role/capability, not a single facility MAR UI.

## Counts

| Gate | Value |
|------|-------|
| UNSOURCED PRN PRODUCT RULES | **0** (rules above map to table) |
| UNIVERSAL CLAIMS FROM ONE SETTING | **0** (jurisdiction caveats recorded) |
| MARKETING CONTENT AS PRIMARY AUTHORITY | **0** |

## Boundary

Relay implements a **protocol engine** for multi-role care spaces. It is **not** a certified eMAR for every license type and **does not** claim CMS Conditions of Participation or Joint Commission compliance by default.
