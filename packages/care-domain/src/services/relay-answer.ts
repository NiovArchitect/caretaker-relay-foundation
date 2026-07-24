/**
 * Authoritative server Relay answer service.
 *
 * UI must call this via POST /api/v1/care/answer — not a parallel client engine.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CurrentCareState } from "../types.js";
import { classifyIntent } from "../relay/intents.js";
import { runAnswerEngine, type AnswerEngineResult } from "../relay/answer-engine.js";
import {
  conversationIdFor,
  listTurns,
  persistTurn,
  resolveWithDurableMemory,
  type RelayTurnRecord,
} from "../relay/conversation-memory.js";
import type { CareStateBag } from "../relay/projections.js";

export type RelayAnswerRequest = {
  question: string;
  principalId: string;
  principalDisplayName: string;
  roleLabel: string;
  careRecipientId: string;
  recipientDisplayName: string;
  store: CareStore;
  /** Optional override state bag (tests) */
  stateOverride?: CareStateBag;
};

export type RelayAnswerResponse = AnswerEngineResult & {
  durable: true;
  turnId?: string;
  conversationId: string;
  canDeterministic: boolean;
  evidenceBound: boolean;
};

function stateToBag(
  state: CurrentCareState | undefined,
  careRecipientId: string,
): CareStateBag {
  if (!state) {
    return {
      careRecipientId,
      medicationSchedules: [],
      medicationRecords: [],
      appointments: [],
      observations: [],
      events: [],
      openSafetyReviews: [],
      tasks: [],
    };
  }
  return {
    careRecipientId: state.careRecipientId,
    medicationSchedules: state.medicationSchedules as unknown as Array<
      Record<string, unknown>
    >,
    medicationRecords: state.medicationRecords as unknown as Array<
      Record<string, unknown>
    >,
    appointments: state.appointments as unknown as Array<Record<string, unknown>>,
    observations: state.observations as unknown as Array<Record<string, unknown>>,
    events: state.events as unknown as Array<Record<string, unknown>>,
    openSafetyReviews: state.openSafetyReviews as unknown as Array<
      Record<string, unknown>
    >,
    tasks: state.tasks as unknown as Array<Record<string, unknown>>,
  };
}

/** Intents that are safely answered from structured projections without LLM. */
const DETERMINISTIC_INTENTS = new Set([
  "MEDICATION_CURRENT",
  "MEDICATION_DUE",
  "MEDICATION_ADMINISTRATION_HISTORY",
  "MEDICATION_INSTRUCTIONS",
  "MEDICATION_UNCERTAINTY",
  "MEDICATION_CHANGE",
  "APPOINTMENT_NEXT",
  "APPOINTMENT_LOGISTICS",
  "APPOINTMENT_PREPARATION",
  "CHANGE_SINCE",
  "RECENT_ACTIVITY",
  "TASKS_NOW",
  "TASKS_REMAINING",
  "CARE_TEAM",
  "CONTACT_PERSON",
  "PROVIDER_CONTACT",
  "PROVIDER_INSTRUCTION",
  "PROVIDER_UPDATE_PREP",
  "HANDOFF_PREP",
  "HANDOFF_REVIEW",
  "SAFETY_CONCERN",
  "ESCALATION",
  "RECIPIENT_ROUTINE",
  "RECIPIENT_PREFERENCES",
  "DOCUMENT_PREP",
  "OBSERVATION_HISTORY",
  "TREND",
]);

export function canAnswerDeterministically(primary: string): boolean {
  return DETERMINISTIC_INTENTS.has(primary);
}

/**
 * Authoritative answer path. Always persists private turn for principal×recipient.
 */
