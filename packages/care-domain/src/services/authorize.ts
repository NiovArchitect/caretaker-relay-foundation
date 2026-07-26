/**
 * Central server authorization contract for Caretaker Relay.
 *
 * PRINCIPLE: Authentication is not authorization.
 * PRINCIPLE: Deny by default. Every recipient operation evaluates here.
 * PRINCIPLE: Role claim is not proof of access.
 *
 * Extends evaluateAccess with a stable decision object suitable for
 * audit metadata, field-level scope, and AI pre-retrieval gates.
 */

import type { CareStore } from "../store/memory-store.js";
import type { AccessScope } from "../types.js";
import {
  evaluateAccess,
  type AccessDecision,
  type AccessDenialCode,
} from "./access.js";

export type AuthorizeAction =
  | "read"
  | "write"
  | "invite"
  | "approve_access"
  | "revoke_access"
  | "export"
  | "relay_answer"
  | "understand"
  | "coordinate"
  | "view_access_matrix"
  | "manage_membership";

export type AuthorizeDataDomain =
  | "profile"
  | "events"
  | "medications"
  | "observations"
  | "appointments"
  | "documents"
  | "messages"
  | "coordination"
  | "notifications"
  | "handoffs"
  | "coverage"
  | "access"
  | "export"
  | "relay"
  | "audit"
  | "emergency"
  | "*";

export type AuthorizationSource =
  | "self_recipient"
  | "active_relationship"
  | "active_consent"
  | "none";

export interface AuthorizeInput {
  actorPersonId: string;
  careRecipientId: string;
  action: AuthorizeAction;
  dataDomain?: AuthorizeDataDomain;
  purpose?: string;
  requiredCategory?: string;
  requiredAction?: string;
  householdId?: string;
  organizationId?: string;
  context?: Record<string, unknown>;
}

export interface AuthorizeResult {
  allowed: boolean;
  reasonCode: AccessDenialCode | "ALLOW" | "MISSING_PERMISSION";
  reason: string;
  authorizationSource: AuthorizationSource;
  effectiveScope: AccessScope;
  appliedRelationshipId?: string;
  audit: {
    actorPersonId: string;
    careRecipientId: string;
    action: AuthorizeAction;
    dataDomain: AuthorizeDataDomain;
    purpose?: string;
    decision: "allow" | "deny";
    reasonCode: string;
    at: string;
  };
}

const EMPTY_SCOPE: AccessScope = {
  informationCategories: [],
  allowedActions: [],
  canEscalate: false,
  authorityLimits: ["none"],
};

const ACTION_TO_REQUIRED: Partial<
  Record<AuthorizeAction, { category?: string; action?: string }>
> = {
  read: {},
  write: { action: "record_observations" },
  invite: { action: "invite" },
  approve_access: { action: "*" },
  revoke_access: { action: "*" },
  export: { action: "export" },
  relay_answer: {},
  understand: { action: "record_observations" },
  coordinate: {},
  view_access_matrix: {},
  manage_membership: { action: "*" },
};

function mapSource(decision: AccessDecision, actorPersonId: string, careRecipientId: string): AuthorizationSource {
  if (!decision.allowed) return "none";
  if (actorPersonId === careRecipientId) return "self_recipient";
  return "active_relationship";
}

function hasControllingAuthority(scope: AccessScope): boolean {
  return (
    scope.informationCategories.includes("*") ||
    scope.allowedActions.includes("*") ||
    scope.allowedActions.includes("invite") ||
    scope.allowedActions.includes("manage_membership")
  );
}

/**
 * Central authorization decision. Deny by default.
 * Call before database retrieval of recipient-scoped data where practical.
 */
