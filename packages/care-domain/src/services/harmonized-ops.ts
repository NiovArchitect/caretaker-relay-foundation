/**
 * Harmonized ambient ops: since-last-visit, shared handoff projection,
 * emergency card, calendar truth labels, evidence labels, multi-recipient guard.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareHandoff } from "../types.js";
import { evaluateAccess } from "./access.js";
import { buildTimeline } from "./care-event-etl.js";
import { listWorkItems, listNeedsOwner } from "./care-work-items.js";
import { listConflicts } from "./conflict-center.js";
import { listShiftAssignments } from "./dsp-assignment.js";
import { listNotificationsForPrincipal } from "./notifications.js";

export type EvidenceLabel =
  | "fact"
  | "report"
  | "confirmation"
  | "conflict"
  | "correction"
  | "ai_inference"
  | "operational";

export function labelFromEpistemic(
  epistemic?: string,
  truth?: string,
  type?: string,
): EvidenceLabel {
  if (type === "correction" || truth === "corrected") return "correction";
  if (truth === "disputed" || epistemic === "CONFLICTED") return "conflict";
  if (truth === "confirmed" || epistemic === "CONFIRMED") return "confirmation";
  if (epistemic === "INFERRED") return "ai_inference";
  if (truth === "reported" || epistemic === "REPORTED") return "report";
  return "fact";
}

export type CalendarTruthState =
  | "scheduled_in_relay"
  | "exported_ics"
  | "personal_calendar_unknown"
  | "shared_with_circle"
  | "requested_from_provider"
  | "confirmed_by_provider"
  | "cancelled";

export function calendarTruthForAppointment(status?: string, scheduleState?: string): {
  state: CalendarTruthState;
  label: string;
  honestNote: string;
} {
  const s = (scheduleState ?? status ?? "").toLowerCase();
  if (s.includes("cancel")) {
    return {
      state: "cancelled",
      label: "Cancelled in Caretaker Relay",
      honestNote: "Internal cancel only — provider booking not automatically changed.",
    };
  }
  if (s.includes("request") || s === "requested" || s === "tentative") {
    return {
      state: "requested_from_provider",
      label: "Requested / tentative",
      honestNote: "Not confirmed by an external provider.",
    };
  }
  if (s === "confirmed" || s === "scheduled" || s === "moved" || s === "rescheduled") {
    return {
      state: "scheduled_in_relay",
      label: "Scheduled inside Caretaker Relay",
      honestNote:
        "This is the shared care schedule. Export .ics or connect a calendar separately. Provider confirmation is not implied.",
    };
  }
  return {
    state: "scheduled_in_relay",
    label: "On the care schedule",
    honestNote: "Internal schedule truth only.",
  };
}

export type SinceLastVisitBriefing = {
  careRecipientId: string;
  recipientName: string;
  viewerPersonId: string;
  lastVisitAt: string | null;
  generatedAt: string;
  whatChanged: Array<{ text: string; evidence: EvidenceLabel; at?: string }>;
  openWork: Array<{
    id: string;
    action: string;
    owner: string;
    status: string;
    dueAt?: string | null;
  }>;
  needsOwner: Array<{ id: string; action: string; priority: string }>;
  conflicts: number;
  upcoming: Array<{ title: string; when: string; calendarTruth: string }>;
  corrections: Array<{ text: string; at: string }>;
  handoffSummary: string | null;
  plainSummary: string;
};

export function buildSinceLastVisit(
  store: CareStore,
  viewerPersonId: string,
  careRecipientId: string,
  lastVisitAt?: string | null,
):
  | { ok: true; briefing: SinceLastVisitBriefing }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(store, viewerPersonId, careRecipientId);
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const recipient = store.getRecipient(careRecipientId);
  const since =
    lastVisitAt && !Number.isNaN(Date.parse(lastVisitAt))
      ? Date.parse(lastVisitAt)
      : Date.now() - 24 * 60 * 60 * 1000;

  const timeline = buildTimeline(store, careRecipientId, { limit: 40 });
  const whatChanged = timeline
    .filter((e) => Date.parse(e.eventAt ?? e.occurredAt) >= since)
    .slice(0, 12)
    .map((e) => ({
      text: e.statement,
      evidence: labelFromEpistemic(e.epistemicStatus, e.truthState, e.type),
      at: e.eventAt ?? e.occurredAt,
    }));

  const work = listWorkItems(store, careRecipientId);
  const openWork = work.map((w) => ({
    id: w.id,
    action: w.action,
    owner: w.ownerDisplayName ?? w.ownerPersonId ?? "Unassigned",
    status: w.status,
    dueAt: w.dueAt,
  }));
  const needsOwner = listNeedsOwner(store, careRecipientId).map((w) => ({
    id: w.id,
    action: w.action,
    priority: w.priority,
  }));
  const conflicts = listConflicts(store, careRecipientId).length;
  const upcoming = store.getAppointments(careRecipientId).map((a) => {
    const ct = calendarTruthForAppointment(a.status, a.scheduleState);
    return {
      title: a.title,
      when: a.startsAtLabel ?? a.startsAt,
      calendarTruth: ct.label,
    };
  });
  const corrections = store.getCorrections(careRecipientId).map((c) => ({
    text: `${c.previousValue} → ${c.correctedValue}`,
    at: c.correctedAt,
  }));
  const handoffs = store.getHandoffs(careRecipientId);
  const latest = handoffs[handoffs.length - 1];
  const handoffSummary = latest
    ? `Last handoff: ${latest.whatChanged.slice(0, 2).join("; ") || "recorded"} · still needs: ${latest.stillNeedsAttention.slice(0, 2).join("; ") || "none listed"}`
    : null;

  const plainSummary = [
    whatChanged.length
      ? `${whatChanged.length} change(s) since you were last here`
      : "No new timeline events since your last visit window",
    openWork.length ? `${openWork.length} open work item(s)` : "No open work items",
    needsOwner.length ? `${needsOwner.length} need an owner` : null,
    conflicts ? `${conflicts} open conflict(s)` : null,
  ]
    .filter(Boolean)
    .join(". ");

  return {
    ok: true,
    briefing: {
      careRecipientId,
      recipientName: recipient?.displayName ?? careRecipientId,
      viewerPersonId,
      lastVisitAt: lastVisitAt ?? null,
      generatedAt: new Date().toISOString(),
      whatChanged,
      openWork,
      needsOwner,
      conflicts,
      upcoming,
      corrections,
      handoffSummary,
      plainSummary,
    },
  };
}

export type SharedHandoffProjection = {
  handoffId: string;
  careRecipientId: string;
  fromPersonId?: string;
  toPersonId?: string;
  periodLabel: string;
  whatHappened: string[];
  whatChanged: string[];
  completedTasks: string[];
  incompleteTasks: string[];
  openConcerns: string[];
  monitoring: string[];
  corrections: string[];
  conflicts: string[];
  scheduledNext: string[];
  owners: Array<{ action: string; owner: string }>;
  acknowledgment: "pending" | "acknowledged";
  roleView: "family" | "dsp" | "clinician" | "recipient" | "generic";
  plainLanguage: string;
};

export function projectHandoffForRole(
  store: CareStore,
  handoff: CareHandoff,
  roleView: SharedHandoffProjection["roleView"],
): SharedHandoffProjection {
  const work = listWorkItems(store, handoff.careRecipientId);
  const conflicts = listConflicts(store, handoff.careRecipientId);
  const apts = store.getAppointments(handoff.careRecipientId);
  const base: SharedHandoffProjection = {
    handoffId: handoff.id,
    careRecipientId: handoff.careRecipientId,
    fromPersonId: handoff.fromPersonId,
    toPersonId: handoff.toPersonId,
    periodLabel: `Handoff at ${handoff.createdAt}`,
    whatHappened: handoff.whatChanged,
    whatChanged: handoff.whatChanged,
    completedTasks: work
      .filter((w) => w.status === "completed")
      .map((w) => w.action)
      .slice(0, 8),
    incompleteTasks: work
      .filter((w) => w.status !== "completed" && w.status !== "cancelled")
      .map((w) => w.action)
      .slice(0, 8),
    openConcerns: handoff.stillNeedsAttention,
    monitoring: handoff.watch,
    corrections: store
      .getCorrections(handoff.careRecipientId)
      .slice(-5)
      .map((c) => c.correctedValue),
    conflicts: conflicts.map((c) => c.title),
    scheduledNext: apts
      .slice(0, 5)
      .map((a) => `${a.title} · ${a.startsAtLabel ?? a.startsAt}`),
    owners: work.slice(0, 8).map((w) => ({
      action: w.action,
      owner: w.ownerDisplayName ?? "Unassigned",
    })),
    acknowledgment: "pending",
    roleView,
    plainLanguage: "",
  };

  if (roleView === "family") {
    base.plainLanguage = `Family handoff: ${base.whatChanged.slice(0, 2).join("; ") || "updates on file"}. Still needs attention: ${base.openConcerns.join("; ") || "nothing listed"}.`;
  } else if (roleView === "dsp") {
    base.plainLanguage = `Shift handoff: complete unfinished tasks, note observations, confirm next coverage. Incomplete: ${base.incompleteTasks.join("; ") || "none"}.`;
  } else if (roleView === "clinician") {
    base.plainLanguage = `Clinical-facing handoff (reported vs confirmed preserved). Concerns: ${base.openConcerns.join("; ") || "none"}. Conflicts: ${base.conflicts.length}.`;
  } else if (roleView === "recipient") {
    base.plainLanguage = `What helpers recorded and what still needs your input. You stay in control of access.`;
  } else {
    base.plainLanguage = base.whatChanged.join("; ") || "Handoff recorded";
  }
  return base;
}

export type EmergencyCard = {
  careRecipientId: string;
  preferredName: string;
  communication: string[];
  emergencyContacts: Array<{ name: string; relation?: string; phone?: string }>;
  allergies: Array<{ label: string; source?: string }>;
  relevantConditions: Array<{ label: string; verification?: string }>;
  medications: Array<{ name: string; dose: string; schedule: string }>;
  mobility: string | null;
  cognitiveSupport: string | null;
  advanceDirectiveLocation: string | null;
  lastUpdated: string;
  sources: string[];
  incomplete: string[];
  accessNote: string;
};

export function buildEmergencyCard(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
):
  | { ok: true; card: EmergencyCard }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(store, actorPersonId, careRecipientId);
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const r = store.getRecipient(careRecipientId);
  const p = r?.profile;
  const incomplete: string[] = [];
  if (!p?.emergencyContacts?.length) incomplete.push("Emergency contacts");
  if (!p?.allergies?.length) incomplete.push("Allergies");
  if (!store.getMedSchedules(careRecipientId).length) incomplete.push("Medications");
  if (!p?.mobilityBaseline) incomplete.push("Mobility needs");

  const card: EmergencyCard = {
    careRecipientId,
    preferredName: r?.preferredName || r?.displayName || careRecipientId,
    communication: p?.communicationNeeds ?? [],
    emergencyContacts: (p?.emergencyContacts ?? []).map((c) => ({
      name: typeof c === "string" ? c : String((c as { name?: string }).name ?? c),
      relation:
        typeof c === "object" && c
          ? String(
              (c as { relationship?: string; relation?: string }).relationship ??
                (c as { relation?: string }).relation ??
                "",
            ) || undefined
          : undefined,
      phone:
        typeof c === "object" && c && "phone" in c
          ? String((c as { phone?: string }).phone ?? "") || undefined
          : undefined,
    })),
    allergies: (p?.allergies ?? []).map((a) =>
      typeof a === "string"
        ? { label: a }
        : {
            label: String((a as { label?: string }).label ?? a),
            source: (a as { sourceLabel?: string }).sourceLabel,
          },
    ),
    relevantConditions: (p?.confirmedConditions ?? []).map((c) => ({
      label: c.label,
      verification: c.verification,
    })),
    medications: store.getMedSchedules(careRecipientId).map((m) => ({
      name: m.name,
      dose: m.dose,
      schedule: m.scheduleLabel,
    })),
    mobility: p?.mobilityBaseline ?? null,
    cognitiveSupport: p?.cognitiveSupportNeeds?.join("; ") ?? null,
    advanceDirectiveLocation: null,
    lastUpdated: new Date().toISOString(),
    sources: ["Authorized care profile", "Medication schedules on file"],
    incomplete,
    accessNote:
      "Opening emergency information is audited. Temporary helpers only see this if membership allows emergency profile.",
  };
  store.writeAudit({
    at: new Date().toISOString(),
    actorPersonId,
    action: "EMERGENCY_CARD_VIEWED",
    careRecipientId,
    details: { incomplete: incomplete.length },
  });
  return { ok: true, card };
}

/** Multi-recipient context guard for consequential actions. */
export function assertActiveRecipientContext(input: {
  requestedRecipientId: string;
  sessionActiveRecipientId: string;
  confirmRecipientId?: string;
}): { ok: true } | { ok: false; code: string; message: string } {
  if (input.requestedRecipientId !== input.sessionActiveRecipientId) {
    return {
      ok: false,
      code: "RECIPIENT_CONTEXT_MISMATCH",
      message:
        "Active care recipient does not match this action. Switch context and confirm the correct person.",
    };
  }
  if (
    input.confirmRecipientId &&
    input.confirmRecipientId !== input.requestedRecipientId
  ) {
    return {
      ok: false,
      code: "RECIPIENT_CONFIRMATION_REQUIRED",
      message: "Confirm the care recipient name before this consequential action.",
    };
  }
  return { ok: true };
}

