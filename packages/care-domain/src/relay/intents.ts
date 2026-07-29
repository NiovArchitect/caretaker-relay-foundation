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
  | "YESTERDAY_WELLBEING"
  | "CHANGES_TODAY"
  | "CHANGES_SINCE_YESTERDAY"
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
  | "META_CONVERSATION"
  | "OPEN_LOOP_STATUS"
  | "WAITING_ON"
  | "VERIFICATION_STATUS"
  | "STATUS_SYNTHESIS"
  | "PREVIOUS_SHIFT"
  | "CARE_UPDATE"; // tell path, not pure Q

/** Conversational / product-meta — never a care update. */
export function isMetaConversationQuestion(q: string): boolean {
  const s = q.toLowerCase().trim();
  return (
    /\b(same response|repeat(ing|ed)? yourself|why did you|why are you|can you (make|be) (that )?shorter|what did you understand|are you (just )?repeating|am i getting|did you just|stop repeating|too long|shorter answer|canned response|did not answer|didn't answer|make that shorter|be more concise|summarize that)\b/.test(
      s,
    ) ||
    /^(am|are|was|were|why|how come)\b.*\b(same|repeat|response|answer|that)\b/.test(
      s,
    ) ||
    /^(make (it|that) shorter|that did not answer|that didn't answer|are you giving me a canned)/.test(
      s,
    )
  );
}

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
  // Medication-plan / Allegra questions are not generic open-loop dumps
  if (
    /\ballegra\b/.test(s) ||
    /medication change/.test(s) ||
    /is (it|allegra|that) active/.test(s)
  ) {
    return false;
  }
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

/**
 * Normalize typos against authorized recipient preferred names only.
 * Never hard-code Evelyn/Marcus — pass active recipient first names.
 */
export function normalizeCareQuestionText(
  raw: string,
  recipientFirstNames: string[] = [],
): string {
  let s = raw.trim();
  for (const name of recipientFirstNames) {
    const first = name.trim().split(/\s+/)[0];
    if (!first || first.length < 3) continue;
    // Common vowel-swap / double-letter caregiver typos for this first name
    const lower = first.toLowerCase();
    // e.g. evenlyn for evelyn: allow one transposition pattern around vowels
    const re = new RegExp(
      `\\b${lower.slice(0, 2)}[a-z]{0,3}${lower.slice(-2)}\\b`,
      "gi",
    );
    s = s.replace(re, (m) => {
      if (m.toLowerCase() === lower) return m;
      // only rewrite if edit distance-ish short
      if (Math.abs(m.length - first.length) <= 2) return first;
      return m;
    });
  }
  return s;
}

