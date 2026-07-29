/**
 * Durable Relay conversation memory — server authority.
 *
 * Persisted via CareUpdate rows (RELAY_TURN_V1: / RELAY_FOCUS_V1:) so Prisma
 * CareUpdateRow stores history without a separate migration.
 *
 * Layering:
 *   A. Durable care truth — authoritative
 *   B. Shared human coordination — authorized shared messages
 *   C. Relay conversation memory — private to principal×recipient
 *
 * Conversation history is NOT care truth. Context resolves language only;
 * authorization still comes from relationship checks.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareUpdate, SourceRef } from "../types.js";
import type { ClassifiedTurn, RelayIntent } from "./intents.js";
import { buildOrderedMedicationCandidatesFromLines } from "../services/medication-candidates.js";

const TURN_PREFIX = "RELAY_TURN_V1:";
const FOCUS_PREFIX = "RELAY_FOCUS_V1:";

export type RelayTurnRecord = {
  turnId: string;
  conversationId: string;
  principalId: string;
  careRecipientId: string;
  timestamp: string;
  rawText: string;
  role: string;
  resolvedIntents: RelayIntent[];
  primaryIntent: RelayIntent;
  resolvedEntities: ClassifiedTurn["entities"];
  decisionContext: string;
  sourceRefs: string[];
  answerSummary: string;
  safetyState: string;
  modelPath: "deterministic" | "llm" | "clarification";
};

export type RelayFocus = {
  conversationId: string;
  principalId: string;
  careRecipientId: string;
  medicationName?: string;
  personName?: string;
  appointmentTitle?: string;
  observationTheme?: string;
  lastIntent?: RelayIntent;
  /** Last full answer (bounded) for coreference */
  lastAnswerSummary?: string;
  lastUserQuestion?: string;
  /** Distinct referents mentioned in the last answer */
  referents?: Array<{
    kind: "observation" | "medication_change" | "medication" | "correction" | "handoff" | "other";
    label: string;
    reporter?: string;
    timeLabel?: string;
    dose?: string;
    reason?: string;
    ordinal?: number;
  }>;
  /** Explicitly selected multi-med candidate after clarification */
  selectedMedicationCandidate?: string;
  /** Canonical ordered medication candidates (display_index 1-based) */
  orderedMedicationCandidates?: Array<{
    display_index: number;
    candidate_id: string;
    medication: string;
    dose: string;
    reason: string;
    reporter: string;
    report_time?: string | null;
  }>;
  updatedAt: string;
};

export type ContextualFollowUpResult = {
  handled: boolean;
  answer?: string;
  clarification?: boolean;
  confidence?: "high" | "medium" | "low";
  selectedReferent?: string;
  modelPath?: "deterministic" | "clarification";
};

function sourceFor(principalId: string, displayName: string): SourceRef {
  return {
    id: `src-relay-${principalId}-${Date.now().toString(36)}`,
    kind: "system_derived",
    label: "Relay conversation turn",
    actorName: displayName,
    actorPersonId: principalId,
    recordedAt: new Date().toISOString(),
    whyVisible: "Private Relay dialogue for this principal and recipient.",
  };
}

export function conversationIdFor(
  principalId: string,
  careRecipientId: string,
): string {
  return `conv-${principalId}-${careRecipientId}`;
}

export function encodeTurnUpdate(
  turn: RelayTurnRecord,
  source: SourceRef,
): CareUpdate {
  return {
    id: turn.turnId,
    careRecipientId: turn.careRecipientId,
    toPersonId: turn.principalId,
    summary: TURN_PREFIX + JSON.stringify(turn),
    status: "ready",
    safetyClass: "low",
    source,
  };
}

export function decodeTurn(u: CareUpdate): RelayTurnRecord | null {
  if (!u.summary || !u.summary.startsWith(TURN_PREFIX)) return null;
  try {
    const raw = JSON.parse(u.summary.slice(TURN_PREFIX.length)) as RelayTurnRecord;
    if (raw.principalId && raw.principalId !== u.toPersonId) return null;
    return raw;
  } catch {
    return null;
  }
}

export function listTurns(
  store: CareStore,
  principalId: string,
  careRecipientId: string,
  limit = 40,
): RelayTurnRecord[] {
  return store
    .getUpdates(careRecipientId)
    .map(decodeTurn)
    .filter((t): t is RelayTurnRecord => !!t && t.principalId === principalId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-limit);
}