export type NotificationOpsStatus = {
  id: string;
  title: string;
  delivery: "recorded" | "unknown_external";
  seen: boolean;
  acknowledged: boolean;
  resolved: boolean;
  noResponse: boolean;
  escalateAfter?: string;
  plainStatus: string;
};

export function notificationOpsStatus(
  store: CareStore,
  principalId: string,
  careRecipientId: string,
): NotificationOpsStatus[] {
  const now = Date.now();
  return listNotificationsForPrincipal(store, principalId, careRecipientId).map(
    (n) => {
      const seen = Boolean(n.seenAt);
      const acknowledged = Boolean(n.acknowledgedAt);
      const resolved = Boolean(n.resolvedAt);
      const ageMs = now - Date.parse(n.createdAt);
      const noResponse = !acknowledged && !resolved && ageMs > 30 * 60 * 1000;
      const escalateAfter = new Date(
        Date.parse(n.createdAt) + 30 * 60 * 1000,
      ).toISOString();
      let plainStatus = "Recorded in Caretaker Relay inbox";
      if (resolved) plainStatus = "Resolved";
      else if (acknowledged) plainStatus = "Acknowledged";
      else if (seen) plainStatus = "Seen — not yet acknowledged";
      else if (noResponse)
        plainStatus = `No response — escalation window opened at ${escalateAfter}`;
      else plainStatus = "Delivered to in-app inbox (external SMS/email not configured)";
      return {
        id: n.id,
        title: n.title,
        delivery: "recorded" as const,
        seen,
        acknowledged,
        resolved,
        noResponse,
        escalateAfter,
        plainStatus,
      };
    },
  );
}

