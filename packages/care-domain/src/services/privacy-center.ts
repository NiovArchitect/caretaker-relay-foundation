/**
 * Recipient privacy / access control center — human-readable, not raw security logs.
 */

import type { CareStore } from "../store/memory-store.js";
import { evaluateAccess } from "./access.js";
import { listInvitations } from "./invitation.js";
import { listAccessRequestsForRecipient } from "./access-request.js";
import { calendarOAuthStatus } from "./schedule-engine.js";

export type PrivacyAccessRow = {
  personId: string;
  displayName: string;
  relationship: string;
  activeRole: string;
  authorizationSource: string;
  approvedBy: string;
  grantedAt: string | null;
  expiresAt: string | null;
  status: string;
  dataDomains: string[];
  actionsAllowed: string[];
  lastMeaningfulAccessAt: string | null;
  lastAccessSurface: string | null;
  lastAccessSummary: string;
  contactVerified: boolean | null;
};

export type PrivacyCenter = {
  careRecipientId: string;
  recipientName: string;
  canManage: boolean;
  people: PrivacyAccessRow[];
  pendingRequests: Array<{
    id: string;
    requesterName: string;
    relationship: string;
    status: string;
    reason: string;
  }>;
  outstandingInvitations: Array<{
    id: string;
    inviteeDisplayName: string;
    roleLabel: string;
    status: string;
    expiresAt?: string;
  }>;
  connectedCalendar: {
    status: string;
    message: string;
  };
  aiUseExplanation: string;
  notificationPreferencesNote: string;
};

export function buildPrivacyCenter(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
):
  | { ok: true; center: PrivacyCenter }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(store, actorPersonId, careRecipientId);
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }

  const recipient = store.getRecipient(careRecipientId);
  const canManage =
    actorPersonId === careRecipientId ||
    access.scope.allowedActions.includes("*") ||
    access.scope.informationCategories.includes("*") ||
    access.scope.allowedActions.some((a) => /manage|admin|access/i.test(a));

  const audits = store.listAudit({ careRecipientId });
  const rels = store
    .getRelationships(careRecipientId)
    .filter((r) => canManage || r.personId === actorPersonId);

  const people: PrivacyAccessRow[] = rels.map((r) => {
    const person = store.getPerson(r.personId);
    const views = audits
      .filter(
        (a) =>
          a.actorPersonId === r.personId &&
          (a.action === "CARE_DATA_VIEW" ||
            a.action === "CARE_ANSWER" ||
            a.action === "CARE_EVENT_INGESTED"),
      )
      .sort((a, b) => b.at.localeCompare(a.at));
    const last = views[0];
    const surface =
      typeof last?.details?.surface === "string"
        ? String(last.details.surface)
        : last
          ? last.action.replace(/_/g, " ").toLowerCase()
          : null;
    const domains = r.access.informationCategories.includes("*")
      ? ["All care domains (controlling)"]
      : r.access.informationCategories.length
        ? r.access.informationCategories
        : ["Daily care (limited)"];
    const actions = r.access.allowedActions.includes("*")
      ? ["All care actions"]
      : r.access.allowedActions.length
        ? r.access.allowedActions
        : ["View", "Record updates"];

    return {
      personId: r.personId,
      displayName: person?.displayName ?? r.personId,
      relationship: r.roleLabel || r.role,
      activeRole: r.roleLabel || r.role,
      authorizationSource: r.organizationId
        ? "Organization assignment"
        : "Care relationship / invitation",
      approvedBy: "Authorized care relationship",
      grantedAt: r.startDate ?? null,
      expiresAt: r.endDate ?? null,
      status: r.status,
      dataDomains: domains,
      actionsAllowed: actions,
      lastMeaningfulAccessAt: last?.at ?? null,
      lastAccessSurface: surface,
      lastAccessSummary: last
        ? `${person?.displayName ?? r.personId} last used ${surface ?? "care"} on ${new Date(last.at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`
        : "No recent care activity recorded",
      contactVerified: null,
    };
  });

  let pendingRequests: PrivacyCenter["pendingRequests"] = [];
  try {
    pendingRequests = listAccessRequestsForRecipient(store, careRecipientId)
      .filter((r) => r.status === "pending")
      .map((r) => ({
        id: r.id,
        requesterName: r.requesterDisplayName || r.requesterPersonId,
        relationship: r.claimedRelationship ?? "unspecified",
        status: r.status,
        reason: r.reason ?? "",
      }));
  } catch {
    pendingRequests = [];
  }

  const outstandingInvitations = listInvitations(store, careRecipientId)
    .filter((i) => i.status === "pending")
    .map((i) => ({
      id: i.id,
      inviteeDisplayName: i.inviteeDisplayName,
      roleLabel: i.roleLabel,
      status: i.status,
      expiresAt: i.expiresAt,
    }));

  const cal = calendarOAuthStatus();
  const center: PrivacyCenter = {
    careRecipientId,
    recipientName: recipient?.displayName ?? careRecipientId,
    canManage,
    people,
    pendingRequests,
    outstandingInvitations,
    connectedCalendar: {
      status: cal.configured ? "connectable" : "not_connected",
      message: cal.message,
    },
    aiUseExplanation:
      "Relay uses only care information you are authorized to see. It drafts summaries and suggestions; people confirm consequential actions. It does not diagnose or change a care plan on its own.",
    notificationPreferencesNote:
      "In-app care notifications are on for authorized helpers. SMS/email delivery is not configured in this competition build.",
  };

  return { ok: true, center };
}