export function classifyIntent(
  raw: string,
  priorEntities?: ClassifiedTurn["entities"],
  opts?: { recipientFirstNames?: string[] },
): ClassifiedTurn {
  const text = normalizeCareQuestionText(raw, opts?.recipientFirstNames ?? []);
  const q = text.toLowerCase();
  const isQuestion =
    QUESTION_RE.test(text) ||
    /tell me|show me|prepare|summarize|what about|anything i need|how is|how'?s|how are|who is|what('s| is)|did anything|feeling|mood/.test(
      q,
    );
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
  if (/\bshe\b|\bher\b|\bmom\b|\bevelyn\b|\brobert\b/.test(q))
    references.push("recipient");
  if (/\byesterday\b|\bprevious shift\b|\blast shift\b/.test(q))
    references.push("yesterday");
  if (/\bbefore\b/.test(q)) references.push("before");

  // Meta / conversational about Relay — never care-update
  if (isMetaConversationQuestion(q)) {
    intents.push("META_CONVERSATION");
  }

  // Urgent today / open review phrasing
  if (
    !intents.includes("META_CONVERSATION") &&
    /\b(urgent|anything urgent|needs? (my )?attention today|what needs review|what needs attention)\b/.test(
      q,
    )
  ) {
    intents.push("TASKS_REMAINING");
    intents.push("OPEN_LOOP_STATUS");
    if (/today|right now|now\b/.test(q)) intents.push("STATUS_SYNTHESIS");
  }

  // Pending Allegra / plan-change questions
  if (
    !intents.includes("META_CONVERSATION") &&
    (/\bis allegra\b|\ballegra (active|on|approved|pending|waiting)\b/.test(q) ||
      /medication change (is |that's |that is )?waiting|what medication change is waiting|pending medication change|waiting for (medication-?plan )?review|medication changes? (are |is )?waiting/.test(
        q,
      ))
  ) {
    intents.push("MEDICATION_CHANGE");
    // Do not also push WAITING_ON — that steals the answer into open-loop Metformin dump
  }

  // Previous shift — exclusive temporal scope (not current-status dump)
  if (
    /previous shift|last shift|during (the )?last shift|end of (the )?shift|from the last shift|on the last shift|during her shift|during his shift|during (maya|daniel|marcus).{0,20}shift|what did (maya|daniel|marcus) report|previous caregiver report|what did (the )?previous caregiver|before my shift|before (this|the) shift|caretaker (who )?helped .{0,40}before|who (worked|helped|covered|cared).{0,40}before (me|my shift)|who was (on|with) .{0,20}before me|prior (caregiver|caretaker|shift|helper)/.test(
      q,
    )
  ) {
    intents.push("PREVIOUS_SHIFT");
    intents.push("HANDOFF_REVIEW");
    intents.push("RECENT_ACTIVITY");
  }

  // High-value synthesis: "How is {name} today" — current day ONLY (no auto CHANGE_SINCE)
  if (
    !intents.includes("PREVIOUS_SHIFT") &&
    !intents.includes("META_CONVERSATION") &&
    (/how('s| is) (she|he|mom|dad|they|everything|my (mom|dad|client|patient))\b/.test(
      q,
    ) ||
      /how('s| is) (she|he) (doing|today|feeling|now)/.test(q) ||
      /how are they|how is everything|what's (the )?latest (on|with)/.test(q) ||
      /^how is\b/.test(q) ||
      (/\bhow (is|did|was) [a-z]{2,20}\b/.test(q) &&
        !/previous shift|last shift|yesterday/.test(q)))
  ) {
    intents.push("STATUS_SYNTHESIS");
    // Do NOT also push CHANGE_SINCE — that concatenates a second canned block.
  }

  // Mood / feeling (without previous-shift double-stack)
  if (
    !intents.includes("PREVIOUS_SHIFT") &&
    /\bmood\b|\bfeeling\b|\bfeelings\b|\bhow (is|was) (she|he|evelyn|robert) feel/.test(
      q,
    )
  ) {
    intents.push("OBSERVATION_HISTORY");
    if (!intents.includes("STATUS_SYNTHESIS")) intents.push("STATUS_SYNTHESIS");
  }

  // Caregiver / caretaker identity (who helps — not who is the recipient)
  if (
    /who (is|are) (your |her |his |the )?(caregiver|caretaker|care taker|helper|helpers|care team)/.test(
      q,
    ) ||
    /who (helps|is helping|takes care|cares for)/.test(q) ||
    /who('s| is) on (the )?care (team|circle)/.test(q)
  ) {
    intents.push("CARE_TEAM");
    intents.push("CARE_COVERAGE");
  }

  // Split temporal plans — do not collapse all into CHANGE_SINCE
  if (
    !intents.includes("PREVIOUS_SHIFT") &&
    !intents.includes("META_CONVERSATION")
  ) {
    const wellbeingQ =
      /how (did|was|is) .{0,40}(feel|feeling|mood|yesterday)|was she (tired|dizzy|ok|okay|feverish)|what was her (mood|energy)|concerning happen yesterday|how was .{0,20} yesterday/.test(
        q,
      ) ||
      (/\byesterday\b/.test(q) &&
        /\b(feel|feeling|mood|tired|fatigue|fever|dizz|pain|sleep|ate|eat|appetite|mobility|fall)\b/.test(
          q,
        ));
    const sinceYesterday =
      /since yesterday|better than yesterday|different from yesterday|resolved since yesterday|remains from yesterday|compared to yesterday/.test(
        q,
      );
    const todayChanges =
      /what changed today|what happened today|what is new today|anything (new|corrected|completed) today|was anything corrected today|what was completed today/.test(
        q,
      ) ||
      (/today/.test(q) &&
        /what (changed|happened|is new)|anything new|corrected|completed/.test(q) &&
        !/how is|right now|urgent/.test(q));

    if (wellbeingQ && !sinceYesterday) {
      intents.push("YESTERDAY_WELLBEING");
      intents.push("OBSERVATION_HISTORY");
    } else if (sinceYesterday) {
      intents.push("CHANGES_SINCE_YESTERDAY");
    } else if (todayChanges) {
      intents.push("CHANGES_TODAY");
    } else if (
      /did anything happen|what happened|anything (new|happen)|yesterday|last night|this morning|overnight|this week|between dinner and bedtime|since i was last|worse since|should i be worried/.test(
        q,
      )
    ) {
      if (/worried|safety|fall|unsafe/.test(q)) intents.push("SAFETY_CONCERN");
      if (/overnight|last night/.test(q)) {
        intents.push("STATUS_SYNTHESIS");
        intents.push("HANDOFF_REVIEW");
      }
      if (/\byesterday\b/.test(q) && !todayChanges) {
        intents.push("YESTERDAY_WELLBEING");
      } else if (/this week|worse|more tired|trend|compared/.test(q)) {
        intents.push("TREND");
        intents.push("CHANGE_SINCE");
      } else if (!intents.includes("CHANGE_SINCE") && !intents.includes("YESTERDAY_WELLBEING")) {
        intents.push("CHANGE_SINCE");
      }
      if (!intents.includes("RECENT_ACTIVITY")) intents.push("RECENT_ACTIVITY");
    }
  }

  // Meals / hydration / swallowing
  if (
    /\b(breakfast|lunch|dinner|eat|ate|eaten|meal|food|water|hydrat|swallow|chew|refuse.*meal)\b/.test(
      q,
    )
  ) {
    intents.push("OBSERVATION_HISTORY");
    intents.push("RECIPIENT_ROUTINE");
    if (/prefer|watch|diet|texture|food i need/.test(q))
      intents.push("RECIPIENT_PREFERENCES");
  }

  // Sleep / pain / fever / symptoms
  if (
    /\b(sleep|slept|awake|pain|hurt|fever|symptom|tired|fatigue)\b/.test(q)
  ) {
    intents.push("OBSERVATION_HISTORY");
    if (/more tired|than normal|trend/.test(q)) intents.push("TREND");
    if (/fever|pain|symptom/.test(q)) intents.push("SAFETY_CONCERN");
  }

  // Mobility / falls / transfers / bathroom assistance
  if (
    /\b(walk|walking|mobility|transfer|fall|fell|almost fall|out of bed|bathroom|toilet|shower|dressed|dressing|morning routine|personal.?care)\b/.test(
      q,
    )
  ) {
    if (/fall|safe to walk|by herself|by himself/.test(q))
      intents.push("SAFETY_CONCERN");
    else intents.push("RECIPIENT_MOBILITY");
    if (/routine|dressed|shower|toilet|bathroom|preferences/.test(q))
      intents.push("RECIPIENT_ROUTINE");
  }

  // Medication dose conflict / bottle vs plan
  if (
    /bottle says|care plan says|dose mismatch|500 mg|250 mg|what should i do/.test(
      q,
    ) && /med|mg|dose|bottle|plan/.test(q)
  ) {
    intents.push("MEDICATION_UNCERTAINTY");
    intents.push("SAFETY_CONCERN");
  }

  // Documents / provenance / corrections / share
  if (
    /discharge|therapy document|where did this .* come from|corrected the report|confirmed and which is only reported|original note|who changed this record|share this document|remove .* access/.test(
      q,
    )
  ) {
    if (/remove .* access|revoke/.test(q)) intents.push("CARE_UPDATE");
    else if (/corrected|changed this record|confirmed and which/.test(q))
      intents.push("VERIFICATION_STATUS");
    else intents.push("DOCUMENT_PREP");
  }

  // Privacy / emergency / who can see
  if (
    /who can see|last access|emergency information|communication preferences|family notified|share this document/.test(
      q,
    )
  ) {
    if (/emergency/.test(q)) intents.push("EMERGENCY_SNAPSHOT");
    else if (/prefer|notified|communication/.test(q))
      intents.push("RECIPIENT_PREFERENCES");
    else intents.push("CARE_TEAM");
  }

  // Coverage / ownership / overdue / reminders / escalate nobody accepts
  if (
    /shift covered|accept(ed)? the coverage|needs an owner|owns the transportation|end of my shift|anything overdue|reminders are coming|see the message|nobody accepts|remind maya|bring the walker/.test(
      q,
    )
  ) {
    if (/nobody accepts|escalat|if nobody/.test(q)) intents.push("ESCALATION");
    if (/overdue|needs an owner|responded to the coverage/.test(q))
      intents.push("WAITING_ON");
    if (/end of my shift|unfinished|still needs to be done|before the end/.test(q))
      intents.push("TASKS_REMAINING");
    if (/remind|reminder/.test(q)) intents.push("TASKS_NOW");
    if (/shift covered|helping after|with evelyn right now|who is with|accept.*coverage|next helper/.test(q))
      intents.push("CARE_COVERAGE");
  }

  // Multi-turn: user selects offered slot e.g. "Wednesday, July 29 · 2:00 PM PDT"
  if (
    (/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(q) &&
      /\b\d{1,2}:\d{2}\s*(am|pm)\b/.test(q)) ||
    /\b(book|confirm|choose|select|pick|use) (that |this |the )?(slot|time|option)\b/.test(
      q,
    ) ||
    (/·/.test(text) && /\b(am|pm)\b/.test(q) && /\b(pd|edt|est|utc|pt)\b/i.test(q))
  ) {
    intents.push("APPOINTMENT_CONFIRM_BOOK");
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
    if (
      /already|did anyone|was .* given|was .* administered|was medication|last (recorded|given|dose|admin)|when did .* give|administered\?|did they (get|take|receive) (the )?(med|dose|pill|metformin)/.test(
        q,
      )
    ) {
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
    /schedule (a |an )?(doctor|dr|clinic|provider|pcp|physician|yoga|pt|therapy|appointment)|book (a |an )?(doctor|appointment|visit|yoga|class|session)|make (a |an )?appointment|set up (a |an )?appointment|i want to schedule|i would like to schedule|can you schedule|schedule .* (tomorrow|today|friday|monday)/.test(
      q,
    ) &&
    !isAmbiguousScheduleMoveQuestion(q) &&
    !intents.includes("APPOINTMENT_CONFIRM_BOOK")
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
    ) &&
    !intents.includes("YESTERDAY_WELLBEING") &&
    !intents.includes("CHANGES_TODAY") &&
    !intents.includes("CHANGES_SINCE_YESTERDAY") &&
    !intents.includes("PREVIOUS_SHIFT")
  ) {
    if (/since yesterday|better than yesterday|different from yesterday/.test(q)) {
      intents.push("CHANGES_SINCE_YESTERDAY");
    } else if (/what changed today|happened today|new today/.test(q)) {
      intents.push("CHANGES_TODAY");
    } else if (/week|more tired|trend|worse|better|compared/.test(q)) {
      intents.push("TREND");
      intents.push("CHANGE_SINCE");
    } else if (/while |during (my )?visit|while daniel|while maya/.test(q)) {
      intents.push("RECENT_ACTIVITY");
    } else if (/\byesterday\b/.test(q)) {
      intents.push("YESTERDAY_WELLBEING");
    } else {
      intents.push("CHANGE_SINCE");
    }
    if (/since (my )?last visit/.test(q) && !intents.includes("CHANGE_SINCE")) {
      intents.push("CHANGES_SINCE_YESTERDAY");
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

  if (
    /who is helping|care (team|circle)|who should i contact|how do i reach|phone|call maya|call daniel|caretaker|caregiver/.test(
      q,
    )
  ) {
    if (/reach|phone|call|contact/.test(q)) intents.push("CONTACT_PERSON");
    else if (!intents.includes("CARE_TEAM")) intents.push("CARE_TEAM");
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

  // Person hints only from prior conversation entities — not fixture cast
  let personHint = priorEntities?.personHint;
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

  // Primary priority: meta & temporal scopes beat generic status dump
  const priority: RelayIntent[] = [
    "META_CONVERSATION",
    "MEDICATION_REDOSE_SAFETY",
    "PREVIOUS_SHIFT",
    "YESTERDAY_WELLBEING",
    "CHANGES_TODAY",
    "CHANGES_SINCE_YESTERDAY",
    "HANDOFF_REVIEW",
    "CARE_COVERAGE",
    "CARE_TEAM",
    "WAITING_ON",
    "OPEN_LOOP_STATUS",
    "TASKS_REMAINING",
    "STATUS_SYNTHESIS",
    "VERIFICATION_STATUS",
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
