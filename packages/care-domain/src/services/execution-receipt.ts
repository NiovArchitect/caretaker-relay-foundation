/**
 * Structured execution receipts — understanding is not completion.
 * User-visible confirmation must derive from this receipt, never raw API slogans.
 */

import type { CareLoopResult, VerificationBundle } from "../types.js";

export type ActionExecutionLevel =
  | "fully_executable"
  | "draftable"
  | "reportable"
  | "review_required"
  | "unsupported";

export type CareActionCategory =
  | "med_administration"
  | "med_refusal"
  | "med_missed"
  | "med_uncertain"
  | "med_plan_change"
  | "med_discontinue"
  | "med_supply"
  | "med_advice"
  | "med_effect"
  | "observation"
  | "meal"
  | "appointment_change"
  | "task"
  | "communication"
  | "note"
  | "unknown";

export type SurfaceDestination =
  | "care_medications"
  | "care_pending_med_changes"
  | "care_observations"
  | "care_timeline"
  | "today_attention"
  | "today_glance"
  | "open_work"
  | "schedule"
  | "handoff"
  | "notifications"
  | "relay_retrieval"
  | "people_privacy"
  | "documents";

export type ExecutionReceipt = {
  requestId: string;
  actionCategories: CareActionCategory[];
  executionLevel: ActionExecutionLevel;
  recipientId: string;
  recipientName: string;
  actorId: string;
  actorName: string;
  result: "saved" | "pending_review" | "needs_clarification" | "denied" | "failed";
  savedRecordIds: {
    eventIds: string[];
    handoffId?: string;
    updateIds: string[];
    medicationRecordIds: string[];
    safetyReviewIds: string[];
    careNoteId?: string;
    taskTitles: string[];
  };
  screenDestinations: SurfaceDestination[];
  handoffInclusion: {
    whatChanged: string[];
    stillNeedsAttention: string[];
    watch: string[];
  };
  pendingReview: boolean;
  activeMedicationPlanChanged: boolean;
  userVisibleConfirmation: string;
  correctionPath: string;
  timestamp: string;
  auditCorrelation: string[];
  originalText?: string;
};

function categorizeCandidate(statement: string, eventType: string): CareActionCategory {
  const s = statement.toLowerCase();
  if (/does not provide dosing advice|permission to dose/.test(s)) return "med_advice";
  if (/medication change needs verification|discontinue/.test(s)) {
    return /discontinue/.test(s) ? "med_discontinue" : "med_plan_change";
  }
  if (/supply|refill/.test(s)) return "med_supply";
  if (/refused|was not given|not given/.test(s)) return "med_refusal";
  if (/missed/.test(s)) return "med_missed";
  if (/uncertain medication|not confirmed administration/.test(s)) return "med_uncertain";
  if (/after .* reported association|experienced .* after/.test(s)) return "med_effect";
  if (eventType === "medication_administration") return "med_administration";
  if (eventType === "observation") return "observation";
  if (eventType === "meal") return "meal";
  if (eventType === "appointment_change") return "appointment_change";
  if (eventType === "task") return "task";
  if (eventType === "communication_request") return "communication";
  if (eventType === "note") return "note";
  return "unknown";
}

function destinationsFor(cat: CareActionCategory): SurfaceDestination[] {
  switch (cat) {
    case "med_administration":
      return ["care_medications", "care_timeline", "handoff", "relay_retrieval"];
    case "med_refusal":
    case "med_missed":
      return ["care_medications", "today_attention", "handoff", "relay_retrieval"];
    case "med_plan_change":
    case "med_discontinue":
      return [
        "care_pending_med_changes",
        "today_attention",
        "open_work",
        "handoff",
        "notifications",
        "relay_retrieval",
      ];
    case "med_supply":
      return ["open_work", "today_attention", "handoff", "relay_retrieval"];
    case "med_uncertain":
    case "med_advice":
      return ["care_timeline", "relay_retrieval"];
    case "med_effect":
      return ["care_observations", "today_attention", "handoff", "relay_retrieval"];
    case "observation":
      return ["care_observations", "today_glance", "handoff", "relay_retrieval"];
    case "meal":
      return ["care_timeline", "today_glance", "handoff", "relay_retrieval"];
    case "appointment_change":
      return ["schedule", "today_glance", "handoff", "relay_retrieval"];
    case "task":
      return ["open_work", "today_attention", "handoff"];
    case "communication":
      return ["notifications", "relay_retrieval"];
    default:
      return ["care_timeline", "relay_retrieval"];
  }
}