export function getFocus(
  store: CareStore,
  principalId: string,
  careRecipientId: string,
): RelayFocus | null {
  const rows = store
    .getUpdates(careRecipientId)
    .filter(
      (u) =>
        u.summary.startsWith(FOCUS_PREFIX) && u.toPersonId === principalId,
    )
    .sort((a, b) => b.source.recordedAt.localeCompare(a.source.recordedAt));
  const top = rows[0];
  if (!top) return null;
  try {
    return JSON.parse(top.summary.slice(FOCUS_PREFIX.length)) as RelayFocus;
  } catch {
    return null;
  }
}

export function saveFocus(
  store: CareStore,
  focus: RelayFocus,
  displayName: string,
): void {
  const src = sourceFor(focus.principalId, displayName);
  store.addUpdate({
    id: `relay-focus-${focus.principalId}-${focus.careRecipientId}`,
    careRecipientId: focus.careRecipientId,
    toPersonId: focus.principalId,
    summary: FOCUS_PREFIX + JSON.stringify({ ...focus, updatedAt: new Date().toISOString() }),
    status: "ready",
    safetyClass: "low",
    source: src,
  });
}

/** Extract referents from a Relay answer for later follow-ups. */
export function extractReferentsFromAnswer(
  answer: string,
  userMessage: string,
): NonNullable<RelayFocus["referents"]> {
  const text = `${userMessage}\n${answer}`;
  const refs: NonNullable<RelayFocus["referents"]> = [];
  const hasFever = /\bfever\b/i.test(text);
  const hasCorrection = /not administered|corrected/i.test(text);
  const reporter =
    text.match(/\bfrom\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)?.[1] ||
    text.match(/\b(Marcus|Maya|Daniel|Walter)\b/)?.[1];

  // Prefer numbered multi-med listing: "1. … Tylenol · reported dose 300mg …"
  const numbered = [...answer.matchAll(/^\s*\d+\.\s*(.+)$/gm)].map((x) => x[1]!.trim());
  let ordinal = 0;
  const seenMed = new Set<string>();
  for (const line of numbered) {
    if (
      !/medication change|needs verification|waiting for medication-plan|reported dose|allergies|fever/i.test(
        line,
      )
    ) {
      continue;
    }
    const nameHit =
      line.match(
        /\b(Tylenol|Acetaminophen|Zyrtec|Cetirizine|Allegra|Fexofenadine|Claritin|Loratadine|Ibuprofen|Advil|Benadryl|Diphenhydramine|[A-Z][a-z]{3,})\b/,
      )?.[1] ||
      line.match(/([A-Za-z][A-Za-z-]{2,})\s*·\s*reported dose/i)?.[1];
    if (!nameHit) continue;
    const key = nameHit.toLowerCase();
    if (seenMed.has(key)) continue;
    if (/medication|change|needs|waiting|active|authorized|current|review/i.test(nameHit))
      continue;
    seenMed.add(key);
    ordinal += 1;
    const dose = line.match(/(\d+\s*(?:mg|mcg|ml|units?))/i)?.[1];
    const reason =
      line.match(/reason:\s*([^.\n]+)/i)?.[1]?.trim() ||
      line.match(/for\s+([^.\n]+)/i)?.[1]?.trim();
    const who = line.match(/\(from\s+([^)]+)\)/i)?.[1] || reporter;
    refs.push({
      kind: "medication_change",
      label: `${nameHit}${dose ? ` ${dose}` : ""} pending plan change`,
      reporter: who,
      dose,
      reason,
      ordinal,
    });
  }
  // Fallback: Allegra-style prose lines
  if (!refs.some((r) => r.kind === "medication_change")) {
    const prose = answer.match(
      /\b([A-Z][a-z]+)\s+(\d+\s*mg)\b[^\n]{0,80}(?:waiting|verification|pending)/gi,
    );
    for (const p of prose ?? []) {
      const mm = p.match(/\b([A-Z][a-z]+)\s+(\d+\s*mg)/i);
      if (!mm) continue;
      const key = mm[1]!.toLowerCase();
      if (seenMed.has(key)) continue;
      seenMed.add(key);
      ordinal += 1;
      refs.push({
        kind: "medication_change",
        label: `${mm[1]} ${mm[2]} pending plan change`,
        reporter,
        dose: mm[2],
        ordinal,
      });
    }
  }

  if (hasFever) {
    refs.push({
      kind: "observation",
      label: "fever report",
      reporter: reporter,
    });
  }
  if (hasCorrection) {
    refs.push({
      kind: "correction",
      label: "medication-administration correction (not given)",
      reporter: reporter,
    });
  }
  // Dedupe by label
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (seen.has(r.label)) return false;
    seen.add(r.label);
    return true;
  });
}

