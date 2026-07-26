/**
 * Contact verification contract (email/phone).
 * Durable codes stored as CareUpdate on account-meta bucket.
 * Delivery (SMTP/SMS) is EXTERNAL — this implements token lifecycle only.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CareUpdate, SourceRef } from "../types.js";
import type { CareStore } from "../store/memory-store.js";

const VERIFY_PREFIX = "CONTACT_VERIFY_V1:";
export const ACCOUNT_META_BUCKET = "cr-account-meta";

export type ContactChannel = "email" | "phone";

export interface ContactVerificationChallenge {
  id: string;
  carePersonId: string;
  channel: ContactChannel;
  contactNormalized: string;
  /** SHA-256 of code — never store raw code after issue response. */
  codeHash: string;
  status: "pending" | "verified" | "expired" | "consumed";
  createdAt: string;
  expiresAt: string;
  verifiedAt?: string;
  attempts: number;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function issueVerificationCode(): string {
  // 6-digit numeric for UX; entropy from crypto RNG
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return String(n).padStart(6, "0");
}

export function encodeVerificationUpdate(
  ch: ContactVerificationChallenge,
  source: SourceRef,
): CareUpdate {
  const payload = {
    kind: "contact_verification",
    carePersonId: ch.carePersonId,
    channel: ch.channel,
    contactNormalized: ch.contactNormalized,
    codeHash: ch.codeHash,
    status: ch.status,
    createdAt: ch.createdAt,
    expiresAt: ch.expiresAt,
    verifiedAt: ch.verifiedAt,
    attempts: ch.attempts,
  };
  return {
    id: ch.id,
    careRecipientId: ACCOUNT_META_BUCKET,
    toPersonId: ch.carePersonId,
    summary: VERIFY_PREFIX + JSON.stringify(payload),
    status: ch.status === "verified" ? "ready" : "draft",
    safetyClass: "low",
    source,
  };
}

export function decodeVerificationFromUpdate(
  u: CareUpdate,
): ContactVerificationChallenge | null {
  if (!u.summary.startsWith(VERIFY_PREFIX)) return null;
  try {
    const raw = JSON.parse(u.summary.slice(VERIFY_PREFIX.length)) as Record<
      string,
      unknown
    >;
    return {
      id: u.id,
      carePersonId: String(raw.carePersonId ?? u.toPersonId),
      channel: (raw.channel as ContactChannel) ?? "email",
      contactNormalized: String(raw.contactNormalized ?? ""),
      codeHash: String(raw.codeHash ?? ""),
      status: (raw.status as ContactVerificationChallenge["status"]) ?? "pending",
      createdAt: String(raw.createdAt ?? ""),
      expiresAt: String(raw.expiresAt ?? ""),
      verifiedAt: raw.verifiedAt ? String(raw.verifiedAt) : undefined,
      attempts: Number(raw.attempts ?? 0),
    };
  } catch {
    return null;
  }
}

export function createVerificationChallenge(
  store: CareStore,
  input: {
    carePersonId: string;
    channel: ContactChannel;
    contact: string;
    ttlMinutes?: number;
  },
): { challenge: ContactVerificationChallenge; plainCode: string } {
  const plainCode = issueVerificationCode();
  const now = Date.now();
  const ttl = (input.ttlMinutes ?? 30) * 60 * 1000;
  const ch: ContactVerificationChallenge = {
    id: store.newId("vc"),
    carePersonId: input.carePersonId,
    channel: input.channel,
    contactNormalized:
      input.channel === "email"
        ? normalizeEmail(input.contact)
        : input.contact.trim(),
    codeHash: hashCode(plainCode),
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    attempts: 0,
  };
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "system_derived",
    label: "Contact verification issued",
    actorPersonId: input.carePersonId,
    recordedAt: ch.createdAt,
    whyVisible: "Account contact verification",
  };
  store.addUpdate(encodeVerificationUpdate(ch, source));
  store.writeAudit({
    at: ch.createdAt,
    actorPersonId: input.carePersonId,
    action: "CONTACT_VERIFICATION_ISSUED",
    details: {
      channel: ch.channel,
      contact_hash: hashCode(ch.contactNormalized).slice(0, 16),
      challenge_id: ch.id,
    },
  });
  return { challenge: ch, plainCode };
}

export function verifyContactCode(
  store: CareStore,
  input: {
    carePersonId: string;
    code: string;
    contact?: string;
  },
):
  | { ok: true; challenge: ContactVerificationChallenge }
  | { ok: false; code: string; message: string } {
  const updates = store.getUpdates(ACCOUNT_META_BUCKET);
  const candidates = updates
    .map(decodeVerificationFromUpdate)
    .filter((c): c is ContactVerificationChallenge => Boolean(c))
    .filter(
      (c) =>
        c.carePersonId === input.carePersonId && c.status === "pending",
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const ch = candidates[0];
  if (!ch) {
    return {
      ok: false,
      code: "NO_PENDING_VERIFICATION",
      message: "No pending verification challenge",
    };
  }
  if (new Date(ch.expiresAt).getTime() < Date.now()) {
    return { ok: false, code: "CODE_EXPIRED", message: "Verification code expired" };
  }
  if (ch.attempts >= 8) {
    return {
      ok: false,
      code: "TOO_MANY_ATTEMPTS",
      message: "Too many verification attempts",
    };
  }
  const presented = hashCode(input.code.trim());
  if (presented !== ch.codeHash) {
    const bumped: ContactVerificationChallenge = {
      ...ch,
      attempts: ch.attempts + 1,
    };
    const source: SourceRef = {
      id: randomUUID(),
      kind: "system_derived",
      label: "Contact verification failed attempt",
      actorPersonId: input.carePersonId,
      recordedAt: new Date().toISOString(),
      whyVisible: "Failed verification attempt",
    };
    store.addUpdate(encodeVerificationUpdate(bumped, source));
    return { ok: false, code: "INVALID_CODE", message: "Invalid verification code" };
  }

  const verified: ContactVerificationChallenge = {
    ...ch,
    status: "verified",
    verifiedAt: new Date().toISOString(),
    attempts: ch.attempts + 1,
  };
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "system_derived",
    label: "Contact verified",
    actorPersonId: input.carePersonId,
    recordedAt: verified.verifiedAt!,
    whyVisible: "Contact verification succeeded",
  };
  store.addUpdate(encodeVerificationUpdate(verified, source));
  store.writeAudit({
    at: verified.verifiedAt!,
    actorPersonId: input.carePersonId,
    action: "CONTACT_VERIFIED",
    details: {
      channel: ch.channel,
      challenge_id: ch.id,
    },
  });
  return { ok: true, challenge: verified };
}

export function isContactVerified(
  store: CareStore,
  carePersonId: string,
): boolean {
  return store
    .getUpdates(ACCOUNT_META_BUCKET)
    .map(decodeVerificationFromUpdate)
    .some(
      (c) =>
        c &&
        c.carePersonId === carePersonId &&
        c.status === "verified",
    );
}