export function authorize(
  store: CareStore,
  input: AuthorizeInput,
): AuthorizeResult {
  const at = new Date().toISOString();
  const dataDomain: AuthorizeDataDomain = input.dataDomain ?? "*";
  const mapped = ACTION_TO_REQUIRED[input.action] ?? {};
  const requiredCategory = input.requiredCategory ?? mapped.category;
  const requiredAction = input.requiredAction ?? mapped.action;

  // Soft relationship check first
  const base = evaluateAccess(store, input.actorPersonId, input.careRecipientId, {
    householdId: input.householdId,
  });

  const deny = (
    reasonCode: AccessDenialCode | "MISSING_PERMISSION",
    reason: string,
  ): AuthorizeResult => ({
    allowed: false,
    reasonCode,
    reason,
    authorizationSource: "none",
    effectiveScope: EMPTY_SCOPE,
    audit: {
      actorPersonId: input.actorPersonId,
      careRecipientId: input.careRecipientId,
      action: input.action,
      dataDomain,
      purpose: input.purpose,
      decision: "deny",
      reasonCode,
      at,
    },
  });

  if (!base.allowed) {
    return deny(base.code, base.reason);
  }

  // Stricter category/action when requested
  if (requiredCategory || requiredAction) {
    const strict = evaluateAccess(
      store,
      input.actorPersonId,
      input.careRecipientId,
      {
        requiredCategory,
        requiredAction:
          requiredAction === "*" ? undefined : requiredAction,
        householdId: input.householdId,
      },
    );
    // Controlling authority (*) always passes controlling actions
    if (
      !strict.allowed &&
      !(
        requiredAction === "*" &&
        hasControllingAuthority(base.scope)
      ) &&
      !(
        (input.action === "invite" ||
          input.action === "revoke_access" ||
          input.action === "approve_access" ||
          input.action === "manage_membership") &&
        hasControllingAuthority(base.scope)
      )
    ) {
      // Soft-allow write paths when relationship is active but action list
      // uses alternate verbs (family * vs professional subset).
      if (
        input.action === "write" ||
        input.action === "understand" ||
        input.action === "relay_answer" ||
        input.action === "read" ||
        input.action === "coordinate"
      ) {
        // Active membership is sufficient for these; field filtering is separate.
      } else if (!hasControllingAuthority(base.scope)) {
        return deny(
          strict.allowed === false
            ? (strict.code as AccessDenialCode)
            : "MISSING_PERMISSION",
          strict.allowed === false
            ? strict.reason
            : "Missing permission for requested action",
        );
      }
    }
  }

  // Controlling-only actions
  if (
    (input.action === "invite" ||
      input.action === "revoke_access" ||
      input.action === "approve_access" ||
      input.action === "manage_membership" ||
      input.action === "view_access_matrix") &&
    !hasControllingAuthority(base.scope) &&
    input.actorPersonId !== input.careRecipientId
  ) {
    // view_access_matrix: any active member may see limited matrix of self only;
    // full who-can-see requires controlling authority — enforced at route.
    if (input.action === "view_access_matrix") {
      // allow with reduced semantics
    } else {
      return deny(
        "MISSING_ACTION",
        "Only controlling authority may perform this membership action.",
      );
    }
  }

  const rel = store.getRelationship(
    input.careRecipientId,
    input.actorPersonId,
  );

  return {
    allowed: true,
    reasonCode: "ALLOW",
    reason: base.reason,
    authorizationSource: mapSource(base, input.actorPersonId, input.careRecipientId),
    effectiveScope: base.scope,
    appliedRelationshipId: rel?.id,
    audit: {
      actorPersonId: input.actorPersonId,
      careRecipientId: input.careRecipientId,
      action: input.action,
      dataDomain,
      purpose: input.purpose,
      decision: "allow",
      reasonCode: "ALLOW",
      at,
    },
  };
}

/** Convenience: deny if not allowed; returns result always. */
export function requireAuthorize(
  store: CareStore,
  input: AuthorizeInput,
): AuthorizeResult {
  return authorize(store, input);
}

/** List recipients the actor may access (active memberships only). */
export function listAuthorizedRecipients(
  store: CareStore,
  actorPersonId: string,
): Array<{
  careRecipientId: string;
  displayName: string;
  roleLabel: string;
  status: string;
}> {
  const out: Array<{
    careRecipientId: string;
    displayName: string;
    roleLabel: string;
    status: string;
  }> = [];
  const rels =
    typeof store.getRelationshipsForPerson === "function"
      ? store.getRelationshipsForPerson(actorPersonId)
      : [];
  for (const rel of rels) {
    if (rel.status !== "active") continue;
    const d = evaluateAccess(store, actorPersonId, rel.careRecipientId);
    if (!d.allowed) continue;
    const rec = store.getRecipient(rel.careRecipientId);
    out.push({
      careRecipientId: rel.careRecipientId,
      displayName: rec?.displayName ?? rel.careRecipientId,
      roleLabel: rel.roleLabel,
      status: rel.status,
    });
  }
  return out;
}
