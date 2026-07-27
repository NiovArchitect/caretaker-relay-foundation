/**
 * Bounded ETL outbox — durable side-effect queue with retry + dead-letter.
 * Competition-sized: in-store CareUpdate rows, process on request or drain.
 */

import type { CareStore } from "../store/memory-store.js";
import { createNotificationIfNew } from "./notifications.js";

export type OutboxStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "failed"
  | "dead_letter";

export type OutboxItem = {
  id: string;
  careRecipientId: string;
  kind: "notification" | "reminder_recalc" | "projection_touch" | "generic";
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  idempotencyKey: string;
  relatedEventId?: string;
};

const PREFIX = "ETL_OUTBOX_V1:";

function encode(i: OutboxItem): string {
  return PREFIX + JSON.stringify(i);
}

function decode(summary: string): OutboxItem | null {
  if (!summary.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(summary.slice(PREFIX.length)) as OutboxItem;
  } catch {
    return null;
  }
}

function save(store: CareStore, item: OutboxItem): void {
  store.addUpdate({
    id: item.id,
    careRecipientId: item.careRecipientId,
    toPersonId: "system",
    summary: encode(item),
    status: "ready",
    safetyClass: "low",
    source: {
      id: `src-obx-${item.id}`,
      kind: "system_derived",
      label: "ETL outbox",
      recordedAt: item.updatedAt,
      whyVisible: "Side-effect queue for reliability",
    },
  });
}

