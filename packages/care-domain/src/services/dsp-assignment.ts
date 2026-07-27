/**
 * DSP assignment / shift lifecycle (competition-bounded, not a marketplace).
 * Durable via CareUpdate SHIFT_ASSIGN_V1 rows.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareRelationship } from "../types.js";
import { evaluateAccess } from "./access.js";
import { createNotificationIfNew } from "./notifications.js";
import { ingestCareEvent } from "./care-event-etl.js";

export type ShiftAssignmentStatus =
  | "proposed"
  | "invited"
  | "accepted"
  | "declined"
  | "scheduled"
  | "active"
  | "completed"
  | "missed"
  | "cancelled"
  | "replaced"
  | "expired"
  | "revoked";

export type ShiftAssignment = {
  id: string;
  careRecipientId: string;
  assigneePersonId: string;
  assigneeDisplayName: string;
  assignerPersonId: string;
  assignerDisplayName: string;
  status: ShiftAssignmentStatus;
  shiftStart: string;
  shiftEnd: string;
  timezone: string;
  scopeNote: string;
  dataDomains: string[];
  createdAt: string;
  updatedAt: string;
  declinedAt?: string;
  acceptedAt?: string;
  replacedByAssignmentId?: string;
  replacesAssignmentId?: string;
  coverageRequested?: boolean;
  handoffId?: string;
};

const PREFIX = "SHIFT_ASSIGN_V1:";

function encode(a: ShiftAssignment): string {
  return PREFIX + JSON.stringify(a);
}

function decode(summary: string): ShiftAssignment | null {
  if (!summary.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(summary.slice(PREFIX.length)) as ShiftAssignment;
  } catch {
    return null;
  }
}

function save(store: CareStore, a: ShiftAssignment): ShiftAssignment {
  store.addUpdate({
    id: a.id,
    careRecipientId: a.careRecipientId,
    toPersonId: a.assigneePersonId,
    summary: encode(a),
    status: "ready",
    safetyClass: "low",
    source: {
      id: `src-shift-${a.id}`,
      kind: "system_derived",
      label: "DSP assignment",
      actorPersonId: a.assignerPersonId,
      actorName: a.assignerDisplayName,
      recordedAt: a.updatedAt,
      whyVisible: "Shift assignment lifecycle",
    },
  });
  return a;
}

export function listShiftAssignments(
  store: CareStore,
  careRecipientId: string,
): ShiftAssignment[] {
  const byId = new Map<string, ShiftAssignment>();
  for (const u of store.getUpdates(careRecipientId)) {
    const a = decode(u.summary);
    if (a) byId.set(a.id, a);
  }
  return [...byId.values()].sort((x, y) =>
    y.shiftStart.localeCompare(x.shiftStart),
  );
}

export function getShiftAssignment(
  store: CareStore,
  careRecipientId: string,
  assignmentId: string,
): ShiftAssignment | undefined {
  return listShiftAssignments(store, careRecipientId).find(
    (a) => a.id === assignmentId,
  );
}

export type CreateShiftInput = {
  careRecipientId: string;
  assignerPersonId: string;
  assignerDisplayName: string;
  assigneePersonId: string;
  assigneeDisplayName: string;
  shiftStart: string;
  shiftEnd: string;
  timezone?: string;
  scopeNote?: string;
};

export function createShiftAssignment(
  store: CareStore,
  input: CreateShiftInput,
):
  | { ok: true; assignment: ShiftAssignment }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.assignerPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const now = new Date().toISOString();
  const assignment: ShiftAssignment = {
    id: store.newId("shift"),
    careRecipientId: input.careRecipientId,
    assigneePersonId: input.assigneePersonId,
    assigneeDisplayName: input.assigneeDisplayName,
    assignerPersonId: input.assignerPersonId,
    assignerDisplayName: input.assignerDisplayName,
    status: "invited",
    shiftStart: input.shiftStart,
    shiftEnd: input.shiftEnd,
    timezone: input.timezone ?? "America/Los_Angeles",
    scopeNote:
      input.scopeNote ??
      "Shift-scoped care tasks, observations, and handoff only",
    dataDomains: [
      "daily_observations",
      "schedules_coverage",
      "handoffs",
      "meals_hydration",
      "mobility",
    ],
    createdAt: now,
    updatedAt: now,
  };
  save(store, assignment);
  createNotificationIfNew(store, {
    principalId: input.assigneePersonId,
    careRecipientId: input.careRecipientId,
    type: "CARE_UPDATE",
    priority: "attention",
    title: "Shift invitation",
    body: `Shift ${input.shiftStart} – ${input.shiftEnd}. Accept or decline.`,
    sourceType: "shift_assignment",
    sourceId: assignment.id,
    actorPersonId: input.assignerPersonId,
    actorDisplayName: input.assignerDisplayName,
    actionType: "open_shift",
    actionTarget: assignment.id,
    dedupeKey: `shift-invite:${assignment.id}`,
  });
  store.writeAudit({
    at: now,
    actorPersonId: input.assignerPersonId,
    action: "SHIFT_ASSIGNMENT_CREATED",
    careRecipientId: input.careRecipientId,
    details: { assignmentId: assignment.id, status: assignment.status },
  });
  return { ok: true, assignment };
}

function ensureAssignee(
  store: CareStore,
  careRecipientId: string,
  personId: string,
  displayName: string,
  endDate?: string,
): void {
  const existing = store.getRelationship(careRecipientId, personId);
  const recipient = store.getRecipient(careRecipientId);
  if (!recipient) return;
  if (!store.getPerson(personId)) {
    store.upsertPerson({
      id: personId,
      displayName,
      kind: "professional",
    });
  }
  /** Shift acceptance must grant observation/task/handoff domains for the window. */
  const shiftAccess = {
    informationCategories: [
      "daily",
      "Daily updates",
      "observation",
      "Health observations",
      "Care tasks",
      "Care instructions",
      "Appointments",
      "medication_admin",
      "handoff",
    ],
    allowedActions: [
      "view",
      "record",
      "handoff",
      "record_observations",
      "complete_tasks",
      "view_schedule",
    ],
    canEscalate: true,
    authorityLimits: ["shift_scoped", "no_care_plan_change"],
  };
  const rel: CareRelationship = existing
    ? {
        ...existing,
        status: "active",
        endDate: endDate ?? existing.endDate,
        role: "paid_caregiver",
        roleLabel: "Direct support professional",
        scheduleNotes: "Active shift assignment",
        // Merge shift domains — do not leave stale transport-only scopes active mid-shift.
        access: {
          informationCategories: [
            ...new Set([
              ...(existing.access.informationCategories ?? []),
              ...shiftAccess.informationCategories,
            ]),
          ],
          allowedActions: [
            ...new Set([
              ...(existing.access.allowedActions ?? []),
              ...shiftAccess.allowedActions,
            ]),
          ],
          canEscalate: true,
          authorityLimits: [
            ...new Set([
              ...(existing.access.authorityLimits ?? []),
              "shift_scoped",
              "no_care_plan_change",
            ]),
          ],
        },
      }
    : {
        id: store.newId("rel"),
        careRecipientId,
        personId,
        role: "paid_caregiver",
        roleLabel: "Direct support professional",
        responsibilities: ["Shift care", "Observations", "Handoff"],
        access: shiftAccess,
        status: "active",
        startDate: new Date().toISOString().slice(0, 10),
        endDate,
        scheduleNotes: "Active shift assignment",
      };
  store.upsertRelationship(rel);
}

