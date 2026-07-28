/**
 * Operational work items — ownership, claiming, escalation.
 * Durable via CareUpdate CARE_WORK_V1 rows (no schema migration).
 */

import type { CareStore } from "../store/memory-store.js";
import { evaluateAccess } from "./access.js";
import { createNotificationIfNew } from "./notifications.js";

export type WorkItemStatus =
  | "unassigned"
  | "available_to_claim"
  | "claimed"
  | "assigned"
  | "accepted"
  | "in_progress"
  | "blocked"
  | "awaiting_approval"
  | "awaiting_external_confirmation"
  | "completed"
  | "declined"
  | "expired"
  | "missed"
  | "escalated"
  | "cancelled";

export type WorkItemPriority = "low" | "normal" | "high" | "urgent";

export type CareWorkItem = {
  id: string;
  careRecipientId: string;
  action: string;
  reason: string;
  ownerPersonId?: string | null;
  ownerDisplayName?: string | null;
  previousOwnerPersonId?: string | null;
  previousOwnerDisplayName?: string | null;
  proposedOwnerPersonId?: string | null;
  proposedOwnerDisplayName?: string | null;
  backupOwnerPersonId?: string | null;
  createdByPersonId: string;
  createdByDisplayName: string;
  dueAt?: string | null;
  priority: WorkItemPriority;
  status: WorkItemStatus;
  blockingReason?: string | null;
  escalationRule?: string | null;
  escalatedAt?: string | null;
  sourceEventId?: string | null;
  handoffId?: string | null;
  completionEvidence?: string | null;
  claimExpiresAt?: string | null;
  acceptedAt?: string | null;
  declinedAt?: string | null;
  declineReason?: string | null;
  declinedByPersonId?: string | null;
  clarificationNote?: string | null;
  correlationId: string;
  createdAt: string;
  updatedAt: string;
  /** Evidence labeling */
  evidenceKind:
    | "fact"
    | "report"
    | "confirmation"
    | "conflict"
    | "correction"
    | "ai_inference"
    | "operational";
};

const PREFIX = "CARE_WORK_V1:";

function encode(w: CareWorkItem): string {
  return PREFIX + JSON.stringify(w);
}

function decode(summary: string): CareWorkItem | null {
  if (!summary.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(summary.slice(PREFIX.length)) as CareWorkItem;
  } catch {
    return null;
  }
}

function save(store: CareStore, w: CareWorkItem): CareWorkItem {
  store.addUpdate({
    id: w.id,
    careRecipientId: w.careRecipientId,
    toPersonId: w.ownerPersonId ?? "care-circle",
    summary: encode(w),
    status:
      w.status === "completed" || w.status === "cancelled"
        ? "sent"
        : "ready",
    safetyClass: w.priority === "urgent" ? "high" : "moderate",
    source: {
      id: `src-work-${w.id}`,
      kind: "system_derived",
      label: "Care work item",
      actorPersonId: w.createdByPersonId,
      actorName: w.createdByDisplayName,
      recordedAt: w.updatedAt,
      whyVisible: "Operational ownership for care continuity",
    },
  });
  return w;
}

