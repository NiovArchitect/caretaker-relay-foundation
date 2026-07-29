/**
 * Semantic content-hash idempotency for consequential care writes.
 *
 * Client idempotency_key remains first line of defense.
 * Content hashes prevent duplicate effects when keys differ but payload is equivalent.
 *
 * MUST NOT dedupe genuinely distinct events (different day, dose, recipient, etc.).
 *
 * Hash is pure-JS FNV-1a 64-bit hex (browser-safe; no node:crypto required).
 */

export type ConsequentialActionType =
  | "medication_administration"
  | "appointment_change"
  | "communication_request"
  | "handoff_creation"
  | "provider_communication";

export interface SemanticIdempotencyInput {
  careRecipientId: string;
  actionType: ConsequentialActionType;
  /** Normalized stable payload fields only */
  payload: Record<string, string | number | boolean | null | undefined>;
  /** Day bucket YYYY-MM-DD in care-recipient local intent (or UTC day) */
  effectiveDay: string;
}

function fnv1a64Hex(input: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** Stable hash over action identity (no volatile timestamps/ids). */
export function semanticContentHash(input: SemanticIdempotencyInput): string {
  const normalized: Record<string, string> = {
    careRecipientId: input.careRecipientId,
    actionType: input.actionType,
    effectiveDay: input.effectiveDay,
  };
  const keys = Object.keys(input.payload).sort();
  for (const k of keys) {
    const v = input.payload[k];
    if (v === undefined || v === null) continue;
    // Normalize whitespace / case for free text fields
    const s =
      typeof v === "string"
        ? v.toLowerCase().replace(/\s+/g, " ").trim()
        : String(v);
    normalized[k] = s;
  }
  const canonical = JSON.stringify(normalized);
  // Double FNV for longer stable key
  return `${fnv1a64Hex(canonical)}${fnv1a64Hex(`cr:${canonical}`)}`;
}

export function dayBucket(isoOrLabel?: string): string {
  if (!isoOrLabel) return new Date().toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(isoOrLabel)) return isoOrLabel.slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

export function medAdminHash(args: {
  careRecipientId: string;
  name: string;
  doseRecorded: string;
  administeredByPersonId: string;
  administeredAt?: string;
  /** administered | not_administered | needs_review */
  requestedState?: string;
}): string {
  return semanticContentHash({
    careRecipientId: args.careRecipientId,
    actionType: "medication_administration",
    effectiveDay: dayBucket(args.administeredAt),
    payload: {
      name: normalizeMedName(args.name),
      dose: String(args.doseRecorded ?? "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim(),
      by: args.administeredByPersonId,
      state: args.requestedState ?? "administered",
    },
  });
}

/** Stable med name for occurrence keys (no hard-coded product names). */
export function normalizeMedName(name: string): string {
  return String(name ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 .%-]/g, "")
    .trim()
    .slice(0, 64);
}

/** Extract medication name from free-text caregiver statement when present. */
export function extractMedNameFromStatement(statement: string): string | null {
  const s = String(statement ?? "");
  const m =
    s.match(
      /\b((?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)|(?:[A-Za-z]{4,}))\s+\d+\s*(?:mg|mcg|ml|units?)\b/i,
    ) ||
    s.match(
      /\b(medication|lunch medication|morning medication|evening medication)\b/i,
    );
  if (m?.[1]) return m[1].trim();
  if (/lunch/i.test(s) && /med/i.test(s)) return "Lunch medication";
  return null;
}

/** Durable occurrence key for one med admin truth per recipient×day×actor×state. */
export function medOccurrenceKey(args: {
  careRecipientId: string;
  name: string;
  doseRecorded: string;
  administeredByPersonId: string;
  administeredAt?: string;
  requestedState?: string;
}): string {
  return `mar-occ:${medAdminHash(args)}`;
}

export function appointmentChangeHash(args: {
  careRecipientId: string;
  title: string;
  startsAtLabel: string;
  status: string;
}): string {
  return semanticContentHash({
    careRecipientId: args.careRecipientId,
    actionType: "appointment_change",
    effectiveDay: dayBucket(),
    payload: {
      title: args.title,
      when: args.startsAtLabel,
      status: args.status,
    },
  });
}

export function communicationHash(args: {
  careRecipientId: string;
  toPersonId: string;
  summary: string;
}): string {
  return semanticContentHash({
    careRecipientId: args.careRecipientId,
    actionType: "communication_request",
    effectiveDay: dayBucket(),
    payload: {
      to: args.toPersonId,
      // Hash a short normalized summary stem (first 120 chars)
      summary: args.summary.slice(0, 120),
    },
  });
}

export function handoffHash(args: {
  careRecipientId: string;
  fromPersonId?: string;
  toPersonId?: string;
  whatChanged: string[];
}): string {
  return semanticContentHash({
    careRecipientId: args.careRecipientId,
    actionType: "handoff_creation",
    effectiveDay: dayBucket(),
    payload: {
      from: args.fromPersonId ?? "",
      to: args.toPersonId ?? "",
      changed: args.whatChanged
        .map((s) => s.toLowerCase().replace(/\s+/g, " ").trim())
        .sort()
        .join("|"),
    },
  });
}
