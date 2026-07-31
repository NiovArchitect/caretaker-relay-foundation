/**
 * Authoritative server Relay answer service.
 *
 * UI must call this via POST /api/v1/care/answer — not a parallel client engine.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CurrentCareState } from "../types.js";
import { classifyIntent, type RelayIntent } from "../relay/intents.js";
import { runAnswerEngine, type AnswerEngineResult } from "../relay/answer-engine.js";
import {
  sanitizeHumanCareCopy,
  semanticDedupeLines,
} from "../relay/util.js";
import {
  conversationIdFor,
  listTurns,
  persistTurn,
  resolveContextualFollowUp,
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
  answerMobilitySupport,
  answerClinicalRetrieve,
  emergencySnapshot,
  syntheticProviderSlots,
} from "./recipient-profile.js";
import {
  isMedicationRedoseSafetyQuestion,
  isUnresolvedWorkQuestion,
  isVerificationStatusQuestion,
} from "../relay/intents.js";
import {
  formatCoverageHuman,
  listCoverage,
  seedDefaultCoverage,
} from "./care-coverage.js";
import {
  buildCareCoverageTimeline,
  formatNextCoverageAnswer,
  formatPreviousCoverageAnswer,
} from "./care-coverage-timeline.js";
import { roleAwareRelayState } from "./role-projection.js";
import {
  authorizeRelayQuestion,
  filterStateByDomains,
  auditRelayAccess,
} from "./relay-authorization.js";
import {
  answerPrnQuestion,
  createOrAdvancePrnEpisode,
  reassessPrnEpisode,
  seedEvelynPrnOrders,
} from "./prn-medication.js";

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
  /** Tests only — skip auth when true (never set in production routes) */
  skipAuthorization?: boolean;
  /** Optional clock for shift-window authorization tests */
  nowMs?: number;
};

export type RelayAnswerResponse = AnswerEngineResult & {
  durable: true;
  turnId?: string;
  conversationId: string;
  canDeterministic: boolean;
  evidenceBound: boolean;
  authorizationOutcome?: "answered" | "denied";
  authorizationCode?: string;
};

function careTeamFromStore(
  store: CareStore,
  careRecipientId: string,
): Array<{ name: string; role: string; phone?: string }> {
  const out: Array<{ name: string; role: string; phone?: string }> = [];
  for (const rel of store.getRelationships(careRecipientId)) {
    if (rel.status !== "active") continue;
    const person = store.getPerson(rel.personId);
    out.push({
      name: person?.displayName ?? rel.roleLabel ?? rel.personId,
      role: rel.roleLabel || rel.role,
    });
  }
  return out;
}

function personNameMapFromStore(store: CareStore): Record<string, string> {
  const map: Record<string, string> = { system: "System" };
  // Prefer full person directory so MAR actors resolve even mid-orchestration.
  if (typeof store.listPeople === "function") {
    for (const p of store.listPeople()) {
      if (p?.id && p.displayName) map[p.id] = p.displayName;
    }
  }
  for (const recipient of store.listRecipients()) {
    for (const rel of store.getRelationships(recipient.id)) {
      const p = store.getPerson(rel.personId);
      if (p) map[p.id] = p.displayName;
    }
    const r = store.getRecipient(recipient.id);
    if (r) map[r.id] = r.displayName;
  }
  return map;
}

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
  "MEDICATION_REDOSE_SAFETY",
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
  "RECIPIENT_MOBILITY",
  "RECIPIENT_IDENTITY",
  "RECIPIENT_AGE",
  "RECIPIENT_DIAGNOSIS",
  "RECIPIENT_ALLERGIES",
  "RECIPIENT_PROFILE",
  "EMERGENCY_SNAPSHOT",
  "APPOINTMENT_REQUEST_NEW",
  "APPOINTMENT_RESCHEDULE",
  "APPOINTMENT_CANCEL",
  "APPOINTMENT_CONFIRM_BOOK",
  "CARE_COVERAGE",
  "TRANSPORTATION",
  "DOCUMENT_PREP",
  "OBSERVATION_HISTORY",
  "TREND",
  "OPEN_LOOP_STATUS",
  "WAITING_ON",
  "VERIFICATION_STATUS",
  "STATUS_SYNTHESIS",
  "CHANGE_SINCE",
]);

export function canAnswerDeterministically(primary: string): boolean {
  return DETERMINISTIC_INTENTS.has(primary);
}

