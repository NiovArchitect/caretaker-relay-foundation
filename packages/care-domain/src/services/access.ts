/**
 * Access / consent isolation for care information.
 *
 * User-facing semantic model: WHO CAN SEE WHAT
 * Substrate mapping: CareRelationship + ConsentRecord → Foundation Permission/ConsentGrant
 *
 * Rules:
 * - Care recipient household is the isolation boundary.
 * - Revoked access must not continue to function.
 * - No cross-household leakage.
 * - Family hierarchy ≠ authority.
 */

import type { CareStore } from "../store/memory-store.js";
import type {
  AccessScope,
  AuthCareContext,
  CareEvent,
  ConsentRecord,
  CurrentCareState,
} from "../types.js";

export type AccessDecision =
  | { allowed: true; reason: string; scope: AccessScope }
  | { allowed: false; reason: string; code: AccessDenialCode };

export type AccessDenialCode =
  | "NO_RELATIONSHIP"
  | "REVOKED"
  | "EXPIRED"
  | "WRONG_HOUSEHOLD"
  | "MISSING_CATEGORY"
  | "MISSING_ACTION"
  | "UNKNOWN_RECIPIENT"
  | "UNAUTHENTICATED";

const DEFAULT_DENY_SCOPE: AccessScope = {
  informationCategories: [],
  allowedActions: [],
  canEscalate: false,
  authorityLimits: ["none"],
};

export function evaluateAccess(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
  opts?: {
    requiredCategory?: string;
    requiredAction?: string;
    householdId?: string;
  },
): AccessDecision {
  const recipient = store.getRecipient(careRecipientId);
  if (!recipient) {
    return {
      allowed: false,
      reason: "Care recipient not found in this context.",
      code: "UNKNOWN_RECIPIENT",
    };
  }

  if (opts?.householdId && recipient.householdId !== opts.householdId) {
    return {
      allowed: false,
      reason: "Cross-household access is forbidden.",
      code: "WRONG_HOUSEHOLD",
    };
  }

  // Care recipient self-access (controlling subject).
  if (actorPersonId === careRecipientId) {
    return {
      allowed: true,
      reason: "Care recipient controls their own care information.",
      scope: {
        informationCategories: ["*"],
        allowedActions: ["*"],
        canEscalate: true,
        authorityLimits: [],
      },
    };
  }

  const rel = store.getRelationship(careRecipientId, actorPersonId);
  if (!rel) {
    return {
      allowed: false,
      reason: "No care relationship grants access.",
      code: "NO_RELATIONSHIP",
    };
  }

  if (rel.status === "revoked") {
    return {
      allowed: false,
      reason: "Access was revoked and no longer functions.",
      code: "REVOKED",
    };
  }
  if (rel.status === "expired") {
    return {
      allowed: false,
      reason: "Access expired.",
      code: "EXPIRED",
    };
  }

  const consent = store.getConsent(careRecipientId, actorPersonId);
  if (consent?.status === "revoked") {
    return {
      allowed: false,
      reason: "Consent was revoked.",
      code: "REVOKED",
    };
  }

  const scope = rel.access;

  if (
    opts?.requiredCategory &&
    !scope.informationCategories.includes("*") &&
    !scope.informationCategories.includes(opts.requiredCategory)
  ) {
    return {
      allowed: false,
      reason: `Not permitted to view category: ${opts.requiredCategory}`,
      code: "MISSING_CATEGORY",
      // scope still attached only on allow; for deny we omit
    } as AccessDecision;
  }

  if (
    opts?.requiredAction &&
    !scope.allowedActions.includes("*") &&
    !scope.allowedActions.includes(opts.requiredAction)
  ) {
    return {
      allowed: false,
      reason: `Not permitted to perform action: ${opts.requiredAction}`,
      code: "MISSING_ACTION",
    };
  }

  return {
    allowed: true,
    reason: `Authorized via ${rel.roleLabel} relationship.`,
    scope,
  };
}

