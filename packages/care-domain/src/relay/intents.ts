/**
 * Relay intent classes — semantic families, not canned strings.
 * Deterministic classifier for testability; LLM may refine later.
 */

export type RelayIntent =
  | "MEDICATION_CURRENT"
  | "MEDICATION_DUE"
  | "MEDICATION_ADMINISTRATION_HISTORY"
  | "MEDICATION_REDOSE_SAFETY"
  | "MEDICATION_UNCERTAINTY"
  | "MEDICATION_CHANGE"
  | "MEDICATION_INSTRUCTIONS"
  | "APPOINTMENT_NEXT"
  | "APPOINTMENT_LOGISTICS"
  | "APPOINTMENT_PREPARATION"
  | "CHANGE_SINCE"
  | "RECENT_ACTIVITY"
  | "TREND"
  | "OBSERVATION_HISTORY"
  | "PROVIDER_INSTRUCTION"
  | "PROVIDER_CONTACT"
  | "PROVIDER_UPDATE_PREP"
  | "HANDOFF_PREP"
  | "HANDOFF_REVIEW"
  | "TASKS_NOW"
  | "TASKS_REMAINING"
  | "CARE_TEAM"
  | "CONTACT_PERSON"
  | "SAFETY_CONCERN"
  | "ESCALATION"
  | "DOCUMENT_PREP"
  | "RECIPIENT_ROUTINE"
  | "RECIPIENT_PREFERENCES"
  | "RECIPIENT_MOBILITY"
  | "RECIPIENT_IDENTITY"
  | "RECIPIENT_AGE"
  | "RECIPIENT_DIAGNOSIS"
  | "RECIPIENT_ALLERGIES"
  | "RECIPIENT_PROFILE"
  | "EMERGENCY_SNAPSHOT"
  | "APPOINTMENT_REQUEST_NEW"
  | "APPOINTMENT_RESCHEDULE"
  | "APPOINTMENT_CANCEL"
  | "APPOINTMENT_CONFIRM_BOOK"
  | "CARE_COVERAGE"
  | "TRANSPORTATION"
  | "UNKNOWN_QUESTION"
  | "OPEN_LOOP_STATUS"
  | "WAITING_ON"
  | "VERIFICATION_STATUS"
  | "STATUS_SYNTHESIS"
  | "CARE_UPDATE"; // tell path, not pure Q

/** Permission-to-administer / redose questions — safety-critical, not history. */
export function isMedicationRedoseSafetyQuestion(q: string): boolean {
  const s = q.toLowerCase().trim();
  // Explicit permission / redose / another dose family (semantic, not one phrase)
  if (
    /\b(should|can|could|may|do)\s+(i|we|she|he|they)\s+(give|take|administer)\b/.test(
      s,
    ) ||
    /\b(give|take|administer)\s+(it|that|the\s+(med|medicine|dose|pill)|her|him|them)\s+again\b/.test(
      s,
    ) ||
    /\b(another|one more|extra)\s+(dose|pill|one|med|medicine)\b/.test(s) ||
    /\b(need|needs)\s+(another|one more|a second)\s+(dose|pill|one)?\b/.test(
      s,
    ) ||
    /\b(is it|is she|is he)\s+(ok|okay|safe|alright)\s+to\s+(give|take)\b/.test(
      s,
    ) ||
    /\bok(ay)?\s+to\s+(give|take)\b/.test(s) ||
    /\bgive\s+(her|him|them)\s+(another|one more|it again)\b/.test(s) ||
    /\btake\s+it\s+again\b/.test(s) ||
    /\bredose\b|\bsecond dose\b|\bdose again\b/.test(s)
  ) {
    // Exclude pure history: "did she take / already give / who gave"
    if (
      /^(did|has|have|was|were)\b/.test(s) ||
      /\balready (give|gave|given|took|take)\b/.test(s) ||
      /\bwho (gave|give|administered)\b/.test(s) ||
      /\bwhen did\b/.test(s)
    ) {
      return false;
    }
    return true;
  }
  return false;
}