export function listWorkItems(
  store: CareStore,
  careRecipientId: string,
  opts?: { includeTerminal?: boolean },
): CareWorkItem[] {
  const byId = new Map<string, CareWorkItem>();
  for (const u of store.getUpdates(careRecipientId)) {
    const w = decode(u.summary);
    if (w) byId.set(w.id, w);
  }
  let rows = [...byId.values()];
  if (!opts?.includeTerminal) {
    // "declined" is NOT terminal — decline only refuses ownership; work stays open
    // as available_to_claim (see declineWorkItem). Filter only true terminals.
    rows = rows.filter(
      (w) =>
        !["completed", "cancelled", "expired", "missed"].includes(w.status),
    );
  }
  return rows.sort((a, b) => {
    const pa = a.priority === "urgent" ? 0 : a.priority === "high" ? 1 : 2;
    const pb = b.priority === "urgent" ? 0 : b.priority === "high" ? 1 : 2;
    if (pa !== pb) return pa - pb;
    return (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999");
  });
}

export function listNeedsOwner(
  store: CareStore,
  careRecipientId: string,
): CareWorkItem[] {
  return listWorkItems(store, careRecipientId).filter(
    (w) =>
      w.status === "unassigned" ||
      w.status === "available_to_claim" ||
      !w.ownerPersonId,
  );
}

export function createWorkItem(
  store: CareStore,
  input: {
    careRecipientId: string;
    actorPersonId: string;
    actorDisplayName: string;
    action: string;
    reason: string;
    ownerPersonId?: string | null;
    ownerDisplayName?: string | null;
    backupOwnerPersonId?: string | null;
    dueAt?: string | null;
    priority?: WorkItemPriority;
    sourceEventId?: string | null;
    escalationRule?: string | null;
    evidenceKind?: CareWorkItem["evidenceKind"];
    status?: WorkItemStatus;
  },
):
  | { ok: true; item: CareWorkItem }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const now = new Date().toISOString();
  const hasOwner = Boolean(input.ownerPersonId);
  const item: CareWorkItem = {
    id: store.newId("work"),
    careRecipientId: input.careRecipientId,
    action: input.action.trim(),
    reason: input.reason.trim(),
    ownerPersonId: input.ownerPersonId ?? null,
    ownerDisplayName: input.ownerDisplayName ?? null,
    backupOwnerPersonId: input.backupOwnerPersonId ?? null,
    createdByPersonId: input.actorPersonId,
    createdByDisplayName: input.actorDisplayName,
    dueAt: input.dueAt ?? null,
    priority: input.priority ?? "normal",
    status:
      input.status ??
      (hasOwner ? "assigned" : "available_to_claim"),
    escalationRule:
      input.escalationRule ??
      "If no response in 30 minutes, notify coordinator and escalate",
    sourceEventId: input.sourceEventId ?? null,
    correlationId: store.newId("wcorr"),
    createdAt: now,
    updatedAt: now,
    evidenceKind: input.evidenceKind ?? "operational",
  };
  if (!hasOwner) item.status = "available_to_claim";
  save(store, item);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "WORK_ITEM_CREATED",
    careRecipientId: input.careRecipientId,
    details: {
      workItemId: item.id,
      status: item.status,
      ownerPersonId: item.ownerPersonId,
    },
  });
  if (item.ownerPersonId) {
    createNotificationIfNew(store, {
      principalId: item.ownerPersonId,
      careRecipientId: input.careRecipientId,
      type: "CARE_UPDATE",
      priority: item.priority === "urgent" ? "urgent" : "attention",
      title: item.action,
      body: `${item.reason} · Due ${item.dueAt ?? "when able"}`,
      sourceType: "work_item",
      sourceId: item.id,
      actorPersonId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      actionType: "open_work_item",
      actionTarget: item.id,
      dedupeKey: `work-assign:${item.id}:${item.ownerPersonId}`,
    });
  } else {
    // Notify active circle that work needs an owner
    for (const rel of store.getRelationships(input.careRecipientId)) {
      if (rel.status !== "active") continue;
      createNotificationIfNew(store, {
        principalId: rel.personId,
        careRecipientId: input.careRecipientId,
        type: "CARE_UPDATE",
        priority: "attention",
        title: "Needs an owner",
        body: item.action,
        sourceType: "work_item",
        sourceId: item.id,
        actorPersonId: input.actorPersonId,
        actorDisplayName: input.actorDisplayName,
        actionType: "claim_work",
        actionTarget: item.id,
        dedupeKey: `work-unassigned:${item.id}:${rel.personId}`,
      });
    }
  }
  return { ok: true, item };
}

export function claimWorkItem(
  store: CareStore,
  input: {
    careRecipientId: string;
    workItemId: string;
    actorPersonId: string;
    actorDisplayName: string;
  },
):
  | { ok: true; item: CareWorkItem }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const item = listWorkItems(store, input.careRecipientId, {
    includeTerminal: true,
  }).find((w) => w.id === input.workItemId);
  if (!item) {
    return { ok: false, code: "NOT_FOUND", message: "Work item not found" };
  }
  if (
    item.ownerPersonId &&
    item.ownerPersonId !== input.actorPersonId &&
    item.status !== "available_to_claim" &&
    item.status !== "unassigned"
  ) {
    return {
      ok: false,
      code: "ALREADY_OWNED",
      message: `Already owned by ${item.ownerDisplayName ?? item.ownerPersonId}`,
    };
  }
  const now = new Date().toISOString();
  const claimed: CareWorkItem = {
    ...item,
    previousOwnerPersonId: item.ownerPersonId ?? null,
    previousOwnerDisplayName: item.ownerDisplayName ?? null,
    ownerPersonId: input.actorPersonId,
    ownerDisplayName: input.actorDisplayName,
    status: "accepted",
    acceptedAt: now,
    claimExpiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    updatedAt: now,
  };
  save(store, claimed);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "WORK_ITEM_ACCEPTED",
    careRecipientId: input.careRecipientId,
    details: {
      workItemId: item.id,
      previousOwnerPersonId: item.ownerPersonId,
      note: "Accept responsibility — not completion",
    },
  });
  return { ok: true, item: claimed };
}