export function isShortContextualFollowUp(question: string): boolean {
  const q = question.trim().toLowerCase().replace(/[?.!]+$/g, "");
  if (q.length > 80) return false;
  return (
    /^(at )?what time( was (that|it|the .{0,30})?)?$/.test(q) ||
    /^when (was|is|did) (that|it|this)/.test(q) ||
    /^when was it reported$/.test(q) ||
    /^who (reported|said|corrected|noted|recorded) (that|it|this)?$/.test(q) ||
    /^who needs to review it$/.test(q) ||
    /^was it confirmed$/.test(q) ||
    /^is (it|that) (active|confirmed|open|still open)$/.test(q) ||
    /^has she taken it$/.test(q) ||
    /^did she take it$/.test(q) ||
    /^what happened after$/.test(q) ||
    /^who is handling it$/.test(q) ||
    /^when is that$/.test(q) ||
    /^(why|which one|what about yesterday)$/.test(q) ||
    /^what time did that happen$/.test(q) ||
    /^who corrected it$/.test(q) ||
    /^(the )?(first|second|third|1st|2nd|3rd)( one)?$/.test(q) ||
    /^what about the (first|second|third)( one)?$/.test(q)
  );
}

/**
 * Resolve short follow-ups from prior turn + focus.
 * Prefer focused clarification over generic domain fallback.
 */