export function respondShiftAssignment(
  store: CareStore,
  input: {
    careRecipientId: string;
    assignmentId: string;
    actorPersonId: string;
    actorDisplayName: string;
    decision: "accept" | "decline";
  },
):
  | { ok: true; assignment: ShiftAssignment; coverage?: ShiftAssignment }
  | { ok: false; code: string; message: string } {
  const a = getShiftAssignment(
    store,
    input.careRecipientId,
    input.assignmentId,
  );
  if (!a) {
    return { ok: false, code: "NOT_FOUND", message: "Assignment not found" };
  }
  if (a.assigneePersonId !== input.actorPersonId) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Only the assigned DSP can accept or decline",
    };
  }
  const now = new Date().toISOString();
  if (input.decision === "decline") {
    const declined: ShiftAssignment = {
      ...a,
      status: "declined",
      declinedAt: now,
      updatedAt: now,
      coverageRequested: true,
    };
    save(store, declined);
    createNotificationIfNew(store, {
      principalId: a.assignerPersonId,
      careRecipientId: a.careRecipientId,
      type: "CARE_UPDATE",
      priority: "important",
      title: "Shift declined — coverage needed",
      body: `${a.assigneeDisplayName} declined the shift. Coverage required.`,
      sourceType: "shift_assignment",
      sourceId: a.id,
      actorPersonId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      actionType: "coverage_request",
      actionTarget: a.id,
      dedupeKey: `shift-declined:${a.id}`,
    });
    store.writeAudit({
      at: now,
      actorPersonId: input.actorPersonId,
      action: "SHIFT_DECLINED",
      careRecipientId: a.careRecipientId,
      details: { assignmentId: a.id },
    });
    return { ok: true, assignment: declined };
  }

  const accepted: ShiftAssignment = {
    ...a,
    status: "accepted",
    acceptedAt: now,
    updatedAt: now,
  };
  // Become scheduled/active based on wall clock
  const start = Date.parse(a.shiftStart);
  const end = Date.parse(a.shiftEnd);
  const t = Date.now();
  if (!Number.isNaN(start) && !Number.isNaN(end)) {
    if (t >= start && t <= end) accepted.status = "active";
    else if (t < start) accepted.status = "scheduled";
    else accepted.status = "completed";
  }
  ensureAssignee(
    store,
    a.careRecipientId,
    a.assigneePersonId,
    a.assigneeDisplayName,
    a.shiftEnd,
  );
  save(store, accepted);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "SHIFT_ACCEPTED",
    careRecipientId: a.careRecipientId,
    details: { assignmentId: a.id, status: accepted.status },
  });
  return { ok: true, assignment: accepted };
}

