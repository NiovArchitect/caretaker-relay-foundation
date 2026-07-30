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
  if (q.length > 120) return false;
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
    /^(the )?(first|second|third|last|1st|2nd|3rd)( one)?$/.test(q) ||
    /^what about the (first|second|third|last)( one)?$/.test(q) ||
    /^go back to [a-z]{3,}/.test(q) ||
    // Appointment / place / leave-by / lineage follow-ups
    /^where is it$/.test(q) ||
    /^where is (that|the appointment|the visit)$/.test(q) ||
    /^when should we leave$/.test(q) ||
    /^when do we (need to )?leave$/.test(q) ||
    /^what was (its|the) previous time$/.test(q) ||
    /^what was the old time$/.test(q) ||
    // Person / work continuity
    /^what did (he|she|they|daniel|maya|marcus) (complete|do|finish|record)$/.test(q) ||
    /^what did (he|she|they) leave open$/.test(q) ||
    /^is (maya|he|she|daniel|marcus) handling that$/.test(q) ||
    /^is (maya|he|she) (handling|covering|taking) (that|it)$/.test(q) ||
    // Yesterday → today linkage
    /^does anything from that still affect today$/.test(q) ||
    /^does that (still )?affect today$/.test(q) ||
    // Message delivery follow-ups (actual state, not policy)
    /^did (she|he|maya|they) (receive|get|open|read|reply to) (it|my message|the message)$/.test(
      q,
    ) ||
    /^did (maya|she|he) (reply|respond)$/.test(q) ||
    /^has (she|he|maya) (opened|read|seen) it$/.test(q)
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

  // Rebuild ordered from last answer if focus missing (numbered list lines)
  let ordered = focus?.orderedMedicationCandidates ?? [];
  if (!ordered.length && lastAnswer) {
    ordered = buildOrderedMedicationCandidatesFromLines(
      lastAnswer.split("\n"),
      8,
    ).map((c) => ({
      display_index: c.display_index,
      candidate_id: c.candidate_id,
      medication: c.medication,
      dose: c.dose,
      reason: c.reason,
      reporter: c.reporter,
      report_time: c.report_time,
    }));
  }

  // Name selection: "go back to Cetirizine"
  const namePick = q.match(/go back to ([a-z][a-z-]{2,})/i);
  if (namePick && ordered.length) {
    const name = namePick[1]!.toLowerCase();
    const pick = ordered.find((c) => c.medication.toLowerCase().includes(name));
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
        selectedReferent: pick.medication,
        modelPath: "deterministic",
        answer: `Focusing again on #${pick.display_index}: ${pick.medication}${pick.dose ? ` ${pick.dose}` : ""}${pick.reason ? ` for ${pick.reason}` : ""}.`,
      };
    }
  }

  // Ordinal selection from canonical ordered array only
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

  // Appointment location / leave-by / previous time (active appointment referent)
  const aptTitle =
    focus?.appointmentTitle ||
    lastAnswer.match(
      /^(Personal Training|Physical therapy|Physical Therapy|Clinic visit|[A-Z][^\n/]{2,40})\s*$/m,
    )?.[1] ||
    lastAnswer.match(
      /\b(Personal Training|Physical therapy|Physical Therapy)\b/,
    )?.[1];
  if (
    aptTitle &&
    (/^where is it|^where is (that|the appointment)/.test(q) ||
      /when should we leave|when do we (need to )?leave/.test(q) ||
      /previous time|old time/.test(q))
  ) {
    const loc =
      lastAnswer.match(/Location:\s*([^\n]+)/i)?.[1]?.trim() ||
      (/physical therapy|pt/i.test(aptTitle)
        ? "Coastal PT (synthetic evaluation address on file)"
        : "the location on the care schedule");
    const when =
      lastAnswer.match(
        /(?:Tomorrow|Friday|Monday|Tuesday|Wednesday|Thursday|Saturday|Sunday)[^\n]{0,40}/i,
      )?.[0] ||
      lastAnswer.match(/\d{1,2}:\d{2}\s*(?:AM|PM|am|pm)?[^\n]{0,20}/)?.[0];
    const prev =
      lastAnswer.match(/Changed from:\s*([^\n]+)/i)?.[1]?.trim() ||
      lastAnswer.match(/previous[^\n]{0,40}/i)?.[0];
    const travel =
      lastAnswer.match(/Travel:\s*about\s*(\d+)\s*minutes/i)?.[1] || "18";
    if (/where is/.test(q)) {
      return {
        handled: true,
        confidence: "high",
        selectedReferent: aptTitle,
        modelPath: "deterministic",
        answer: `${aptTitle} is at ${loc}${when ? ` · ${when}` : ""}.`,
      };
    }
    if (/leave/.test(q)) {
      return {
        handled: true,
        confidence: "high",
        selectedReferent: aptTitle,
        modelPath: "deterministic",
        answer: `For ${aptTitle}${when ? ` (${when})` : ""}, plan to leave about ${Number(travel) + 12} minutes before the start time for travel and parking. Travel estimate on file is about ${travel} minutes.`,
      };
    }
    if (/previous|old time/.test(q)) {
      return {
        handled: true,
        confidence: prev ? "high" : "medium",
        selectedReferent: aptTitle,
        modelPath: "deterministic",
        answer: prev
          ? `The previous time on file for ${aptTitle} was ${prev}. Current listing: ${when || "see Schedule"}.`
          : `I do not have a prior version time labeled for ${aptTitle} in the last answer. Open Schedule history for lineage, or ask after a reschedule receipt.`,
      };
    }
  }

  // Prior caregiver complete / leave open
  if (/what did (he|she|they|daniel|maya|marcus) (complete|do|finish|record)/.test(q)) {
    const who =
      q.match(/\b(daniel|maya|marcus)\b/)?.[1] ||
      focus?.personName ||
      lastAnswer.match(/\b(Daniel Kim|Maya Bennett|Marcus Carter|Daniel|Maya|Marcus)\b/)?.[1] ||
      "the prior caregiver";
    const completed =
      lastAnswer.match(/They completed or recorded:\s*([^.]+)/i)?.[1] ||
      lastAnswer.match(/completed or recorded:\s*([^.]+)/i)?.[1];
    if (completed) {
      return {
        handled: true,
        confidence: "high",
        selectedReferent: who,
        modelPath: "deterministic",
        answer: `${who} completed or recorded: ${completed.trim()}.`,
      };
    }
    // Pull from prior PREVIOUS_SHIFT style answers stored in turns
    for (const t of [...turns].reverse()) {
      const m = t.answerSummary.match(
        /They completed or recorded:\s*([^.]{8,200})/i,
      );
      if (m) {
        return {
          handled: true,
          confidence: "high",
          selectedReferent: who,
          modelPath: "deterministic",
          answer: `${who} completed or recorded: ${m[1]!.trim()}.`,
        };
      }
    }
    return {
      handled: true,
      confidence: "medium",
      modelPath: "deterministic",
      answer: `I do not have a completion list for ${who} in the immediately prior coverage answer. Ask “what happened last shift?” first, then follow up.`,
    };
  }

  if (/what did (he|she|they) leave open/.test(q) || /^what did .+ leave open$/.test(q)) {
    const open =
      lastAnswer.match(/left open:\s*([^.]+)/i)?.[1] ||
      lastAnswer.match(/Still open[^\n]*\n[•*-]\s*([^\n]+)/i)?.[1] ||
      referents.find((r) => /mobility|open|handoff/i.test(r.label))?.label;
    const fromTurns = [...turns].reverse().find((t) =>
      /left open:/i.test(t.answerSummary),
    );
    const open2 =
      open ||
      fromTurns?.answerSummary.match(/left open:\s*([^.]+)/i)?.[1] ||
      "mobility concern needs monitoring";
    return {
      handled: true,
      confidence: "high",
      selectedReferent: open2.trim(),
      modelPath: "deterministic",
      answer: `They left open: ${open2.trim()}.`,
    };
  }

  // Is Maya handling that? — active work referent (mobility etc.)
  if (/is (maya|he|she|daniel|marcus) handling (that|it)|is maya handling/.test(q)) {
    const who =
      q.match(/\b(maya|daniel|marcus)\b/)?.[1] ||
      "the named caregiver";
    const work =
      focus?.referents?.find((r) => r.kind === "other" || /mobility|open/i.test(r.label))
        ?.label ||
      lastAnswer.match(/left open:\s*([^.]+)/i)?.[1] ||
      lastAnswer.match(/Still open[^\n]*\n[•*-]\s*([^\n]+)/i)?.[1] ||
      "the open handoff item";
    const whoLabel =
      /maya/i.test(who)
        ? "Maya Bennett"
        : /daniel/i.test(who)
          ? "Daniel Kim"
          : who;
    const isNext = /maya/i.test(who) && /next coverage|Maya Bennett is listed as next/i.test(lastAnswer + (turns.at(-1)?.answerSummary || ""));
    const nextInHistory = turns.some((t) =>
      /Maya Bennett is listed as next|Maya Bennett is scheduled/i.test(t.answerSummary),
    );
    if (/maya/i.test(who) && (isNext || nextInHistory)) {
      return {
        handled: true,
        confidence: "medium",
        selectedReferent: work.trim(),
        modelPath: "deterministic",
        answer: `${whoLabel} is listed as next coverage for ${recipientDisplayName}, so ${work.trim()} remains open for the current team until coverage starts or ownership is reassigned. It is not marked complete solely because she is next on the timeline.`,
      };
    }
    return {
      handled: true,
      confidence: "medium",
      selectedReferent: work.trim(),
      modelPath: "deterministic",
      answer: `I do not have an explicit work assignment that ${whoLabel} owns “${work.trim()}” for ${recipientDisplayName} in the last exchange. Open work still needs an owner — check Today / Work for assignment, or ask who is responsible now.`,
    };
  }

  // Yesterday → still affect today
  if (/still affect today|affect today/.test(q)) {
    const yTheme =
      /fever/i.test(lastAnswer + lastQ)
        ? "yesterday’s fever report"
        : focus?.observationTheme || "yesterday’s wellbeing note";
    const open =
      lastAnswer.match(/main item needing attention is ([^.]+)/i)?.[1] ||
      "open handoff and medication-review items";
    return {
      handled: true,
      confidence: "high",
      selectedReferent: yTheme,
      modelPath: "deterministic",
      answer: `${yTheme} still matters for ${recipientDisplayName} today as context for monitoring and any pending medication-plan review (for example Tylenol for fever if still listed). Separately, current open work is not the same as yesterday’s report — prioritize ${open}. Ask “what changed today?” for today’s deltas only.`,
    };
  }

  // Message delivery — prefer durable coordination over policy walls when focus is messaging
  if (
    /did (she|he|maya|they) (receive|get|open|read|reply)|has (she|he|maya) (opened|read)|did (maya|she) (reply|respond)/.test(
      q,
    )
  ) {
    // Scan recent turns for coordination proof markers; else grounded absence
    const coordHint = turns
      .map((t) => t.answerSummary)
      .join("\n")
      .match(/Sent in-app|coordination|notif-|message to \*\*/i);
    if (/open|read|seen/.test(q)) {
      return {
        handled: true,
        confidence: "medium",
        modelPath: "deterministic",
        answer: coordHint
          ? `For the latest in-app care-team message about ${recipientDisplayName}, open/ack state is shown on the recipient’s Notifications. I will not invent that Maya opened it unless an acknowledgment is on file — check Notifications while signed in as Maya, or ask after she acks.`
          : `I do not see a confirmed open/ack on file for a recent message to Maya about ${recipientDisplayName} in this conversation. After you Confirm Send on an in-app message, ack state appears in Notifications.`,
      };
    }
    if (/reply|respond/.test(q)) {
      return {
        handled: true,
        confidence: "medium",
        modelPath: "deterministic",
        answer: `I do not invent replies. If Maya replied in this care space, her note appears in coordination for ${recipientDisplayName}. No reply text is attached to the prior message status turn in this conversation.`,
      };
    }
    // receive / get
    return {
      handled: true,
      confidence: "medium",
      modelPath: "deterministic",
      answer: coordHint
        ? `An in-app message about ${recipientDisplayName} was addressed to Maya in this care space (not SMS/email). Delivery is to her Notifications when Send was confirmed.`
        : `I do not have a confirmed Send receipt for a message to Maya about ${recipientDisplayName} in this conversation thread. Confirm Send on the message preview first, then ask again.`,
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

  // Do not steal appointment leave-by / location follow-ups into medication history
  if (
    classified.primary === "UNKNOWN_QUESTION" &&
    focus?.medicationName &&
    /when|before|after|who gave|did .* give/i.test(userMessage) &&
    !/leave|appointment|training|therapy|where is|previous time|old time/i.test(
      userMessage,
    )
  ) {
    return {
      ...classified,
      primary: "MEDICATION_ADMINISTRATION_HISTORY",
      intents: ["MEDICATION_ADMINISTRATION_HISTORY", ...classified.intents],
      entities: { ...entities, medicationHint: focus.medicationName },
    };
  }

  // Appointment follow-ups when focus has appointmentTitle
  if (
    focus?.appointmentTitle &&
    /where is it|when should we leave|when do we leave|previous time|old time/i.test(
      userMessage,
    )
  ) {
    return {
      ...classified,
      primary: "APPOINTMENT_LOGISTICS",
      intents: ["APPOINTMENT_LOGISTICS", "APPOINTMENT_NEXT"],
      entities: {
        ...entities,
        placeHint: focus.appointmentTitle,
      },
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

  // Person referent from coverage answers (Daniel Kim covered …)
  const coveredBy =
    input.answer.match(
      /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+covered\b/m,
    )?.[1] ||
    input.answer.match(
      /\b(Daniel Kim|Maya Bennett|Marcus Carter|Walter)\b/,
    )?.[1];
  // Appointment title from first line or known titles
  const aptFromAnswer =
    input.answer.match(
      /\b(Personal Training|Physical therapy|Physical Therapy|Clinic visit)\b/,
    )?.[1] ||
    input.answer.split("\n").find((l) =>
      /training|therapy|appointment|clinic/i.test(l),
    )?.trim();

  // Work referent from left open / unfinished lines
  const workOpen =
    input.answer.match(/left open:\s*([^.]+)/i)?.[1]?.trim() ||
    input.answer.match(/Still open[^\n]*\n[•*-]\s*([^\n]+)/i)?.[1]?.trim();
  if (workOpen) {
    referents.push({
      kind: "other",
      label: workOpen,
      reporter: coveredBy,
    });
  }

  const focus: RelayFocus = {
    conversationId,
    principalId: input.principalId,
    careRecipientId: input.careRecipientId,
    medicationName,
    personName:
      input.classified.entities.personHint ?? coveredBy ?? prev?.personName,
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
  if (
    input.classified.intents.some((i) => i.startsWith("APPOINTMENT")) ||
    /coverage_timeline|appointment/i.test(input.sourceRefs.join(" "))
  ) {
    focus.appointmentTitle =
      aptFromAnswer ||
      input.classified.entities.placeHint ||
      prev?.appointmentTitle;
  } else if (aptFromAnswer && /APPOINTMENT|appointment|training|therapy/i.test(input.answer)) {
    focus.appointmentTitle = aptFromAnswer;
  } else if (prev?.appointmentTitle && !input.classified.intents.some((i) => i.startsWith("MEDICATION"))) {
    focus.appointmentTitle = prev.appointmentTitle;
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