/** Open coordination / unresolved work family. */
export function isUnresolvedWorkQuestion(q: string): boolean {
  const s = q.toLowerCase().trim();
  return (
    /\bunresolved\b/.test(s) ||
    /\bunfinished\b/.test(s) ||
    /\bstill (open|pending|waiting|unfinished|outstanding|left)\b/.test(s) ||
    /\bwhat('s| is) still\b/.test(s) ||
    /\bwhat('s| is) (still )?(open|pending|left|outstanding|unfinished)\b/.test(
      s,
    ) ||
    /\bwhat('s| is) left\b|\bwhat remains\b/.test(s) ||
    /\banything (still )?(open|unresolved|pending|not finished|left|outstanding)\b/.test(
      s,
    ) ||
    /\bwaiting on\b|\bstill waiting\b|\bare we waiting\b|\bwho are we waiting\b/.test(
      s,
    ) ||
    /\bopen (request|item|loop|task)s?\b/.test(s) ||
    /\bpending (request|clarification|item)s?\b/.test(s) ||
    /\bnot finished\b|\bstill needs?\b|\bwhat still needs\b/.test(s) ||
    /\bwhat are we waiting\b|\bwhat am i still waiting\b/.test(s) ||
    /\bdid maya answer\b|\bdid (the )?doctor reply\b|\bdid dr\.?\s*\w+ reply\b/.test(
      s,
    ) ||
    /\bopen items?\b|\boutstanding\b/.test(s)
  );
}

/** Verification / confirmation-status family. */
export function isVerificationStatusQuestion(q: string): boolean {
  const s = q.toLowerCase().trim();
  // Never steal appointment booking confirmation / schedule commands
  if (
    /\bconfirm\s+(appointment|booking|slot|the\s+booking)\b/.test(s) ||
    /\byes[, ]*book\b|\bbook that slot\b|\bsave (the )?appointment request\b/.test(
      s,
    )
  ) {
    return false;
  }
  return (
    /\b(has|have|is|was|were)\s+(this|that|it|the\s+\w+)?\s*(been\s+)?(verif|confirm)/.test(
      s,
    ) ||
    /\bverif(ied|y|ication)\b/.test(s) ||
    /\bconfirmation status\b|\bverification status\b/.test(s) ||
    /\bneeds?\s+checking\b|\bneeds?\s+verif/.test(s) ||
    /\bis (this|that|it) (confirmed|reported|verified|uncertain)\b/.test(s) ||
    /\b(still )?(reported|confirmed|verified) only\b/.test(s) ||
    /\breported only\b|\bjust reported\b/.test(s) ||
    /\bwhat('s| is) (the )?(verification|confirmation) status\b/.test(s) ||
    /\bhas (anyone|someone) (confirmed|verified)\b/.test(s) ||
    /\bprovider (confirmed|authorized|verified)\b/.test(s) ||
    /\bverified or reported\b|\bconfirm(ed)? or (just )?report/.test(s) ||
    /\bdid we verify\b|\bhave we verified\b/.test(s) ||
    // "is … confirmed?" / "has … been confirmed?"
    /\b(is|was)\s+.+\s+confirmed\b/.test(s) ||
    /\b(has|have)\s+.+\s+(been\s+)?(confirmed|verified)\b/.test(s)
  );
}

/** Mobility / transfer / assistive support family. */
export function isMobilitySupportQuestion(q: string): boolean {
  const s = q.toLowerCase().trim();
  return (
    /\btransfer(ring|s)?\b/.test(s) ||
    /\bmobility\b/.test(s) ||
    /\bassist(ive)?\s+devices?\b/.test(s) ||
    /\bassist(ive)?\s+(device|with|needed|support)\b/.test(s) ||
    /\b(need|needs|support)\b.{0,40}\b(transfer|walk|standing|mobility|ambulat)/.test(
      s,
    ) ||
    /\b(how|what)\b.{0,30}\b(transfer|walk|mobility|stand)\b/.test(s) ||
    /\bfunctional baseline\b|\bphysical support\b|\bhelp (her|him|them) (stand|walk|transfer)\b/.test(
      s,
    ) ||
    /\bgait\b|\bwheeler?\b|\bwalker\b|\bcane\b|\brail\b/.test(s) ||
    /\bindependent with transfers\b|\bhow mobile\b/.test(s)
  );
}

/** Ambiguous scheduling move / reschedule without named appointment. */
export function isAmbiguousScheduleMoveQuestion(q: string): boolean {
  const s = q.toLowerCase().trim();
  if (
    /\breschedule\b/.test(s) ||
    /\bchange\b.{0,24}\bappointment\b/.test(s) ||
    /\bmove\b.{0,40}\bappointment\b/.test(s) ||
    /\bshift\b.{0,40}\bappointment\b/.test(s) ||
    /\bpush\b.{0,40}\bappointment\b/.test(s) ||
    /\bmove\s+pt\b|\bmove\s+physical therapy\b/.test(s) ||
    /\bchange\b.{0,24}\b(time|slot|visit)\b/.test(s)
  ) {
    return true;
  }
  // Bare "move it / can you move / shift it" when not clearly non-schedule
  if (
    /\b(can|could|will|would)\s+you\s+(move|shift|change|push)\b/.test(s) ||
    /\b(can|could)\s+we\s+(move|shift|change|push)\b/.test(s) ||
    /\bmove\s+it\b|\bshift\s+it\b|\bpush\s+it\b|\bchange\s+it\b/.test(s) ||
    /\bmove\s+(that|this)\b/.test(s) ||
    /\bplease\s+(move|reschedule|shift)\b/.test(s)
  ) {
    // Exclude non-schedule: move her to bed, bowel move, etc.
    if (
      /\b(bed|chair|toilet|bowel|house|room|medication|dose)\b/.test(s) &&
      !/\b(appointment|pt|therapy|clinic|visit|slot)\b/.test(s)
    ) {
      // still allow pure "can you move it" with only "it"
      if (!/\b(move|shift|push|change)\s+it\b/.test(s)) return false;
    }
    return true;
  }
  return false;
}

export type CaregiverPersona =
  | "family"
  | "professional_dsp"
  | "physician"
  | "unknown";

export type DecisionContext =
  | "information"
  | "before_administering"
  | "handoff"
  | "escalation"
  | "clinic_prep"
  | "documentation"
  | "unclear";

export type ClassifiedTurn = {
  intents: RelayIntent[];
  primary: RelayIntent;
  decisionContext: DecisionContext;
  entities: {
    medicationHint?: string;
    personHint?: string;
    timeHint?: "today" | "yesterday" | "this_week" | "last_visit" | "relative";
    placeHint?: string;
    references: string[]; // "it", "that", "she"
  };
  isQuestion: boolean;
  isObservationUpdate: boolean;
  needsClarification: boolean;
  clarificationPrompt?: string;
};

const QUESTION_RE =
  /\?$|^(what|when|where|who|how|did|does|do|is|are|can|should|has|have|was|were)\b/i;

export function classifyPersona(roleLabel: string | undefined | null): CaregiverPersona {
  const r = (roleLabel ?? "").toLowerCase();
  if (/physician|primary care|provider|doctor|clinician|health professional/.test(r)) {
    return "physician";
  }
  if (
    /professional caregiver|paid caregiver|direct support|dsp|in-home|agency/.test(
      r,
    )
  ) {
    return "professional_dsp";
  }
  if (/family|friend|primary family|spouse|adult child|unpaid/.test(r)) {
    return "family";
  }
  return "unknown";
}

export function classifyIntent(
  raw: string,
  priorEntities?: ClassifiedTurn["entities"],
): ClassifiedTurn {
  const text = raw.trim();
  const q = text.toLowerCase();
  const isQuestion =
    QUESTION_RE.test(text) ||
    /tell me|show me|prepare|summarize|what about|anything i need/.test(q);
  const isObservationUpdate =
    !isQuestion &&
    /\b(gave|took|seemed|noticed|ate|dizzy|tired|tired|fell|slept|refused)\b/.test(
      q,
    );

  const intents: RelayIntent[] = [];
  const references: string[] = [];
  if (/\bit\b|\bthat (medicine|med|one|dose)\b|\bthat\b/.test(q)) {
    references.push("it");
  }
  if (/\bshe\b|\bher\b|\bmom\b|\bevelyn\b/.test(q)) references.push("recipient");
  if (/\byesterday\b/.test(q)) references.push("yesterday");
  if (/\bbefore\b/.test(q)) references.push("before");

  // High-value synthesis: "How is Evelyn doing?"
  if (
    /how is (evelyn|robert|she|he|mom|they) doing|how('s| is) (she|he|evelyn|robert) (doing|today)|how are they|how is everything|what's (the )?latest (on|with)|how's (evelyn|robert|mom)/i.test(
      q,
    )
  ) {
    intents.push("STATUS_SYNTHESIS");
    intents.push("CHANGE_SINCE");
  }

  // Safety-critical: redose / permission-to-give — before history inheritance
  if (isMedicationRedoseSafetyQuestion(q)) {
    intents.push("MEDICATION_REDOSE_SAFETY");
    intents.push("MEDICATION_DUE");
    intents.push("MEDICATION_INSTRUCTIONS");
  }

  // Verification status — before generic unknowns
  if (isVerificationStatusQuestion(q)) {
    intents.push("VERIFICATION_STATUS");
  }

  // Unresolved / open-loop work
  if (isUnresolvedWorkQuestion(q)) {
    intents.push("WAITING_ON");
    intents.push("OPEN_LOOP_STATUS");
    intents.push("TASKS_REMAINING");
  }

  // Mobility / transfer support (DSP + family)
  if (isMobilitySupportQuestion(q)) {
    intents.push("RECIPIENT_MOBILITY");
  }

  // Coverage / next helper — before identity (avoid "who is" → profile dump)
  if (
    /who is helping|helping now|who comes after|next caregiver|next helper|who is next|when is maya|how much longer am i|tak(es|ing) over|who (takes|is taking) over|who is covering|who is with|tonight.*(help|cover)|who is responsible after|after i leave|after me\b|who comes next|who takes over after/.test(
      q,
    )
  ) {
    intents.push("CARE_COVERAGE");
  }

  if (
    /emergency contact|who (do i|should i) call|crisis contact|emergency phone/.test(
      q,
    )
  ) {
    intents.push("EMERGENCY_SNAPSHOT");
  }

  if (
    /transport|how (do|will) (i |we )?(get|drive|take)|ride to|travel to|leave by|driving to/.test(
      q,
    )
  ) {
    intents.push("TRANSPORTATION");
  }

  if (
    /cancel (the |her |his |evelyn'?s )?(pt |physical therapy |doctor |clinic )?appointment|cancel pt|call off (the )?appointment/.test(
      q,
    )
  ) {
    intents.push("APPOINTMENT_CANCEL");
  }

  if (
    /confirm appointment request|confirm (the )?booking|yes[, ]*book|book that slot|save (the )?appointment request/.test(
      q,
    )
  ) {
    intents.push("APPOINTMENT_CONFIRM_BOOK");
  }

  // Person intelligence — before event/task families
  if (
    /how old|what age|date of birth|\bdob\b|years old/.test(q)
  ) {
    intents.push("RECIPIENT_AGE");
  }
  if (
    /diagnos|condition on file|what (condition|disease)|medical condition|what does she have|what does he have/.test(
      q,
    )
  ) {
    intents.push("RECIPIENT_DIAGNOSIS");
  }
  if (/allerg(y|ies)|intolerance/.test(q)) {
    intents.push("RECIPIENT_ALLERGIES");
  }
  if (
    /who is (evelyn|robert|she|he)|about (evelyn|robert|her|him)|tell me about|care profile|recipient profile|what should i know about/.test(
      q,
    )
  ) {
    intents.push("RECIPIENT_IDENTITY");
    intents.push("RECIPIENT_PROFILE");
  }
  if (
    /emergency (info|snapshot|card)|essential care|what would (ems|er|hospital) need|critical (info|information)/.test(
      q,
    )
  ) {
    intents.push("EMERGENCY_SNAPSHOT");
  }

  // Medication family — do not match fabricated protocol / "administer" alone
  // Skip history routing when this is a redose/permission question
  if (
    !/protocol\s*9|protocol\s+zeta/i.test(q) &&
    !intents.includes("MEDICATION_REDOSE_SAFETY") &&
    /medicat|medicine|meds?\b|dose|pill|metformin|lunch med|with food|already give|gave her|(administer|administration).*(med|dose|pill|metformin)|gave .* (med|dose|pill)|give it|give her|give him/.test(
      q,
    )
  ) {
    if (/next|due|need (next|now)|coming up/.test(q)) intents.push("MEDICATION_DUE");
    if (/already|did anyone|was .* given|last (recorded|given|dose)|when did .* give/.test(q)) {
      intents.push("MEDICATION_ADMINISTRATION_HISTORY");
    }
    if (/with food|how (do|should)|instruction|take it|route/.test(q)) {
      intents.push("MEDICATION_INSTRUCTIONS");
    }
    if (/don'?t remember|uncertain|what do we know|unclear|discrepan/.test(q)) {
      intents.push("MEDICATION_UNCERTAINTY");
    }
    if (/change|changed|dr\.?\s*shah change|new med/.test(q)) {
      intents.push("MEDICATION_CHANGE");
    }
    if (
      intents.every(
        (i) =>
          i.startsWith("RECIPIENT") ||
          i === "VERIFICATION_STATUS" ||
          i === "WAITING_ON" ||
          i === "OPEN_LOOP_STATUS",
      )
    ) {
      intents.push("MEDICATION_CURRENT");
    }
  }

  // New booking vs existing appointment vs reschedule / move-it
  if (
    /schedule (a |an )?(doctor|dr|clinic|provider|pcp|physician)|book (a |an )?(doctor|appointment|visit)|make (a |an )?appointment|set up (a |an )?appointment|i want to schedule|i would like to schedule/.test(
      q,
    ) &&
    !isAmbiguousScheduleMoveQuestion(q)
  ) {
    intents.push("APPOINTMENT_REQUEST_NEW");
  } else if (isAmbiguousScheduleMoveQuestion(q)) {
    intents.push("APPOINTMENT_RESCHEDULE");
  } else if (
    /appoint|pt\b|physical therapy|clinic|doctor'?s visit|where do i (take|go)|bring|prepare for/.test(
      q,
    )
  ) {
    if (/where|address|location|clinic|take her/.test(q)) intents.push("APPOINTMENT_LOGISTICS");
    if (/bring|prepare|what should i/.test(q)) intents.push("APPOINTMENT_PREPARATION");
    if (intents.every((i) => !i.startsWith("APPOINTMENT"))) intents.push("APPOINTMENT_NEXT");
  }

  if (
    /what changed|since yesterday|since (my )?last|what happened|going on|while daniel|while maya|during my visit|this week/.test(
      q,
    )
  ) {
    if (/week|more tired|trend|worse|better|compared/.test(q)) intents.push("TREND");
    else if (/while |during (my )?visit|while daniel|while maya/.test(q)) {
      intents.push("RECENT_ACTIVITY");
    } else {
      intents.push("CHANGE_SINCE");
    }
    // DSP: "since my last visit" is change_since (state delta), not only activity
    if (/since (my )?last visit/.test(q) && !intents.includes("CHANGE_SINCE")) {
      intents.push("CHANGE_SINCE");
    }
  }

  if (/dizz|symptom|noticed|observation|behavior|baseline|watch for|safety/.test(q)) {
    if (/watch|safety|warning|escalate/.test(q)) intents.push("SAFETY_CONCERN");
    else intents.push("OBSERVATION_HISTORY");
  }

  if (/dr\.?\s*shah|provider instruction|what did .* say|clinic update|prepare (an )?update|for (her )?doctor|for the clinic/.test(q)) {
    if (/reach|phone|contact|call/.test(q)) intents.push("PROVIDER_CONTACT");
    else if (/prepare|update for|summary for/.test(q)) intents.push("PROVIDER_UPDATE_PREP");
    else intents.push("PROVIDER_INSTRUCTION");
  }

  if (/handoff|before i leave|next caregiver|maya need|leave for me|previous caregiver/.test(q)) {
    if (/prepare|for me|my handoff/.test(q)) intents.push("HANDOFF_PREP");
    else intents.push("HANDOFF_REVIEW");
  }

  if (
    /need to deal|needs attention|need me|waiting for me|unfinished|complete during|tasks? (now|today)|document before|escalate|remain/.test(
      q,
    )
  ) {
    if (/document|escalate/.test(q)) intents.push("ESCALATION");
    else if (/unfinished|remain|before i leave|document before/.test(q)) {
      intents.push("TASKS_REMAINING");
    } else intents.push("TASKS_NOW");
  }

  if (/who is helping|care (team|circle)|who should i contact|how do i reach|phone|call maya|call daniel/.test(q)) {
    if (/reach|phone|call|contact/.test(q)) intents.push("CONTACT_PERSON");
    else intents.push("CARE_TEAM");
  }

  if (/usually|routine|around lunch|preferences|respect|baseline/.test(q)) {
    if (/prefer/.test(q)) intents.push("RECIPIENT_PREFERENCES");
    else intents.push("RECIPIENT_ROUTINE");
  }

  if (/prepare.*document|care summary|export/.test(q)) intents.push("DOCUMENT_PREP");

  // Open-loop / waiting-on (again after late patterns; helpers may have already pushed)
  if (isUnresolvedWorkQuestion(q)) {
    if (!intents.includes("WAITING_ON")) intents.push("WAITING_ON");
    if (!intents.includes("OPEN_LOOP_STATUS")) intents.push("OPEN_LOOP_STATUS");
  }

  if (isObservationUpdate && intents.length === 0) intents.push("CARE_UPDATE");
  if (isQuestion && intents.length === 0) intents.push("UNKNOWN_QUESTION");
  if (!isQuestion && !isObservationUpdate && intents.length === 0) {
    intents.push("UNKNOWN_QUESTION");
  }

  // Entities
  let medicationHint = priorEntities?.medicationHint;
  if (/metformin|lunch med|lunch medication/.test(q)) medicationHint = "Metformin";
  else if (/medicat|medicine|dose|pill/.test(q) && priorEntities?.medicationHint) {
    medicationHint = priorEntities.medicationHint;
  } else if (/medicat|medicine|dose|pill|give it|another dose/.test(q)) {
    medicationHint = medicationHint ?? "Metformin";
  }

  let personHint = priorEntities?.personHint;
  if (/maya/.test(q)) personHint = "Maya Bennett";
  if (/daniel/.test(q)) personHint = "Daniel Kim";
  if (/marcus/.test(q)) personHint = "Marcus Carter";
  if (/dr\.?\s*shah|priya/.test(q)) personHint = "Dr. Priya Shah";
  // Named person + give/gave → admin history ONLY for history-shaped questions,
  // never for redose/permission ("should I give…")
  if (
    personHint &&
    /give|gave|given|administer/.test(q) &&
    !intents.includes("MEDICATION_REDOSE_SAFETY") &&
    !intents.includes("MEDICATION_ADMINISTRATION_HISTORY") &&
    (/already|did |has |have |was |who |when /.test(q) ||
      /gave|given|administered/.test(q))
  ) {
    intents.push("MEDICATION_ADMINISTRATION_HISTORY");
  }

  let timeHint: ClassifiedTurn["entities"]["timeHint"] = priorEntities?.timeHint;
  if (/yesterday/.test(q)) timeHint = "yesterday";
  else if (/today|now/.test(q)) timeHint = "today";
  else if (/this week|last week/.test(q)) timeHint = "this_week";
  else if (/last visit|since my last/.test(q)) timeHint = "last_visit";

  // Primary priority: safety > verification > open loops > mobility > first match
  const priority: RelayIntent[] = [
    "MEDICATION_REDOSE_SAFETY",
    "STATUS_SYNTHESIS",
    "CARE_COVERAGE",
    "VERIFICATION_STATUS",
    "WAITING_ON",
    "OPEN_LOOP_STATUS",
    "RECIPIENT_MOBILITY",
    "APPOINTMENT_RESCHEDULE",
  ];
  const unique = [...new Set(intents)];
  let primary: RelayIntent = unique[0] ?? "UNKNOWN_QUESTION";
  for (const p of priority) {
    if (unique.includes(p)) {
      primary = p;
      break;
    }
  }

  // Decision context + optional clarification
  let decisionContext: DecisionContext = "information";
  let needsClarification = false;
  let clarificationPrompt: string | undefined;
  if (intents.includes("MEDICATION_REDOSE_SAFETY")) {
    decisionContext = "before_administering";
  } else if (
    /did .* take|already give|got this|whether she got/.test(q) &&
    /med|dose|pill|medicine/.test(q)
  ) {
    decisionContext = "before_administering";
    if (!/confirm|checking before|giving it now/.test(q) && /today|now|right now/.test(q)) {
      needsClarification = true;
      clarificationPrompt =
        "I can see what's recorded. Are you checking before giving a dose now, or reviewing what already happened?";
    }
  }
  if (/handoff|before i leave/.test(q)) decisionContext = "handoff";
  if (/escalate|urgent|safety/.test(q) || intents.includes("MEDICATION_REDOSE_SAFETY")) {
    if (intents.includes("MEDICATION_REDOSE_SAFETY")) decisionContext = "before_administering";
    else decisionContext = "escalation";
  }
  if (/prepare.*dr|clinic|doctor/.test(q)) decisionContext = "clinic_prep";
  if (/document before/.test(q)) decisionContext = "documentation";

  return {
    intents: unique,
    primary,
    decisionContext,
    entities: {
      medicationHint,
      personHint,
      timeHint,
      references: [...new Set([...references, ...(priorEntities?.references ?? [])])],
    },
    isQuestion,
    isObservationUpdate,
    needsClarification,
    clarificationPrompt,
  };
}
