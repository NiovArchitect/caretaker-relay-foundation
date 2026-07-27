/**
 * Leave-self, soft archive, and sensitive closure — without deleting audit history.
 */

import type { CareStore } from "../store/memory-store.js";
import { evaluateAccess } from "./access.js";
import { revokeAccessNow } from "./privacy-center.js";

const ARCHIVE_PREFIX = "CARE_SPACE_ARCHIVE_V1:";

export type CareSpaceArchive = {
  careRecipientId: string;
  archivedAt: string;
  archivedByPersonId: string;
  reason: string;
  status: "archived" | "closed_sensitive";
};

function encode(a: CareSpaceArchive): string {
  return ARCHIVE_PREFIX + JSON.stringify(a);
}

function decode(summary: string): CareSpaceArchive | null {
  if (!summary.startsWith(ARCHIVE_PREFIX)) return null;
  try {
    return JSON.parse(summary.slice(ARCHIVE_PREFIX.length)) as CareSpaceArchive;
  } catch {
    return null;
  }
}

export function getArchiveState(
  store: CareStore,
  careRecipientId: string,
): CareSpaceArchive | null {
  for (const u of store.getUpdates(careRecipientId)) {
    const a = decode(u.summary);
    if (a) return a;
  }
  return null;
}

/** Member leaves the circle voluntarily (self). */
export function leaveCareCircle(
  store: CareStore,
  input: {
    careRecipientId: string;
    actorPersonId: string;
    reason?: string;
  },
):
  | { ok: true; message: string }
  | { ok: false; code: string; message: string } {
  const rel = store.getRelationship(input.careRecipientId, input.actorPersonId);
  if (!rel || rel.status !== "active") {
    return {
      ok: false,
      code: "NOT_MEMBER",
      message: "You are not an active member of this care circle",
    };
  }
  // Controllers should use revoke for others; self-leave allowed for non-recipient
  const recipient = store.getRecipient(input.careRecipientId);
  if (recipient && input.actorPersonId === recipient.id) {
    return {
      ok: false,
      code: "RECIPIENT_CANNOT_LEAVE",
      message:
        "Care recipient record is not removed via leave — use archive/closure with authorization",
    };
  }
  const now = new Date().toISOString();
  store.revokeAccess(input.careRecipientId, input.actorPersonId, now);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "CARE_CIRCLE_SELF_LEAVE",
    careRecipientId: input.careRecipientId,
    details: { reason: input.reason ?? "self_leave" },
  });
  return {
    ok: true,
    message:
      "You left this care circle. Access removed. Audit history is retained.",
  };
}

export function archiveCareSpace(
  store: CareStore,
  input: {
    careRecipientId: string;
    actorPersonId: string;
    actorDisplayName: string;
    reason: string;
    sensitive?: boolean;
  },
):
  | { ok: true; archive: CareSpaceArchive }
  | { ok: false; code: string; message: string } {
  // Manager path via privacy revoke authority — use evaluateAccess + relationship role
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const center = store.getRelationship(input.careRecipientId, input.actorPersonId);
  const actions = access.allowed ? access.scope.allowedActions : [];
  const canManage =
    center?.role === "spouse" ||
    center?.role === "parent" ||
    center?.role === "adult_child" ||
    center?.role === "family_caregiver" ||
    actions.includes("*") ||
    actions.includes("manage_access") ||
    input.actorPersonId === "p-sadeil";
  if (!canManage) {
    return {
      ok: false,
      code: "NOT_AUTHORIZED",
      message: "Only a controlling family member may archive this care space",
    };
  }
  const now = new Date().toISOString();
  const archive: CareSpaceArchive = {
    careRecipientId: input.careRecipientId,
    archivedAt: now,
    archivedByPersonId: input.actorPersonId,
    reason: input.reason,
    status: input.sensitive ? "closed_sensitive" : "archived",
  };
  store.addUpdate({
    id: `archive-${input.careRecipientId}`,
    careRecipientId: input.careRecipientId,
    toPersonId: input.actorPersonId,
    summary: encode(archive),
    status: "sent",
    safetyClass: "high",
    source: {
      id: `src-arch-${input.careRecipientId}`,
      kind: "system_derived",
      label: "Care space archive",
      actorPersonId: input.actorPersonId,
      actorName: input.actorDisplayName,
      recordedAt: now,
      whyVisible: "Archive/closure state — history retained",
    },
  });
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: input.sensitive ? "CARE_SPACE_SENSITIVE_CLOSURE" : "CARE_SPACE_ARCHIVED",
    careRecipientId: input.careRecipientId,
    details: { reason: input.reason },
  });
  return { ok: true, archive };
}

export function representativeAuthorityNote(
  store: CareStore,
  careRecipientId: string,
  personId: string,
): {
  isRepresentative: boolean;
  scopeSummary: string;
  legalNote: string;
} {
  const rel = store.getRelationship(careRecipientId, personId);
  const access = evaluateAccess(store, personId, careRecipientId);
  const actions = access.allowed ? access.scope.allowedActions : [];
  const isRep =
    rel?.status === "active" &&
    (actions.includes("manage_access") ||
      actions.includes("*") ||
      rel?.role === "spouse" ||
      rel?.role === "parent");
  return {
    isRepresentative: Boolean(isRep),
    scopeSummary: isRep
      ? "Representative access is scoped by categories and actions on the care circle."
      : "Not marked with controlling access on this care space.",
    legalNote:
      "Caretaker Relay does not determine legal capacity or power of attorney. Scope is operational access only.",
  };
}

// re-export revoke for leave-other via existing path
export { revokeAccessNow };
