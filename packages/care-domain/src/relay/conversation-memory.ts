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
 * Conversation history is NOT care truth.
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
  updatedAt: string;
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
  // Stable conversation per principal×recipient (product policy: continuous care dialogue)
  return `conv-${principalId}-${careRecipientId}`;
}

export function encodeTurnUpdate(
  turn: RelayTurnRecord,
  source: SourceRef,
): CareUpdate {
  return {
    id: turn.turnId,
    careRecipientId: turn.careRecipientId,
    // Private to principal — toPersonId = principal (not shared circle)
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
    // Enforce principal isolation on decode
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

  // Topic switch: medication after appointment — "it" binds to med if med intent present
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
  const focus: RelayFocus = {
    conversationId,
    principalId: input.principalId,
    careRecipientId: input.careRecipientId,
    medicationName:
      input.classified.entities.medicationHint ?? prev?.medicationName,
    personName: input.classified.entities.personHint ?? prev?.personName,
    observationTheme: /dizz/i.test(input.userMessage + input.answer)
      ? "dizziness"
      : prev?.observationTheme,
    lastIntent: input.classified.primary,
    updatedAt: new Date().toISOString(),
  };
  // Topic switch: if this turn is clearly medication, don't keep appointment as "it"
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
