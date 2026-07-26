/**
 * Durable access-request lifecycle (request → approve/deny → membership).
 * Persisted via CareUpdate rows (same pattern as invitations) — no schema migration required.
 *
 * PRINCIPLE: New accounts have zero recipient access until approval or invitation.
 */

import type {
  AccessScope,
  CareRelationshipRole,
  CareUpdate,
  SourceRef,
} from "../types.js";
import type { CareStore } from "../store/memory-store.js";
import { defaultInviteAccess } from "./invitation.js";

const ACCESS_REQ_PREFIX = "ACCESS_REQ_V1:";
/** Synthetic recipient bucket for requests not yet bound to a real recipient id. */
export const PROVISIONAL_REQUEST_BUCKET = "cr-access-requests";

export type AccessRequestStatus =
  | "pending"
  | "approved"
  | "denied"
  | "cancelled"
  | "expired";

export interface CareAccessRequest {
  id: string;
  /** Real recipient id when known; provisional id when requester only named them. */
  careRecipientId: string;
  provisionalRecipientName?: string;
  requesterPersonId: string;
  requesterDisplayName: string;
  requesterEmail?: string;
  claimedRelationship: string;
  reason: string;
  status: AccessRequestStatus;
  createdAt: string;
  decidedAt?: string;
  decidedByPersonId?: string;
  /** When approved, membership uses this role. */
  approvedRole?: CareRelationshipRole;
  approvedRoleLabel?: string;
}

export function encodeAccessRequestUpdate(
  req: CareAccessRequest,
  source: SourceRef,
): CareUpdate {
  const payload = {
    kind: "access_request",
    provisionalRecipientName: req.provisionalRecipientName,
    requesterPersonId: req.requesterPersonId,
    requesterDisplayName: req.requesterDisplayName,
    requesterEmail: req.requesterEmail,
    claimedRelationship: req.claimedRelationship,
    reason: req.reason,
    status: req.status,
    createdAt: req.createdAt,
    decidedAt: req.decidedAt,
    decidedByPersonId: req.decidedByPersonId,
    approvedRole: req.approvedRole,
    approvedRoleLabel: req.approvedRoleLabel,
  };
  return {
    id: req.id,
    careRecipientId: req.careRecipientId,
    toPersonId: req.requesterPersonId,
    summary: ACCESS_REQ_PREFIX + JSON.stringify(payload),
    status:
      req.status === "pending"
        ? "draft"
        : req.status === "approved"
          ? "ready"
          : "blocked_pending_verify",
    safetyClass: "low",
    source,
  };
}

export function decodeAccessRequestFromUpdate(
  u: CareUpdate,
): CareAccessRequest | null {
  if (!u.summary.startsWith(ACCESS_REQ_PREFIX)) return null;
  try {
    const raw = JSON.parse(u.summary.slice(ACCESS_REQ_PREFIX.length)) as Record<
      string,
      unknown
    >;
    return {
      id: u.id,
      careRecipientId: u.careRecipientId,
      provisionalRecipientName: raw.provisionalRecipientName
        ? String(raw.provisionalRecipientName)
        : undefined,
      requesterPersonId: String(raw.requesterPersonId ?? u.toPersonId),
      requesterDisplayName: String(raw.requesterDisplayName ?? ""),
      requesterEmail: raw.requesterEmail
        ? String(raw.requesterEmail)
        : undefined,
      claimedRelationship: String(raw.claimedRelationship ?? ""),
      reason: String(raw.reason ?? ""),
      status: (raw.status as AccessRequestStatus) ?? "pending",
      createdAt: String(raw.createdAt ?? u.source.recordedAt),
      decidedAt: raw.decidedAt ? String(raw.decidedAt) : undefined,
      decidedByPersonId: raw.decidedByPersonId
        ? String(raw.decidedByPersonId)
        : undefined,
      approvedRole: raw.approvedRole as CareRelationshipRole | undefined,
      approvedRoleLabel: raw.approvedRoleLabel
        ? String(raw.approvedRoleLabel)
        : undefined,
    };
  } catch {
    return null;
  }
}

export function listAccessRequestsForRecipient(
  store: CareStore,
  careRecipientId: string,
): CareAccessRequest[] {
  return store
    .getUpdates(careRecipientId)
    .map(decodeAccessRequestFromUpdate)
    .filter((r): r is CareAccessRequest => Boolean(r));
}

