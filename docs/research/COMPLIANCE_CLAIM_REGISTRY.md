# ComplianceClaimRegistry — Caretaker Relay PRN

**Version:** 2026-07-30  
**Owner:** Agent Zero / product  
**Rule:** Unsupported compliance claims must remain **0**.

| claim | product surface | supporting authority | jurisdiction | setting | evidence | reviewer | approval state | limitation | review by |
|-------|-----------------|----------------------|--------------|---------|----------|----------|----------------|------------|-----------|
| Designed around authoritative medication-safety guidance | product copy, scorecards | CA DDS MAR PRN reason/result; CMS order documentation themes; ACL judging criteria | multi; not universal | multi-setting engine | `FINAL_SYSTEM_PRN_PRIMARY_SOURCE_RESEARCH.md` | Agent Zero | **allowed_product_wording** | Not a certification | 2026-10-30 |
| Supports reason-and-result PRN charting | Care History, Relay, episode model | CA DDS Filling Out a MAR (PRN reason + results) | CA DDS practice; advisory elsewhere | community / home / facility-configurable | episode fields + public journey | Agent Zero | **allowed_product_wording** | Not a certified MAR | 2026-10-30 |
| Maintains an auditable medication administration history | audit + completedRecent | documentation + audit trail principles | multi | multi | `PRN_ADMINISTERED` / `PRN_REASSESSED` audit | Agent Zero | **allowed_product_wording** | Not eMAR certification | 2026-10-30 |
| Configurable to organization and jurisdiction policies | policy-pack stub / protocol engine | setting variation matrix | multi | multi | research matrices | Agent Zero | **allowed_product_wording** | Full packs incomplete | 2026-10-30 |
| Human verification remains required | Relay confirm PRN | human-in-the-loop safety | multi | multi | preview → confirm path | Agent Zero | **allowed_product_wording** | — | 2026-10-30 |
| Not a substitute for an authorized medication order or clinical judgment | all PRN surfaces | safety boundary | multi | multi | no dose invention; OTC ≠ plan | Agent Zero | **required_disclaimer** | Always on | 2026-10-30 |
| CMS certified | — | — | — | — | none | — | **FORBIDDEN** | Never without formal review | — |
| Joint Commission compliant | — | — | — | — | none | — | **FORBIDDEN** | — | — |
| HIPAA compliant | — | — | — | — | none | — | **FORBIDDEN** until qualified review | — | — |
| Certified MAR / eMAR | — | — | — | — | none | — | **FORBIDDEN** | — | — |
| Government approved | — | — | — | — | none | — | **FORBIDDEN** | — | — |
| Meets all medication-administration laws | — | — | — | — | none | — | **FORBIDDEN** | — | — |

**UNSUPPORTED COMPLIANCE CLAIMS in product surfaces this release: 0**
