/**
 * Server-backed care notifications (durable via CareUpdate rows).
 * System of record = store + Prisma CareUpdateRow flush.
 * localStorage must never be authority.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareUpdate, SourceRef } from "../types.js";

export const NOTIF_PREFIX = "CARE_NOTIF_V1:";
export const CLARIFY_REQ_PREFIX = "CLARIFY_REQ_V1:";
export const CLARIFY_RESP_PREFIX = "CLARIFY_RESP_V1:";

export type NotificationType =
  | "NEW_COORDINATION_MESSAGE"
  | "MEDICATION_UPCOMING"
  | "MEDICATION_DUE"
  | "MEDICATION_VERIFICATION"
  | "APPOINTMENT_UPCOMING"
  | "LEAVE_SOON"
  | "HANDOFF_READY"
  | "CARE_UPDATE"
  | "PROVIDER_UPDATE"
  | "CLARIFICATION_REQUEST"
  | "CLARIFICATION_RESPONSE"
  | "INVITATION";

export type NotificationPriority = "info" | "attention" | "important" | "urgent";

export type CareNotification = {
  id: string;
  principalId: string;
  careRecipientId: string;
  type: NotificationType;
  priority: NotificationPriority;
  title: string;
  body: string;
  sourceType: string;
  sourceId: string;
  actorPersonId?: string;
  actorDisplayName?: string;
  createdAt: string;
  seenAt?: string | null;
  acknowledgedAt?: string | null;
  resolvedAt?: string | null;
  actionType: string;
  actionTarget: string;
  dedupeKey: string;
  metadata?: Record<string, unknown>;
};

export type ClarificationRequest = {
  id: string;
  careRecipientId: string;
  requesterPersonId: string;
  requesterDisplayName: string;
  targetPersonId: string;
  targetDisplayName: string;
  question: string;
  contextSummary?: string;
  createdAt: string;
  status: "open" | "answered" | "cancelled";
  responseId?: string;
};

export type ClarificationResponse = {
  id: string;
  requestId: string;
  careRecipientId: string;
  responderPersonId: string;
  responderDisplayName: string;
  body: string;
  createdAt: string;
};

function src(
  actorPersonId: string,
  actorName: string,
  label: string,
): SourceRef {
  return {
    id: `src-notif-${Date.now().toString(36)}`,
    kind: "system_derived",
    label,
    actorPersonId,
    actorName,
    recordedAt: new Date().toISOString(),
    whyVisible: "Care collaboration notification",
  };
}

export function encodeNotification(n: CareNotification): CareUpdate {
  return {
    id: n.id,
    careRecipientId: n.careRecipientId,
    toPersonId: n.principalId,
    summary: NOTIF_PREFIX + JSON.stringify(n),
    status: n.resolvedAt ? "ready" : n.seenAt ? "ready" : "ready",
    safetyClass:
      n.priority === "urgent"
        ? "high"
        : n.priority === "important"
          ? "moderate"
          : "low",
    source: src(
      n.actorPersonId ?? "system",
      n.actorDisplayName ?? "System",
      "Care notification",
    ),
  };
}

export function decodeNotification(u: CareUpdate): CareNotification | null {
  if (!u.summary.startsWith(NOTIF_PREFIX)) return null;
  try {
    const n = JSON.parse(u.summary.slice(NOTIF_PREFIX.length)) as CareNotification;
    if (n.principalId !== u.toPersonId) return null;
    return n;
  } catch {
    return null;
  }
}

export function listNotificationsForPrincipal(
  store: CareStore,
  principalId: string,
  careRecipientId?: string,
): CareNotification[] {
  // Notifications are private to principal; may span recipients they care for
  const recipientIds = careRecipientId
    ? [careRecipientId]
    : collectRecipientIds(store);
  const out: CareNotification[] = [];
  for (const rid of recipientIds) {
    for (const u of store.getUpdates(rid)) {
      if (u.toPersonId !== principalId) continue;
      const n = decodeNotification(u);
      if (n) out.push(n);
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function collectRecipientIds(store: CareStore): string[] {
  // Known lab recipients + any with updates
  const ids = new Set<string>(["cr-olivia", "cr-robert"]);
  // memory store may not expose listRecipients — probe known
  for (const id of ["cr-olivia", "cr-robert"]) {
    if (store.getRecipient(id)) ids.add(id);
  }
  return [...ids];
}

export function upsertNotification(
  store: CareStore,
  n: CareNotification,
): CareNotification {
  // Overwrite by stable id (state transitions)
  store.addUpdate(encodeNotification(n));
  return n;
}

export function createNotificationIfNew(
  store: CareStore,
  partial: Omit<
    CareNotification,
    "id" | "createdAt" | "seenAt" | "acknowledgedAt" | "resolvedAt"
  > & { id?: string; createdAt?: string },
): CareNotification {
  const existing = listNotificationsForPrincipal(
    store,
    partial.principalId,
    partial.careRecipientId,
  ).find((n) => n.dedupeKey === partial.dedupeKey && !n.resolvedAt);
  if (existing) return existing;

  const n: CareNotification = {
    id: partial.id ?? `notif-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    principalId: partial.principalId,
    careRecipientId: partial.careRecipientId,
    type: partial.type,
    priority: partial.priority,
    title: partial.title,
    body: partial.body,
    sourceType: partial.sourceType,
    sourceId: partial.sourceId,
    actorPersonId: partial.actorPersonId,
    actorDisplayName: partial.actorDisplayName,
    createdAt: partial.createdAt ?? new Date().toISOString(),
    seenAt: null,
    acknowledgedAt: null,
    resolvedAt: null,
    actionType: partial.actionType,
    actionTarget: partial.actionTarget,
    dedupeKey: partial.dedupeKey,
    metadata: partial.metadata,
  };
  // Force write even if hash collides by ensuring unique summary via id in body
  store.addUpdate(encodeNotification(n));
  return n;
}

/** Bypass content-hash dedupe for status updates by using same id and new summary. */
export function patchNotification(
  store: CareStore,
  principalId: string,
  notificationId: string,
  patch: Partial<
    Pick<CareNotification, "seenAt" | "acknowledgedAt" | "resolvedAt" | "metadata">
  >,
): CareNotification | null {
  const all = listNotificationsForPrincipal(store, principalId);
  const cur = all.find((n) => n.id === notificationId);
  if (!cur) return null;
  const next: CareNotification = { ...cur, ...patch };
  // Memory map overwrites by id; PrismaCareStore may treat new hash as insert of same id
  store.addUpdate(encodeNotification(next));
  return next;
}

