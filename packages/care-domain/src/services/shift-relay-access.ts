/**
 * DSP / paid-caregiver shift-window authorization for Relay.
 * Family / controlling roles skip this path (not_shift_role).
 *
 * States: proposed → invited → accepted → scheduled → pre_shift → active →
 * ending → documentation_window → completed/expired/revoked/replaced.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareDataDomain } from "./minimum-necessary.js";
import {
  listShiftAssignments,
  type ShiftAssignment,
  type ShiftAssignmentStatus,
} from "./dsp-assignment.js";
import { listInvitations } from "./invitation.js";

/** Pre-shift prep window (ms before shiftStart). */
export const PRE_SHIFT_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Post-shift documentation window (ms after shiftEnd). */
export const DOC_WINDOW_MS = 2 * 60 * 60 * 1000;
/** Ending phase: last 15 minutes of active shift. */
export const ENDING_WINDOW_MS = 15 * 60 * 1000;

export type ShiftRelayPhase =
  | "proposed"
  | "invited"
  | "accepted"
  | "scheduled"
  | "pre_shift"
  | "active"
  | "ending"
  | "documentation_window"
  | "completed"
  | "expired"
  | "revoked"
  | "replaced"
  | "declined"
  | "missed"
  | "cancelled"
  | "no_assignment";

export type ShiftRelayDecision =
  | { kind: "not_shift_role" }
  | {
      kind: "denied";
      code: string;
      phase: ShiftRelayPhase;
      answer: string;
      assignmentId?: string;
    }
  | {
      kind: "authorized";
      phase: ShiftRelayPhase;
      assignmentId: string;
      domains: CareDataDomain[];
      /** When true, only documentation intents may proceed (handoff / own note). */
      documentationOnly: boolean;
    };

const PREP_DOMAINS: CareDataDomain[] = [
  "demographics_basic",
  "schedules_coverage",
  "handoffs",
  "preferences_routines",
  "appointments",
];

const ACTIVE_DOMAINS: CareDataDomain[] = [
  "demographics_basic",
  "daily_observations",
  "meals_hydration",
  "mobility",
  "symptoms",
  "behavioral_notes",
  "schedules_coverage",
  "handoffs",
  "appointments",
  "preferences_routines",
  "medication_admin",
  "tasks" as CareDataDomain,
].filter(Boolean) as CareDataDomain[];

// tasks is not a CareDataDomain — use daily_observations + schedules
const ACTIVE_SHIFT_DOMAINS: CareDataDomain[] = [
  "demographics_basic",
  "daily_observations",
  "meals_hydration",
  "mobility",
  "symptoms",
  "behavioral_notes",
  "schedules_coverage",
  "handoffs",
  "appointments",
  "preferences_routines",
  "medication_admin",
];

const DOC_DOMAINS: CareDataDomain[] = [
  "handoffs",
  "daily_observations",
  "demographics_basic",
];

/** Bounded PRN continuity during documentation window / next-coverage handoff. */
const PRN_CONTINUITY_DOMAINS: CareDataDomain[] = [
  "handoffs",
  "medication_admin",
  "symptoms",
  "demographics_basic",
];

const DENY_NO_CARE =
  "You do not currently have authorized access to a care profile for that request. An invitation, approval, or assignment is required.";
const DENY_INACTIVE =
  "Your care access for this person is no longer active. I cannot share care details with expired or revoked access.";
const DENY_SHIFT_WINDOW =
  "I can't share care details outside your authorized shift window. Access is limited to your assigned shift and documentation period.";
const DENY_PRE_ACCEPT =
  "Your shift invitation has not been accepted yet. Accept the assignment before I can share care information.";
const DENY_DOC_ONLY =
  "Your operational shift access has ended. During the documentation window you may only finalize handoff notes and correct your own shift reports — not open general care questions.";

function isShiftScopedRelationship(
  store: CareStore,
  principalId: string,
  careRecipientId: string,
): boolean {
  const rel = store.getRelationship(careRecipientId, principalId);
  if (!rel) return false;
  if (rel.role === "paid_caregiver" || /dsp|direct support|paid caregiver/i.test(rel.roleLabel)) {
    return true;
  }
  if (rel.access.authorityLimits?.includes("shift_scoped")) return true;
  return false;
}

function hasAnyShiftAssignment(
  store: CareStore,
  principalId: string,
  careRecipientId: string,
): boolean {
  return listShiftAssignments(store, careRecipientId).some(
    (a) => a.assigneePersonId === principalId,
  );
}