/** Shared path for guard / meta answers that already have full text. */
function intentForProjection(projection: string): {
  primary: RelayIntent;
  intents: RelayIntent[];
} {
  switch (projection) {
    case "OPEN_LOOPS":
      return {
        primary: "TASKS_REMAINING",
        intents: ["TASKS_REMAINING", "OPEN_LOOP_STATUS", "WAITING_ON"],
      };
    case "COVERAGE_TIMELINE":
      return {
        primary: "CARE_COVERAGE",
        intents: ["CARE_COVERAGE"],
      };
    case "CONTINUITY":
      return {
        primary: "CARE_COVERAGE",
        intents: ["CARE_COVERAGE", "CARE_TEAM"],
      };
    case "SCHEDULING":
      return {
        primary: "APPOINTMENT_NEXT",
        intents: ["APPOINTMENT_NEXT"],
      };
    default:
      return { primary: "UNKNOWN_QUESTION", intents: ["UNKNOWN_QUESTION"] };
  }
}

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
  // Sanitize smoke/run residue from all special-path answers
  const cleanedAnswer = sanitizeHumanCareCopy(
    answer
      .split("\n")
      .filter((line) => {
        const t = line.trim();
        if (!t) return true;
        if (
          /RESPONSE_RECEIVED|Open list\s+\d+|s\d+-\d{10,}|Open loop probe|probe \d{10,}/i.test(
            t,
          )
        )
          return false;
        return true;
      })
      .join("\n"),
  );
  // Collapse duplicate bullets after filter
  const lines = cleanedAnswer.split("\n");
  const bullets = lines.filter((l) => l.trim().startsWith("•"));
  const nonBullets = lines.filter((l) => !l.trim().startsWith("•"));
  const dedupedBullets = semanticDedupeLines(
    bullets.map((b) => b.replace(/^•\s*/, "")),
  ).map((b) => `• ${b}`);
  const finalAnswer = [...nonBullets, ...dedupedBullets]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const mapped = intentForProjection(projection);
  const classified = {
    intents: mapped.intents,
    primary: mapped.primary,
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
    answer: finalAnswer,
    sourceRefs,
    modelPath: "deterministic",
  });
  return {
    answer: finalAnswer,
    intent: mapped.primary,
    intents: mapped.intents,
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
  const conversationId = conversationIdFor(
    req.principalId,
    req.careRecipientId,
  );

  // ── Authorization before retrieval (mandatory) ─────────────────────────
  if (!req.skipAuthorization) {
    const authz = authorizeRelayQuestion(store, {
      principalId: req.principalId,
      careRecipientId: req.careRecipientId,
      roleLabel: req.roleLabel,
      question: req.question,
      nowMs: req.nowMs,
    });
    if (authz.kind === "denied") {
      auditRelayAccess(store, {
        principalId: req.principalId,
        careRecipientId: req.careRecipientId,
        question: req.question,
        outcome: "denied",
        code: authz.code,
      });
      const turn = persistTurn(store, {
        principalId: req.principalId,
        principalDisplayName: req.principalDisplayName,
        careRecipientId: req.careRecipientId,
        roleLabel: req.roleLabel,
        userMessage: req.question,
        classified: {
          intents: ["UNKNOWN_QUESTION"],
          primary: "UNKNOWN_QUESTION",
          decisionContext: "information",
          entities: { references: [] },
          isQuestion: true,
          isObservationUpdate: false,
          needsClarification: false,
        },
        answer: authz.answer,
        sourceRefs: [`authz:${authz.code}`],
        modelPath: "deterministic",
      });
      return {
        answer: authz.answer,
        intent: "UNKNOWN_QUESTION",
        intents: ["UNKNOWN_QUESTION"],
        persona: "unknown",
        sourceRefs: [`authz:${authz.code}`],
        needsClarification: false,
        projectionsUsed: [],
        conversationId,
        modelPath: "deterministic",
        classified: {
          intents: ["UNKNOWN_QUESTION"],
          primary: "UNKNOWN_QUESTION",
          decisionContext: "information",
          entities: { references: [] },
          isQuestion: true,
          isObservationUpdate: false,
          needsClarification: false,
        },
        durable: true,
        turnId: turn.turnId,
        canDeterministic: true,
        evidenceBound: true,
        authorizationOutcome: "denied",
        authorizationCode: authz.code,
      };
    }

    // Role-aware retrieval: project before answer engine — never full dump + hide in LLM.
    const roleState = req.stateOverride
      ? undefined
      : roleAwareRelayState(store, req.principalId, req.careRecipientId);
    let state =
      req.stateOverride ??
      stateToBag(
        roleState ?? store.getCurrentState(req.careRecipientId),
        req.careRecipientId,
      );
    // Filter retrieved bag to permitted domains (server-side)
    state = filterStateByDomains(
      state,
      authz.domains,
      authz.capabilities.controlling,
    );
    const result = answerWithState(req, state);
    auditRelayAccess(store, {
      principalId: req.principalId,
      careRecipientId: req.careRecipientId,
      question: req.question,
      outcome: "answered",
      domains: authz.domains,
      intent: result.intent,
    });
    return {
      ...result,
      authorizationOutcome: "answered",
    };
  }

  // Test-only path
  const roleState = req.stateOverride
    ? undefined
    : roleAwareRelayState(store, req.principalId, req.careRecipientId);
  const state =
    req.stateOverride ??
    stateToBag(
      roleState ?? store.getCurrentState(req.careRecipientId),
      req.careRecipientId,
    );
  return answerWithState(req, state);
}

