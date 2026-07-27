# Harmonized Ambient Care Experience — Gap Matrix

**Campaign:** CARETAKER RELAY — HARMONIZED AMBIENT CARE EXPERIENCE  
**Date:** 2026-07-27  
**Mode:** Prove gaps → implement missing → public smoke → deploy exact SHAs

| Capability | Pre-campaign | Gap proof | Implementation | Public proof target |
|---|---|---|---|---|
| Next-action ownership | Partial (tasks/handoff text) | No durable owner state machine | `care-work-items.ts` CARE_WORK_V1 | Today work panel + API work-items |
| Unassigned work / claiming | Missing | No claim API | create/claim/transition routes | claim button on Today |
| Cross-role handoff | Handoff primitive exists | Role projection thin | `projectHandoffForRole` | handoff projection API |
| Shift-end handoff | DSP completeShiftHandoff | Boundary checklist missing | `shiftBoundaryChecklist` | `/shifts/:id/boundary` |
| No-replacement escalation | Partial DSP decline path | Overdue work silent | `escalateOverdueWork` | escalate buttons + API |
| Since-last-visit briefing | Partial Today whatChanged | Not structured briefing | `buildSinceLastVisit` | `#since-last-visit` |
| Multi-recipient isolation | rid() + access | Consequential confirm weak | `assertActiveRecipientContext` | confirm checkbox on create |
| Shared-device protection | session revoke exists | Confirm before create | same guard + UI confirm | work create requires confirm |
| Notification delivery/ack/no-response | markSeen/ack/resolve | Ops labeling weak | `notificationOpsStatus` | notification-ops panel |
| Correction propagation | applyCorrection | Evidence labels weak | `labelFromEpistemic` | evidence badges |
| Evidence/report/inference labeling | epistemic on events | Not surfaced | labels in since-last-visit | evidence-label badges |
| Calendar truth states | schedule engine | Honest labels missing | `calendarTruthForAppointment` | calendar-truth list |
| Emergency information | Care profile snapshot | Card API missing | `buildEmergencyCard` | emergency-card API + Care tab |
| Representative authority | access scopes | unchanged | privacy/access already | privacy center (prior) |
| Offline / sync states | none | no label | `describeSyncState` + UI | sync-state-label |
| Document-to-action | documents service | not full | work items can be created from Today | create work from action |
| Recurrence exceptions | schedule engine partial | not expanded this pass | calendar truth honesty | calendar-truth API |
| Empty states | lightweight empty | work empty added | work-empty-state | empty work copy |
| Leaving / archive journeys | revoke/export prior | not re-litigated | preserve prior | prior privacy revoke |
| Flagship judge journey | prior e2e | new harmonized e2e | `harmonized-care-experience.spec.ts` | public browser |
| Adversarial journey bank | isolation tests | extended unit | stranger denied work/emergency | unit + multi-tenant |

## Authority notes

- Server authorization remains authority; claim ≠ membership.
- No HIPAA-compliant claims.
- Soft Translucent brand preserved.
- Prisma flush/login performance not reopened.