export type SyncState = "saved" | "pending_sync" | "failed" | "needs_review";

export function describeSyncState(online: boolean, pending: boolean, failed: boolean): {
  state: SyncState;
  label: string;
} {
  if (failed) return { state: "failed", label: "Failed — not saved to care service" };
  if (!online || pending)
    return { state: "pending_sync", label: "Pending sync — do not assume saved" };
  return { state: "saved", label: "Saved" };
}

export function shiftBoundaryChecklist(
  store: CareStore,
  careRecipientId: string,
  assignmentId: string,
): {
  unfinishedTasks: string[];
  handoffRequired: boolean;
  openConflicts: number;
  nextCoverage: string | null;
  safeToExpire: boolean;
  message: string;
} {
  const shifts = listShiftAssignments(store, careRecipientId);
  const a = shifts.find((s) => s.id === assignmentId);
  const unfinished = listWorkItems(store, careRecipientId)
    .filter((w) => w.status !== "completed" && w.status !== "cancelled")
    .map((w) => w.action);
  const openConflicts = listConflicts(store, careRecipientId).length;
  const handoffRequired = unfinished.length > 0 || openConflicts > 0;
  const next = shifts.find(
    (s) =>
      s.id !== assignmentId &&
      (s.status === "accepted" ||
        s.status === "scheduled" ||
        s.status === "active" ||
        s.status === "invited"),
  );
  const safeToExpire = !handoffRequired || Boolean(next);
  return {
    unfinishedTasks: unfinished,
    handoffRequired,
    openConflicts,
    nextCoverage: next
      ? `${next.assigneeDisplayName} (${next.status})`
      : null,
    safeToExpire,
    message: safeToExpire
      ? "Shift may end — coverage or handoff conditions met"
      : "Do not silently drop access: finish handoff or confirm replacement first",
  };
}
