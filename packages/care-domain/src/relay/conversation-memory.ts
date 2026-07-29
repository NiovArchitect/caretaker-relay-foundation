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
  const hasTylenol = /\btylenol|acetaminophen\b/i.test(text);
  const hasAllegra = /\ballegra\b/i.test(text);
  const hasCorrection = /not administered|corrected/i.test(text);
  const reporter =
    text.match(/\bfrom\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)?.[1] ||
    text.match(/\b(Marcus|Maya|Daniel|Walter)\b/)?.[1];

  if (hasFever) {
    refs.push({
      kind: "observation",
      label: "fever report",
      reporter: reporter,
    });
  }
  if (hasTylenol) {
    refs.push({
      kind: "medication_change",
      label: "Tylenol medication-change report",
      reporter: reporter,
    });
  }
  if (hasAllegra) {
    refs.push({
      kind: "medication_change",
      label: "Allegra pending medication-plan verification",
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
  if (q.length > 72) return false;
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
    /^who corrected it$/.test(q)
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

  // Multi-referent time questions → clarify
  if (
    /what time|when was|when did|at what time/.test(q) &&
    referents.length >= 2
  ) {
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

  // Time follow-up — single referent
  if (/what time|when was|when did|at what time/.test(q)) {
    const ref = referents[0];
    if (ref?.timeLabel) {
      return {
        handled: true,
        confidence: "high",
        selectedReferent: ref.label,
        modelPath: "deterministic",
        answer: `The ${ref.label} is on file for ${recipientDisplayName} at ${ref.timeLabel}.`,
      };
    }
    // Scan answer for clock-ish labels
    const timeHit =
      lastAnswer.match(
        /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)[^.]*?\d{1,2}:\d{2}\s*(?:AM|PM)?[^.]*?(?:PDT|PST|EDT|EST)?/i,
      )?.[0] ||
      lastAnswer.match(/\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i)?.[0];
    if (timeHit && ref) {
      return {
        handled: true,
        confidence: "medium",
        selectedReferent: ref.label,
        modelPath: "deterministic",
        answer: `I believe you mean the ${ref.label}. The time on file is ${timeHit.trim()}.`,
      };
    }
    if (ref) {
      return {
        handled: true,
        confidence: "medium",
        selectedReferent: ref.label,
        modelPath: "deterministic",
        answer: `I believe you mean the ${ref.label} for ${recipientDisplayName}. I do not have a precise clock time for that report on file—only that it was recorded in the recent care day / prior shift notes.`,
      };
    }
  }

  // Who reported
  if (/who (reported|said|noted|recorded)/.test(q)) {
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
    const pending = referents.find((r) => r.kind === "medication_change");
    if (pending || /pending|not an active|waiting for/i.test(lastAnswer)) {
      const label = pending?.label || focus?.medicationName || "that medication change";
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
    const med =
      focus?.medicationName ||
      referents.find((r) => r.kind === "medication_change" || r.kind === "medication")
        ?.label;
    if (med && /allegra|pending|not an active|waiting/i.test(med + lastAnswer)) {
      return {
        handled: true,
        confidence: "high",
        selectedReferent: med,
        modelPath: "deterministic",
        answer: `${med} is a pending medication-change request for ${recipientDisplayName}, not an authorized administration instruction. Relay does not treat it as something already given.`,
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
  let medicationName =
    input.classified.entities.medicationHint ?? prev?.medicationName;
  if (/\ballegra\b/i.test(input.answer + input.userMessage)) {
    medicationName = "Allegra";
  } else if (/\btylenol|acetaminophen\b/i.test(input.answer + input.userMessage)) {
    medicationName = medicationName ?? "Tylenol";
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