export function markSeen(
  store: CareStore,
  principalId: string,
  notificationId: string,
): CareNotification | null {
  return patchNotification(store, principalId, notificationId, {
    seenAt: new Date().toISOString(),
  });
}

export function markAcknowledged(
  store: CareStore,
  principalId: string,
  notificationId: string,
): CareNotification | null {
  const now = new Date().toISOString();
  return patchNotification(store, principalId, notificationId, {
    seenAt: now,
    acknowledgedAt: now,
  });
}

export function markResolved(
  store: CareStore,
  principalId: string,
  notificationId: string,
): CareNotification | null {
  const now = new Date().toISOString();
  return patchNotification(store, principalId, notificationId, {
    seenAt: now,
    acknowledgedAt: now,
    resolvedAt: now,
  });
}

export function notificationFromCoordination(input: {
  store: CareStore;
  careRecipientId: string;
  messageId: string;
  fromPersonId: string;
  fromDisplayName: string;
  toPersonId: string;
  body: string;
}): CareNotification {
  return createNotificationIfNew(input.store, {
    principalId: input.toPersonId,
    careRecipientId: input.careRecipientId,
    type: "NEW_COORDINATION_MESSAGE",
    priority: "attention",
    title: `Message from ${input.fromDisplayName}`,
    body: input.body.slice(0, 280),
    sourceType: "coordination",
    sourceId: input.messageId,
    actorPersonId: input.fromPersonId,
    actorDisplayName: input.fromDisplayName,
    actionType: "open_coordination",
    actionTarget: `coordination:${input.messageId}`,
    dedupeKey: `coord:${input.messageId}:${input.toPersonId}`,
  });
}

export function encodeClarificationRequest(
  req: ClarificationRequest,
  source: SourceRef,
): CareUpdate {
  return {
    id: req.id,
    careRecipientId: req.careRecipientId,
    toPersonId: req.targetPersonId,
    summary: CLARIFY_REQ_PREFIX + JSON.stringify(req),
    status: "ready",
    safetyClass: "moderate",
    source,
  };
}

export function decodeClarificationRequest(
  u: CareUpdate,
): ClarificationRequest | null {
  if (!u.summary.startsWith(CLARIFY_REQ_PREFIX)) return null;
  try {
    return JSON.parse(u.summary.slice(CLARIFY_REQ_PREFIX.length)) as ClarificationRequest;
  } catch {
    return null;
  }
}