/** Assigner creates replacement after decline. */
export function createCoverageReplacement(
  store: CareStore,
  input: {
    careRecipientId: string;
    declinedAssignmentId: string;
    assignerPersonId: string;
    assignerDisplayName: string;
    replacementPersonId: string;
    replacementDisplayName: string;
  },
):
  | { ok: true; assignment: ShiftAssignment; prior: ShiftAssignment }
  | { ok: false; code: string; message: string } {
  const prior = getShiftAssignment(
    store,
    input.careRecipientId,
    input.declinedAssignmentId,
  );
  if (!prior) {
    return { ok: false, code: "NOT_FOUND", message: "Prior assignment not found" };
  }
  const created = createShiftAssignment(store, {
    careRecipientId: input.careRecipientId,
    assignerPersonId: input.assignerPersonId,
    assignerDisplayName: input.assignerDisplayName,
    assigneePersonId: input.replacementPersonId,
    assigneeDisplayName: input.replacementDisplayName,
    shiftStart: prior.shiftStart,
    shiftEnd: prior.shiftEnd,
    timezone: prior.timezone,
    scopeNote: prior.scopeNote,
  });
  if (!created.ok) return created;
  const updatedPrior: ShiftAssignment = {
    ...prior,
    status: "replaced",
    replacedByAssignmentId: created.assignment.id,
    updatedAt: new Date().toISOString(),
  };
  save(store, updatedPrior);
  const replacement: ShiftAssignment = {
    ...created.assignment,
    replacesAssignmentId: prior.id,
  };
  save(store, replacement);
  return { ok: true, assignment: replacement, prior: updatedPrior };
}

export function expireShiftAssignment(
  store: CareStore,
  input: {
    careRecipientId: string;
    assignmentId: string;
    actorPersonId: string;
  },
):
  | { ok: true; assignment: ShiftAssignment }
  | { ok: false; code: string; message: string } {
  const a = getShiftAssignment(
    store,
    input.careRecipientId,
    input.assignmentId,
  );
  if (!a) {
    return { ok: false, code: "NOT_FOUND", message: "Assignment not found" };
  }
  const now = new Date().toISOString();
  const expired: ShiftAssignment = {
    ...a,
    status: "expired",
    updatedAt: now,
  };
  save(store, expired);
  // Revoke relationship end
  store.revokeAccess(a.careRecipientId, a.assigneePersonId, now);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "SHIFT_EXPIRED",
    careRecipientId: a.careRecipientId,
    details: { assignmentId: a.id, assigneePersonId: a.assigneePersonId },
  });
  return { ok: true, assignment: expired };
}

export function completeShiftHandoff(
  store: CareStore,
  input: {
    careRecipientId: string;
    assignmentId: string;
    actorPersonId: string;
    actorDisplayName: string;
    whatChanged: string[];
    stillNeedsAttention: string[];
  },
):
  | { ok: true; assignment: ShiftAssignment; handoffId: string }
  | { ok: false; code: string; message: string } {
  const a = getShiftAssignment(
    store,
    input.careRecipientId,
    input.assignmentId,
  );
  if (!a) {
    return { ok: false, code: "NOT_FOUND", message: "Assignment not found" };
  }
  if (a.assigneePersonId !== input.actorPersonId) {
    return { ok: false, code: "FORBIDDEN", message: "Not your shift" };
  }
  const now = new Date().toISOString();
  const handoff = store.addHandoff({
    id: store.newId("ho"),
    careRecipientId: input.careRecipientId,
    fromPersonId: input.actorPersonId,
    whatChanged: input.whatChanged,
    stillNeedsAttention: input.stillNeedsAttention,
    watch: [],
    sources: [],
    createdAt: now,
    evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
  });
  ingestCareEvent(store, {
    careRecipientId: input.careRecipientId,
    actorPrincipalId: input.actorPersonId,
    actorDisplayName: input.actorDisplayName,
    actorActiveRole: "dsp",
    sourceKind: "dsp_shift",
    type: "handoff",
    title: "Shift handoff",
    statement: input.whatChanged.join("; ") || "Shift completed",
    truthState: "confirmed",
    confidenceLabel: "confirmed",
    structured: { handoffId: handoff.id, assignmentId: a.id },
  });
  const completed: ShiftAssignment = {
    ...a,
    status: "completed",
    handoffId: handoff.id,
    updatedAt: now,
  };
  save(store, completed);
  return { ok: true, assignment: completed, handoffId: handoff.id };
}

export function shiftBriefing(
  store: CareStore,
  careRecipientId: string,
  assignmentId: string,
): { tasks: string[]; recent: string[]; period: string } {
  const a = getShiftAssignment(store, careRecipientId, assignmentId);
  const tasks = store
    .getTasks(careRecipientId)
    .filter((t) => t.status === "pending" || t.status === "in_progress")
    .map((t) => t.title)
    .slice(0, 8);
  const recent = store
    .getEvents(careRecipientId)
    .slice(0, 6)
    .map((e) => e.statement);
  return {
    tasks,
    recent,
    period: a
      ? `${a.shiftStart} → ${a.shiftEnd} (${a.timezone})`
      : "No active assignment",
  };
}
