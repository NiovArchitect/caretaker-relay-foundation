/**
 * No-response escalation — deadlines, alternate owners, visible blocked state.
 */

import type { CareStore } from "../store/memory-store.js";
import {
  listNotificationsForPrincipal,
  createNotificationIfNew,
  markResolved,
} from "./notifications.js";
import { createWorkItem } from "./care-work-items.js";
import { evaluateAccess } from "./access.js";

export type EscalationResult = {
  notificationId: string;
  escalated: boolean;
  alternateNotified: boolean;
  workItemId?: string;
  plainStatus: string;
};

/**
 * For a principal's open notifications past escalate window:
 * notify alternate and open a needs-owner work item.
 */
export function escalateNoResponseForRecipient(
  store: CareStore,
  input: {
    careRecipientId: string;
    actorPersonId: string;
    actorDisplayName: string;
    alternatePersonId: string;
    alternateDisplayName?: string;
    windowMs?: number;
  },
):
  | { ok: true; results: EscalationResult[] }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const windowMs = input.windowMs ?? 30 * 60 * 1000;
  const now = Date.now();
  const results: EscalationResult[] = [];

  // Scan circle principals for stale notifications on this recipient
  const principals = new Set<string>([
    input.actorPersonId,
    input.alternatePersonId,
  ]);
  for (const rel of store.getRelationships(input.careRecipientId)) {
    if (rel.status === "active") principals.add(rel.personId);
  }

  for (const principalId of principals) {
    for (const n of listNotificationsForPrincipal(
      store,
      principalId,
      input.careRecipientId,
    )) {
      if (n.resolvedAt || n.acknowledgedAt) continue;
      const age = now - Date.parse(n.createdAt);
      if (age < windowMs) continue;
      if (n.priority === "info") continue;

      const work = createWorkItem(store, {
        careRecipientId: input.careRecipientId,
        actorPersonId: input.actorPersonId,
        actorDisplayName: input.actorDisplayName,
        action: `Follow up: ${n.title}`,
        reason: `No response to in-app notification since ${n.createdAt}`,
        ownerPersonId: input.alternatePersonId,
        ownerDisplayName: input.alternateDisplayName ?? input.alternatePersonId,
        priority: n.priority === "urgent" ? "urgent" : "high",
        evidenceKind: "operational",
        status: "assigned",
        escalationRule: "Alternate owner after no response",
      });

      createNotificationIfNew(store, {
        principalId: input.alternatePersonId,
        careRecipientId: input.careRecipientId,
        type: "CARE_UPDATE",
        priority: "urgent",
        title: `No response: ${n.title}`,
        body: `${principalId} has not acknowledged. You are the alternate owner.`,
        sourceType: "notification_escalation",
        sourceId: n.id,
        actorPersonId: input.actorPersonId,
        actorDisplayName: input.actorDisplayName,
        actionType: "open_work_item",
        actionTarget: work.ok ? work.item.id : n.id,
        dedupeKey: `noresp-esc:${n.id}:${input.alternatePersonId}`,
      });

      results.push({
        notificationId: n.id,
        escalated: true,
        alternateNotified: true,
        workItemId: work.ok ? work.item.id : undefined,
        plainStatus: `${principalId} received "${n.title}" at ${n.createdAt}. No response. ${input.alternateDisplayName ?? input.alternatePersonId} notified as alternate.`,
      });
    }
  }

  store.writeAudit({
    at: new Date().toISOString(),
    actorPersonId: input.actorPersonId,
    action: "NO_RESPONSE_ESCALATION_RUN",
    careRecipientId: input.careRecipientId,
    details: { count: results.length, alternate: input.alternatePersonId },
  });

  return { ok: true, results };
}

export function declineNotification(
  store: CareStore,
  principalId: string,
  notificationId: string,
  reason?: string,
) {
  const n = markResolved(store, principalId, notificationId);
  if (!n) return null;
  store.writeAudit({
    at: new Date().toISOString(),
    actorPersonId: principalId,
    action: "NOTIFICATION_DECLINED",
    careRecipientId: n.careRecipientId,
    details: { notificationId, reason: reason ?? "declined" },
  });
  return n;
}