export function createClarificationRequest(
  store: CareStore,
  input: {
    careRecipientId: string;
    requesterPersonId: string;
    requesterDisplayName: string;
    targetPersonId: string;
    targetDisplayName: string;
    question: string;
    contextSummary?: string;
  },
): { request: ClarificationRequest; notification: CareNotification } {
  const request: ClarificationRequest = {
    id: `clrq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    careRecipientId: input.careRecipientId,
    requesterPersonId: input.requesterPersonId,
    requesterDisplayName: input.requesterDisplayName,
    targetPersonId: input.targetPersonId,
    targetDisplayName: input.targetDisplayName,
    question: input.question,
    contextSummary: input.contextSummary,
    createdAt: new Date().toISOString(),
    status: "open",
  };
  store.addUpdate(
    encodeClarificationRequest(
      request,
      src(
        input.requesterPersonId,
        input.requesterDisplayName,
        "Clarification request",
      ),
    ),
  );
  const notification = createNotificationIfNew(store, {
    principalId: input.targetPersonId,
    careRecipientId: input.careRecipientId,
    type: "CLARIFICATION_REQUEST",
    priority: "important",
    title: `${input.requesterDisplayName} needs your help`,
    body: input.question.slice(0, 280),
    sourceType: "clarification_request",
    sourceId: request.id,
    actorPersonId: input.requesterPersonId,
    actorDisplayName: input.requesterDisplayName,
    actionType: "open_clarification",
    actionTarget: `clarification:${request.id}`,
    dedupeKey: `clrq:${request.id}:${input.targetPersonId}`,
    metadata: { request },
  });
  return { request, notification };
}

export function encodeClarificationResponse(
  resp: ClarificationResponse,
  source: SourceRef,
): CareUpdate {
  return {
    id: resp.id,
    careRecipientId: resp.careRecipientId,
    toPersonId: resp.responderPersonId,
    summary: CLARIFY_RESP_PREFIX + JSON.stringify(resp),
    status: "ready",
    safetyClass: "moderate",
    source,
  };
}

export function respondToClarification(
  store: CareStore,
  input: {
    requestId: string;
    careRecipientId: string;
    responderPersonId: string;
    responderDisplayName: string;
    body: string;
  },
): {
  response: ClarificationResponse;
  request: ClarificationRequest | null;
  notification: CareNotification | null;
} | null {
  const updates = store.getUpdates(input.careRecipientId);
  let request: ClarificationRequest | null = null;
  for (const u of updates) {
    const r = decodeClarificationRequest(u);
    if (r && r.id === input.requestId) {
      request = r;
      break;
    }
  }
  if (!request) return null;

  const response: ClarificationResponse = {
    id: `clrs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    requestId: input.requestId,
    careRecipientId: input.careRecipientId,
    responderPersonId: input.responderPersonId,
    responderDisplayName: input.responderDisplayName,
    body: input.body,
    createdAt: new Date().toISOString(),
  };
  store.addUpdate(
    encodeClarificationResponse(
      response,
      src(
        input.responderPersonId,
        input.responderDisplayName,
        "Clarification response",
      ),
    ),
  );
  // Update request status
  const closed: ClarificationRequest = {
    ...request,
    status: "answered",
    responseId: response.id,
  };
  store.addUpdate(
    encodeClarificationRequest(
      closed,
      src(
        input.responderPersonId,
        input.responderDisplayName,
        "Clarification closed",
      ),
    ),
  );

  const notification = createNotificationIfNew(store, {
    principalId: request.requesterPersonId,
    careRecipientId: input.careRecipientId,
    type: "CLARIFICATION_RESPONSE",
    priority: "important",
    title: `${input.responderDisplayName} replied`,
    body: input.body.slice(0, 280),
    sourceType: "clarification_response",
    sourceId: response.id,
    actorPersonId: input.responderPersonId,
    actorDisplayName: input.responderDisplayName,
    actionType: "open_clarification_response",
    actionTarget: `clarification_response:${response.id}`,
    dedupeKey: `clrs:${response.id}:${request.requesterPersonId}`,
    metadata: { requestId: request.id, response },
  });

  return { response, request: closed, notification };
}

export function listOpenClarificationsForTarget(
  store: CareStore,
  targetPersonId: string,
  careRecipientId: string,
): ClarificationRequest[] {
  return store
    .getUpdates(careRecipientId)
    .map(decodeClarificationRequest)
    .filter(
      (r): r is ClarificationRequest =>
        !!r && r.targetPersonId === targetPersonId && r.status === "open",
    );
}