/**
 * Decline responsibility: task remains OPEN (available_to_claim).
 * Decline is NOT cancel. Handoff acknowledgment is unaffected.
 */
export function declineWorkItem(
  store: CareStore,
  input: {
    careRecipientId: string;
    workItemId: string;
    actorPersonId: string;
    actorDisplayName: string;
    reason?: string;
  },
):
  | { ok: true; item: CareWorkItem }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const item = listWorkItems(store, input.careRecipientId, {
    includeTerminal: true,
  }).find((w) => w.id === input.workItemId);
  if (!item) {
    return { ok: false, code: "NOT_FOUND", message: "Work item not found" };
  }
  if (["completed", "cancelled"].includes(item.status)) {
    return {
      ok: false,
      code: "TERMINAL",
      message: "Completed or cancelled work cannot be declined",
    };
  }
  const now = new Date().toISOString();
  const next: CareWorkItem = {
    ...item,
    previousOwnerPersonId: item.ownerPersonId ?? null,
    previousOwnerDisplayName: item.ownerDisplayName ?? null,
    ownerPersonId: null,
    ownerDisplayName: null,
    status: "available_to_claim",
    declinedAt: now,
    declinedByPersonId: input.actorPersonId,
    declineReason: input.reason?.trim() || "Declined without reason",
    updatedAt: now,
  };
  save(store, next);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "WORK_ITEM_DECLINED",
    careRecipientId: input.careRecipientId,
    details: {
      workItemId: item.id,
      reason: next.declineReason,
      note: "Decline is not cancel — work remains open",
    },
  });
  // Coordinator / circle awareness
  for (const rel of store.getRelationships(input.careRecipientId)) {
    if (rel.status !== "active") continue;
    if (rel.personId === input.actorPersonId) continue;
    createNotificationIfNew(store, {
      principalId: rel.personId,
      careRecipientId: input.careRecipientId,
      type: "CARE_UPDATE",
      priority: "attention",
      title: `Declined: ${item.action}`,
      body: `${input.actorDisplayName} declined responsibility. Task is still open. ${next.escalationRule ?? ""}`,
      sourceType: "work_item",
      sourceId: item.id,
      actorPersonId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      actionType: "claim_work",
      actionTarget: item.id,
      dedupeKey: `work-decline:${item.id}:${rel.personId}:${now.slice(0, 16)}`,
    });
  }
  return { ok: true, item: next };
}

/** Seed unassigned work items from a handoff stillNeedsAttention list. */
export function seedWorkItemsFromHandoff(
  store: CareStore,
  input: {
    careRecipientId: string;
    handoffId: string;
    actorPersonId: string;
    actorDisplayName: string;
    stillNeedsAttention: string[];
    backupOwnerPersonId?: string | null;
  },
): CareWorkItem[] {
  const created: CareWorkItem[] = [];
  const existing = listWorkItems(store, input.careRecipientId, {
    includeTerminal: true,
  });
  for (const line of input.stillNeedsAttention) {
    const action = line.trim();
    if (!action) continue;
    // Skip if an open item already matches this action for this handoff
    const dup = existing.find(
      (w) =>
        w.action === action &&
        w.handoffId === input.handoffId &&
        !["completed", "cancelled"].includes(w.status),
    );
    if (dup) continue;
    const r = createWorkItem(store, {
      careRecipientId: input.careRecipientId,
      actorPersonId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      action,
      reason: `From handoff ${input.handoffId} — still needs attention. Handoff acknowledgment does not accept this task.`,
      ownerPersonId: null,
      ownerDisplayName: null,
      backupOwnerPersonId: input.backupOwnerPersonId ?? null,
      sourceEventId: input.handoffId,
      status: "available_to_claim",
      priority: /transport|med|medication|safety|mobility/i.test(action)
        ? "high"
        : "normal",
      evidenceKind: "operational",
    });
    if (r.ok) {
      const withHandoff: CareWorkItem = {
        ...r.item,
        handoffId: input.handoffId,
      };
      save(store, withHandoff);
      created.push(withHandoff);
    }
  }
  return created;
}