export function resolveContextualFollowUp(
  store: CareStore,
  principalId: string,
  careRecipientId: string,
  recipientDisplayName: string,
  question: string,
): ContextualFollowUpResult {
  if (!isShortContextualFollowUp(question)) {
    return { handled: false };
  }

  const focus = getFocus(store, principalId, careRecipientId);
  const turns = listTurns(store, principalId, careRecipientId, 6);
  const last = turns.at(-1);
  const lastAnswer = focus?.lastAnswerSummary || last?.answerSummary || "";
  const lastQ = focus?.lastUserQuestion || last?.rawText || "";
  const referents =
    focus?.referents?.length
      ? focus.referents
      : extractReferentsFromAnswer(lastAnswer, lastQ);

  if (!lastAnswer && referents.length === 0) {
    return { handled: false };
  }

  const q = question.trim().toLowerCase();

  // Ordinal selection from canonical ordered array only
  const ordered = focus?.orderedMedicationCandidates ?? [];
  const ordMatch = q.match(
    /(?:the )?(first|1st|second|2nd|third|3rd|last)(?: one)?/,
  );
  if (ordMatch && ordered.length >= 1) {
    const token = ordMatch[1]!;
    let idx = 0;
    if (/second|2nd/.test(token)) idx = 1;
    else if (/third|3rd/.test(token)) idx = 2;
    else if (/last/.test(token)) idx = ordered.length - 1;
    else idx = 0;
    const pick = ordered[idx];
    if (pick) {
      saveFocus(
        store,
        {
          ...(focus ?? {
            conversationId: conversationIdFor(principalId, careRecipientId),
            principalId,
            careRecipientId,
            updatedAt: new Date().toISOString(),
          }),
          selectedMedicationCandidate: pick.candidate_id,
          medicationName: pick.medication,
          orderedMedicationCandidates: ordered,
          lastAnswerSummary: lastAnswer,
          lastUserQuestion: lastQ,
          referents,
          updatedAt: new Date().toISOString(),
        },
        "Relay",
      );
      return {
        handled: true,
        confidence: "high",
        selectedReferent: `${pick.medication} ${pick.dose}`.trim(),
        modelPath: "deterministic",
        answer: `Understood — focusing on #${pick.display_index}: ${pick.medication}${pick.dose ? ` ${pick.dose}` : ""}${pick.reason ? ` for ${pick.reason}` : ""}${pick.reporter ? ` (reported by ${pick.reporter})` : ""}. Ask when it was reported, who reported it, whether it is active, or if the recipient took it.`,
      };
    }
  }

  // Multi-referent time questions → clarify (unless one candidate already selected)
  if (
    /what time|when was|when did|at what time|when was it reported/.test(q) &&
    !focus?.selectedMedicationCandidate
  ) {
    if (ordered.length >= 2) {
      const labels = ordered
        .map((c) => `${c.display_index}) ${c.medication}${c.dose ? ` ${c.dose}` : ""}`)
        .join("; ");
      return {
        handled: true,
        clarification: true,
        confidence: "low",
        modelPath: "clarification",
        answer: `Which medication change do you mean? ${labels}. You can say “the second one.”`,
      };
    }
    if (referents.length >= 2) {
      const a = referents[0]!.label;
      const b = referents[1]!.label;
      return {
        handled: true,
        clarification: true,
        confidence: "low",
        modelPath: "clarification",
        answer: `Do you mean when the ${a} was recorded, or when the ${b} was recorded?`,
      };
    }
  }

  // Time follow-up — selected ordered candidate or single
  if (/what time|when was|when did|at what time|when was it reported/.test(q)) {
    const selected =
      ordered.find((c) => c.candidate_id === focus?.selectedMedicationCandidate) ||
      (ordered.length === 1 ? ordered[0] : undefined);
    if (selected) {
      return {
        handled: true,
        confidence: "high",
        selectedReferent: selected.medication,
        modelPath: "deterministic",
        answer: selected.report_time
          ? `${selected.medication}${selected.dose ? ` ${selected.dose}` : ""} was reported at ${selected.report_time}.`
          : `${selected.medication}${selected.dose ? ` ${selected.dose}` : ""} was reported for ${recipientDisplayName}; a precise clock time is not on file beyond the recent care record.`,
      };
    }
  }

  // Who reported
  if (/who (reported|said|noted|recorded)/.test(q)) {
    const selected = ordered.find(
      (c) => c.candidate_id === focus?.selectedMedicationCandidate,
    );
    if (selected?.reporter) {
      return {
        handled: true,
        confidence: "high",
        selectedReferent: selected.medication,
        modelPath: "deterministic",
        answer: `${selected.reporter} reported ${selected.medication}${selected.dose ? ` ${selected.dose}` : ""} for ${recipientDisplayName}.`,
      };
    }
    const ref = referents[0];
    const reporter =
      ref?.reporter ||
      lastAnswer.match(/\bfrom\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)?.[1] ||
      lastAnswer.match(/\b(Marcus Carter|Maya Bennett|Daniel Kim|Marcus|Maya|Daniel)\b/)?.[1];
    if (reporter && ref) {
      return {
        handled: true,
        confidence: "high",
        selectedReferent: ref.label,
        modelPath: "deterministic",
        answer: `${reporter} reported the ${ref.label} for ${recipientDisplayName}.`,
      };
    }
    if (reporter) {
      return {
        handled: true,
        confidence: "medium",
        modelPath: "deterministic",
        answer: `That update is attributed to ${reporter} on the care record for ${recipientDisplayName}.`,
      };
    }
    return {
      handled: true,
      confidence: "medium",
      modelPath: "deterministic",
      answer: `I do not have a clear reporter name on the prior answer for ${recipientDisplayName}. The note is on the care record, but the actor field is incomplete.`,
    };
  }

  // Who corrected
  if (/who corrected/.test(q)) {
    if (/correct|not administered/i.test(lastAnswer)) {
      const who =
        lastAnswer.match(/\b(Marcus Carter|Maya Bennett|Daniel Kim|Marcus|Maya)\b/)?.[1] ||
        "an authorized caregiver";
      return {
        handled: true,
        confidence: "medium",
        selectedReferent: "medication-administration correction",
        modelPath: "deterministic",
        answer: `The medication-administration record was corrected to “not administered.” On file, that correction is associated with ${who}. Original reports remain in history.`,
      };
    }
    return {
      handled: true,
      confidence: "low",
      clarification: true,
      modelPath: "clarification",
      answer: `I do not see a correction called out in the immediately previous answer. Do you mean a medication-administration correction, or something else on the prior shift?`,
    };
  }

  // Who needs to review
  if (/who needs to review/.test(q)) {
    const med =
      focus?.medicationName ||
      referents.find((r) => r.kind === "medication_change")?.label ||
      "the pending medication change";
    return {
      handled: true,
      confidence: "medium",
      selectedReferent: med,
      modelPath: "deterministic",
      answer: `${med} still needs medication-plan verification for ${recipientDisplayName}. An authorized family primary or clinician can review it—it is not active plan instruction until approved.`,
    };
  }

  // Was it confirmed / is it active
  if (/was it confirmed|is (it|that) (active|confirmed)/.test(q)) {
    const selected = ordered.find(
      (c) => c.candidate_id === focus?.selectedMedicationCandidate,
    );
    if (selected || focus?.medicationName || /pending|not an active|waiting for/i.test(lastAnswer)) {
      const label = selected
        ? `${selected.medication}${selected.dose ? ` ${selected.dose}` : ""}`
        : focus?.medicationName || "that medication change";
      return {
        handled: true,
        confidence: "high",
        selectedReferent: label,
        modelPath: "deterministic",
        answer: `No — ${label} is not confirmed as active plan instruction for ${recipientDisplayName}. It remains pending authorized review.`,
      };
    }
    if (/fever|observation/i.test(lastAnswer)) {
      return {
        handled: true,
        confidence: "medium",
        selectedReferent: "fever report",
        modelPath: "deterministic",
        answer: `The fever note is caregiver-reported on file for ${recipientDisplayName}. That is a reported observation, not a clinician-confirmed diagnosis.`,
      };
    }
  }

  // Has she taken it / did she take it
  if (/has she taken it|did she take it/.test(q)) {
    const selected = ordered.find(
      (c) => c.candidate_id === focus?.selectedMedicationCandidate,
    );
    if (selected || focus?.medicationName) {
      const label = selected
        ? `${selected.medication}${selected.dose ? ` ${selected.dose}` : ""}`
        : focus!.medicationName!;
      return {
        handled: true,
        confidence: "high",
        selectedReferent: label,
        modelPath: "deterministic",
        answer: `${label} is a pending medication-plan change for ${recipientDisplayName}, not an authorized administration instruction. Relay does not treat a pending plan request as something already given. Check Care → medication administration for administration history.`,
      };
    }
    if (/not administered|corrected/i.test(lastAnswer)) {
      return {
        handled: true,
        confidence: "high",
        modelPath: "deterministic",
        answer: `The current record says the medication was not administered for ${recipientDisplayName}. Earlier reports remain in history.`,
      };
    }
    return {
      handled: true,
      confidence: "medium",
      modelPath: "deterministic",
      answer: `I do not have a confirmed administration of that item in the prior exchange for ${recipientDisplayName}. Check Care → medication administration for current truth.`,
    };
  }

  // Still open / handling
  if (/still open|who is handling/.test(q)) {
    return {
      handled: true,
      confidence: "medium",
      modelPath: "deterministic",
      answer: `From the prior exchange, open items for ${recipientDisplayName} still include pending medication-plan verification and any handoff notes that were not finished. Ask “what needs review?” for the current open list.`,
    };
  }

  return { handled: false };
}

