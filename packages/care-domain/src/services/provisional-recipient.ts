/**
 * Provisional recipient lifecycle (draft → activation / decline / expire).
 * Durable via CareUpdate rows — no schema migration.
 * PRINCIPLE: No automatic merge by name; no PHI discovery of existing recipients.
 */

import type {
  CareRelationship,
  CareRecipient,
  CareUpdate,
  SourceRef,
} from "../types.js";
import type { CareStore } from "../store/memory-store.js";
import { defaultInviteAccess } from "./invitation.js";

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
 * Binding to an *existing* recipient requires controlling authority on that
 * recipient — knowing a recipient id alone is never sufficient (blocks takeover).
 * Creator may only self-bind when activating a brand-new self care space
 * via activateSelfCareSpace (creates the recipient first).
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
  const recipient = store.getRecipient(input.careRecipientId);
  if (!recipient) {
    return {
      ok: false,
      code: "UNKNOWN_RECIPIENT",
      message: "Target recipient not found",
    };
  }
  // Existing recipient: require controlling authority on the target.
  // Creator status alone must NOT allow binding to arbitrary known ids.
  const access = store.getRelationship(
    input.careRecipientId,
    input.actorPersonId,
  );
  const controlling =
    access &&
    access.status === "active" &&
    (access.access.allowedActions.includes("*") ||
      access.access.informationCategories.includes("*") ||
      access.access.allowedActions.includes("invite") ||
      access.access.allowedActions.includes("manage_membership"));
  if (!controlling) {
    store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: input.actorPersonId,
      action: "PROVISIONAL_BIND_DENIED",
      careRecipientId: input.careRecipientId,
      details: {
        provisional_id: provisional.id,
        reason: "no_controlling_authority_on_target",
      },
    });
    return {
      ok: false,
      code: "FORBIDDEN",
      message:
        "Not authorized to bind this provisional to the target recipient. Use invitation or create your own care space.",
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

function isSelfAuthorityClaim(claimed: string): boolean {
  const c = claimed.toLowerCase();
  return (
    /\bself\b/.test(c) ||
    /receiving care/.test(c) ||
    /i am the person/.test(c) ||
    /for myself/.test(c) ||
    /my own care/.test(c) ||
    /care recipient/.test(c)
  );
}

/**
 * JOURNEY 1 — New recipient-self care space for any preferred name.
 *
 * Creates:
 *  - one CareRecipient (new id; never merges by name)
 *  - one active care_recipient relationship (recipient_self)
 *  - one active consent scoped for self
 *  - optional provisional marked active/bound for audit lineage
 *
 * SECURITY:
 *  - claim:self alone is insufficient without this explicit setup call
 *  - never links to an existing recipient by name or guessed id
 *  - idempotent when actor already has an active care_recipient membership
 */
export function setupSelfCareSpace(
  store: CareStore,
  input: {
    actorPersonId: string;
    actorDisplayName: string;
    preferredName: string;
    confirmation?: string;
    householdId?: string;
  },
):
  | {
      ok: true;
      careRecipientId: string;
      relationshipId: string;
      created: boolean;
      verificationMethod: "recipient_created_care_space";
    }
  | { ok: false; code: string; message: string } {
  const preferredName = input.preferredName.trim();
  if (preferredName.length < 2) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      message: "preferred_name required (min 2 characters)",
    };
  }

  // Idempotent: existing active care_recipient membership
  const existingSelf = store
    .getRelationshipsForPerson(input.actorPersonId)
    .find((r) => r.status === "active" && r.role === "care_recipient");
  if (existingSelf) {
    store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: input.actorPersonId,
      action: "RECIPIENT_SELF_SETUP_IDEMPOTENT",
      careRecipientId: existingSelf.careRecipientId,
      details: {
        relationship_id: existingSelf.id,
        verification_method: "recipient_created_care_space",
      },
    });
    return {
      ok: true,
      careRecipientId: existingSelf.careRecipientId,
      relationshipId: existingSelf.id,
      created: false,
      verificationMethod: "recipient_created_care_space",
    };
  }

  const now = new Date().toISOString();
  const careRecipientId = store.newId("cr");
  const householdId = input.householdId || store.newId("hh");
  const recipient: CareRecipient = {
    id: careRecipientId,
    displayName: preferredName,
    preferredName,
    householdId,
    profile: {
      // Minimal self profile — no invented clinical facts
    },
  };
  store.upsertRecipient(recipient);
  store.upsertPerson({
    id: input.actorPersonId,
    displayName: input.actorDisplayName,
    kind: "care_recipient",
  });

  const access = defaultInviteAccess("care_recipient");
  const relationshipId = `rel-${careRecipientId}-${input.actorPersonId}`;
  const relationship: CareRelationship = {
    id: relationshipId,
    careRecipientId,
    personId: input.actorPersonId,
    role: "care_recipient",
    roleLabel: "Care recipient (self)",
    responsibilities: ["Own care participation", "Preferences", "Observations"],
    access,
    status: "active",
    startDate: now.slice(0, 10),
  };
  store.upsertRelationship(relationship);
  store.upsertConsent({
    id: `consent-${careRecipientId}-${input.actorPersonId}`,
    careRecipientId,
    granteePersonId: input.actorPersonId,
    scope: access,
    status: "active",
    grantedAt: now,
  });

  // Audit-linked provisional draft → active for lineage (optional trail)
  const p = createProvisionalRecipient(store, {
    preferredName,
    createdByPersonId: input.actorPersonId,
    createdByDisplayName: input.actorDisplayName,
    claimedAuthority: "I am the person receiving care (self)",
    creatorNote: input.confirmation || "Recipient-created care space",
  });
  const activated: ProvisionalRecipient = {
    ...p,
    status: "active",
    boundRecipientId: careRecipientId,
    activatedAt: now,
    updatedAt: now,
  };
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "system_derived",
    label: "Recipient-self care space created",
    actorName: input.actorDisplayName,
    actorPersonId: input.actorPersonId,
    recordedAt: now,
    whyVisible: "Account created their own care recipient record with self relationship",
  };
  store.addUpdate(encodeProvisionalUpdate(activated, source));
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "RECIPIENT_SELF_CARE_SPACE_CREATED",
    careRecipientId,
    details: {
      relationship_id: relationshipId,
      provisional_id: p.id,
      verification_method: "recipient_created_care_space",
      verification_status: "active",
      preferred_name_length: preferredName.length,
      // Do not store free-text PHI in audit beyond length
    },
  });

  return {
    ok: true,
    careRecipientId,
    relationshipId,
    created: true,
    verificationMethod: "recipient_created_care_space",
  };
}

export { isSelfAuthorityClaim };