function levelFor(cats: CareActionCategory[]): ActionExecutionLevel {
  if (cats.some((c) => c === "med_plan_change" || c === "med_discontinue")) {
    return "review_required";
  }
  if (cats.some((c) => c === "med_advice")) return "reportable";
  if (cats.some((c) => c === "med_administration" || c === "observation" || c === "meal")) {
    return "reportable";
  }
  if (cats.some((c) => c === "med_supply" || c === "task")) return "fully_executable";
  return "reportable";
}

/** Build receipt after successful confirmAndPersist. */
export function buildExecutionReceipt(input: {
  bundle: VerificationBundle;
  result: CareLoopResult;
  actorId: string;
  actorName: string;
  requestId?: string;
}): ExecutionReceipt {
  const { bundle, result } = input;
  const candidates = bundle.understood.candidates ?? [];
  const cats = [
    ...new Set(
      candidates.map((c) => categorizeCandidate(c.statement, c.eventType)),
    ),
  ];
  const dest = [...new Set(cats.flatMap(destinationsFor))];
  const taskTitles = candidates
    .filter((c) => c.eventType === "task")
    .map((c) => c.statement);
  const pendingReview = cats.some(
    (c) => c === "med_plan_change" || c === "med_discontinue" || c === "med_uncertain",
  );
  const p = result.persisted;
  const lines = candidates.map((c) => c.statement);
  const recipient = bundle.understood.careRecipientName;
  let userVisible: string;
  if (!p?.eventIds?.length && !taskTitles.length) {
    userVisible = `Nothing durable was saved for ${recipient}. You can correct the wording and try again.`;
  } else if (pendingReview) {
    userVisible = `I saved a report for ${recipient} that needs verification (not an active medication-plan change): ${lines.slice(0, 3).join("; ")}. It will appear under pending medication changes, Today attention, and the next-shift handoff.`;
  } else {
    userVisible = `I recorded this for ${recipient}: ${lines.slice(0, 3).join("; ")}. It is on the care record${p?.handoffId ? " and included for the next caregiver handoff" : ""}.`;
  }

  return {
    requestId: input.requestId ?? `rcpt-${Date.now().toString(36)}`,
    actionCategories: cats.length ? cats : ["unknown"],
    executionLevel: levelFor(cats),
    recipientId: bundle.understood.careRecipientId,
    recipientName: recipient,
    actorId: input.actorId,
    actorName: input.actorName,
    result: pendingReview
      ? "pending_review"
      : p?.eventIds?.length
        ? "saved"
        : "needs_clarification",
    savedRecordIds: {
      eventIds: p?.eventIds ?? [],
      handoffId: p?.handoffId,
      updateIds: p?.updateIds ?? [],
      medicationRecordIds: p?.medicationRecordIds ?? [],
      safetyReviewIds: p?.safetyReviewIds ?? [],
      careNoteId: p?.careNoteId,
      taskTitles,
    },
    screenDestinations: dest,
    handoffInclusion: {
      whatChanged: lines.filter((l) => !/uncertain|advice/i.test(l)).slice(0, 6),
      stillNeedsAttention: taskTitles.length
        ? taskTitles
        : lines.filter((l) => /refused|missed|needs verification|supply/i.test(l)).slice(0, 6),
      watch: lines.filter((l) => /observation|fever|dizzy|pain|after/i.test(l)).slice(0, 4),
    },
    pendingReview,
    activeMedicationPlanChanged: false,
    userVisibleConfirmation: userVisible,
    correctionPath:
      "Use Correct something in Relay, or open Care history to file a correction with provenance.",
    timestamp: new Date().toISOString(),
    auditCorrelation: result.auditIds ?? [],
    originalText: bundle.understood.rawText,
  };
}