/** Filter events by caller's allowed information categories (coarse). */
export function filterEventsForViewer(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
  events: CareEvent[],
): CareEvent[] {
  const decision = evaluateAccess(store, actorPersonId, careRecipientId);
  if (!decision.allowed) return [];

  const cats = decision.scope.informationCategories;
  if (cats.includes("*")) return events;

  return events.filter((e) => {
    const needed = categoryForEventType(e.type);
    return cats.includes(needed) || cats.includes("Daily updates");
  });
}

export function filterCurrentStateForViewer(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
): CurrentCareState | { denied: true; reason: string; code: AccessDenialCode } {
  const decision = evaluateAccess(store, actorPersonId, careRecipientId, {
    requiredAction: "view_plan",
  });
  // Professional caregivers may only have view_schedule / record_observations
  const soft = evaluateAccess(store, actorPersonId, careRecipientId);
  if (!soft.allowed) {
    return { denied: true, reason: soft.reason, code: soft.code };
  }

  const state = store.getCurrentState(careRecipientId);
  if (!state) {
    return {
      denied: true,
      reason: "No care state for recipient.",
      code: "UNKNOWN_RECIPIENT",
    };
  }

  const cats = soft.scope.informationCategories;
  if (cats.includes("*")) return state;

  // Limited professional access: strip med records if not in categories
  const canSeeMeds =
    cats.includes("Medication record") || cats.includes("Care plan");
  const canSeeHealth =
    cats.includes("Health observations") ||
    cats.includes("Daily updates") ||
    cats.includes("Care instructions");

  return {
    ...state,
    events: filterEventsForViewer(
      store,
      actorPersonId,
      careRecipientId,
      state.events,
    ),
    medicationRecords: canSeeMeds ? state.medicationRecords : [],
    observations: canSeeHealth ? state.observations : [],
    // decision unused intentionally when soft allow
    ...(decision.allowed ? {} : {}),
  };
}

function categoryForEventType(type: CareEvent["type"]): string {
  switch (type) {
    case "medication_administration":
      return "Medication record";
    case "appointment_change":
      return "Appointments";
    case "observation":
      return "Health observations";
    case "meal":
    case "note":
    case "communication_request":
      return "Daily updates";
    case "task":
      return "Care tasks";
    default:
      return "Daily updates";
  }
}

export function assertAuthContext(
  ctx: AuthCareContext | null | undefined,
): AccessDecision {
  if (!ctx?.actorPersonId || !ctx.careRecipientId || !ctx.sessionId) {
    return {
      allowed: false,
      reason: "Authenticated care context required.",
      code: "UNAUTHENTICATED",
    };
  }
  return {
    allowed: true,
    reason: "Session present.",
    scope: DEFAULT_DENY_SCOPE,
  };
}

export function grantConsent(
  store: CareStore,
  consent: ConsentRecord,
): ConsentRecord {
  store.upsertConsent(consent);
  store.writeAudit({
    at: new Date().toISOString(),
    actorPersonId: consent.careRecipientId,
    action: "CONSENT_GRANTED",
    careRecipientId: consent.careRecipientId,
    details: {
      granteePersonId: consent.granteePersonId,
      categories: consent.scope.informationCategories,
    },
  });
  return consent;
}

export function whoCanSeeWhat(
  store: CareStore,
  careRecipientId: string,
): Array<{
  personId: string;
  displayName: string;
  roleLabel: string;
  status: string;
  canSee: string[];
  canDo: string[];
  limits: string[];
}> {
  const rels = store.getRelationships(careRecipientId);
  return rels.map((r) => {
    const person = store.getPerson(r.personId);
    return {
      personId: r.personId,
      displayName: person?.displayName ?? r.personId,
      roleLabel: r.roleLabel,
      status: r.status,
      canSee: r.access.informationCategories,
      canDo: r.access.allowedActions,
      limits: r.access.authorityLimits,
    };
  });
}
