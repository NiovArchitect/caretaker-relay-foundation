/**
 * Care-space invitation + human coordination helpers.
 * Persist invitations/coordination via CareUpdate rows so Prisma store works without schema migration.
 */

import type {
  CareCoordinationMessage,
  CareInvitation,
  CareInvitationStatus,
  CareRelationshipRole,
  CareUpdate,
  SourceRef,
} from "../types.js";
import type { CareStore } from "../store/memory-store.js";

const INVITE_PREFIX = "INVITE_V1:";
const COORD_PREFIX = "COORD_V1:";

/** Browser + Node safe UUID (no node:crypto — vendored into the app bundle). */
function safeUuid(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function newInviteToken(): string {
  return safeUuid().replace(/-/g, "") + safeUuid().replace(/-/g, "").slice(0, 16);
}

/** Fast non-crypto hex digest for invite token lookup (browser-safe). */
function hashToken(token: string): string {
  let h1 = 2166136261;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 16777619);
    h2 ^= c;
    h2 = Math.imul(h2, 16777619);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, "0") +
    (h2 >>> 0).toString(16).padStart(8, "0") +
    token.length.toString(16).padStart(4, "0") +
    "cr01"
  ).slice(0, 32);
}

export function encodeInvitationUpdate(
  inv: CareInvitation,
  source: SourceRef,
): CareUpdate {
  // SECURITY: persist token HASH only — never re-store raw token after create response.
  const payload = {
    kind: "invitation",
    tokenHash: hashToken(inv.token),
    inviterPersonId: inv.inviterPersonId,
    inviteePersonId: inv.inviteePersonId,
    inviteeDisplayName: inv.inviteeDisplayName,
    inviteeEmail: inv.inviteeEmail,
    role: inv.role,
    roleLabel: inv.roleLabel,
    status: inv.status,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    acceptedAt: inv.acceptedAt,
  };
  return {
    id: inv.id,
    careRecipientId: inv.careRecipientId,
    toPersonId: inv.inviteePersonId,
    summary: INVITE_PREFIX + JSON.stringify(payload),
    status:
      inv.status === "pending"
        ? "draft"
        : inv.status === "accepted"
          ? "ready"
          : "blocked_pending_verify",
    safetyClass: "low",
    source,
  };
}

export function decodeInvitationFromUpdate(u: CareUpdate): CareInvitation | null {
  if (!u.summary.startsWith(INVITE_PREFIX)) return null;
  try {
    const raw = JSON.parse(u.summary.slice(INVITE_PREFIX.length)) as Record<
      string,
      unknown
    >;
    return {
      id: u.id,
      careRecipientId: u.careRecipientId,
      // Token not re-exposed from storage; only hash is durable
      token: "",
      inviterPersonId: String(raw.inviterPersonId ?? ""),
      inviteePersonId: String(raw.inviteePersonId ?? u.toPersonId),
      inviteeDisplayName: String(raw.inviteeDisplayName ?? ""),
      inviteeEmail: raw.inviteeEmail ? String(raw.inviteeEmail) : undefined,
      role: (raw.role as CareRelationshipRole) ?? "family_caregiver",
      roleLabel: String(raw.roleLabel ?? "Family caregiver"),
      status: (raw.status as CareInvitationStatus) ?? "pending",
      createdAt: String(raw.createdAt ?? u.source.recordedAt),
      expiresAt: raw.expiresAt ? String(raw.expiresAt) : undefined,
      acceptedAt: raw.acceptedAt ? String(raw.acceptedAt) : undefined,
    };
  } catch {
    return null;
  }
}

/** Match invitation by hashing the presented token against stored tokenHash. */
export function matchInvitationToken(
  store: CareStore,
  careRecipientId: string,
  presentedToken: string,
): CareInvitation | null {
  const th = hashToken(presentedToken);
  let best: CareInvitation | null = null;
  for (const u of store.getUpdates(careRecipientId)) {
    if (!u.summary.startsWith(INVITE_PREFIX)) continue;
    try {
      const raw = JSON.parse(u.summary.slice(INVITE_PREFIX.length)) as Record<
        string,
        unknown
      >;
      // Skip consumed tokens (hash cleared or marked used after accept).
      const storedHash = String(raw.tokenHash ?? "");
      if (!storedHash || storedHash.startsWith("used:")) continue;
      if (storedHash !== th) continue;
      const inv = decodeInvitationFromUpdate(u);
      if (!inv) continue;
      inv.token = presentedToken; // restore for accept flow only in-memory
      // Prefer terminal statuses when multiple rows share a hash (should not happen).
      if (!best || inv.status !== "pending") best = inv;
      if (inv.status === "accepted" || inv.status === "revoked" || inv.status === "expired") {
        return inv;
      }
    } catch {
      /* continue */
    }
  }
  return best;
}