export function listOutbox(
  store: CareStore,
  careRecipientId?: string,
): OutboxItem[] {
  const ids = careRecipientId
    ? [careRecipientId]
    : store.listRecipients().map((r) => r.id);
  // Also scan account meta style by walking known recipients
  const out: OutboxItem[] = [];
  const seen = new Set<string>();
  for (const rid of ids) {
    for (const u of store.getUpdates(rid)) {
      const item = decode(u.summary);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        out.push(item);
      }
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function enqueueOutbox(
  store: CareStore,
  input: {
    careRecipientId: string;
    kind: OutboxItem["kind"];
    payload: Record<string, unknown>;
    idempotencyKey: string;
    relatedEventId?: string;
    maxAttempts?: number;
  },
): OutboxItem {
  const existing = listOutbox(store, input.careRecipientId).find(
    (i) => i.idempotencyKey === input.idempotencyKey,
  );
  if (existing) return existing;
  const now = new Date().toISOString();
  const item: OutboxItem = {
    id: store.newId("obx"),
    careRecipientId: input.careRecipientId,
    kind: input.kind,
    payload: input.payload,
    status: "pending",
    attempts: 0,
    maxAttempts: input.maxAttempts ?? 3,
    createdAt: now,
    updatedAt: now,
    idempotencyKey: input.idempotencyKey,
    relatedEventId: input.relatedEventId,
  };
  save(store, item);
  store.writeAudit({
    at: now,
    actorPersonId: "system",
    action: "ETL_OUTBOX_ENQUEUED",
    careRecipientId: input.careRecipientId,
    details: { outboxId: item.id, kind: item.kind, idempotencyKey: item.idempotencyKey },
  });
  return item;
}

function processOne(store: CareStore, item: OutboxItem): OutboxItem {
  const now = new Date().toISOString();
  if (item.status === "succeeded" || item.status === "dead_letter") return item;
  const next: OutboxItem = {
    ...item,
    status: "processing",
    attempts: item.attempts + 1,
    updatedAt: now,
  };
  save(store, next);

  try {
    if (item.kind === "notification") {
      const p = item.payload;
      createNotificationIfNew(store, {
        principalId: String(p.principalId ?? ""),
        careRecipientId: item.careRecipientId,
        type: (p.type as "CARE_UPDATE") ?? "CARE_UPDATE",
        priority: (p.priority as "attention") ?? "attention",
        title: String(p.title ?? "Care update"),
        body: String(p.body ?? ""),
        sourceType: String(p.sourceType ?? "outbox"),
        sourceId: String(p.sourceId ?? item.id),
        actorPersonId: p.actorPersonId ? String(p.actorPersonId) : undefined,
        actorDisplayName: p.actorDisplayName
          ? String(p.actorDisplayName)
          : undefined,
        actionType: String(p.actionType ?? "open_today"),
        actionTarget: String(p.actionTarget ?? item.id),
        dedupeKey: String(p.dedupeKey ?? item.idempotencyKey),
      });
    }
    // reminder_recalc / projection_touch are no-ops that prove drain works
    const ok: OutboxItem = {
      ...next,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
      lastError: undefined,
    };
    save(store, ok);
    store.writeAudit({
      at: ok.updatedAt,
      actorPersonId: "system",
      action: "ETL_OUTBOX_SUCCEEDED",
      careRecipientId: item.careRecipientId,
      details: { outboxId: item.id, attempts: ok.attempts },
    });
    return ok;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "failed";
    const failed: OutboxItem = {
      ...next,
      status: next.attempts >= next.maxAttempts ? "dead_letter" : "failed",
      lastError: msg,
      updatedAt: new Date().toISOString(),
    };
    save(store, failed);
    store.writeAudit({
      at: failed.updatedAt,
      actorPersonId: "system",
      action:
        failed.status === "dead_letter"
          ? "ETL_OUTBOX_DEAD_LETTER"
          : "ETL_OUTBOX_FAILED",
      careRecipientId: item.careRecipientId,
      details: { outboxId: item.id, error: msg, attempts: failed.attempts },
    });
    return failed;
  }
}

/** Drain pending/failed items (bounded). Idempotent via idempotencyKey. */
export function drainOutbox(
  store: CareStore,
  opts?: { careRecipientId?: string; limit?: number },
): { processed: number; succeeded: number; failed: number; deadLetter: number } {
  const limit = opts?.limit ?? 20;
  const items = listOutbox(store, opts?.careRecipientId)
    .filter((i) => i.status === "pending" || i.status === "failed")
    .slice(0, limit);
  let succeeded = 0;
  let failed = 0;
  let deadLetter = 0;
  for (const item of items) {
    const r = processOne(store, item);
    if (r.status === "succeeded") succeeded++;
    else if (r.status === "dead_letter") deadLetter++;
    else if (r.status === "failed") failed++;
  }
  return {
    processed: items.length,
    succeeded,
    failed,
    deadLetter,
  };
}

export function outboxHealth(store: CareStore): {
  pending: number;
  failed: number;
  deadLetter: number;
  succeeded: number;
  healthy: boolean;
} {
  const all = listOutbox(store);
  const pending = all.filter((i) => i.status === "pending").length;
  const failed = all.filter((i) => i.status === "failed").length;
  const deadLetter = all.filter((i) => i.status === "dead_letter").length;
  const succeeded = all.filter((i) => i.status === "succeeded").length;
  return {
    pending,
    failed,
    deadLetter,
    succeeded,
    healthy: deadLetter === 0 && failed < 5,
  };
}

/**
 * Simulate: event already durable; notification side effect enqueued and retried.
 */
export function proveEtlReliability(
  store: CareStore,
  careRecipientId: string,
): {
  enqueued: OutboxItem;
  firstDrain: ReturnType<typeof drainOutbox>;
  secondDrain: ReturnType<typeof drainOutbox>;
  duplicatePrevented: boolean;
  health: ReturnType<typeof outboxHealth>;
} {
  const key = `proof-notif:${careRecipientId}:hydration`;
  const enqueued = enqueueOutbox(store, {
    careRecipientId,
    kind: "notification",
    idempotencyKey: key,
    payload: {
      principalId: store.getRelationships(careRecipientId)[0]?.personId ?? "p-sadeil",
      title: "Reliability proof",
      body: "Side effect after durable event",
      dedupeKey: key,
      type: "CARE_UPDATE",
      priority: "info",
      sourceType: "etl_proof",
      sourceId: key,
      actionType: "open_today",
      actionTarget: careRecipientId,
    },
    relatedEventId: "proof-event",
  });
  const again = enqueueOutbox(store, {
    careRecipientId,
    kind: "notification",
    idempotencyKey: key,
    payload: enqueued.payload,
  });
  const firstDrain = drainOutbox(store, { careRecipientId, limit: 10 });
  const secondDrain = drainOutbox(store, { careRecipientId, limit: 10 });
  return {
    enqueued,
    firstDrain,
    secondDrain,
    duplicatePrevented: again.id === enqueued.id,
    health: outboxHealth(store),
  };
}