export function transitionWorkItem(
  store: CareStore,
  input: {
    careRecipientId: string;
    workItemId: string;
    actorPersonId: string;
    actorDisplayName: string;
    status: WorkItemStatus;
    blockingReason?: string;
    completionEvidence?: string;
  },
):
  | { ok: true; item: CareWorkItem }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const item = listWorkItems(store, input.careRecipientId, {
    includeTerminal: true,
  }).find((w) => w.id === input.workItemId);
  if (!item) {
    return { ok: false, code: "NOT_FOUND", message: "Work item not found" };
  }
  const now = new Date().toISOString();
  const next: CareWorkItem = {
    ...item,
    status: input.status,
    blockingReason: input.blockingReason ?? item.blockingReason,
    completionEvidence: input.completionEvidence ?? item.completionEvidence,
    escalatedAt: input.status === "escalated" ? now : item.escalatedAt,
    updatedAt: now,
  };
  save(store, next);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "WORK_ITEM_TRANSITIONED",
    careRecipientId: input.careRecipientId,
    details: {
      workItemId: item.id,
      from: item.status,
      to: input.status,
    },
  });
  if (input.status === "escalated" && item.backupOwnerPersonId) {
    createNotificationIfNew(store, {
      principalId: item.backupOwnerPersonId,
      careRecipientId: input.careRecipientId,
      type: "CARE_UPDATE",
      priority: "urgent",
      title: `Escalated: ${item.action}`,
      body: item.escalationRule ?? "No response — please take ownership",
      sourceType: "work_item",
      sourceId: item.id,
      actorPersonId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      actionType: "open_work_item",
      actionTarget: item.id,
      dedupeKey: `work-esc:${item.id}:${item.backupOwnerPersonId}`,
    });
  }
  return { ok: true, item: next };
}

/**
 * Coordinator proposes a new owner. Does NOT complete the task.
 * Target must accept (claim) or decline separately.
 */
export function reassignWorkItem(
  store: CareStore,
  input: {
    careRecipientId: string;
    workItemId: string;
    actorPersonId: string;
    actorDisplayName: string;
    newOwnerPersonId: string;
    newOwnerDisplayName: string;
    note?: string;
  },
):
  | { ok: true; item: CareWorkItem }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const targetAccess = evaluateAccess(
    store,
    input.newOwnerPersonId,
    input.careRecipientId,
  );
  if (!targetAccess.allowed) {
    return {
      ok: false,
      code: "TARGET_NO_ACCESS",
      message: "Proposed owner has no authorized relationship for this recipient",
    };
  }
  const item = listWorkItems(store, input.careRecipientId, {
    includeTerminal: true,
  }).find((w) => w.id === input.workItemId);
  if (!item) {
    return { ok: false, code: "NOT_FOUND", message: "Work item not found" };
  }
  if (["completed", "cancelled"].includes(item.status)) {
    return {
      ok: false,
      code: "TERMINAL",
      message: "Cannot reassign completed or cancelled work",
    };
  }
  const now = new Date().toISOString();
  const next: CareWorkItem = {
    ...item,
    previousOwnerPersonId: item.ownerPersonId ?? null,
    previousOwnerDisplayName: item.ownerDisplayName ?? null,
    proposedOwnerPersonId: input.newOwnerPersonId,
    proposedOwnerDisplayName: input.newOwnerDisplayName,
    // Stay open — proposed owner must accept; not silent transfer of ownership
    ownerPersonId: null,
    ownerDisplayName: null,
    status: "available_to_claim",
    blockingReason: input.note ?? `Proposed for ${input.newOwnerDisplayName}`,
    updatedAt: now,
  };
  save(store, next);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "WORK_ITEM_REASSIGN_PROPOSED",
    careRecipientId: input.careRecipientId,
    details: {
      workItemId: item.id,
      proposedOwnerPersonId: input.newOwnerPersonId,
      previousOwnerPersonId: item.ownerPersonId,
    },
  });
  createNotificationIfNew(store, {
    principalId: input.newOwnerPersonId,
    careRecipientId: input.careRecipientId,
    type: "CARE_UPDATE",
    priority: "attention",
    title: `Work offered: ${item.action}`,
    body: `${input.actorDisplayName} proposed you as owner. Accept or decline — this is not automatic assignment.`,
    sourceType: "work_item",
    sourceId: item.id,
    actorPersonId: input.actorPersonId,
    actorDisplayName: input.actorDisplayName,
    actionType: "claim_work",
    actionTarget: item.id,
    dedupeKey: `work-reassign:${item.id}:${input.newOwnerPersonId}:${now.slice(0, 16)}`,
  });
  return { ok: true, item: next };
}