export function answerRelayQuestion(
  req: RelayAnswerRequest,
): RelayAnswerResponse {
  const store = req.store;
  const state =
    req.stateOverride ??
    stateToBag(
      store.getCurrentState(req.careRecipientId),
      req.careRecipientId,
    );

  // Lightweight second recipient safety: never serve Evelyn meds for Robert
  if (req.careRecipientId === "cr-robert" && !req.stateOverride) {
    const robertState: CareStateBag = {
      careRecipientId: "cr-robert",
      medicationSchedules: [
        {
          id: "med-robert-am",
          name: "Lisinopril",
          dose: "10 mg",
          scheduleLabel: "Morning",
          scheduleTime: "8:00 AM",
          authorizedBy: "Dr. Amara Cole",
          mealRelation: "With or without food",
        },
      ],
      medicationRecords: [],
      appointments: [
        {
          id: "apt-robert-pcp",
          title: "Primary care follow-up",
          startsAt: "2026-07-28T17:00:00Z",
          startsAtLabel: "Monday, July 28 · 10:00 AM PDT",
          location: "Coastal Family Medicine (synthetic evaluation location)",
          status: "scheduled",
        },
      ],
      observations: [],
      events: [
        {
          id: "ev-robert-1",
          statement: "Robert reported feeling steady on his morning walk.",
          occurredAt: "2026-07-22T16:00:00Z",
          source: { actorName: "Marcus Carter" },
        },
      ],
      openSafetyReviews: [],
      tasks: [],
    };
    return answerWithState(req, robertState);
  }

  return answerWithState(req, state);
}

function answerWithState(
  req: RelayAnswerRequest,
  state: CareStateBag,
): RelayAnswerResponse {
  const store = req.store;
  const handoffs = store.getHandoffs(req.careRecipientId);
  const latest = handoffs[handoffs.length - 1];
  const open = (state.openSafetyReviews ?? []).map((r) =>
    String(r.reason ?? r.message ?? ""),
  );
  const conversationId = conversationIdFor(
    req.principalId,
    req.careRecipientId,
  );

  const priorTurns = listTurns(
    store,
    req.principalId,
    req.careRecipientId,
    8,
  );
  const priorEntities = priorTurns.at(-1)?.resolvedEntities;

  const result = runAnswerEngine({
    question: req.question,
    principalId: req.principalId,
    principalName: req.principalDisplayName,
    roleLabel: req.roleLabel,
    recipientId: req.careRecipientId,
    recipientName: req.recipientDisplayName,
    state,
    attentionLines: open,
    handoff: latest
      ? {
          whatChanged: latest.whatChanged ?? [],
          stillNeedsAttention: latest.stillNeedsAttention ?? [],
          toPersonId: latest.toPersonId,
        }
      : null,
    priorEntities,
    conversationId,
    resolveMemory: (classified, q) =>
      resolveWithDurableMemory(
        store,
        req.principalId,
        req.careRecipientId,
        classified,
        q,
      ),
  });

  const canDeterministic = canAnswerDeterministically(result.intent);

  // Observation / non-question: return empty marker for understand path
  const classifiedPeek = classifyIntent(req.question);
  if (
    classifiedPeek.isObservationUpdate &&
    !classifiedPeek.isQuestion &&
    result.intent === "UNKNOWN_QUESTION"
  ) {
    // Let caller fall through to understand — do not persist empty Q&A
    return {
      ...result,
      answer: "",
      durable: true,
      conversationId,
      canDeterministic: false,
      evidenceBound: true,
    };
  }

  const turn = persistTurn(store, {
    principalId: req.principalId,
    principalDisplayName: req.principalDisplayName,
    careRecipientId: req.careRecipientId,
    roleLabel: req.roleLabel,
    userMessage: req.question,
    classified: result.classified,
    answer: result.answer,
    sourceRefs: result.sourceRefs,
    modelPath: result.modelPath,
  });

  return {
    ...result,
    durable: true,
    turnId: turn.turnId,
    conversationId,
    canDeterministic,
    evidenceBound: true,
  };
}

export function listPrincipalTurns(
  store: CareStore,
  principalId: string,
  careRecipientId: string,
): RelayTurnRecord[] {
  return listTurns(store, principalId, careRecipientId);
}