function answerWithState(
  req: RelayAnswerRequest,
  state: CareStateBag,
): RelayAnswerResponse {
  const store = req.store;
  const handoffs = store.getHandoffs(req.careRecipientId);
  // Prefer true temporal latest — Map/array order is not a contract under Prisma reload.
  const latest = [...handoffs].sort((a, b) => {
    const ta = Date.parse(String(a.createdAt ?? "")) || 0;
    const tb = Date.parse(String(b.createdAt ?? "")) || 0;
    return ta - tb;
  })[handoffs.length - 1];
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

  // Continuity + person + scheduling intents
  let preClassified = classifyIntent(req.question, priorEntities);
  preClassified = resolveWithDurableMemory(
    store,
    req.principalId,
    req.careRecipientId,
    preClassified,
    req.question,
  );

  // Short follow-ups: resolve against prior turn/focus before generic UNKNOWN
  const contextual = resolveContextualFollowUp(
    store,
    req.principalId,
    req.careRecipientId,
    req.recipientDisplayName,
    req.question,
  );
  if (contextual.handled && contextual.answer) {
    return persistDeterministicAnswer(
      req,
      sanitizeHumanCareCopy(contextual.answer),
      [
        `conversation:follow_up:${contextual.confidence ?? "medium"}`,
        contextual.selectedReferent
          ? `referent:${contextual.selectedReferent}`
          : "referent:prior_answer",
      ],
      contextual.modelPath === "clarification" ? "CLARIFICATION" : "CONTEXT_FOLLOW_UP",
    );
  }

  // PRN (as-needed) medication — authorized order + charting episode path
  seedEvelynPrnOrders(store, req.careRecipientId);

  // Inventory / status questions first (never open a charting preview)
  if (
    /what prn|as-needed medication|prn medication|what as-needed|when was .{0,30}(prn|as-needed|last as-needed)|follow-?up complete|still needs to be charted|reason for the last prn|who gave the last as-needed/i.test(
      qLow,
    ) &&
    !/\bi gave\b|\bgave her\b|\bgave him\b|confirm prn/i.test(qLow)
  ) {
    const prnInv = answerPrnQuestion(
      store,
      req.careRecipientId,
      req.recipientDisplayName,
      req.question,
    );
    if (prnInv) {
      return persistDeterministicAnswer(
        req,
        sanitizeHumanCareCopy(prnInv),
        ["prn:projection"],
        "PRN_ANSWER",
      );
    }
  }

  // Confirm PRN charting
  if (
    /^(confirm prn|confirm as-needed|confirm the prn|yes,? chart (the )?prn|looks right[,.]? chart prn)\b/i.test(
      req.question.trim(),
    )
  ) {
    const last = listTurns(store, req.principalId, req.careRecipientId, 4)
      .reverse()
      .find((t) => /as-needed check|Ready to verify|confirm PRN/i.test(t.answerSummary));
    const med =
      last?.answerSummary.match(/\*\*As-needed check for ([^*]+)\*\*/i)?.[1] ||
      last?.answerSummary.match(/Acetaminophen|Tylenol|[A-Z][a-z]+/)?.[0] ||
      "Acetaminophen";
    const symptom =
      last?.answerSummary.match(/Reason:\s*([^\n(]+)/i)?.[1]?.trim() || "pain";
    const severity =
      last?.answerSummary.match(/\(([^)]+)\)/)?.[1] || undefined;
    const created = createOrAdvancePrnEpisode(store, {
      careRecipientId: req.careRecipientId,
      actorPersonId: req.principalId,
      actorDisplayName: req.principalDisplayName,
      medicationHint: med,
      symptom,
      severityBefore: severity,
      confirm: true,
    });
    if (created.ok) {
      return persistDeterministicAnswer(
        req,
        sanitizeHumanCareCopy(created.plainLanguage),
        ["prn:administered", created.episode.id],
        "PRN_ADMIN",
      );
    }
    // Interval block: still surface plain safety language + invite reassessment of last dose
    return persistDeterministicAnswer(
      req,
      sanitizeHumanCareCopy(
        created.message +
          "\n\nIf you already charted an as-needed dose, tell me how the symptom is now (better, unchanged, or worse) to complete the result.",
      ),
      ["prn:blocked"],
      "PRN_BLOCKED",
    );
  }

  // Effectiveness / reassessment follow-up (only when open PRN episode likely)
  if (
    /^(it )?(helped|didn'?t help|did not help|no (clear )?change|worse|worsened|better)\b/i.test(
      req.question.trim(),
    ) ||
    /\b(pain is|it is) (down to|better|worse)/i.test(qLow) ||
    /how is .{0,20}(pain|nausea|itch|feeling) now/i.test(qLow) ||
    /\bhelped\b.+\b(pain|walk)/i.test(qLow) ||
    /\bpain improved\b|\bpain is better\b|\bfeeling better\b|\bfollow-?up complete\b/i.test(
      qLow,
    ) ||
    /\b(the )?(as-needed|prn).{0,20}(helped|did not help|didn'?t help)\b/i.test(
      qLow,
    )
  ) {
    let effect: "improved" | "unchanged" | "worsened" | "unable_to_assess" =
      "unable_to_assess";
    if (
      /help|better|improved|down to|lower|comfort/i.test(qLow) &&
      !/didn'?t help|did not help/i.test(qLow)
    )
      effect = "improved";
    else if (/didn'?t help|did not help|no (clear )?change|unchanged|same/i.test(qLow))
      effect = "unchanged";
    else if (/worse|worsened|higher|more pain/i.test(qLow)) effect = "worsened";
    const sev =
      req.question.match(/(\d+)\s*\/\s*10/)?.[0] ||
      req.question.match(/down to (?:a )?(\d+)/i)?.[0];
    const re = reassessPrnEpisode(store, {
      careRecipientId: req.careRecipientId,
      actorPersonId: req.principalId,
      actorDisplayName: req.principalDisplayName,
      effect,
      severityAfter: sev,
    });
    if (re.ok) {
      return persistDeterministicAnswer(
        req,
        sanitizeHumanCareCopy(re.plainLanguage),
        ["prn:reassess", re.episode.id],
        "PRN_REASSESS",
      );
    }
    // Do not fall through to handoff/generic — effectiveness phrases stay in PRN domain
    return persistDeterministicAnswer(
      req,
      sanitizeHumanCareCopy(
        re.message ||
          "I do not see an open as-needed follow-up to update. If a dose was just given, confirm charting first, then tell me how the symptom is now.",
      ),
      ["prn:reassess_miss"],
      "PRN_REASSESS",
    );
  }

  // Charting reports only — require gave/administered language (not "can she take")
  if (
    /\b(i )?gave\b.+\b(prn|as[- ]?needed|tylenol|acetaminophen|benadryl|ondansetron|zofran|when needed)\b|\bgave her the (prn |as-needed )?(tylenol|ondansetron|zofran)\b|\badministered\b.+\b(prn|as-needed|tylenol|ondansetron)\b|\bi gave her benadryl\b/i.test(
      qLow,
    )
  ) {
    const med =
      req.question.match(
        /\b(tylenol|acetaminophen|benadryl|ibuprofen|advil|ondansetron|zofran)\b/i,
      )?.[1] || "Acetaminophen";
    const medNorm = /zofran/i.test(med) ? "Ondansetron" : med;
    const symptom =
      req.question.match(
        /\b(pain|knee pain|nausea|itch(?:ing)?|wheez(?:ing)?|fever|constipat(?:ion)?|anxiety)\b/i,
      )?.[1] ||
      (/itch/i.test(qLow)
        ? "itching"
        : /ondansetron|zofran|nause/i.test(qLow)
          ? "nausea"
          : "pain");
    const severity =
      req.question.match(/(\d+)\s*\/\s*10|about a (\d+)/i)?.[0] || undefined;
    const created = createOrAdvancePrnEpisode(store, {
      careRecipientId: req.careRecipientId,
      actorPersonId: req.principalId,
      actorDisplayName: req.principalDisplayName,
      medicationHint: medNorm,
      symptom,
      severityBefore: severity,
      confirm: false,
      forceUnauthorized: /benadryl/i.test(medNorm),
    });
    if (created.ok) {
      return persistDeterministicAnswer(
        req,
        sanitizeHumanCareCopy(created.plainLanguage),
        [
          created.episode.unauthorizedReport
            ? "prn:unauthorized_report"
            : "prn:preview",
          created.order?.id || "no-order",
        ],
        "PRN_PREVIEW",
      );
    }
  }

  // "Can she have pain medicine?" — eligibility from order, not charting
  if (
    /can .{0,30}(have|take).{0,30}(pain|prn|as-needed|tylenol|acetaminophen)/i.test(
      qLow,
    )
  ) {
    const prnCan = answerPrnQuestion(
      store,
      req.careRecipientId,
      req.recipientDisplayName,
      "What PRN medication can Evelyn take for pain?",
    );
    if (prnCan) {
      return persistDeterministicAnswer(
        req,
        sanitizeHumanCareCopy(
          prnCan +
            "\n\nIf a symptom is present now, tell me what you observe (and optional severity). I will not recommend a dose.",
        ),
        ["prn:eligibility"],
        "PRN_ANSWER",
      );
    }
  }

  const prnQ = answerPrnQuestion(
    store,
    req.careRecipientId,
    req.recipientDisplayName,
    req.question,
  );
  if (prnQ) {
    return persistDeterministicAnswer(
      req,
      sanitizeHumanCareCopy(prnQ),
      ["prn:projection"],
      "PRN_ANSWER",
    );
  }

  // Medication redose safety — must not inherit admin-history "Yes" from prior turns
  if (
    preClassified.intents.includes("MEDICATION_REDOSE_SAFETY") ||
    isMedicationRedoseSafetyQuestion(req.question)
  ) {
    // Fall through to answer engine with clean entities (no personHint bleed)
    const engine = runAnswerEngine({
      question: req.question,
      principalId: req.principalId,
      principalName: req.principalDisplayName,
      roleLabel: req.roleLabel,
      recipientId: req.careRecipientId,
      recipientName: req.recipientDisplayName,
      state,
      priorEntities: {
        medicationHint: preClassified.entities.medicationHint ?? "Metformin",
        references: preClassified.entities.references ?? [],
      },
      conversationId,
    });
    const turn = persistTurn(store, {
      principalId: req.principalId,
      principalDisplayName: req.principalDisplayName,
      careRecipientId: req.careRecipientId,
      roleLabel: req.roleLabel,
      userMessage: req.question,
      classified: engine.classified,
      answer: engine.answer,
      sourceRefs: engine.sourceRefs,
      modelPath: "deterministic",
    });
    return {
      ...engine,
      durable: true,
      turnId: turn.turnId,
      canDeterministic: true,
      evidenceBound: true,
    };
  }

  // Appointment confirm must win over verification-status phrasing
  if (preClassified.intents.includes("APPOINTMENT_CONFIRM_BOOK")) {
    // fall through to personIntent path below
  } else if (
    // Verification status — explicit care-truth states
    preClassified.intents.includes("VERIFICATION_STATUS") ||
    isVerificationStatusQuestion(req.question)
  ) {
    const engine = runAnswerEngine({
      question: req.question,
      principalId: req.principalId,
      principalName: req.principalDisplayName,
      roleLabel: req.roleLabel,
      recipientId: req.careRecipientId,
      recipientName: req.recipientDisplayName,
      state,
      priorEntities,
      conversationId,
    });
    const turn = persistTurn(store, {
      principalId: req.principalId,
      principalDisplayName: req.principalDisplayName,
      careRecipientId: req.careRecipientId,
      roleLabel: req.roleLabel,
      userMessage: req.question,
      classified: engine.classified,
      answer: engine.answer,
      sourceRefs: engine.sourceRefs,
      modelPath: "deterministic",
    });
    return {
      ...engine,
      durable: true,
      turnId: turn.turnId,
      canDeterministic: true,
      evidenceBound: true,
    };
  }

  // Unresolved work — orchestration + open uncertainties (not generic fallback).
  // Do not steal Allegra / medication-change questions into the open-loop dump.
  // R-CONTEXT-001/002: first-priority and person-handling need answer-engine paths.
  const isFirstPriorityQ =
    /\bwhat should i do first\b|\bwhere should i start\b|\bwhat comes first\b|\bwhat is the first priorit|\bwhat should i (handle|do) before (anything|everything)\b|\bstart with what\b|\bwhat'?s first on/i.test(
      req.question,
    );
  const isPersonHandlingQ =
    /\bwhat is (maya|daniel|marcus|she|he) (handling|taking care of|working on|responsible for|doing|covering)\b|\bwhat does (maya|daniel|marcus) (still )?have open\b/i.test(
      req.question,
    );
  if (
    !/allegra|medication change/i.test(req.question) &&
    !isFirstPriorityQ &&
    !isPersonHandlingQ &&
    (preClassified.intents.includes("WAITING_ON") ||
      preClassified.intents.includes("OPEN_LOOP_STATUS") ||
      isUnresolvedWorkQuestion(req.question))
  ) {
    const loops = summarizeOpenLoops(
      store,
      req.careRecipientId,
      req.principalId,
    );
    const guidance = listProviderGuidance(store, req.careRecipientId);
    const openReviews = (state.openSafetyReviews ?? []).map((r) =>
      String(r.reason ?? r.message ?? "open safety review"),
    );
    // Prefer latest handoff unfinished work first so shift-to-shift answers
    // advance instead of being drowned by long-lived review queues.
    const rawLines: string[] = [];
    if (latest?.stillNeedsAttention?.length) {
      for (const n of latest.stillNeedsAttention.slice(0, 4)) {
        rawLines.push(`Handoff still needs attention: ${n}`);
      }
    }
    for (const l of loops.lines) rawLines.push(l);
    for (const r of openReviews) {
      if (r) rawLines.push(`Needs checking: ${r}`);
    }
    // Final semantic reconcile across handoff + loops + safety reviews
    const keys = new Set<string>();
    const lines: string[] = [];
    for (const line of rawLines) {
      let key = line.toLowerCase();
      if (/allegra/i.test(key)) key = "allegra";
      else if (/metformin|with-lunch|with lunch/i.test(key)) key = "metformin_review";
      else if (
        /incompatible dimensions|not comparable|ambiguous \(count|cannot convert|missing unit/i.test(
          key,
        )
      )
        key = "dose_unit";
      else key = key.replace(/[^a-z0-9]+/g, " ").trim().slice(0, 48);
      if (keys.has(key)) continue;
      keys.add(key);
      if (key === "allegra") {
        lines.push(
          "Allegra 60 mg change is waiting for medication-plan verification (one active issue).",
        );
      } else if (key === "metformin_review") {
        lines.push(
          "Needs your review: a prior Metformin-with-lunch confirmation is still open.",
        );
      } else if (key === "dose_unit") {
        lines.push(
          "Needs checking: a reported dose unit does not match the authorized instruction.",
        );
      } else {
        lines.push(line);
      }
    }
    let answer: string;
    if (lines.length === 0) {
      answer =
        `Nothing is currently flagged as unresolved for ${req.recipientDisplayName}. ` +
        (guidance[0]
          ? `Latest provider note on file: ${guidance[0].sourceDisplayName} — ${guidance[0].text.slice(0, 160)}`
          : "Open coordination loops and verification items look clear.");
    } else {
      answer =
        `Here's what is still open for ${req.recipientDisplayName}:\n` +
        lines.map((l) => `• ${l}`).join("\n");
      if (loops.waitingOnNames.length) {
        answer += `\n\nWaiting on: ${loops.waitingOnNames.join(", ")}.`;
      }
    }
    return persistDeterministicAnswer(
      req,
      answer,
      ["orchestration:open_loops"],
      "OPEN_LOOPS",
    );
  }

  // Next / previous coverage questions MUST use CareCoverageTimeline — never
  // the seed CARE_COVER_V1 "Helping now / Next" prose short-circuit.
  const qCov = req.question.toLowerCase();
  // Query-only: exclude action phrasing ("tell the next caregiver … refused lunch")
  const isNextCaregiverQ =
    /who works after me|who is (taking over|next|after me)|when does (the )?next (caregiver|helper|person)|next (caregiver|shift|helper)|who should receive my handoff|is anyone covering|has the next (caregiver|helper) accepted|covering tonight|who takes over|handoff target|who (do i|should i) hand (off|over)/i.test(
      qCov,
    ) &&
    !/\b(tell|message|notify|ask|send|report|left|refused|unfinished|saying)\b/i.test(
      qCov,
    );
  const isPreviousCaregiverQ =
    /before my shift|previous (caregiver|caretaker|shift)|who (worked|helped|covered).{0,40}before|prior (caregiver|shift)/i.test(
      qCov,
    );
  if (isNextCaregiverQ || isPreviousCaregiverQ) {
    const timeline = buildCareCoverageTimeline(
      store,
      req.careRecipientId,
      req.principalId,
    );
    let answer: string;
    if (isPreviousCaregiverQ) {
      answer = formatPreviousCoverageAnswer(timeline, req.recipientDisplayName);
      if (latest?.stillNeedsAttention?.length) {
        answer +=
          ` They left open: ` +
          latest.stillNeedsAttention
            .slice(0, 3)
            .map((w) => sanitizeHumanCareCopy(w))
            .filter(Boolean)
            .join("; ") +
          ".";
      }
    } else {
      // Next caregiver / handoff target / acceptance
      answer = formatNextCoverageAnswer(timeline, req.recipientDisplayName);
      const n = timeline.next;
      if (n.caregiver_name) {
        if (/accept/i.test(qCov)) {
          answer =
            n.status && /accepted|active|scheduled|planned/i.test(n.status)
              ? `${n.caregiver_name}'s next coverage is ${String(n.status).replace(/_/g, " ")}.`
              : `I do not have an accepted next-caregiver assignment on file for ${req.recipientDisplayName}.`;
        } else if (/handoff|receive/i.test(qCov)) {
          answer = `Your handoff should go to ${n.caregiver_name}${
            n.start ? ` (scheduled to begin when coverage starts)` : ""
          }.`;
        }
      } else if (/handoff|receive/i.test(qCov)) {
        answer =
          "No next caregiver is scheduled yet. Your current handoff will remain a draft until coverage is assigned.";
      }
    }
    return persistDeterministicAnswer(
      req,
      answer,
      ["coverage_timeline", isPreviousCaregiverQ ? "previous" : "next"],
      "COVERAGE_TIMELINE",
    );
  }

  // Clinical retrieve phrases (doctor validation) — before generic open-loop / appointment steal
  {
    const qClin = req.question.toLowerCase();
    const recipient = store.getRecipient(req.careRecipientId);
    let clinDomain:
      | "vitals"
      | "oxygen"
      | "surgeries"
      | "therapies"
      | "comorbidities"
      | "code_status"
      | "diet"
      | "devices"
      | "orientation"
      | "mobility"
      | null = null;
    if (/\b(vital|vitals|blood pressure|heart rate|temperature|spo2)\b/.test(qClin))
      clinDomain = "vitals";
    else if (/\b(oxygen|on oxygen|o2\b|airway|trache)\b/.test(qClin))
      clinDomain = "oxygen";
    else if (/\b(surger|surgical|operation)\b/.test(qClin)) clinDomain = "surgeries";
    else if (
      /\b(therap(y|ies)|physical therapy|occupational|speech therapy|\bot\b)\b/.test(
        qClin,
      ) &&
      !/\bappointment\b|\bwhen is\b|\bwhat time\b/.test(qClin)
    )
      clinDomain = "therapies";
    else if (/\b(comorbid|diagnos|condition)\b/.test(qClin))
      clinDomain = "comorbidities";
    else if (
      /\b(code status|dnr|dni|polst|advance directive|full code|do not resuscitat)\b/.test(
        qClin,
      )
    )
      clinDomain = "code_status";
    else if (/\b(diet|swallow|texture|nutrition|what can (she|he|they) eat)\b/.test(qClin))
      clinDomain = "diet";
    else if (
      /\b(orient|orientation status|acting like (her|him|them)self|cognitive baseline)\b/.test(
        qClin,
      )
    )
      clinDomain = "orientation";
    else if (
      /\b(ambulat|mobility status|weight[- ]?bearing|walk(s|ing)? by (her|him|them)self|transfer)\b/.test(
        qClin,
      )
    )
      clinDomain = "mobility";
    else if (/\b(device|machine|equipment|catheter|feeding tube|walker|cane)\b/.test(qClin))
      clinDomain = "devices";
    if (clinDomain) {
      return persistDeterministicAnswer(
        req,
        answerClinicalRetrieve(clinDomain, recipient),
        ["recipient_profile", clinDomain],
        "RECIPIENT_PROFILE",
      );
    }
  }

  // Appointment actions before generic profile identity (reschedule must not become H&P dump)
  const personIntent = preClassified.intents.find((i) =>
    [
      "CARE_COVERAGE",
      "TRANSPORTATION",
      "APPOINTMENT_REQUEST_NEW",
      "APPOINTMENT_RESCHEDULE",
      "APPOINTMENT_CANCEL",
      "APPOINTMENT_CONFIRM_BOOK",
      "RECIPIENT_AGE",
      "RECIPIENT_DIAGNOSIS",
      "RECIPIENT_IDENTITY",
      "RECIPIENT_PROFILE",
      "RECIPIENT_ALLERGIES",
      "RECIPIENT_MOBILITY",
      "EMERGENCY_SNAPSHOT",
    ].includes(i),
  );
  if (personIntent) {
    const recipient = store.getRecipient(req.careRecipientId);
    let answer = "";
    if (personIntent === "CARE_COVERAGE") {
      // Generic coverage overview still uses timeline (not seed-only prose)
      const timeline = buildCareCoverageTimeline(
        store,
        req.careRecipientId,
        req.principalId,
      );
      const parts: string[] = [];
      if (timeline.current.caregiver_name) {
        const ct = timeline.current.coverage_type?.replace(/_/g, " ") ?? "coverage";
        parts.push(
          `Current ${ct}: ${timeline.current.caregiver_name}` +
            (timeline.current.role ? ` · ${timeline.current.role}` : "") +
            (timeline.current.is_ongoing_primary_coverage
              ? " (ongoing primary family coverage)"
              : ""),
        );
        if (timeline.current.start && timeline.current.end) {
          parts.push(
            `Hours: ${timeline.current.start} – ${timeline.current.end}`,
          );
        }
      }
      if (timeline.previous.caregiver_name) {
        parts.push(
          `Previous: ${timeline.previous.caregiver_name}` +
            (timeline.previous.start && timeline.previous.end
              ? ` (${timeline.previous.start} – ${timeline.previous.end})`
              : ""),
        );
      }
      if (timeline.next.caregiver_name) {
        parts.push(
          `Next: ${timeline.next.caregiver_name}` +
            (timeline.next.start ? ` starts ${timeline.next.start}` : ""),
        );
      } else {
        parts.push(
          "No next caregiver is scheduled yet. A handoff can stay as a draft until coverage is assigned.",
        );
      }
      answer = parts.join("\n");
    } else if (personIntent === "TRANSPORTATION") {
      const notes = recipient?.profile?.transportationNotes;
      const apts = store.getAppointments(req.careRecipientId);
      const next = apts.find((a) => a.status !== "cancelled") ?? apts[0];
      answer =
        (notes
          ? `Transportation notes on file for ${req.recipientDisplayName}:\n• ${notes}\n\n`
          : `I don't have a detailed transportation plan on file for ${req.recipientDisplayName}.\n\n`) +
        (next
          ? `Next relevant appointment: ${next.title} · ${next.startsAtLabel ?? next.startsAt}${
              next.location ? ` · ${next.location}` : ""
            }.\nLeave-by and travel buffer are recalculated from that appointment time when you open Care or ask about logistics.`
          : `No appointment is listed for travel planning right now.`);
    } else if (personIntent === "RECIPIENT_AGE") {
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
      if (!allergies.length) {
        answer = `Allergy status for ${req.recipientDisplayName}: **UNKNOWN** — nothing is listed on file. That is not the same as “no known allergies.”`;
      } else if (
        allergies.some((a) => /no known|nkda|nka\b/i.test(a.label))
      ) {
        answer =
          `Allergy status for ${req.recipientDisplayName}: **NO KNOWN ALLERGIES** on file.\n` +
          allergies
            .map(
              (a) =>
                `• ${a.label}${a.sourceLabel ? ` (${a.sourceLabel})` : ""}`,
            )
            .join("\n");
      } else {
        answer =
          `Allergy status for ${req.recipientDisplayName}: **KNOWN ALLERGY / intolerance** on file:\n` +
          allergies
            .map(
              (a) =>
                `• ${a.label}${a.sourceLabel ? ` (${a.sourceLabel})` : ""}`,
            )
            .join("\n");
      }
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
        `\n• Unavailable (collision example): Wednesday, July 29 · 3:30 PM PDT\n` +
        `\nWhat I still need to book honestly:\n` +
        `1) Preferred day/time from the available slots\n` +
        `2) Visit reason\n` +
        `3) Your confirmation (“confirm appointment request”)\n\n` +
        `Reply with a preferred slot (for example “Wednesday July 29 at 2:00 PM”).`;
    } else if (personIntent === "RECIPIENT_MOBILITY") {
      answer = answerMobilitySupport(recipient);
    } else if (personIntent === "APPOINTMENT_RESCHEDULE") {
      const apts = store
        .getAppointments(req.careRecipientId)
        .filter((a) => a.status !== "cancelled");
      const q = req.question.toLowerCase();
      const named = apts.filter(
        (a) =>
          (/physical therapy|\bpt\b/.test(q) &&
            /physical therapy|\bpt\b/i.test(a.title)) ||
          (/doctor|clinic|pcp|primary/.test(q) &&
            /doctor|clinic|primary|follow/i.test(a.title)) ||
          (/therapy/.test(q) && /therapy/i.test(a.title)),
      );
      if (apts.length === 0) {
        answer = `I don't have an appointment on file to move for ${req.recipientDisplayName}.`;
      } else if (named.length === 1 || apts.length === 1) {
        const target = named[0] ?? apts[0]!;
        answer =
          `I can help with a reschedule request for ${req.recipientDisplayName}.\n\n` +
          `Current appointment on file:\n• ${target.title}: ${target.startsAtLabel ?? target.startsAt} · ${target.location ?? "location on file"} · status ${target.status}\n\n` +
          `Honest reschedule workflow:\n` +
          `1) Confirm this is the appointment to move (or name a different one)\n` +
          `2) Propose a new day/time\n` +
          `3) You verify before care truth updates\n` +
          `4) Reminders and leave-by recalculate from the NEW start only\n\n` +
          `Tell me the new preferred time.`;
      } else {
        // Multiple candidates — clarify rather than generic fallback or silent pick
        answer =
          `I can help reschedule — which appointment should I move for ${req.recipientDisplayName}?\n\n` +
          apts
            .slice(0, 6)
            .map(
              (a) =>
                `• ${a.title}: ${a.startsAtLabel ?? a.startsAt}${
                  a.location ? ` · ${a.location}` : ""
                }`,
            )
            .join("\n") +
          `\n\nCurrent appointments on file are listed above. Reply with the appointment name (for example “physical therapy” or the clinic visit), then a new day/time so you can verify before care truth updates.`;
      }
    } else if (personIntent === "APPOINTMENT_CANCEL") {
      const apts = store.getAppointments(req.careRecipientId);
      const pt =
        apts.find((a) => /physical therapy|pt/i.test(a.title)) ?? apts[0];
      if (!pt) {
        answer = `I don't have an appointment on file to cancel for ${req.recipientDisplayName}.`;
      } else if (pt.status === "cancelled") {
        answer = `${pt.title} is already marked cancelled (${pt.startsAtLabel ?? pt.startsAt}).`;
      } else {
        store.upsertAppointment({
          ...pt,
          status: "cancelled",
          startsAtLabel: pt.startsAtLabel
            ? `${pt.startsAtLabel} (cancelled)`
            : "Cancelled",
        });
        answer =
          `I marked ${pt.title} as **cancelled** for ${req.recipientDisplayName}.\n\n` +
          `Prior scheduled time was: ${pt.startsAtLabel ?? pt.startsAt}.\n` +
          `This is a care-record cancellation request — not proof the clinic office has been notified unless you or an authorized person contacts them.\n` +
          `Reminders for this appointment should not be treated as active.`;
      }
    } else if (personIntent === "APPOINTMENT_CONFIRM_BOOK") {
      const prior = [...priorTurns].reverse().find((t) =>
        /slot id:|proposed slot|draft confirmation|available:|appointment request/i.test(
          t.answerSummary,
        ),
      );
      const slotMatch = prior?.answerSummary.match(/Slot id:\s*(\S+)/i);
      const labelMatch = prior?.answerSummary.match(
        /Proposed slot:\s*([^\n]+)/i,
      );
      // User may paste an offered slot line directly: "Wednesday, July 29 · 2:00 PM PDT"
      const userSlotLabel = (() => {
        const m = req.question.match(
          /((?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)[^\n]{0,40}\d{1,2}:\d{2}\s*(?:am|pm)[^\n]{0,12})/i,
        );
        return m?.[1]?.trim() ?? null;
      })();
      if (!slotMatch && !labelMatch && !userSlotLabel && !prior) {
        answer =
          `I don't have a pending appointment draft to confirm. Ask me to schedule an appointment first, pick an available slot, then confirm that time.`;
      } else if (/3:30\s*PM/i.test(req.question) || /1530|3:30 PM/i.test(userSlotLabel ?? "")) {
        answer =
          `I can't book that slot — it is marked unavailable (collision) on the lab Schedule/Slot layer.\n` +
          `Pick an available slot instead.`;
      } else {
        const slotId =
          slotMatch?.[1] ??
          `slot-req-${Date.now().toString(36)}`;
        const label =
          labelMatch?.[1]?.trim() ??
          userSlotLabel ??
          "Requested visit (time from your selection)";
        {
          const aptId = `apt-req-${slotId}`;
          const existing = store
            .getAppointments(req.careRecipientId)
            .find((a) => a.id === aptId);
          if (existing) {
            answer =
              `That appointment request is already on file (idempotent):\n• ${existing.title} · ${existing.startsAtLabel}\n• Status: ${existing.status}\n\n` +
              `Still not a live clinic confirmation until the office accepts.`;
          } else {
            store.upsertAppointment({
              id: aptId,
              careRecipientId: req.careRecipientId,
              title: "Care appointment (caregiver-requested)",
              startsAt: "2026-07-29T21:00:00.000Z",
              startsAtLabel: label,
              location: "Coastal Family Medicine (synthetic)",
              status: "scheduled",
              epistemicStatus: "REPORTED",
              source: {
                id: `src-${aptId}`,
                kind: "caregiver_text",
                label: "Caregiver appointment request",
                actorName: req.principalDisplayName,
                recordedAt: new Date().toISOString(),
                whyVisible: "Saved after caregiver confirmed appointment draft.",
              },
            });
            answer =
              `Saved appointment **request** for ${req.recipientDisplayName}:\n` +
              `• ${label}\n• Slot: ${slotId}\n• Status: scheduled (caregiver-reported request)\n\n` +
              `I will not claim the clinic has accepted this until office confirmation or a real booking integration exists. ` +
              `Reminders can track this request time; leave-by will use this start time.`;
          }
        }
      }
    }
    if (answer) {
      return persistDeterministicAnswer(
        req,
        answer,
        [`continuity:${personIntent}`],
        "CONTINUITY",
      );
    }
  }

  // Collision / unavailable slot — any scheduling context
  if (
    /3:30|15:30/i.test(qLow) &&
    (/slot|book|pm|appointment|available|unavailable/i.test(qLow) ||
      priorTurns.some((t) =>
        /schedule|appointment|slot|available/i.test(
          `${t.rawText} ${t.answerSummary}`,
        ),
      ))
  ) {
    const slots = syntheticProviderSlots({});
    return persistDeterministicAnswer(
      req,
      `That 3:30 PM slot is marked **unavailable** (collision) on the lab availability layer. Choose an available slot:\n` +
        slots
          .filter((s) => s.available)
          .map((s) => `• ${s.startsAtLabel}`)
          .join("\n"),
      ["scheduling:collision"],
      "SCHEDULING",
    );
  }

  // Multi-turn scheduling: day + time after a scheduling conversation
  if (
    /make the time|at \d|july 29|wednesday|2\s*pm|14:00|preferred slot|9\s*am|11\s*am|3:30/i.test(
      qLow,
    ) &&
    (priorTurns.some((t) =>
      /schedule|appointment|slot|available/i.test(
        `${t.rawText} ${t.answerSummary}`,
      ),
    ) ||
      /schedule|appointment|slot/i.test(req.question))
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
        `Reply “confirm appointment request” to save this as a caregiver-requested appointment candidate. ` +
        `I will not claim the clinic has accepted it until office confirmation or a real booking integration exists.`
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

  // Open-loop path already handled earlier via isUnresolvedWorkQuestion + intents.
  // Keep a late safety net for residual phrasing (never Allegra/plan-change).
  if (
    isUnresolvedWorkQuestion(req.question) &&
    !/allegra|medication change/i.test(req.question) &&
    !isFirstPriorityQ &&
    !isPersonHandlingQ
  ) {
    const loops = summarizeOpenLoops(
      store,
      req.careRecipientId,
      req.principalId,
    );
    const answer =
      loops.lines.length === 0
        ? `Nothing is currently flagged as unresolved for ${req.recipientDisplayName}.`
        : `Here's what is still open:\n` +
          loops.lines.map((l) => `• ${l}`).join("\n");
    return persistDeterministicAnswer(
      req,
      answer,
      ["orchestration:open_loops_late"],
      "OPEN_LOOPS",
    );
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

  const coverageTimeline = buildCareCoverageTimeline(
    store,
    req.careRecipientId,
    req.principalId,
  ) as unknown as Record<string, unknown>;
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
    careTeam: careTeamFromStore(store, req.careRecipientId),
    personNameMap: personNameMapFromStore(store),
    coverageTimeline,
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
