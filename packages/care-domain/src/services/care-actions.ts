/**
 * Consequential care-action registry with human-in-the-loop approval.
 * AI / Relay may propose; execution requires confirm when consequential.
 */

import type { CareStore } from "../store/memory-store.js";
import { evaluateAccess } from "./access.js";
import { createNotificationIfNew } from "./notifications.js";
import { transitionSchedule, upsertScheduleItem } from "./schedule-engine.js";
import { ingestCareEvent } from "./care-event-etl.js";

export const CONSEQUENTIAL_ACTION_TYPES = [
  "notify_helpers",
  "reschedule_appointment",
  "create_appointment",
  "complete_shift_handoff",
  "revoke_access",
  "export_phi",
  "escalate_clinical",
  "change_medication_plan",
  "book_external",
] as const;

export type CareActionType = (typeof CONSEQUENTIAL_ACTION_TYPES)[number] | string;

export type ProposedCareAction = {
  id: string;
  type: CareActionType;
  careRecipientId: string;
  proposedByPrincipalId: string;
  proposedByDisplayName: string;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  consequential: boolean;
  status: "proposed" | "approved" | "rejected" | "executed" | "failed" | "cancelled";
  createdAt: string;
  decidedAt?: string;
  decidedByPrincipalId?: string;
  executionResult?: string;
  correlationId: string;
};

const ACTION_PREFIX = "CARE_ACTION_V1:";

export function isConsequentialAction(type: string): boolean {
  return (CONSEQUENTIAL_ACTION_TYPES as readonly string[]).includes(type);
}

function encode(a: ProposedCareAction): string {
  return ACTION_PREFIX + JSON.stringify(a);
}

function decode(summary: string): ProposedCareAction | null {
  if (!summary.startsWith(ACTION_PREFIX)) return null;
  try {
    return JSON.parse(summary.slice(ACTION_PREFIX.length)) as ProposedCareAction;
  } catch {
    return null;
  }
}

export function listProposedActions(
  store: CareStore,
  careRecipientId: string,
): ProposedCareAction[] {
  const byId = new Map<string, ProposedCareAction>();
  for (const u of store.getUpdates(careRecipientId)) {
    const a = decode(u.summary);
    if (a) byId.set(a.id, a);
  }
  return [...byId.values()].sort((x, y) => y.createdAt.localeCompare(x.createdAt));
}

export function getProposedAction(
  store: CareStore,
  careRecipientId: string,
  actionId: string,
): ProposedCareAction | undefined {
  return listProposedActions(store, careRecipientId).find((a) => a.id === actionId);
}

function saveAction(store: CareStore, a: ProposedCareAction): ProposedCareAction {
  store.addUpdate({
    id: a.id,
    careRecipientId: a.careRecipientId,
    toPersonId: a.proposedByPrincipalId,
    summary: encode(a),
    status: a.status === "executed" ? "sent" : "ready",
    safetyClass: a.consequential ? "moderate" : "low",
    source: {
      id: `src-act-${a.id}`,
      kind: "system_derived",
      label: "Care action",
      actorPersonId: a.proposedByPrincipalId,
      actorName: a.proposedByDisplayName,
      recordedAt: a.createdAt,
      whyVisible: "Proposed care action awaiting or completing confirmation",
    },
  });
  return a;
}

export type ProposeActionInput = {
  careRecipientId: string;
  actorPrincipalId: string;
  actorDisplayName: string;
  type: CareActionType;
  title: string;
  summary: string;
  payload?: Record<string, unknown>;
  /** When false, execute immediately if not consequential. */
  forceConfirm?: boolean;
};

export type ActionOutcome =
  | { ok: true; action: ProposedCareAction; requiresConfirmation: boolean }
  | { ok: false; code: string; message: string };

export function proposeCareAction(
  store: CareStore,
  input: ProposeActionInput,
): ActionOutcome {
  const access = evaluateAccess(
    store,
    input.actorPrincipalId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }

  if (input.type === "book_external") {
    return {
      ok: false,
      code: "EXTERNAL_UNAVAILABLE",
      message:
        "External provider booking is not configured. Use internal schedule or export .ics.",
    };
  }

  const consequential =
    isConsequentialAction(input.type) || Boolean(input.forceConfirm);
  const now = new Date().toISOString();
  const action: ProposedCareAction = {
    id: store.newId("act"),
    type: input.type,
    careRecipientId: input.careRecipientId,
    proposedByPrincipalId: input.actorPrincipalId,
    proposedByDisplayName: input.actorDisplayName,
    title: input.title,
    summary: input.summary,
    payload: input.payload ?? {},
    consequential,
    status: consequential ? "proposed" : "approved",
    createdAt: now,
    correlationId: store.newId("acorr"),
  };

  saveAction(store, action);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPrincipalId,
    action: "CARE_ACTION_PROPOSED",
    careRecipientId: input.careRecipientId,
    details: {
      actionId: action.id,
      type: action.type,
      consequential,
    },
  });

  if (!consequential) {
    return executeCareAction(store, {
      careRecipientId: input.careRecipientId,
      actionId: action.id,
      actorPrincipalId: input.actorPrincipalId,
      actorDisplayName: input.actorDisplayName,
      decision: "approve",
    });
  }

  return { ok: true, action, requiresConfirmation: true };
}