export function listAccessRequestsForRequester(
  store: CareStore,
  requesterPersonId: string,
  recipientIds: string[],
): CareAccessRequest[] {
  const out: CareAccessRequest[] = [];
  const seen = new Set<string>();
  for (const rid of recipientIds) {
    for (const r of listAccessRequestsForRecipient(store, rid)) {
      if (r.requesterPersonId === requesterPersonId && !seen.has(r.id)) {
        seen.add(r.id);
        out.push(r);
      }
    }
  }
  // Also scan provisional bucket
  for (const r of listAccessRequestsForRecipient(
    store,
    PROVISIONAL_REQUEST_BUCKET,
  )) {
    if (r.requesterPersonId === requesterPersonId && !seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}

export function findAccessRequest(
  store: CareStore,
  requestId: string,
  searchRecipientIds: string[],
): CareAccessRequest | null {
  const ids = [...new Set([...searchRecipientIds, PROVISIONAL_REQUEST_BUCKET])];
  for (const rid of ids) {
    for (const r of listAccessRequestsForRecipient(store, rid)) {
      if (r.id === requestId) return r;
    }
  }
  return null;
}

export function approveAccessRequest(
  store: CareStore,
  req: CareAccessRequest,
  approverPersonId: string,
  opts?: {
    role?: CareRelationshipRole;
    roleLabel?: string;
    scope?: AccessScope;
  },
): CareAccessRequest {
  const now = new Date().toISOString();
  const role = opts?.role ?? "family_caregiver";
  const roleLabel =
    opts?.roleLabel ??
    (role === "paid_caregiver"
      ? "Professional caregiver"
      : "Family / friend caregiver");
  const access = opts?.scope ?? defaultInviteAccess(role);

  const existingRel = store.getRelationship(
    req.careRecipientId,
    req.requesterPersonId,
  );
  const existingConsent = store.getConsent(
    req.careRecipientId,
    req.requesterPersonId,
  );

  store.upsertRelationship({
    id: existingRel?.id ?? `rel-${req.requesterPersonId}-${req.careRecipientId}`,
    careRecipientId: req.careRecipientId,
    personId: req.requesterPersonId,
    role,
    roleLabel,
    responsibilities: existingRel?.responsibilities?.length
      ? existingRel.responsibilities
      : ["Care continuity"],
    access,
    status: "active",
    startDate: existingRel?.startDate ?? now.slice(0, 10),
  });
  store.upsertConsent({
    id: existingConsent?.id ?? `consent-${req.requesterPersonId}`,
    careRecipientId: req.careRecipientId,
    granteePersonId: req.requesterPersonId,
    scope: access,
    status: "active",
    grantedAt: existingConsent?.grantedAt ?? now,
  });

  const approved: CareAccessRequest = {
    ...req,
    status: "approved",
    decidedAt: now,
    decidedByPersonId: approverPersonId,
    approvedRole: role,
    approvedRoleLabel: roleLabel,
  };
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "system_derived",
    label: "Access request approved",
    actorName: store.getPerson(approverPersonId)?.displayName,
    actorPersonId: approverPersonId,
    recordedAt: now,
    whyVisible: "Membership established via access request approval",
  };
  store.addUpdate(encodeAccessRequestUpdate(approved, source));
  store.writeAudit({
    at: now,
    actorPersonId: approverPersonId,
    action: "ACCESS_REQUEST_APPROVED",
    careRecipientId: req.careRecipientId,
    details: {
      request_id: req.id,
      requester_person_id: req.requesterPersonId,
      role,
    },
  });
  return approved;
}

export function denyAccessRequest(
  store: CareStore,
  req: CareAccessRequest,
  denierPersonId: string,
): CareAccessRequest {
  const now = new Date().toISOString();
  const denied: CareAccessRequest = {
    ...req,
    status: "denied",
    decidedAt: now,
    decidedByPersonId: denierPersonId,
  };
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "system_derived",
    label: "Access request denied",
    actorPersonId: denierPersonId,
    recordedAt: now,
    whyVisible: "Access request denied by authorized principal",
  };
  store.addUpdate(encodeAccessRequestUpdate(denied, source));
  store.writeAudit({
    at: now,
    actorPersonId: denierPersonId,
    action: "ACCESS_REQUEST_DENIED",
    careRecipientId: req.careRecipientId,
    details: {
      request_id: req.id,
      requester_person_id: req.requesterPersonId,
    },
  });
  return denied;
}