/** Latest relevant assignment for principal×recipient. */
export function latestAssignmentForPrincipal(
  store: CareStore,
  careRecipientId: string,
  principalId: string,
): ShiftAssignment | undefined {
  return listShiftAssignments(store, careRecipientId)
    .filter((a) => a.assigneePersonId === principalId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/**
 * Derive operational phase from assignment + wall clock.
 * Pure (does not mutate store) except callers may persist transitions separately.
 */
export function deriveShiftPhase(
  assignment: ShiftAssignment,
  nowMs: number = Date.now(),
): ShiftRelayPhase {
  const status = assignment.status as ShiftAssignmentStatus;
  if (status === "proposed") return "proposed";
  if (status === "invited") return "invited";
  if (status === "declined") return "declined";
  if (status === "revoked") return "revoked";
  if (status === "replaced") return "replaced";
  if (status === "expired") return "expired";
  if (status === "cancelled") return "cancelled";
  if (status === "missed") return "missed";

  const start = Date.parse(assignment.shiftStart);
  const end = Date.parse(assignment.shiftEnd);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    if (status === "accepted" || status === "scheduled") return "scheduled";
    if (status === "active") return "active";
    if (status === "completed") return "completed";
    return status as ShiftRelayPhase;
  }

  if (status === "completed") {
    if (nowMs <= end + DOC_WINDOW_MS) return "documentation_window";
    return "completed";
  }

  if (nowMs < start - PRE_SHIFT_WINDOW_MS) {
    if (status === "accepted" || status === "scheduled") return "scheduled";
    return status as ShiftRelayPhase;
  }
  if (nowMs < start) {
    return "pre_shift";
  }
  if (nowMs <= end) {
    if (nowMs >= end - ENDING_WINDOW_MS) return "ending";
    return "active";
  }
  // past end
  if (nowMs <= end + DOC_WINDOW_MS) {
    return "documentation_window";
  }
  return "expired";
}

export function domainsForShiftPhase(phase: ShiftRelayPhase): CareDataDomain[] {
  switch (phase) {
    case "pre_shift":
      return [...PREP_DOMAINS];
    case "active":
    case "ending":
      return [...ACTIVE_SHIFT_DOMAINS];
    case "documentation_window":
      return [...DOC_DOMAINS];
    default:
      return [];
  }
}

/** True if intent is allowed during documentation-only window. */
export function isDocumentationIntent(intents: string[]): boolean {
  return intents.some(
    (i) =>
      i === "HANDOFF_PREP" ||
      i === "HANDOFF_REVIEW" ||
      i === "OBSERVATION_HISTORY" ||
      i === "CHANGE_SINCE" ||
      i === "RECENT_ACTIVITY",
  );
}

/**
 * Bounded continuity intents for incomplete as-needed (PRN) reassessment.
 * Does not grant broad medication-plan access — only follow-up charting language.
 */
export function isPrnContinuityIntent(
  question: string,
  intents: string[] = [],
): boolean {
  const q = question.toLowerCase();
  if (
    intents.some(
      (i) =>
        i === "MEDICATION_HISTORY" ||
        i === "MEDICATION_ADMIN" ||
        i === "MEDICATION_STATUS" ||
        i === "OPEN_LOOP_STATUS" ||
        i === "TASKS_REMAINING" ||
        i === "HANDOFF_REVIEW",
    )
  ) {
    // Still require PRN/follow-up language so general med questions stay denied in doc window
    if (
      /as[- ]?needed|prn|follow-?up|reassess|did it help|helped|nausea|ondansetron|acetaminophen|tylenol|chart(ed)?|result after|how (are|is) .{0,20}(pain|nausea|feeling)/i.test(
        q,
      )
    ) {
      return true;
    }
  }
  return (
    /^(it )?(helped|didn'?t help|did not help|no (clear )?change|worse|worsened|better)\b/i.test(
      question.trim(),
    ) ||
    /\b(pain is|it is|nausea is) (down to|better|worse)/i.test(q) ||
    /\bas[- ]?needed (follow-?up|medication|dose)\b|\bprn (follow-?up|episode|reassess)/i.test(
      q,
    ) ||
    /\bstill needs (to be )?(checked|charted|followed)/i.test(q) ||
    /\bwhat (as-needed|prn).{0,40}(follow|check|open|left)\b/i.test(q) ||
    /\bwhen was (the )?(last )?(as-needed|prn)\b/i.test(q) ||
    /\bconfirm prn\b|\bchart(ed)? (as-needed|prn)\b/i.test(q) ||
    /\b(mark|record).{0,20}(helped|did not help|result)\b/i.test(q)
  );
}

export function prnContinuityDomains(): CareDataDomain[] {
  return [...PRN_CONTINUITY_DOMAINS];
}

/**
 * Resolve shift-scoped Relay access for a principal.
 * Non-DSP relationships without shift assignments → not_shift_role (family path).
 */
export function resolveShiftRelayAccess(
  store: CareStore,
  input: {
    principalId: string;
    careRecipientId: string;
    roleLabel?: string;
    nowMs?: number;
  },
): ShiftRelayDecision {
  const nowMs = input.nowMs ?? Date.now();
  const shiftScoped =
    isShiftScopedRelationship(store, input.principalId, input.careRecipientId) ||
    hasAnyShiftAssignment(store, input.principalId, input.careRecipientId) ||
    /dsp|direct support|paid caregiver/i.test(input.roleLabel ?? "");

  // Pending invitation without active membership → deny (invited-not-accepted)
  const rel = store.getRelationship(
    input.careRecipientId,
    input.principalId,
  );
  if (!rel || rel.status !== "active") {
    const invs = listInvitations(store, input.careRecipientId);
    const pendingInvite = invs.find(
      (i) =>
        i.inviteePersonId === input.principalId && i.status === "pending",
    );
    if (pendingInvite) {
      return {
        kind: "denied",
        code: "INVITED_NOT_ACCEPTED",
        phase: "invited",
        answer: DENY_PRE_ACCEPT,
      };
    }
  }

  if (!shiftScoped) {
    return { kind: "not_shift_role" };
  }

  const assignment = latestAssignmentForPrincipal(
    store,
    input.careRecipientId,
    input.principalId,
  );

  if (!assignment) {
    // Shift-scoped role but no assignment → deny operational care answers
    if (rel?.status === "active" && !rel.access.authorityLimits?.includes("shift_scoped")) {
      // permanent paid caregiver without shift rows — allow via normal path
      return { kind: "not_shift_role" };
    }
    return {
      kind: "denied",
      code: "NO_ACTIVE_SHIFT",
      phase: "no_assignment",
      answer: DENY_SHIFT_WINDOW,
    };
  }

  const phase = deriveShiftPhase(assignment, nowMs);

  if (
    phase === "invited" ||
    phase === "proposed" ||
    phase === "declined" ||
    phase === "cancelled" ||
    phase === "missed"
  ) {
    return {
      kind: "denied",
      code:
        phase === "invited" || phase === "proposed"
          ? "INVITED_NOT_ACCEPTED"
          : "SHIFT_NOT_ACTIVE",
      phase,
      assignmentId: assignment.id,
      answer:
        phase === "invited" || phase === "proposed"
          ? DENY_PRE_ACCEPT
          : DENY_SHIFT_WINDOW,
    };
  }

  if (phase === "scheduled") {
    return {
      kind: "denied",
      code: "BEFORE_PRE_SHIFT_WINDOW",
      phase,
      assignmentId: assignment.id,
      answer: DENY_SHIFT_WINDOW,
    };
  }

  if (phase === "expired" || phase === "revoked" || phase === "replaced" || phase === "completed") {
    return {
      kind: "denied",
      code:
        phase === "revoked"
          ? "REVOKED"
          : phase === "replaced"
            ? "SHIFT_REPLACED"
            : "EXPIRED",
      phase,
      assignmentId: assignment.id,
      answer: DENY_INACTIVE,
    };
  }

  if (phase === "documentation_window") {
    return {
      kind: "authorized",
      phase,
      assignmentId: assignment.id,
      domains: domainsForShiftPhase(phase),
      documentationOnly: true,
    };
  }

  if (phase === "pre_shift" || phase === "active" || phase === "ending") {
    // Intersect assignment dataDomains when present
    const assigned = new Set(
      (assignment.dataDomains ?? []).map((d) => d as CareDataDomain),
    );
    let domains = domainsForShiftPhase(phase);
    if (assigned.size > 0) {
      domains = domains.filter(
        (d) =>
          assigned.has(d) ||
          d === "demographics_basic" ||
          d === "handoffs" ||
          d === "schedules_coverage",
      );
      // Map legacy domain names
      if (assigned.has("daily_observations" as CareDataDomain) || assignment.dataDomains.includes("daily_observations")) {
        // keep
      }
    }
    return {
      kind: "authorized",
      phase,
      assignmentId: assignment.id,
      domains,
      documentationOnly: false,
    };
  }

  return {
    kind: "denied",
    code: "SHIFT_NOT_ACTIVE",
    phase,
    assignmentId: assignment.id,
    answer: DENY_SHIFT_WINDOW,
  };
}

/** Re-export constants for tests. */
export const SHIFT_DOMAIN_PRESETS = {
  PREP_DOMAINS,
  ACTIVE_SHIFT_DOMAINS,
  DOC_DOMAINS,
  PRN_CONTINUITY_DOMAINS,
  DENY_NO_CARE,
  DENY_INACTIVE,
  DENY_SHIFT_WINDOW,
  DENY_PRE_ACCEPT,
  DENY_DOC_ONLY,
};
