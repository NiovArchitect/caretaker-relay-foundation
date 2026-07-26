/**
 * Provisional recipient lifecycle (draft → activation / decline / expire).
 * Durable via CareUpdate rows — no schema migration.
 * PRINCIPLE: No automatic merge by name; no PHI discovery of existing recipients.
 */

import type { CareUpdate, SourceRef } from "../types.js";
import type { CareStore } from "../store/memory-store.js";

const PROV_PREFIX = "PROVISIONAL_RECIPIENT_V1:";
export const PROVISIONAL_BUCKET = "cr-provisional-recipients";

export type ProvisionalStatus =
  | "draft"
  | "invitation_pending"
  | "verification_pending"
  | "representative_review"
  | "organization_review"
  | "ready_to_activate"
  | "active"
  | "declined"
  | "expired"
  | "suspended"
  | "duplicate_review";

export interface ProvisionalRecipient {
  id: string;
  preferredName: string;
  /** Opaque note — never used for auto-match against existing PHI. */
  creatorNote?: string;
  createdByPersonId: string;
  createdByDisplayName: string;
  claimedAuthority: string;
  status: ProvisionalStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  boundRecipientId?: string;
  activatedAt?: string;
  declinedAt?: string;
  declineReason?: string;
}

export function encodeProvisionalUpdate(
  p: ProvisionalRecipient,
  source: SourceRef,
): CareUpdate {
  const payload = {
    kind: "provisional_recipient",
    preferredName: p.preferredName,
    creatorNote: p.creatorNote,
    createdByPersonId: p.createdByPersonId,
    createdByDisplayName: p.createdByDisplayName,
    claimedAuthority: p.claimedAuthority,
    status: p.status,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    expiresAt: p.expiresAt,
    boundRecipientId: p.boundRecipientId,
    activatedAt: p.activatedAt,
    declinedAt: p.declinedAt,
    declineReason: p.declineReason,
  };
  return {
    id: p.id,
    careRecipientId: PROVISIONAL_BUCKET,
    toPersonId: p.createdByPersonId,
    summary: PROV_PREFIX + JSON.stringify(payload),
    status:
      p.status === "active"
        ? "ready"
        : p.status === "declined" || p.status === "expired"
          ? "blocked_pending_verify"
          : "draft",
    safetyClass: "low",
    source,
  };
}

export function decodeProvisionalFromUpdate(
  u: CareUpdate,
): ProvisionalRecipient | null {
  if (!u.summary.startsWith(PROV_PREFIX)) return null;
  try {
    const raw = JSON.parse(u.summary.slice(PROV_PREFIX.length)) as Record<
      string,
      unknown
    >;
    return {
      id: u.id,
      preferredName: String(raw.preferredName ?? ""),
      creatorNote: raw.creatorNote ? String(raw.creatorNote) : undefined,
      createdByPersonId: String(raw.createdByPersonId ?? u.toPersonId),
      createdByDisplayName: String(raw.createdByDisplayName ?? ""),
      claimedAuthority: String(raw.claimedAuthority ?? ""),
      status: (raw.status as ProvisionalStatus) ?? "draft",
      createdAt: String(raw.createdAt ?? ""),
      updatedAt: String(raw.updatedAt ?? raw.createdAt ?? ""),
      expiresAt: raw.expiresAt ? String(raw.expiresAt) : undefined,
      boundRecipientId: raw.boundRecipientId
        ? String(raw.boundRecipientId)
        : undefined,
      activatedAt: raw.activatedAt ? String(raw.activatedAt) : undefined,
      declinedAt: raw.declinedAt ? String(raw.declinedAt) : undefined,
      declineReason: raw.declineReason
        ? String(raw.declineReason)
        : undefined,
    };
  } catch {
    return null;
  }
}

function ensureBucket(store: CareStore): void {
  if (!store.getRecipient(PROVISIONAL_BUCKET)) {
    store.upsertRecipient({
      id: PROVISIONAL_BUCKET,
      displayName: "Provisional recipient queue",
      preferredName: "Provisional",
      householdId: "hh-provisional",
    });
  }
}

export function createProvisionalRecipient(
  store: CareStore,
  input: {
    preferredName: string;
    createdByPersonId: string;
    createdByDisplayName: string;
    claimedAuthority: string;
    creatorNote?: string;
    ttlDays?: number;
  },
): ProvisionalRecipient {
  ensureBucket(store);
  const now = new Date().toISOString();
  const ttl = (input.ttlDays ?? 30) * 24 * 3600 * 1000;
  const p: ProvisionalRecipient = {
    id: store.newId("prov"),
    preferredName: input.preferredName.trim(),
    creatorNote: input.creatorNote?.trim(),
    createdByPersonId: input.createdByPersonId,
    createdByDisplayName: input.createdByDisplayName,
    claimedAuthority: input.claimedAuthority.trim(),
    status: "draft",
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + ttl).toISOString(),
  };
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "system_derived",
    label: "Provisional recipient created",
    actorName: input.createdByDisplayName,
    actorPersonId: input.createdByPersonId,
    recordedAt: now,
    whyVisible: "Draft provisional care space — not an active recipient",
  };
  store.addUpdate(encodeProvisionalUpdate(p, source));
  store.writeAudit({
    at: now,
    actorPersonId: input.createdByPersonId,
    action: "PROVISIONAL_RECIPIENT_CREATED",
    details: {
      provisional_id: p.id,
      // Do not log preferred name in operational audit details by default
      claimed_authority: p.claimedAuthority,
      status: p.status,
    },
  });
  return p;
}

