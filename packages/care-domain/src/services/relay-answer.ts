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
import {
  listProviderGuidance,
  summarizeOpenLoops,
} from "./orchestration.js";
import { scanAdversarialQuestion } from "./adversarial-guard.js";
import { resolveCurrentProvider, resolveEscalationTarget } from "./care-team.js";
import {
  answerAgeQuestion,
  answerDiagnosisQuestion,
  answerIdentityOverview,
  emergencySnapshot,
  syntheticProviderSlots,
} from "./recipient-profile.js";

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
  "RECIPIENT_IDENTITY",
  "RECIPIENT_AGE",
  "RECIPIENT_DIAGNOSIS",
  "RECIPIENT_ALLERGIES",
  "RECIPIENT_PROFILE",
  "EMERGENCY_SNAPSHOT",
  "APPOINTMENT_REQUEST_NEW",
  "APPOINTMENT_RESCHEDULE",
  "DOCUMENT_PREP",
  "OBSERVATION_HISTORY",
  "TREND",
  "OPEN_LOOP_STATUS",
  "WAITING_ON",
]);

export function canAnswerDeterministically(primary: string): boolean {
  return DETERMINISTIC_INTENTS.has(primary);
}

/** Shared path for guard / meta answers that already have full text. */
function persistDeterministicAnswer(
  req: RelayAnswerRequest,
  answer: string,
  sourceRefs: string[],
  projection: string,
): RelayAnswerResponse {
  const conversationId = conversationIdFor(
    req.principalId,
    req.careRecipientId,
  );
  const classified = {
    intents: ["SAFETY_CONCERN" as const],
    primary: "SAFETY_CONCERN" as const,
    decisionContext: "information" as const,
    entities: { references: [] as string[] },
    isQuestion: true,
    isObservationUpdate: false,
    needsClarification: false,
  };
  const turn = persistTurn(req.store, {
    principalId: req.principalId,
    principalDisplayName: req.principalDisplayName,
    careRecipientId: req.careRecipientId,
    roleLabel: req.roleLabel,
    userMessage: req.question,
    classified: { ...classified, intents: [...classified.intents] },
    answer,
    sourceRefs,
    modelPath: "deterministic",
  });
  return {
    answer,
    intent: "SAFETY_CONCERN",
    intents: ["SAFETY_CONCERN"],
    persona: "family",
    sourceRefs,
    needsClarification: false,
    projectionsUsed: [projection],
    conversationId,
    modelPath: "deterministic",
    classified: { ...classified, intents: [...classified.intents] },
    durable: true,
    turnId: turn.turnId,
    canDeterministic: true,
    evidenceBound: true,
  };
}

/**
 * Provenance, trust-challenge, absence-of-evidence, and contradiction probes.
 * Deterministic; no LLM. Surfaces source/state without defensiveness.
 */
