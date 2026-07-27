/**
 * Shared handoff lifecycle — one handoff truth, status machine + acknowledgment.
 * Durable via CareUpdate CARE_HANDOFF_LC_V1 (no schema migration).
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareHandoff } from "../types.js";
import { evaluateAccess } from "./access.js";
import { createNotificationIfNew } from "./notifications.js";
import { listWorkItems } from "./care-work-items.js";
import { listConflicts } from "./conflict-center.js";

export type HandoffLifecycleStatus =
  | "draft"
  | "ready"
  | "sent"
  | "delivered"
  | "seen"
  | "acknowledged"
  | "correction_required"
  | "completed"
  | "expired"
  | "escalated";

export type HandoffLifecycle = {
  handoffId: string;
  careRecipientId: string;
  status: HandoffLifecycleStatus;
  fromPersonId?: string;
  toPersonId?: string;
  periodLabel?: string;
  acknowledgedAt?: string | null;
  acknowledgedByPersonId?: string | null;
  seenAt?: string | null;
  sentAt?: string | null;
  escalatedAt?: string | null;
  deadlineAt?: string | null;
  alternatePersonId?: string | null;
  updatedAt: string;
  updatedByPersonId: string;
};

const PREFIX = "CARE_HANDOFF_LC_V1:";

function encode(l: HandoffLifecycle): string {
  return PREFIX + JSON.stringify(l);
}

function decode(summary: string): HandoffLifecycle | null {
  if (!summary.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(summary.slice(PREFIX.length)) as HandoffLifecycle;
  } catch {
    return null;
  }
}

function save(store: CareStore, l: HandoffLifecycle): HandoffLifecycle {
  store.addUpdate({
    id: `hlc-${l.handoffId}`,
    careRecipientId: l.careRecipientId,
    toPersonId: l.toPersonId ?? "care-circle",
    summary: encode(l),
    status:
      l.status === "completed" || l.status === "expired" ? "sent" : "ready",
    safetyClass: l.status === "escalated" ? "high" : "moderate",
    source: {
      id: `src-hlc-${l.handoffId}`,
      kind: "system_derived",
      label: "Handoff lifecycle",
      actorPersonId: l.updatedByPersonId,
      actorName: "Caretaker Relay",
      recordedAt: l.updatedAt,
      whyVisible: "Shared handoff continuity",
    },
  });
  return l;
}

export function getHandoffLifecycle(
  store: CareStore,
  careRecipientId: string,
  handoffId: string,
): HandoffLifecycle | null {
  for (const u of store.getUpdates(careRecipientId)) {
    const l = decode(u.summary);
    if (l?.handoffId === handoffId) return l;
  }
  return null;
}

export function ensureHandoffLifecycle(
  store: CareStore,
  handoff: CareHandoff,
  actorPersonId: string,
): HandoffLifecycle {
  const existing = getHandoffLifecycle(
    store,
    handoff.careRecipientId,
    handoff.id,
  );
  if (existing) return existing;
  const now = new Date().toISOString();
  return save(store, {
    handoffId: handoff.id,
    careRecipientId: handoff.careRecipientId,
    status: "ready",
    fromPersonId: handoff.fromPersonId,
    toPersonId: handoff.toPersonId,
    periodLabel: `Handoff at ${handoff.createdAt}`,
    deadlineAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    updatedAt: now,
    updatedByPersonId: actorPersonId,
  });
}

export function transitionHandoffLifecycle(
  store: CareStore,
  input: {
    careRecipientId: string;
    handoffId: string;
    actorPersonId: string;
    actorDisplayName: string;
    status: HandoffLifecycleStatus;
    alternatePersonId?: string | null;
  },
):
  | { ok: true; lifecycle: HandoffLifecycle; handoff: CareHandoff }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const handoff = store
    .getHandoffs(input.careRecipientId)
    .find((h) => h.id === input.handoffId);
  if (!handoff) {
    return { ok: false, code: "NOT_FOUND", message: "Handoff not found" };
  }
  const prev =
    getHandoffLifecycle(store, input.careRecipientId, input.handoffId) ??
    ensureHandoffLifecycle(store, handoff, input.actorPersonId);
  const now = new Date().toISOString();
  const next: HandoffLifecycle = {
    ...prev,
    status: input.status,
    updatedAt: now,
    updatedByPersonId: input.actorPersonId,
    alternatePersonId: input.alternatePersonId ?? prev.alternatePersonId,
  };
  if (input.status === "sent" || input.status === "delivered") {
    next.sentAt = next.sentAt ?? now;
  }
  if (input.status === "seen") next.seenAt = now;
  if (input.status === "acknowledged") {
    next.acknowledgedAt = now;
    next.acknowledgedByPersonId = input.actorPersonId;
  }
  if (input.status === "escalated") next.escalatedAt = now;
  save(store, next);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "HANDOFF_LIFECYCLE_TRANSITION",
    careRecipientId: input.careRecipientId,
    details: {
      handoffId: input.handoffId,
      from: prev.status,
      to: input.status,
    },
  });

  if (
    (input.status === "sent" || input.status === "delivered") &&
    handoff.toPersonId
  ) {
    createNotificationIfNew(store, {
      principalId: handoff.toPersonId,
      careRecipientId: input.careRecipientId,
      type: "HANDOFF_READY",
      priority: "important",
      title: "Care handoff ready for you",
      body: "Review unfinished work and acknowledge when oriented.",
      sourceType: "handoff",
      sourceId: handoff.id,
      actorPersonId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      actionType: "open_handoff",
      actionTarget: handoff.id,
      dedupeKey: `handoff-sent:${handoff.id}:${handoff.toPersonId}`,
    });
  }
  if (input.status === "escalated" && next.alternatePersonId) {
    createNotificationIfNew(store, {
      principalId: next.alternatePersonId,
      careRecipientId: input.careRecipientId,
      type: "CARE_UPDATE",
      priority: "urgent",
      title: "Handoff not acknowledged — please take ownership",
      body: `Deadline passed for handoff ${handoff.id}`,
      sourceType: "handoff",
      sourceId: handoff.id,
      actorPersonId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      actionType: "open_handoff",
      actionTarget: handoff.id,
      dedupeKey: `handoff-esc:${handoff.id}:${next.alternatePersonId}`,
    });
  }
  return { ok: true, lifecycle: next, handoff };
}

/** Full shared handoff payload for one truth, multi-role views. */
export function buildSharedHandoffPacket(
  store: CareStore,
  handoff: CareHandoff,
  lifecycle: HandoffLifecycle | null,
) {
  const work = listWorkItems(store, handoff.careRecipientId);
  const conflicts = listConflicts(store, handoff.careRecipientId);
  return {
    handoffId: handoff.id,
    careRecipientId: handoff.careRecipientId,
    fromPersonId: handoff.fromPersonId,
    toPersonId: handoff.toPersonId,
    status: lifecycle?.status ?? "ready",
    periodLabel: lifecycle?.periodLabel ?? `Handoff at ${handoff.createdAt}`,
    whatChanged: handoff.whatChanged,
    stillNeedsAttention: handoff.stillNeedsAttention,
    watch: handoff.watch,
    completedWork: work
      .filter((w) => w.status === "completed")
      .map((w) => w.action),
    unfinishedWork: work
      .filter((w) => w.status !== "completed" && w.status !== "cancelled")
      .map((w) => ({
        action: w.action,
        owner: w.ownerDisplayName ?? "Unassigned",
        status: w.status,
      })),
    conflicts: conflicts.map((c) => c.title),
    corrections: store
      .getCorrections(handoff.careRecipientId)
      .slice(-5)
      .map((c) => `${c.previousValue} → ${c.correctedValue}`),
    upcoming: store
      .getAppointments(handoff.careRecipientId)
      .slice(0, 5)
      .map((a) => `${a.title} · ${a.startsAtLabel ?? a.startsAt}`),
    acknowledgment: lifecycle?.acknowledgedAt
      ? "acknowledged"
      : lifecycle?.status === "seen"
        ? "seen"
        : "pending",
    acknowledgedAt: lifecycle?.acknowledgedAt ?? null,
    deadlineAt: lifecycle?.deadlineAt ?? null,
    sources: handoff.sources.map((s) => s.label),
  };
}