export function listProvisionalForCreator(
  store: CareStore,
  creatorPersonId: string,
): ProvisionalRecipient[] {
  ensureBucket(store);
  return store
    .getUpdates(PROVISIONAL_BUCKET)
    .map(decodeProvisionalFromUpdate)
    .filter((p): p is ProvisionalRecipient => Boolean(p))
    .filter((p) => p.createdByPersonId === creatorPersonId);
}

export function findProvisional(
  store: CareStore,
  provisionalId: string,
): ProvisionalRecipient | null {
  ensureBucket(store);
  for (const u of store.getUpdates(PROVISIONAL_BUCKET)) {
    const p = decodeProvisionalFromUpdate(u);
    if (p?.id === provisionalId) return p;
  }
  return null;
}

/**
 * Bind provisional → real recipient id.
 * SECURITY: Does not search existing recipients by name.
 * Caller must supply an explicit careRecipientId they already control.
 */
export function bindProvisionalToRecipient(
  store: CareStore,
  provisional: ProvisionalRecipient,
  input: {
    careRecipientId: string;
    actorPersonId: string;
    actorDisplayName: string;
  },
):
  | { ok: true; provisional: ProvisionalRecipient }
  | { ok: false; code: string; message: string } {
  if (
    provisional.status === "active" ||
    provisional.status === "declined" ||
    provisional.status === "expired"
  ) {
    return {
      ok: false,
      code: "INVALID_STATE",
      message: `Cannot bind from status ${provisional.status}`,
    };
  }
  if (provisional.createdByPersonId !== input.actorPersonId) {
    // Only creator or future controlling authority on the target may bind
    const access = store.getRelationship(
      input.careRecipientId,
      input.actorPersonId,
    );
    if (
      !access ||
      access.status !== "active" ||
      !(
        access.access.allowedActions.includes("*") ||
        access.access.informationCategories.includes("*")
      )
    ) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message: "Not authorized to bind this provisional record",
      };
    }
  }
  const recipient = store.getRecipient(input.careRecipientId);
  if (!recipient) {
    return {
      ok: false,
      code: "UNKNOWN_RECIPIENT",
      message: "Target recipient not found",
    };
  }
  const now = new Date().toISOString();
  const next: ProvisionalRecipient = {
    ...provisional,
    status: "ready_to_activate",
    boundRecipientId: input.careRecipientId,
    updatedAt: now,
  };
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "system_derived",
    label: "Provisional bound to recipient",
    actorName: input.actorDisplayName,
    actorPersonId: input.actorPersonId,
    recordedAt: now,
    whyVisible: "Explicit bind — no name matching",
  };
  store.addUpdate(encodeProvisionalUpdate(next, source));
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "PROVISIONAL_RECIPIENT_BOUND",
    careRecipientId: input.careRecipientId,
    details: {
      provisional_id: provisional.id,
      status: next.status,
    },
  });
  return { ok: true, provisional: next };
}

export function activateProvisional(
  store: CareStore,
  provisional: ProvisionalRecipient,
  actorPersonId: string,
):
  | { ok: true; provisional: ProvisionalRecipient }
  | { ok: false; code: string; message: string } {
  if (provisional.status !== "ready_to_activate" || !provisional.boundRecipientId) {
    return {
      ok: false,
      code: "NOT_READY",
      message: "Provisional must be bound before activation",
    };
  }
  if (
    provisional.expiresAt &&
    new Date(provisional.expiresAt).getTime() < Date.now()
  ) {
    return { ok: false, code: "EXPIRED", message: "Provisional expired" };
  }
  const now = new Date().toISOString();
  const next: ProvisionalRecipient = {
    ...provisional,
    status: "active",
    activatedAt: now,
    updatedAt: now,
  };
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "system_derived",
    label: "Provisional activated",
    actorPersonId,
    recordedAt: now,
    whyVisible: "Provisional care space activated against real recipient",
  };
  store.addUpdate(encodeProvisionalUpdate(next, source));
  store.writeAudit({
    at: now,
    actorPersonId,
    action: "PROVISIONAL_RECIPIENT_ACTIVATED",
    careRecipientId: provisional.boundRecipientId,
    details: { provisional_id: provisional.id },
  });
  return { ok: true, provisional: next };
}

export function declineProvisional(
  store: CareStore,
  provisional: ProvisionalRecipient,
  actorPersonId: string,
  reason?: string,
): ProvisionalRecipient {
  const now = new Date().toISOString();
  const next: ProvisionalRecipient = {
    ...provisional,
    status: "declined",
    declinedAt: now,
    declineReason: reason,
    updatedAt: now,
  };
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "system_derived",
    label: "Provisional declined",
    actorPersonId,
    recordedAt: now,
    whyVisible: "Provisional declined — grants no access",
  };
  store.addUpdate(encodeProvisionalUpdate(next, source));
  store.writeAudit({
    at: now,
    actorPersonId,
    action: "PROVISIONAL_RECIPIENT_DECLINED",
    details: { provisional_id: provisional.id },
  });
  return next;
}