/** Narrow or expand relationship scope (controlling only). */
export function modifyAccessScope(
  store: CareStore,
  input: {
    actorPersonId: string;
    careRecipientId: string;
    targetPersonId: string;
    informationCategories?: string[];
    allowedActions?: string[];
    endDate?: string | null;
  },
): { ok: true } | { ok: false; code: string; message: string } {
  const actorAccess = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!actorAccess.allowed) {
    return { ok: false, code: actorAccess.code, message: actorAccess.reason };
  }
  const canManage =
    input.actorPersonId === input.careRecipientId ||
    actorAccess.scope.allowedActions.includes("*") ||
    actorAccess.scope.informationCategories.includes("*");
  if (!canManage) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Only the care recipient or a controlling authority can change scope.",
    };
  }
  const rel = store.getRelationship(input.careRecipientId, input.targetPersonId);
  if (!rel) {
    return { ok: false, code: "NOT_FOUND", message: "No relationship to modify" };
  }
  store.upsertRelationship({
    ...rel,
    access: {
      ...rel.access,
      informationCategories:
        input.informationCategories ?? rel.access.informationCategories,
      allowedActions: input.allowedActions ?? rel.access.allowedActions,
    },
    endDate:
      input.endDate === null
        ? undefined
        : input.endDate !== undefined
          ? input.endDate
          : rel.endDate,
  });
  store.writeAudit({
    at: new Date().toISOString(),
    actorPersonId: input.actorPersonId,
    action: "ACCESS_SCOPE_MODIFIED",
    careRecipientId: input.careRecipientId,
    details: {
      targetPersonId: input.targetPersonId,
      informationCategories: input.informationCategories,
      allowedActions: input.allowedActions,
      endDate: input.endDate,
    },
  });
  return { ok: true };
}

export function revokeAccessNow(
  store: CareStore,
  input: {
    actorPersonId: string;
    careRecipientId: string;
    targetPersonId: string;
  },
): { ok: true } | { ok: false; code: string; message: string } {
  const actorAccess = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!actorAccess.allowed) {
    return { ok: false, code: actorAccess.code, message: actorAccess.reason };
  }
  const canManage =
    input.actorPersonId === input.careRecipientId ||
    actorAccess.scope.allowedActions.includes("*") ||
    actorAccess.scope.informationCategories.includes("*");
  if (!canManage && input.actorPersonId !== input.targetPersonId) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "Not authorized to revoke this access",
    };
  }
  const now = new Date().toISOString();
  store.revokeAccess(input.careRecipientId, input.targetPersonId, now);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "ACCESS_REVOKED",
    careRecipientId: input.careRecipientId,
    details: { targetPersonId: input.targetPersonId },
  });
  return { ok: true };
}