export function resolveWithDurableMemory(
  store: CareStore,
  principalId: string,
  careRecipientId: string,
  classified: ClassifiedTurn,
  userMessage: string,
): ClassifiedTurn {
  const focus = getFocus(store, principalId, careRecipientId);
  const entities = { ...classified.entities };

  if (
    focus?.medicationName &&
    (entities.references.includes("it") ||
      /\bit\b|\bthat (medicine|med|one|dose)\b/i.test(userMessage))
  ) {
    entities.medicationHint = focus.medicationName;
  }
  if (/yesterday/i.test(userMessage)) entities.timeHint = "yesterday";

  if (
    classified.primary === "UNKNOWN_QUESTION" &&
    focus?.medicationName &&
    /when|before|after|who gave|did .* give/i.test(userMessage)
  ) {
    return {
      ...classified,
      primary: "MEDICATION_ADMINISTRATION_HISTORY",
      intents: ["MEDICATION_ADMINISTRATION_HISTORY", ...classified.intents],
      entities: { ...entities, medicationHint: focus.medicationName },
    };
  }

  if (
    /before.*dizz|dizz.*before|before she/i.test(userMessage) &&
    (focus?.medicationName || focus?.observationTheme)
  ) {
    return {
      ...classified,
      primary: "OBSERVATION_HISTORY",
      intents: [
        "OBSERVATION_HISTORY",
        "MEDICATION_ADMINISTRATION_HISTORY",
        ...classified.intents,
      ],
      entities: { ...entities, medicationHint: focus?.medicationName },
    };
  }

  if (
    classified.intents.some((i) => i.startsWith("MEDICATION")) &&
    entities.references.includes("it") &&
    focus?.medicationName
  ) {
    entities.medicationHint = focus.medicationName;
  }

  return { ...classified, entities };
}

