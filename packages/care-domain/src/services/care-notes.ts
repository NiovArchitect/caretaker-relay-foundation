/**
 * Role-aware care notes from verified candidates + care truth.
 * Professional readability ≠ clinical authority.
 */

import type {
  AuthCareContext,
  CareCandidate,
  CareUpdate,
  SourceRef,
  VerificationBundle,
} from "../types.js";
import type { CareStore } from "../store/memory-store.js";

export type CareNoteKind =
  | "family_care_update"
  | "dsp_support_note"
  | "handoff_summary"
  | "provider_update"
  | "daily_care_summary";

export type CareNote = {
  id: string;
  careRecipientId: string;
  kind: CareNoteKind;
  title: string;
  body: string;
  authorPersonId: string;
  authorDisplayName: string;
  roleLabel: string;
  createdAt: string;
  sourceEventIds: string[];
  originalRawText?: string;
  verificationStatus: "confirmed" | "reported";
};

const NOTE_PREFIX = "CARE_NOTE_V1:";

export function noteKindForRole(roleLabel: string): CareNoteKind {
  const r = roleLabel.toLowerCase();
  if (/physician|provider|doctor|clinician/.test(r)) return "provider_update";
  if (/professional|dsp|paid|direct support|in-home|agency/.test(r))
    return "dsp_support_note";
  return "family_care_update";
}

export function userFacingNoteLabel(kind: CareNoteKind): string {
  switch (kind) {
    case "family_care_update":
      return "Care update";
    case "dsp_support_note":
      return "Support note";
    case "handoff_summary":
      return "Handoff summary";
    case "provider_update":
      return "Provider update";
    case "daily_care_summary":
      return "Daily care summary";
  }
}

function classifyLine(c: CareCandidate): string {
  switch (c.eventType) {
    case "medication_administration":
      return "Medication report";
    case "observation":
      return "Observation";
    case "appointment_change":
      return "Appointment / schedule";
    case "meal":
      return "Meal / hydration";
    case "communication_request":
      return "Communication";
    case "task":
      return "Care activity";
    default:
      return "Care update";
  }
}

/**
 * Build a professional-quality note from verified candidates.
 * Does not invent diagnoses.
 */
export function composeCareNote(input: {
  bundle: VerificationBundle;
  ctx: AuthCareContext;
  roleLabel: string;
  eventIds: string[];
  confirmedItemIds?: string[];
}): CareNote {
  const kind = noteKindForRole(input.roleLabel);
  const now = new Date().toISOString();
  const confirmed = new Set(
    input.confirmedItemIds ?? input.bundle.items.map((i) => i.id),
  );
  const lines: string[] = [];
  const recipient = input.bundle.understood.careRecipientName;

  for (const item of input.bundle.items) {
    if (!confirmed.has(item.id)) continue;
    if (item.candidateId === "uncertainty") continue;
    const cand = input.bundle.understood.candidates.find(
      (c) => c.id === item.candidateId,
    );
    if (!cand) continue;
    const section = classifyLine(cand);
    lines.push(`${section}: ${cand.statement}`);
    if (item.discrepancy) {
      lines.push(
        `Medication discrepancy held for review: said ${item.discrepancy.recordedDose}; on-file instruction ${item.discrepancy.authorizedDose}.`,
      );
    }
  }

  if (lines.length === 0) {
    lines.push("No confirmed care items in this update.");
  }

  const header =
    kind === "dsp_support_note"
      ? `Support note — ${recipient}`
      : kind === "provider_update"
        ? `Provider-facing update — ${recipient} (caregiver-reported)`
        : `Care update — ${recipient}`;

  const body = [
    header,
    "",
    ...lines.map((l) => `• ${l}`),
    "",
    `Reported by: ${input.ctx.actorDisplayName}`,
    `Role: ${input.roleLabel}`,
    `Status: Caregiver-verified care record (not a clinical diagnosis or order)`,
    `Recorded: ${new Date(now).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })}`,
  ].join("\n");

  return {
    id: `note-${Date.now().toString(36)}`,
    careRecipientId: input.ctx.careRecipientId,
    kind,
    title: userFacingNoteLabel(kind),
    body,
    authorPersonId: input.ctx.actorPersonId,
    authorDisplayName: input.ctx.actorDisplayName,
    roleLabel: input.roleLabel,
    createdAt: now,
    sourceEventIds: input.eventIds,
    originalRawText: input.bundle.understood.rawText,
    verificationStatus: "confirmed",
  };
}

export function persistCareNote(
  store: CareStore,
  note: CareNote,
  source: SourceRef,
): CareUpdate {
  const payload = `${NOTE_PREFIX}${JSON.stringify(note)}`;
  return store.addUpdate({
    id: store.newId("upd"),
    careRecipientId: note.careRecipientId,
    toPersonId: note.authorPersonId,
    summary: payload,
    source,
    status: "ready",
    safetyClass: "low",
  });
}

export function listCareNotes(
  store: CareStore,
  careRecipientId: string,
): CareNote[] {
  const out: CareNote[] = [];
  for (const u of store.getUpdates(careRecipientId)) {
    const blob = u.summary ?? "";
    if (!blob.startsWith(NOTE_PREFIX)) continue;
    try {
      const note = JSON.parse(blob.slice(NOTE_PREFIX.length)) as CareNote;
      out.push(note);
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Gentle coaching for vague updates (not form interrogation). */
export function coachingPromptForRaw(raw: string): string | null {
  const q = raw.toLowerCase();
  if (/\bweird\b|\boff\b|\bnot herself\b|\bnot himself\b/.test(q)) {
    return "That helps. What seemed different from her usual baseline?";
  }
  if (/\bate poorly\b|\bdidn'?t eat much\b|\bhardly ate\b/.test(q)) {
    return "About how much did she eat, and was that different from usual?";
  }
  if (/\bdizz\b|\blightheaded\b/.test(q) && !/\b(am|pm|morning|noon|afternoon|evening|o'?clock|around \d)\b/.test(q)) {
    return "About what time did the dizziness happen?";
  }
  if (/\bfell\b|\bfall\b/.test(q) && !/\b(help|helped|sit|seated|caught)\b/.test(q)) {
    return "Did she fall all the way, or were you able to help her sit safely?";
  }
  return null;
}
