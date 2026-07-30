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

function humanPrincipalLabel(
  store: CareStore,
  personId: string,
  fallback?: string,
): string {
  if (fallback && fallback.trim() && !/^p-[a-z0-9-]+$/i.test(fallback)) {
    return fallback.trim();
  }
  try {
    const p = store.getPerson?.(personId) as
      | { displayName?: string; name?: string }
      | undefined;
    const n = p?.displayName || p?.name;
    if (n && String(n).trim()) return String(n).trim();
  } catch {
    /* store may not implement getPerson */
  }
  // Never show raw principal IDs in caregiver-facing status
  if (/^p-[a-z0-9-]+$/i.test(personId)) return "a care team member";
  return personId;
}

function humanWhen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "earlier";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(t));
  } catch {
    return "earlier";
  }
}

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
  const MAX = 10; // hard cap — never fan-out unbounded against large inboxes

  // Scan circle principals for stale notifications on this recipient
  const principals = new Set<string>([
    input.actorPersonId,
    input.alternatePersonId,
  ]);
  for (const rel of store.getRelationships(input.careRecipientId)) {
    if (rel.status === "active") principals.add(rel.personId);
  }

  outer: for (const principalId of principals) {
    const list = listNotificationsForPrincipal(
      store,
      principalId,
      input.careRecipientId,
    ).slice(0, 40);
    for (const n of list) {
      if (results.length >= MAX) break outer;
      if (n.resolvedAt || n.acknowledgedAt) continue;
      if (n.sourceType === "notification_escalation") continue;
      if (n.title.startsWith("No response:")) continue;
      const age = now - Date.parse(n.createdAt);
      if (Number.isNaN(age) || age < windowMs) continue;
      if (n.priority === "info") continue;

      const ownerLabel = humanPrincipalLabel(
        store,
        principalId,
        principalId === input.actorPersonId ? input.actorDisplayName : undefined,
      );
      const altLabel =
        input.alternateDisplayName ||
        humanPrincipalLabel(store, input.alternatePersonId);
      const whenHuman = humanWhen(n.createdAt);

      const work = createWorkItem(store, {
        careRecipientId: input.careRecipientId,
        actorPersonId: input.actorPersonId,
        actorDisplayName: input.actorDisplayName,
        action: `Follow up: ${n.title}`.slice(0, 120),
        reason: `No response to in-app notification since ${whenHuman}`,
        ownerPersonId: input.alternatePersonId,
        ownerDisplayName: altLabel,
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
        title: `No response: ${n.title}`.slice(0, 100),
        body: `${ownerLabel} has not acknowledged. You are the alternate owner.`,
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
        plainStatus: `${ownerLabel} received "${n.title}" ${whenHuman}. No response. ${altLabel} notified as alternate.`,
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