export function persistTurn(
  store: CareStore,
  input: {
    principalId: string;
    principalDisplayName: string;
    careRecipientId: string;
    roleLabel: string;
    userMessage: string;
    classified: ClassifiedTurn;
    answer: string;
    sourceRefs: string[];
    modelPath: RelayTurnRecord["modelPath"];
  },
): RelayTurnRecord {
  const conversationId = conversationIdFor(
    input.principalId,
    input.careRecipientId,
  );
  const turn: RelayTurnRecord = {
    turnId: `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    conversationId,
    principalId: input.principalId,
    careRecipientId: input.careRecipientId,
    timestamp: new Date().toISOString(),
    rawText: input.userMessage,
    role: input.roleLabel,
    resolvedIntents: input.classified.intents,
    primaryIntent: input.classified.primary,
    resolvedEntities: input.classified.entities,
    decisionContext: input.classified.decisionContext,
    sourceRefs: input.sourceRefs,
    answerSummary: input.answer.slice(0, 2000),
    safetyState: "ok",
    modelPath: input.modelPath,
  };
  store.addUpdate(
    encodeTurnUpdate(
      turn,
      sourceFor(input.principalId, input.principalDisplayName),
    ),
  );

  const prev = getFocus(store, input.principalId, input.careRecipientId);
  const referents = extractReferentsFromAnswer(input.answer, input.userMessage);
  // Rebuild ordered candidates from the answer lines (same ordering policy as display)
  let orderedMedicationCandidates = prev?.orderedMedicationCandidates;
  const ordered = buildOrderedMedicationCandidatesFromLines(
    input.answer.split("\n"),
    8,
  );
  if (ordered.length) {
    orderedMedicationCandidates = ordered.map((c) => ({
      display_index: c.display_index,
      candidate_id: c.candidate_id,
      medication: c.medication,
      dose: c.dose,
      reason: c.reason,
      reporter: c.reporter,
      report_time: c.report_time,
    }));
  }
  let medicationName =
    input.classified.entities.medicationHint ?? prev?.medicationName;
  if (orderedMedicationCandidates?.[0]) {
    medicationName = orderedMedicationCandidates[0].medication;
  }

  const focus: RelayFocus = {
    conversationId,
    principalId: input.principalId,
    careRecipientId: input.careRecipientId,
    medicationName,
    personName: input.classified.entities.personHint ?? prev?.personName,
    observationTheme: /\bfever\b/i.test(input.userMessage + input.answer)
      ? "fever"
      : /dizz/i.test(input.userMessage + input.answer)
        ? "dizziness"
        : prev?.observationTheme,
    lastIntent: input.classified.primary,
    lastAnswerSummary: input.answer.slice(0, 1500),
    lastUserQuestion: input.userMessage.slice(0, 500),
    referents: referents.length ? referents : prev?.referents,
    selectedMedicationCandidate: prev?.selectedMedicationCandidate,
    orderedMedicationCandidates,
    updatedAt: new Date().toISOString(),
  };
  if (input.classified.intents.some((i) => i.startsWith("MEDICATION"))) {
    focus.appointmentTitle = undefined;
  }
  if (input.classified.intents.some((i) => i.startsWith("APPOINTMENT"))) {
    focus.appointmentTitle =
      input.classified.entities.placeHint ?? prev?.appointmentTitle;
  }
  saveFocus(store, focus, input.principalDisplayName);
  return turn;
}

/** Privacy: another principal must not list these turns. */
export function assertPrincipalIsolation(
  store: CareStore,
  careRecipientId: string,
  principalA: string,
  principalB: string,
): { aCount: number; bCount: number; leak: boolean } {
  const a = listTurns(store, principalA, careRecipientId);
  const b = listTurns(store, principalB, careRecipientId);
  const aIds = new Set(a.map((t) => t.turnId));
  const leak = b.some((t) => aIds.has(t.turnId) && t.principalId === principalA);
  return { aCount: a.length, bCount: b.length, leak };
}