export function executeCareAction(
  store: CareStore,
  input: {
    careRecipientId: string;
    actionId: string;
    actorPrincipalId: string;
    actorDisplayName: string;
    decision: "approve" | "reject";
  },
): ActionOutcome {
  const access = evaluateAccess(
    store,
    input.actorPrincipalId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }

  const action = getProposedAction(store, input.careRecipientId, input.actionId);
  if (!action) {
    return { ok: false, code: "NOT_FOUND", message: "Action not found" };
  }
  if (action.status === "executed" || action.status === "rejected") {
    return { ok: true, action, requiresConfirmation: false };
  }

  const now = new Date().toISOString();
  if (input.decision === "reject") {
    const rejected: ProposedCareAction = {
      ...action,
      status: "rejected",
      decidedAt: now,
      decidedByPrincipalId: input.actorPrincipalId,
    };
    saveAction(store, rejected);
    store.writeAudit({
      at: now,
      actorPersonId: input.actorPrincipalId,
      action: "CARE_ACTION_REJECTED",
      careRecipientId: input.careRecipientId,
      details: { actionId: action.id },
    });
    return { ok: true, action: rejected, requiresConfirmation: false };
  }

  let executionResult = "ok";
  try {
    switch (action.type) {
      case "create_appointment": {
        const r = upsertScheduleItem(store, {
          careRecipientId: input.careRecipientId,
          actorPrincipalId: input.actorPrincipalId,
          actorDisplayName: input.actorDisplayName,
          title: String(action.payload.title ?? action.title),
          startsAt: String(action.payload.startsAt ?? new Date().toISOString()),
          startsAtLabel: action.payload.startsAtLabel as string | undefined,
          location: action.payload.location as string | undefined,
          scheduleState: "confirmed",
        });
        executionResult = r.ok ? `appointment:${r.appointment.id}` : r.message;
        if (!r.ok) throw new Error(r.message);
        break;
      }
      case "reschedule_appointment": {
        const r = transitionSchedule(store, {
          careRecipientId: input.careRecipientId,
          appointmentId: String(action.payload.appointmentId ?? ""),
          actorPrincipalId: input.actorPrincipalId,
          actorDisplayName: input.actorDisplayName,
          scheduleState: "rescheduled",
          newStartsAt: action.payload.newStartsAt as string | undefined,
          newStartsAtLabel: action.payload.newStartsAtLabel as string | undefined,
        });
        executionResult = r.ok ? `rescheduled:${r.appointment.id}` : r.message;
        if (!r.ok) throw new Error(r.message);
        break;
      }
      case "notify_helpers": {
        const body = String(action.payload.body ?? action.summary);
        const members = store
          .getRelationships(input.careRecipientId)
          .filter((r) => r.status === "active");
        for (const m of members) {
          createNotificationIfNew(store, {
            principalId: m.personId,
            careRecipientId: input.careRecipientId,
            type: "CARE_UPDATE",
            priority: "attention",
            title: action.title,
            body,
            sourceType: "care_action",
            sourceId: action.id,
            actorPersonId: input.actorPrincipalId,
            actorDisplayName: input.actorDisplayName,
            actionType: "open_today",
            actionTarget: action.id,
            dedupeKey: `act-notify:${action.id}:${m.personId}`,
          });
        }
        executionResult = `notified:${members.length}`;
        break;
      }
      case "complete_shift_handoff": {
        const handoff = store.addHandoff({
          id: store.newId("ho"),
          careRecipientId: input.careRecipientId,
          fromPersonId: input.actorPrincipalId,
          toPersonId: action.payload.toPersonId as string | undefined,
          whatChanged: (action.payload.whatChanged as string[]) ?? [action.summary],
          stillNeedsAttention:
            (action.payload.stillNeedsAttention as string[]) ?? [],
          watch: (action.payload.watch as string[]) ?? [],
          sources: [],
          createdAt: now,
          evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
        });
        ingestCareEvent(store, {
          careRecipientId: input.careRecipientId,
          actorPrincipalId: input.actorPrincipalId,
          actorDisplayName: input.actorDisplayName,
          actorActiveRole: "dsp",
          sourceKind: "dsp_shift",
          type: "handoff",
          title: "Shift handoff",
          statement: action.summary,
          truthState: "confirmed",
          confidenceLabel: "confirmed",
          structured: { handoffId: handoff.id },
        });
        executionResult = `handoff:${handoff.id}`;
        break;
      }
      case "export_phi":
      case "revoke_access":
      case "escalate_clinical":
      case "change_medication_plan":
        executionResult = "recorded_pending_policy";
        ingestCareEvent(store, {
          careRecipientId: input.careRecipientId,
          actorPrincipalId: input.actorPrincipalId,
          actorDisplayName: input.actorDisplayName,
          sourceKind: "system",
          type: "note",
          title: action.title,
          statement: `Approved action ${action.type}: ${action.summary}`,
          truthState: "confirmed",
          confidenceLabel: "confirmed",
        });
        break;
      default:
        executionResult = "no_op";
    }
  } catch (e) {
    const failed: ProposedCareAction = {
      ...action,
      status: "failed",
      decidedAt: now,
      decidedByPrincipalId: input.actorPrincipalId,
      executionResult: e instanceof Error ? e.message : "failed",
    };
    saveAction(store, failed);
    return { ok: false, code: "EXECUTION_FAILED", message: failed.executionResult ?? "failed" };
  }

  const executed: ProposedCareAction = {
    ...action,
    status: "executed",
    decidedAt: now,
    decidedByPrincipalId: input.actorPrincipalId,
    executionResult,
  };
  saveAction(store, executed);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPrincipalId,
    action: "CARE_ACTION_EXECUTED",
    careRecipientId: input.careRecipientId,
    details: {
      actionId: action.id,
      type: action.type,
      executionResult,
    },
  });
  return { ok: true, action: executed, requiresConfirmation: false };
}
