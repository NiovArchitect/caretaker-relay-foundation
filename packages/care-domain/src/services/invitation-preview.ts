/**
 * PHI-safe invitation preview.
 * Pre-auth: minimal. Post-auth valid token: scoped details only.
 */

import type { CareStore } from "../store/memory-store.js";
import {
  findInvitationByTokenGlobal,
  matchInvitationToken,
} from "./invitation.js";

export type InvitePreviewPreAuth = {
  stage: "pre_auth";
  valid_format: boolean;
  message: string;
  product: "Caretaker Relay";
};

export type InvitePreviewAuthorized = {
  stage: "authorized_preview";
  valid: true;
  inviterDisplayName: string;
  recipientDisplayName: string;
  proposedRole: string;
  roleLabel: string;
  dataDomains: string[];
  actionsAllowed: string[];
  expiresAt?: string;
  authorizationSource: string;
  invitationId: string;
  careRecipientId: string;
};

export type InvitePreviewDenied = {
  stage: "denied";
  valid: false;
  code:
    | "MALFORMED"
    | "NOT_FOUND"
    | "EXPIRED"
    | "REVOKED"
    | "CONSUMED"
    | "WRONG_IDENTITY";
  message: string;
  phi_disclosed: false;
};

function domainsForRole(role: string): string[] {
  if (/dsp|paid|professional/i.test(role)) {
    return ["Daily care", "Shift tasks", "Observations", "Handoffs"];
  }
  if (/physician|clinician|provider/i.test(role)) {
    return ["Clinical summary", "Medications", "Observations", "Appointments"];
  }
  return ["Daily care", "Schedule", "Coordination", "Documents (limited)"];
}

function actionsForRole(role: string): string[] {
  if (/dsp|paid/i.test(role)) {
    return ["View shift", "Record observations", "Complete handoff"];
  }
  if (/physician|clinician/i.test(role)) {
    return ["View clinical summary", "Review trends", "Ask care-team questions"];
  }
  return ["View Today", "Record updates", "Message helpers"];
}

/** Pre-auth: only confirm format / product — zero PHI. */
export function previewInvitationPreAuth(token: string): InvitePreviewPreAuth {
  const t = (token ?? "").trim();
  if (!t || t.length < 8) {
    return {
      stage: "pre_auth",
      valid_format: false,
      message:
        "Enter an invitation code from someone who already coordinates care. No care details are shown until the code validates.",
      product: "Caretaker Relay",
    };
  }
  return {
    stage: "pre_auth",
    valid_format: true,
    message:
      "Sign in or create an account to validate this invitation. Recipient details appear only after a successful check.",
    product: "Caretaker Relay",
  };
}

/**
 * Authenticated preview. Invalid tokens never reveal recipient PHI.
 */
export function previewInvitationAuthenticated(
  store: CareStore,
  token: string,
  actorPersonId: string,
): InvitePreviewAuthorized | InvitePreviewDenied {
  const t = (token ?? "").trim();
  if (!t || t.length < 8) {
    return {
      stage: "denied",
      valid: false,
      code: "MALFORMED",
      message: "That invitation code is not valid.",
      phi_disclosed: false,
    };
  }

  let careRecipientId: string | null = null;
  const recipientIds = store.listRecipients().map((r) => r.id);
  let inv = findInvitationByTokenGlobal(store, recipientIds, t);
  if (inv) {
    careRecipientId = inv.careRecipientId;
  } else {
    for (const rid of recipientIds) {
      const m = matchInvitationToken(store, rid, t);
      if (m) {
        inv = m;
        careRecipientId = rid;
        break;
      }
    }
  }

  if (!inv || !careRecipientId) {
    return {
      stage: "denied",
      valid: false,
      code: "NOT_FOUND",
      message:
        "This invitation could not be validated. No care information is available.",
      phi_disclosed: false,
    };
  }

  if (inv.status === "revoked") {
    return {
      stage: "denied",
      valid: false,
      code: "REVOKED",
      message: "This invitation was revoked. No care information is available.",
      phi_disclosed: false,
    };
  }
  if (inv.status === "accepted" || inv.status === "consumed") {
    return {
      stage: "denied",
      valid: false,
      code: "CONSUMED",
      message: "This invitation was already used. No additional details are shown.",
      phi_disclosed: false,
    };
  }
  if (inv.expiresAt && Date.parse(inv.expiresAt) < Date.now()) {
    return {
      stage: "denied",
      valid: false,
      code: "EXPIRED",
      message: "This invitation has expired. No care information is available.",
      phi_disclosed: false,
    };
  }
  if (
    inv.inviteePersonId &&
    inv.inviteePersonId.length > 3 &&
    !inv.inviteePersonId.startsWith("pending") &&
    inv.inviteePersonId !== "open" &&
    inv.inviteePersonId !== actorPersonId
  ) {
    return {
      stage: "denied",
      valid: false,
      code: "WRONG_IDENTITY",
      message:
        "This invitation is for a different account. Sign in with the invited identity.",
      phi_disclosed: false,
    };
  }

  const recipient = store.getRecipient(careRecipientId);
  const inviter = store.getPerson(inv.inviterPersonId);

  return {
    stage: "authorized_preview",
    valid: true,
    inviterDisplayName: inviter?.displayName ?? "An authorized care contact",
    recipientDisplayName: recipient?.displayName ?? "Care recipient",
    proposedRole: inv.role,
    roleLabel: inv.roleLabel,
    dataDomains: domainsForRole(inv.role + inv.roleLabel),
    actionsAllowed: actionsForRole(inv.role + inv.roleLabel),
    expiresAt: inv.expiresAt,
    authorizationSource: "Secure invitation from authorized member",
    invitationId: inv.id,
    careRecipientId,
  };
}