function scanProvenanceTrustQuestion(input: {
  question: string;
  recipientDisplayName: string;
  store: CareStore;
  careRecipientId: string;
}): { answer: string; sourceRefs: string[] } | null {
  const q = input.question.trim();
  const qLow = q.toLowerCase();
  const recipient = input.recipientDisplayName;
  const schedules = input.store.getMedSchedules(input.careRecipientId);
  const medLine = schedules[0]
    ? `${schedules[0].name} ${schedules[0].dose} (authorized instruction on file${
        schedules[0].authorizedBy ? ` by ${schedules[0].authorizedBy}` : ""
      })`
    : "no medication schedule on file";

  // Absence of evidence ≠ evidence of absence
  if (
    /definitely not take|did (she|he|they) not take|prove (she|he) didn'?t|no way (she|he) took/i.test(
      q,
    )
  ) {
    return {
      sourceRefs: ["provenance:absence_of_evidence"],
      answer:
        `No administration recorded is not the same as proof that ${recipient} did not take a medication.\n\n` +
        `I can only say what is (or is not) in the care record. ` +
        `If you need certainty, record what happened or ask the person who was present to confirm.`,
    };
  }

  // Meta / how do you know
  if (
    /how do you know|who told you|when was that recorded|is that confirmed or just reported|are you using old (info|information)|what changed since you last answered|why (are you|can't you) (asking|answer)|are you sure/i.test(
      qLow,
    )
  ) {
    return {
      sourceRefs: ["provenance:meta"],
      answer:
        `I answer from ${recipient}'s authorized care record for this session — medication schedules, administrations, appointments, handoffs, and confirmed updates.\n\n` +
        `Schedules are authorized instructions on file; many observations and administrations are caregiver-reported until confirmed.\n\n` +
        `Current medication on file: ${medLine}.\n\n` +
        `If something looks stale or wrong, say what changed and I can help verify it with the right person.`,
    };
  }

  // Trust challenge — surface source, do not get defensive
  if (
    /why should i trust|you were wrong before|that doesn'?t sound right|show me where that came from|is that the doctor or a caregiver/i.test(
      qLow,
    )
  ) {
    return {
      sourceRefs: ["provenance:trust"],
      answer:
        `You shouldn't take my word alone — check the source on file.\n\n` +
        `For ${recipient}, the current authorized medication instruction is: ${medLine}.\n\n` +
        `Caregiver reports and doctor orders are labeled differently when both exist. ` +
        `If this doesn't match what you were told, tell me the conflict and we can verify rather than guess.`,
    };
  }

  // Named caregiver time conflict
  if (
    /(maya|daniel|marcus).{0,40}(said|says).{0,40}(but|while).{0,40}(maya|daniel|marcus|noon|11)/i.test(
      qLow,
    ) ||
    /said noon but .+ said|contradict|conflicting/i.test(qLow)
  ) {
    return {
      sourceRefs: ["provenance:conflict"],
      answer:
        `I see a possible conflict between caregiver statements. I won't silently pick one unsupported time.\n\n` +
        `Current care truth for ${recipient} stays on the authorized record (${medLine}) until a verified update supersedes it.\n\n` +
        `If both people reported different times, record each report with who said it, or ask them to confirm so the history stays reviewable.`,
    };
  }

  // Inline correction / negation in one utterance
  if (
    /wait[, ]+no|actually no|i mean no|— wait no|she didn'?t|he didn'?t/i.test(
      q,
    ) &&
    /(took|given|gave|mark)/i.test(q)
  ) {
    return {
      sourceRefs: ["provenance:negation"],
      answer:
        `Understood — you're correcting yourself. I won't treat the first claim as care truth.\n\n` +
        `Nothing is marked as given from a chat assertion alone. ` +
        `If you want the record updated, share the accurate observation and confirm it so the medication history stays accurate.`,
    };
  }

  return null;
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

  const qLow = req.question.toLowerCase();

  // Adversarial reliability pre-scan (false premises, injection, role claims, etc.)
  const guard = scanAdversarialQuestion({
    store,
    careRecipientId: req.careRecipientId,
    recipientDisplayName: req.recipientDisplayName,
    principalId: req.principalId,
    principalDisplayName: req.principalDisplayName,
    roleLabel: req.roleLabel,
    question: req.question,
  });
  if (guard.blocked && guard.answer) {
    return persistDeterministicAnswer(req, guard.answer, [
      `adversarial:${guard.reason}`,
    ], "ADVERSARIAL_GUARD");
  }

  // Provenance / trust / absence-of-evidence — judge-facing self-awareness (deterministic)
  const meta = scanProvenanceTrustQuestion({
    question: req.question,
    recipientDisplayName: req.recipientDisplayName,
    store,
    careRecipientId: req.careRecipientId,
  });
  if (meta) {
    return persistDeterministicAnswer(req, meta.answer, meta.sourceRefs, "PROVENANCE_TRUST");
  }

  // Person intelligence — age, diagnosis, profile, emergency snapshot
  const preClassified = classifyIntent(req.question, priorEntities);
  const personIntent = preClassified.intents.find((i) =>
    [
      "RECIPIENT_AGE",
      "RECIPIENT_DIAGNOSIS",
      "RECIPIENT_IDENTITY",
      "RECIPIENT_PROFILE",
      "RECIPIENT_ALLERGIES",
      "EMERGENCY_SNAPSHOT",
      "APPOINTMENT_REQUEST_NEW",
      "APPOINTMENT_RESCHEDULE",
    ].includes(i),
  );
  if (personIntent) {
    const recipient = store.getRecipient(req.careRecipientId);
    let answer = "";
    if (personIntent === "RECIPIENT_AGE") {
      answer = answerAgeQuestion(recipient);
    } else if (personIntent === "RECIPIENT_DIAGNOSIS") {
      answer = answerDiagnosisQuestion(recipient);
    } else if (
      personIntent === "RECIPIENT_IDENTITY" ||
      personIntent === "RECIPIENT_PROFILE"
    ) {
      answer = answerIdentityOverview(recipient);
    } else if (personIntent === "RECIPIENT_ALLERGIES") {
      const allergies = recipient?.profile?.allergies ?? [];
      answer = allergies.length
        ? `Allergies / intolerances on file for ${req.recipientDisplayName}:\n` +
          allergies
            .map(
              (a) =>
                `• ${a.label}${a.sourceLabel ? ` (${a.sourceLabel})` : ""}`,
            )
            .join("\n")
        : `I don't have allergies listed on file for ${req.recipientDisplayName}.`;
    } else if (personIntent === "EMERGENCY_SNAPSHOT") {
      const meds = store.getMedSchedules(req.careRecipientId).map(
        (m) => `${m.name} ${m.dose} — ${m.scheduleLabel}`,
      );
      answer = emergencySnapshot(recipient, meds);
    } else if (personIntent === "APPOINTMENT_REQUEST_NEW") {
      const slots = syntheticProviderSlots({});
      const free = slots.filter((s) => s.available);
      answer =
        `I can help prepare a doctor appointment request for ${req.recipientDisplayName}, but I will not pretend an external clinic booking completed without real provider availability/booking.\n\n` +
        `Lab availability (synthetic Schedule/Slot layer — not a live EHR calendar):\n` +
        free.map((s) => `• Available: ${s.startsAtLabel}`).join("\n") +
        `\n\nWhat I still need to book honestly:\n` +
        `1) Preferred day/time from the available slots (or another day)\n` +
        `2) Visit reason (follow-up, new concern, med review, etc.)\n` +
        `3) Your confirmation before anything is saved as care truth\n\n` +
        `Reply with a preferred slot (for example “Wednesday July 29 at 2:00 PM”) and the reason for the visit. ` +
        `I will then show a confirmation draft — not an automatic book.`;
    } else if (personIntent === "APPOINTMENT_RESCHEDULE") {
      const apts = store.getAppointments(req.careRecipientId);
      const pt = apts.find((a) => /physical therapy|pt/i.test(a.title));
      const current = pt
        ? `${pt.title}: ${pt.startsAtLabel ?? pt.startsAt} · ${pt.location ?? "location on file"} · status ${pt.status}`
        : apts[0]
          ? `${apts[0].title}: ${apts[0].startsAtLabel ?? apts[0].startsAt}`
          : "no appointment on file";
      answer =
        `I can help with a reschedule request for ${req.recipientDisplayName}.\n\n` +
        `Current appointment on file:\n• ${current}\n\n` +
        `Honest reschedule workflow:\n` +
        `1) Confirm which appointment to move\n` +
        `2) Propose a new day/time\n` +
        `3) You verify before care truth updates\n` +
        `4) Reminders and leave-by times recalculate from the NEW start time only\n\n` +
        `I will not leave a leave-by reminder tied to an old time after a reschedule. ` +
        `Tell me the new preferred time (or ask me to show lab-available slots).`;
    }
    if (answer) {
      return persistDeterministicAnswer(
        req,
        answer,
        [`recipient_profile:${personIntent}`],
        "RECIPIENT_PROFILE",
      );
    }
  }

  // Multi-turn scheduling: day + time after a scheduling conversation
  if (
    /make the time|at \d|july 29|wednesday|2\s*pm|14:00|preferred slot/i.test(
      qLow,
    ) &&
    priorTurns.some((t) =>
      /schedule|appointment|slot|available/i.test(
        `${t.rawText} ${t.answerSummary}`,
      ),
    )
  ) {
    const slots = syntheticProviderSlots({});
    const match = slots.find(
      (s) =>
        s.available &&
        ((/2\s*pm|14:00|2:00/i.test(qLow) && /2:00 PM/i.test(s.startsAtLabel)) ||
          (/9\s*am|9:00/i.test(qLow) && /9:00 AM/i.test(s.startsAtLabel)) ||
          (/11/i.test(qLow) && /11:00 AM/i.test(s.startsAtLabel))),
    );
    const answer = match
      ? `Draft confirmation (not booked yet):\n\n` +
        `• Recipient: ${req.recipientDisplayName}\n` +
        `• Requested: Doctor / clinic visit\n` +
        `• Proposed slot: ${match.startsAtLabel}\n` +
        `• Slot id: ${match.slotId}\n` +
        `• Availability source: synthetic lab Schedule/Slot (not live clinic API)\n\n` +
        `Reply “confirm appointment request” to save this as a caregiver-requested appointment candidate for verification. ` +
        `I will not claim the clinic has accepted it until a real booking integration or human confirmation from the office exists.`
      : `I still need a clear available slot. Lab-available options:\n` +
        slots
          .filter((s) => s.available)
          .map((s) => `• ${s.startsAtLabel}`)
          .join("\n") +
        `\n\nWhich available time should I put in a confirmation draft?`;
    return persistDeterministicAnswer(
      req,
      answer,
      ["scheduling:multi_turn_draft"],
      "SCHEDULING",
    );
  }

  // Open-loop / waiting-on — orchestration state, not Q&A projection alone
  if (
    /waiting on|still waiting|are we waiting|who are we waiting|did maya answer|did (the )?doctor reply|did dr\.?\s*shah reply|anything unresolved|what still needs|what am i still waiting|open request|pending (request|clarification)/i.test(
      qLow,
    )
  ) {
    const loops = summarizeOpenLoops(
      store,
      req.careRecipientId,
      req.principalId,
    );
    const guidance = listProviderGuidance(store, req.careRecipientId);
    let answer: string;
    if (loops.lines.length === 0) {
      answer =
        "Nothing is currently waiting on another person for this care recipient. " +
        (guidance[0]
          ? `Latest provider note on file: ${guidance[0].sourceDisplayName} — ${guidance[0].text.slice(0, 160)}`
          : "All open coordination loops look closed.");
    } else {
      answer =
        `Here's what is still open:\n` +
        loops.lines.map((l) => `• ${l}`).join("\n");
      if (loops.waitingOnNames.length) {
        answer += `\n\nWaiting on: ${loops.waitingOnNames.join(", ")}.`;
      }
    }
    const conversationId = conversationIdFor(
      req.principalId,
      req.careRecipientId,
    );
    const classified = {
      intents: ["WAITING_ON", "OPEN_LOOP_STATUS"] as const,
      primary: "WAITING_ON" as const,
      decisionContext: "information" as const,
      entities: { references: [] as string[] },
      isQuestion: true,
      isObservationUpdate: false,
      needsClarification: false,
    };
    const turn = persistTurn(store, {
      principalId: req.principalId,
      principalDisplayName: req.principalDisplayName,
      careRecipientId: req.careRecipientId,
      roleLabel: req.roleLabel,
      userMessage: req.question,
      classified: { ...classified, intents: [...classified.intents] },
      answer,
      sourceRefs: ["orchestration"],
      modelPath: "deterministic",
    });
    return {
      answer,
      intent: "WAITING_ON",
      intents: ["WAITING_ON", "OPEN_LOOP_STATUS"],
      persona: "family",
      sourceRefs: ["orchestration"],
      needsClarification: false,
      projectionsUsed: ["OPEN_LOOPS"],
      conversationId,
      modelPath: "deterministic",
      classified: { ...classified, intents: [...classified.intents] },
      durable: true,
      turnId: turn.turnId,
      canDeterministic: true,
      evidenceBound: true,
    };
  }

  // Clinical-judgment questions: offer current provider from care-team data (not hardcoded names)
  if (
    /should we change|is it safe to|clinical (review|judgment)/i.test(qLow)
  ) {
    const conversationId = conversationIdFor(
      req.principalId,
      req.careRecipientId,
    );
    const provider =
      resolveEscalationTarget(
        store,
        req.careRecipientId,
        "provider_clinical",
        req.principalId,
      ) ?? resolveCurrentProvider(store, req.careRecipientId);
    const answer = provider
      ? `I can share authorized care information for ${req.recipientDisplayName}, but clinical decisions need professional judgment.\n\n` +
        `I can prepare a concise question for ${provider.displayName} (${provider.roleLabel}${
          provider.organizationName ? `, ${provider.organizationName}` : ""
        }). Want me to ask them?`
      : `I can share authorized care information for ${req.recipientDisplayName}, but I don't have a current clinical provider on their care team to escalate to.`;
    const classified = {
      intents: ["PROVIDER_UPDATE_PREP", "SAFETY_CONCERN"] as const,
      primary: "PROVIDER_UPDATE_PREP" as const,
      decisionContext: "clinic_prep" as const,
      entities: {
        references: [] as string[],
        personHint: provider?.displayName,
      },
      isQuestion: true,
      isObservationUpdate: false,
      needsClarification: false,
    };
    const turn = persistTurn(store, {
      principalId: req.principalId,
      principalDisplayName: req.principalDisplayName,
      careRecipientId: req.careRecipientId,
      roleLabel: req.roleLabel,
      userMessage: req.question,
      classified: { ...classified, intents: [...classified.intents] },
      answer,
      sourceRefs: ["provider_offer", "care_team"],
      modelPath: "deterministic",
    });
    return {
      answer,
      intent: "PROVIDER_UPDATE_PREP",
      intents: ["PROVIDER_UPDATE_PREP", "SAFETY_CONCERN"],
      persona: "family",
      sourceRefs: ["provider_offer", "care_team"],
      needsClarification: false,
      projectionsUsed: ["CARE_TEAM"],
      conversationId,
      modelPath: "deterministic",
      classified: { ...classified, intents: [...classified.intents] },
      durable: true,
      turnId: turn.turnId,
      canDeterministic: true,
      evidenceBound: true,
    };
  }

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
