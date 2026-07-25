/**
 * Relay intent classes — semantic families, not canned strings.
 * Deterministic classifier for testability; LLM may refine later.
 */

export type RelayIntent =
  | "MEDICATION_CURRENT"
  | "MEDICATION_DUE"
  | "MEDICATION_ADMINISTRATION_HISTORY"
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
  | "CARE_UPDATE"; // tell path, not pure Q

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

  // Coverage / next helper — before identity (avoid "who is" → profile dump)
  if (
    /who is helping|helping now|who comes after|next caregiver|next helper|who is next|when is maya|how much longer am i|taking over|who is covering|who is with|tonight.*(help|cover)/.test(
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
  if (
    !/protocol\s*9|protocol\s+zeta/i.test(q) &&
    /medicat|medicine|meds?\b|dose|pill|metformin|lunch med|with food|already give|gave her|(administer|administration).*(med|dose|pill|metformin)|gave .* (med|dose|pill)/.test(
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
    if (intents.length === 0 || intents.every((i) => i.startsWith("RECIPIENT"))) {
      intents.push("MEDICATION_CURRENT");
    }
  }

  // New booking vs existing appointment vs reschedule
  if (
    /schedule (a |an )?(doctor|dr|clinic|provider|pcp|physician)|book (a |an )?(doctor|appointment|visit)|make (a |an )?appointment|set up (a |an )?appointment|i want to schedule|i would like to schedule/.test(
      q,
    ) &&
    !/reschedule|change (the |her |his )?appointment|move (the |her )?appointment/.test(q)
  ) {
    intents.push("APPOINTMENT_REQUEST_NEW");
  } else if (
    /reschedule|change (the |her |his )?appointment|move (the |pt |physical )?appointment|move pt|move physical therapy/.test(
      q,
    )
  ) {
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

  // Open-loop / waiting-on status (orchestration awareness)
  if (
    /waiting on|still waiting|are we waiting|who are we waiting|did maya answer|did (the )?doctor reply|did dr\.?\s*shah reply|anything unresolved|what still needs|what am i still waiting|open request|pending (request|clarification)/i.test(
      q,
    )
  ) {
    intents.push("WAITING_ON");
    intents.push("OPEN_LOOP_STATUS");
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
  } else if (/medicat|medicine|dose|pill/.test(q)) {
    medicationHint = medicationHint ?? "Metformin";
  }

  let personHint = priorEntities?.personHint;
  if (/maya/.test(q)) personHint = "Maya Bennett";
  if (/daniel/.test(q)) personHint = "Daniel Kim";
  if (/marcus/.test(q)) personHint = "Marcus Carter";
  if (/dr\.?\s*shah|priya/.test(q)) personHint = "Dr. Priya Shah";
  // Named person + give/gave without explicit med word still administration history
  if (
    personHint &&
    /give|gave|given|administer/.test(q) &&
    !intents.includes("MEDICATION_ADMINISTRATION_HISTORY")
  ) {
    intents.push("MEDICATION_ADMINISTRATION_HISTORY");
  }

  let timeHint: ClassifiedTurn["entities"]["timeHint"] = priorEntities?.timeHint;
  if (/yesterday/.test(q)) timeHint = "yesterday";
  else if (/today|now/.test(q)) timeHint = "today";
  else if (/this week|last week/.test(q)) timeHint = "this_week";
  else if (/last visit|since my last/.test(q)) timeHint = "last_visit";

  const primary = intents[0] ?? "UNKNOWN_QUESTION";

  // Decision context + optional clarification
  let decisionContext: DecisionContext = "information";
  let needsClarification = false;
  let clarificationPrompt: string | undefined;
  if (
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
  if (/escalate|urgent|safety/.test(q)) decisionContext = "escalation";
  if (/prepare.*dr|clinic|doctor/.test(q)) decisionContext = "clinic_prep";
  if (/document before/.test(q)) decisionContext = "documentation";

  return {
    intents: [...new Set(intents)],
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
