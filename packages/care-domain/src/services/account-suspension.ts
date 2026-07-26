/**
 * Account suspension contract — principal status + session wipe.
 * Durable metadata via CareUpdate on account-meta bucket.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareUpdate, SourceRef } from "../types.js";
import { ACCOUNT_META_BUCKET } from "./contact-verification.js";

const SUSPEND_PREFIX = "ACCOUNT_STATUS_V1:";

export type AccountPrincipalStatus =
  | "active"
  | "suspended"
  | "closed"
  | "pending_access";

export interface AccountStatusRecord {
  carePersonId: string;
  status: AccountPrincipalStatus;
  reason?: string;
  suspendedAt?: string;
  suspendedByPersonId?: string;
  reactivatedAt?: string;
  updatedAt: string;
}

export function encodeAccountStatusUpdate(
  rec: AccountStatusRecord,
  source: SourceRef,
): CareUpdate {
  return {
    id: `acct-status-${rec.carePersonId}`,
    careRecipientId: ACCOUNT_META_BUCKET,
    toPersonId: rec.carePersonId,
    summary: SUSPEND_PREFIX + JSON.stringify(rec),
    status: rec.status === "suspended" ? "blocked_pending_verify" : "ready",
    safetyClass: "low",
    source,
  };
}

export function decodeAccountStatus(
  u: CareUpdate,
): AccountStatusRecord | null {
  if (!u.summary.startsWith(SUSPEND_PREFIX)) return null;
  try {
    return JSON.parse(u.summary.slice(SUSPEND_PREFIX.length)) as AccountStatusRecord;
  } catch {
    return null;
  }
}

function ensureBucket(store: CareStore): void {
  if (!store.getRecipient(ACCOUNT_META_BUCKET)) {
    store.upsertRecipient({
      id: ACCOUNT_META_BUCKET,
      displayName: "Account meta",
      householdId: "hh-account-meta",
    });
  }
}

export function getAccountStatus(
  store: CareStore,
  carePersonId: string,
): AccountStatusRecord | null {
  ensureBucket(store);
  for (const u of store.getUpdates(ACCOUNT_META_BUCKET)) {
    const rec = decodeAccountStatus(u);
    if (rec?.carePersonId === carePersonId) return rec;
  }
  return null;
}

export function isAccountSuspended(
  store: CareStore,
  carePersonId: string,
): boolean {
  return getAccountStatus(store, carePersonId)?.status === "suspended";
}

export function suspendAccount(
  store: CareStore,
  input: {
    carePersonId: string;
    reason: string;
    suspendedByPersonId: string;
  },
): AccountStatusRecord {
  ensureBucket(store);
  const now = new Date().toISOString();
  const rec: AccountStatusRecord = {
    carePersonId: input.carePersonId,
    status: "suspended",
    reason: input.reason,
    suspendedAt: now,
    suspendedByPersonId: input.suspendedByPersonId,
    updatedAt: now,
  };
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "system_derived",
    label: "Account suspended",
    actorPersonId: input.suspendedByPersonId,
    recordedAt: now,
    whyVisible: "Account suspension",
  };
  store.addUpdate(encodeAccountStatusUpdate(rec, source));
  store.writeAudit({
    at: now,
    actorPersonId: input.suspendedByPersonId,
    action: "ACCOUNT_SUSPENDED",
    details: {
      target_person_id: input.carePersonId,
      reason: input.reason.slice(0, 200),
    },
  });
  return rec;
}

export function reactivateAccount(
  store: CareStore,
  input: {
    carePersonId: string;
    reactivatedByPersonId: string;
  },
): AccountStatusRecord {
  ensureBucket(store);
  const now = new Date().toISOString();
  const prev = getAccountStatus(store, input.carePersonId);
  const rec: AccountStatusRecord = {
    carePersonId: input.carePersonId,
    status: "active",
    reason: prev?.reason,
    suspendedAt: prev?.suspendedAt,
    suspendedByPersonId: prev?.suspendedByPersonId,
    reactivatedAt: now,
    updatedAt: now,
  };
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "system_derived",
    label: "Account reactivated",
    actorPersonId: input.reactivatedByPersonId,
    recordedAt: now,
    whyVisible: "Account reactivation",
  };
  store.addUpdate(encodeAccountStatusUpdate(rec, source));
  store.writeAudit({
    at: now,
    actorPersonId: input.reactivatedByPersonId,
    action: "ACCOUNT_REACTIVATED",
    details: { target_person_id: input.carePersonId },
  });
  return rec;
}