/** After accept: keep audit row but prevent token replay via hash. */
export function markInvitationConsumed(
  inv: CareInvitation,
  source: SourceRef,
): CareUpdate {
  const payload = {
    kind: "invitation",
    tokenHash: `used:${hashToken(inv.token || "consumed")}`,
    inviterPersonId: inv.inviterPersonId,
    inviteePersonId: inv.inviteePersonId,
    inviteeDisplayName: inv.inviteeDisplayName,
    inviteeEmail: inv.inviteeEmail,
    role: inv.role,
    roleLabel: inv.roleLabel,
    status: "accepted" as CareInvitationStatus,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    acceptedAt: inv.acceptedAt ?? new Date().toISOString(),
  };
  return {
    id: inv.id,
    careRecipientId: inv.careRecipientId,
    toPersonId: inv.inviteePersonId,
    summary: INVITE_PREFIX + JSON.stringify(payload),
    status: "ready",
    safetyClass: "low",
    source,
  };
}

export function listInvitations(
  store: CareStore,
  careRecipientId: string,
): CareInvitation[] {
  return store
    .getUpdates(careRecipientId)
    .map(decodeInvitationFromUpdate)
    .filter((x): x is CareInvitation => !!x);
}

export function findInvitationByTokenForRecipient(
  store: CareStore,
  careRecipientId: string,
  token: string,
): CareInvitation | null {
  return matchInvitationToken(store, careRecipientId, token);
}

/** Find invite token across a known recipient list. */
export function findInvitationByTokenGlobal(
  store: CareStore,
  careRecipientIds: string[],
  token: string,
): CareInvitation | null {
  for (const id of careRecipientIds) {
    const found = matchInvitationToken(store, id, token);
    if (found) return found;
  }
  return null;
}

export function encodeCoordinationUpdate(
  msg: CareCoordinationMessage,
  source: SourceRef,
): CareUpdate {
  const payload = {
    kind: "coordination",
    fromPersonId: msg.fromPersonId,
    fromDisplayName: msg.fromDisplayName,
    body: msg.body,
    createdAt: msg.createdAt,
  };
  return {
    id: msg.id,
    careRecipientId: msg.careRecipientId,
    toPersonId: msg.toPersonId ?? msg.careRecipientId,
    summary: COORD_PREFIX + JSON.stringify(payload),
    status: "ready",
    safetyClass: "low",
    source,
  };
}

export function decodeCoordinationFromUpdate(
  u: CareUpdate,
): CareCoordinationMessage | null {
  if (!u.summary.startsWith(COORD_PREFIX)) return null;
  try {
    const raw = JSON.parse(u.summary.slice(COORD_PREFIX.length)) as Record<
      string,
      unknown
    >;
    return {
      id: u.id,
      careRecipientId: u.careRecipientId,
      fromPersonId: String(raw.fromPersonId ?? u.source.actorPersonId ?? ""),
      fromDisplayName: String(
        raw.fromDisplayName ?? u.source.actorName ?? "Caregiver",
      ),
      toPersonId: u.toPersonId,
      body: String(raw.body ?? ""),
      createdAt: String(raw.createdAt ?? u.source.recordedAt),
      kind: "coordination",
    };
  } catch {
    return null;
  }
}

export function listCoordination(
  store: CareStore,
  careRecipientId: string,
): CareCoordinationMessage[] {
  return store
    .getUpdates(careRecipientId)
    .map(decodeCoordinationFromUpdate)
    .filter((x): x is CareCoordinationMessage => !!x)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function defaultInviteAccess(role: CareRelationshipRole) {
  if (role === "care_recipient") {
    // Recipient-self: view own care; no caregiver assignment / invite / med-order authority.
    return {
      informationCategories: [
        "Medications",
        "Care plan",
        "Appointments",
        "Daily updates",
        "Clinical documents",
        "Demographics",
        "Emergency",
        "Advance care",
        "Preferences",
      ],
      allowedActions: [
        "view_plan",
        "view_schedule",
        "view_appointments",
        "receive_updates",
        "record_observations",
        "correct",
        "view_medications",
        "view_history",
        "message_care_team",
      ],
      canEscalate: false,
      authorityLimits: [
        "Recipient-self cannot invite caregivers",
        "Recipient-self cannot change medication schedule",
        "Recipient-self cannot reassign care work",
        "Recipient-self cannot access caregiver-private coordination",
      ],
    };
  }
  if (role === "paid_caregiver" || role === "direct_support_professional") {
    return {
      informationCategories: [
        "Care tasks",
        "Care instructions",
        "Appointments",
      ],
      allowedActions: [
        "record_observations",
        "complete_tasks",
        "view_schedule",
        "receive_updates",
      ],
      canEscalate: true,
      authorityLimits: ["Cannot share records outside care plan"],
    };
  }
  return {
    informationCategories: ["Daily updates", "Appointments", "Care plan"],
    allowedActions: [
      "receive_updates",
      "view_plan",
      "view_appointments",
      "correct",
      "record_observations",
    ],
    canEscalate: true,
    authorityLimits: ["Cannot change medication schedule"],
  };
}

/** Normalize invitation role aliases (recipient_self → care_recipient). */
export function normalizeInviteRole(role: string | undefined): CareRelationshipRole {
  const r = (role || "family_caregiver").trim().toLowerCase();
  if (
    r === "care_recipient" ||
    r === "recipient_self" ||
    r === "self" ||
    r === "receiving_care"
  ) {
    return "care_recipient";
  }
  return (role as CareRelationshipRole) || "family_caregiver";
}