/** Immediate no-response escalation — task stays open. */
export function escalateWorkItem(
  store: CareStore,
  input: {
    careRecipientId: string;
    workItemId: string;
    actorPersonId: string;
    actorDisplayName: string;
    reason?: string;
    alternatePersonId?: string | null;
    alternateDisplayName?: string | null;
  },
):
  | { ok: true; item: CareWorkItem }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const item = listWorkItems(store, input.careRecipientId, {
    includeTerminal: true,
  }).find((w) => w.id === input.workItemId);
  if (!item) {
    return { ok: false, code: "NOT_FOUND", message: "Work item not found" };
  }
  if (["completed", "cancelled"].includes(item.status)) {
    return {
      ok: false,
      code: "TERMINAL",
      message: "Cannot escalate completed or cancelled work",
    };
  }
  const now = new Date().toISOString();
  const altId = input.alternatePersonId ?? item.backupOwnerPersonId ?? null;
  const altName = input.alternateDisplayName ?? null;
  const next: CareWorkItem = {
    ...item,
    status: "escalated",
    escalatedAt: now,
    blockingReason:
      input.reason ??
      "No one accepted before deadline — escalated; still open",
    backupOwnerPersonId: altId ?? item.backupOwnerPersonId,
    ownerPersonId: null,
    ownerDisplayName: null,
    updatedAt: now,
  };
  save(store, next);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "WORK_ITEM_ESCALATED",
    careRecipientId: input.careRecipientId,
    details: {
      workItemId: item.id,
      alternatePersonId: altId,
      note: "Escalation keeps work open",
    },
  });
  const notifyIds = new Set<string>();
  if (altId) notifyIds.add(altId);
  for (const rel of store.getRelationships(input.careRecipientId)) {
    if (rel.status !== "active") continue;
    // Controllers / family often need escalation awareness
    if (
      /family|spouse|parent|adult_child|coordinator|controller/i.test(
        rel.roleLabel ?? rel.role ?? "",
      )
    ) {
      notifyIds.add(rel.personId);
    }
  }
  for (const pid of notifyIds) {
    createNotificationIfNew(store, {
      principalId: pid,
      careRecipientId: input.careRecipientId,
      type: "CARE_UPDATE",
      priority: "urgent",
      title: `Escalated: ${item.action}`,
      body:
        (input.reason ?? "No acceptance before deadline.") +
        " Task remains open. Accept responsibility if you can help.",
      sourceType: "work_item",
      sourceId: item.id,
      actorPersonId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      actionType: "claim_work",
      actionTarget: item.id,
      dedupeKey: `work-esc-now:${item.id}:${pid}:${now.slice(0, 13)}`,
    });
  }
  if (altName) {
    /* name used only for audit readability */
  }
  return { ok: true, item: next };
}

/** Escalate items with no acknowledgment past due (or rule threshold). */
export function escalateOverdueWork(
  store: CareStore,
  careRecipientId: string,
  actorPersonId: string,
  actorDisplayName: string,
): CareWorkItem[] {
  const now = Date.now();
  const out: CareWorkItem[] = [];
  for (const w of listWorkItems(store, careRecipientId)) {
    if (!w.dueAt) continue;
    if (Date.parse(w.dueAt) > now) continue;
    if (["completed", "cancelled", "escalated"].includes(w.status)) continue;
    const r = escalateWorkItem(store, {
      careRecipientId,
      workItemId: w.id,
      actorPersonId,
      actorDisplayName,
      reason: "Past due with no acceptance or completion",
      alternatePersonId: w.backupOwnerPersonId,
    });
    if (r.ok) out.push(r.item);
  }
  return out;
}

/** After appointment confirm — align transport open work due times. */
export function reconcileTransportAfterAppointment(
  store: CareStore,
  input: {
    careRecipientId: string;
    actorPersonId: string;
    actorDisplayName: string;
    appointmentId: string;
    startsAt: string;
    startsAtLabel: string;
  },
): CareWorkItem[] {
  const updated: CareWorkItem[] = [];
  for (const w of listWorkItems(store, input.careRecipientId, {
    includeTerminal: true,
  })) {
    if (["completed", "cancelled"].includes(w.status)) continue;
    if (!/transport|ride|drive|pickup|pick-up|pharmacy/i.test(w.action)) {
      continue;
    }
    const now = new Date().toISOString();
    const next: CareWorkItem = {
      ...w,
      dueAt: input.startsAt,
      reason: `${w.reason} · Aligned to appointment ${input.startsAtLabel} (${input.appointmentId})`,
      updatedAt: now,
    };
    save(store, next);
    updated.push(next);
    store.writeAudit({
      at: now,
      actorPersonId: input.actorPersonId,
      action: "WORK_ITEM_DUE_RECONCILED",
      careRecipientId: input.careRecipientId,
      details: {
        workItemId: w.id,
        appointmentId: input.appointmentId,
        dueAt: input.startsAt,
      },
    });
  }
  return updated;
}
