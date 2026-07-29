/**
 * Conflict detection and resolution for care truth.
 * Medication mismatches: never auto-select dosage.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareEvent } from "../types.js";
import { evaluateAccess } from "./access.js";
import { ingestCareEvent } from "./care-event-etl.js";
import { createNotificationIfNew } from "./notifications.js";

export type CareConflict = {
  id: string;
  careRecipientId: string;
  kind:
    | "schedule"
    | "duplicate_observation"
    | "contradictory_report"
    | "medication_mismatch"
    | "stale_instruction"
    | "corrected_report"
    | "other";
  status: "open" | "resolved" | "superseded";
  title: string;
  summary: string;
  sides: Array<{
    eventId?: string;
    statement: string;
    actor?: string;
    eventAt?: string;
    reportAt?: string;
    authority?: string;
    confidence?: string;
  }>;
  whyCannotDecide: string;
  authorizedResolverRoles: string[];
  availableActions: string[];
  resolution?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt: string;
};

const PREFIX = "CARE_CONFLICT_V1:";

function encode(c: CareConflict): string {
  return PREFIX + JSON.stringify(c);
}

function decode(summary: string): CareConflict | null {
  if (!summary.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(summary.slice(PREFIX.length)) as CareConflict;
  } catch {
    return null;
  }
}

function save(store: CareStore, c: CareConflict): CareConflict {
  store.addUpdate({
    id: c.id,
    careRecipientId: c.careRecipientId,
    toPersonId: "system",
    summary: encode(c),
    status: c.status === "open" ? "ready" : "sent",
    safetyClass: c.kind === "medication_mismatch" ? "high" : "moderate",
    source: {
      id: `src-cf-${c.id}`,
      kind: "system_derived",
      label: "Care conflict",
      recordedAt: c.createdAt,
      whyVisible: "Conflict requires authorized human resolution",
    },
  });
  return c;
}

export function listConflicts(
  store: CareStore,
  careRecipientId: string,
  opts?: { includeResolved?: boolean },
): CareConflict[] {
  const byId = new Map<string, CareConflict>();
  for (const u of store.getUpdates(careRecipientId)) {
    const c = decode(u.summary);
    if (c) byId.set(c.id, c);
  }
  // Also surface event-level conflict groups
  const events = store.getEvents(careRecipientId);
  for (const e of events) {
    if ((e.conflictWithIds?.length ?? 0) === 0) continue;
    const id = e.conflictGroupId ?? `cg-${e.id}`;
    if (byId.has(id)) continue;
    const peers = (e.conflictWithIds ?? [])
      .map((pid) => store.getEvent(pid))
      .filter(Boolean) as CareEvent[];
    byId.set(id, {
      id,
      careRecipientId,
      kind: "schedule",
      status: "open",
      title: "Schedule disagreement",
      summary: e.statement,
      sides: [e, ...peers].map((x) => ({
        eventId: x.id,
        statement: x.statement,
        actor: x.source?.actorName,
        eventAt: x.eventAt ?? x.occurredAt,
        reportAt: x.reportAt ?? x.source?.recordedAt,
        authority: x.authorityBasis,
        confidence: x.confidenceLabel,
      })),
      whyCannotDecide:
        "Two care notes about the schedule do not match. Choose which note is correct, or keep both on file for review.",
      authorizedResolverRoles: ["family_primary", "clinician", "controlling"],
      availableActions: ["confirm_side_a", "confirm_side_b", "mark_both_reported", "open_review"],
      createdAt: e.reportAt ?? e.occurredAt,
    });
  }
  let rows = [...byId.values()];
  if (!opts?.includeResolved) rows = rows.filter((c) => c.status === "open");
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function openMedicationMismatch(
  store: CareStore,
  input: {
    careRecipientId: string;
    actorPersonId: string;
    actorDisplayName: string;
    reportedAmount: string;
    planAmount: string;
    medicationName: string;
    reportedEventId?: string;
  },
): CareConflict {
  const now = new Date().toISOString();
  const c: CareConflict = {
    id: store.newId("cf"),
    careRecipientId: input.careRecipientId,
    kind: "medication_mismatch",
    status: "open",
    title: `Medication amount mismatch — ${input.medicationName}`,
    summary: `Reported ${input.reportedAmount}; authorized plan ${input.planAmount}`,
    sides: [
      {
        eventId: input.reportedEventId,
        statement: `Caregiver reported ${input.medicationName} ${input.reportedAmount}`,
        actor: input.actorDisplayName,
        eventAt: now,
        reportAt: now,
        authority: "membership",
        confidence: "reported",
      },
      {
        statement: `Authorized plan: ${input.medicationName} ${input.planAmount}`,
        actor: "Care plan",
        authority: "care_plan",
        confidence: "confirmed",
      },
    ],
    whyCannotDecide:
      "Relay does not select dosage or change the care plan. An authorized reviewer must resolve.",
    authorizedResolverRoles: ["clinician", "family_primary", "controlling"],
    availableActions: [
      "confirm_plan_dose",
      "confirm_reported_needs_review",
      "request_clinician_review",
    ],
    createdAt: now,
  };
  save(store, c);
  // Notify authorized reviewers (active members with primary/clinical)
  for (const rel of store.getRelationships(input.careRecipientId)) {
    if (rel.status !== "active") continue;
    if (
      !/primary|physician|clinician|family_caregiver|adult_child/i.test(
        rel.role + rel.roleLabel,
      )
    ) {
      continue;
    }
    createNotificationIfNew(store, {
      principalId: rel.personId,
      careRecipientId: input.careRecipientId,
      type: "CARE_UPDATE",
      priority: "urgent",
      title: c.title,
      body: c.whyCannotDecide,
      sourceType: "conflict",
      sourceId: c.id,
      actorPersonId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      actionType: "resolve_conflict",
      actionTarget: c.id,
      dedupeKey: `med-mismatch:${c.id}:${rel.personId}`,
    });
  }
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "CONFLICT_OPENED",
    careRecipientId: input.careRecipientId,
    details: { conflictId: c.id, kind: c.kind },
  });
  return c;
}

export function resolveConflict(
  store: CareStore,
  input: {
    careRecipientId: string;
    conflictId: string;
    actorPersonId: string;
    actorDisplayName: string;
    resolution: string;
    chosenStatement?: string;
  },
):
  | { ok: true; conflict: CareConflict }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const all = listConflicts(store, input.careRecipientId, {
    includeResolved: true,
  });
  const c = all.find((x) => x.id === input.conflictId);
  if (!c) {
    return { ok: false, code: "NOT_FOUND", message: "Conflict not found" };
  }
  const now = new Date().toISOString();
  const resolved: CareConflict = {
    ...c,
    status: "resolved",
    resolution: input.resolution,
    resolvedAt: now,
    resolvedBy: input.actorDisplayName,
  };
  save(store, resolved);
  if (input.chosenStatement) {
    ingestCareEvent(store, {
      careRecipientId: input.careRecipientId,
      actorPrincipalId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      sourceKind: "correction",
      type: "correction",
      title: "Conflict resolution",
      statement: input.chosenStatement,
      truthState: "confirmed",
      confidenceLabel: "confirmed",
      structured: { conflictId: c.id, resolution: input.resolution },
    });
  }
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "CONFLICT_RESOLVED",
    careRecipientId: input.careRecipientId,
    details: {
      conflictId: c.id,
      resolution: input.resolution,
    },
  });
  return { ok: true, conflict: resolved };
}
