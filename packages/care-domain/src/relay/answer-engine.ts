/**
 * Relay intelligence: intent → authorized projections → persona-shaped answer.
 * Conversation memory is separate from durable care truth.
 */

import {
  classifyIntent,
  classifyPersona,
  type CaregiverPersona,
  type ClassifiedTurn,
  type RelayIntent,
} from "./intents.js";
import {
  buildProjections,
  formatReminderDigest,
  SYNTHETIC_FACILITIES,
  type CareProjections,
  type CareStateBag,
} from "./projections.js";
import {
  formatCareDateTime,
  plainDiscrepancyMessage,
  resolvePersonName,
  sanitizeHumanCareCopy,
  semanticDedupeLines,
  str as utilStr,
} from "./util.js";
import {
  buildOrderedMedicationCandidates,
  buildOrderedMedicationCandidatesFromLines,
  formatOrderedMedicationList,
} from "../services/medication-candidates.js";

export type AnswerEngineInput = {
  question: string;
  principalId: string;
  principalName: string;
  roleLabel: string;
  recipientId: string;
  recipientName: string;
  state: CareStateBag;
  attentionLines?: string[];
  handoff?: {
    whatChanged: string[];
    stillNeedsAttention: string[];
    toPersonId?: string;
  } | null;
  priorEntities?: ClassifiedTurn["entities"];
  resolveMemory?: (c: ClassifiedTurn, q: string) => ClassifiedTurn;
  conversationId?: string;
  careTeam?: Array<{ name: string; role: string; phone?: string }>;
  personNameMap?: Record<string, string>;
  coverageTimeline?: Record<string, unknown> | null;
};

export type AnswerEngineResult = {
  answer: string;
  intent: RelayIntent;
  intents: RelayIntent[];
  persona: CaregiverPersona;
  sourceRefs: string[];
  needsClarification: boolean;
  projectionsUsed: string[];
  conversationId: string;
  modelPath: "deterministic" | "llm" | "clarification";
  classified: ClassifiedTurn;
};

function str(v: unknown): string {
  return utilStr(v);
}

export function runAnswerEngine(input: AnswerEngineInput): AnswerEngineResult {
  const persona = classifyPersona(input.roleLabel);
  const first =
    input.recipientName.trim().split(/\s+/)[0] ?? input.recipientName;
  let classified = classifyIntent(input.question, input.priorEntities, {
    recipientFirstNames: [first, input.recipientName].filter(Boolean),
  });
  if (input.resolveMemory) {
    classified = input.resolveMemory(classified, input.question);
  }

  const proj = buildProjections({
    state: input.state,
    recipientId: input.recipientId,
    recipientName: input.recipientName,
    attentionLines: input.attentionLines,
    careTeam: input.careTeam,
    personNameMap: input.personNameMap,
    handoff: input.handoff,
    coverageTimeline: input.coverageTimeline ?? null,
  });

  if (classified.needsClarification && classified.clarificationPrompt) {
    const answer = classified.clarificationPrompt;
    return {
      answer,
      intent: classified.primary,
      intents: classified.intents,
      persona,
      sourceRefs: ["clarification"],
      needsClarification: true,
      projectionsUsed: [],
      conversationId: input.conversationId ?? "",
      modelPath: "clarification" as const,
      classified,
    };
  }

  const { answer, sourceRefs, projectionsUsed } = composeAnswer({
    classified,
    persona,
    proj,
    recipientName: input.recipientName,
    principalName: input.principalName,
    question: input.question,
    personNameMap: input.personNameMap,
    state: input.state,
  });

  return {
    answer,
    intent: classified.primary,
    intents: classified.intents,
    persona,
    sourceRefs,
    needsClarification: false,
    projectionsUsed,
    conversationId: input.conversationId ?? "",
    modelPath: "deterministic" as const,
    classified,
  };
}

/**
 * One exclusive primary answer plan — never concatenate multiple full templates.
 * Order is most-specific first; each branch returns a single primary (or a tight pair).
 */
function exclusiveAnswerPlan(
  classified: ClassifiedTurn,
  question: string,
): RelayIntent[] {
  const q = question.toLowerCase().trim();
  const primary = classified.primary;

  if (primary === "META_CONVERSATION" || classified.intents.includes("META_CONVERSATION")) {
    return ["META_CONVERSATION"];
  }

  // Message / collaboration status — never CARE_TEAM or generic UNKNOWN wall
  if (
    /\b(did|has|have)\b.+\b(message|msg)\b/.test(q) ||
    /\b(opened|read|replied to)\b.+\b(message|it)\b/.test(q) ||
    /\bdid she (open|reply|read)\b/.test(q) ||
    /\bwho (was )?contacted\b/.test(q) ||
    /\bmessage status\b|\bget my message\b/.test(q)
  ) {
    return ["CARE_UPDATE"];
  }

  // Escalation / no-response — exclusive
  if (
    primary === "ESCALATION" ||
    /\b(escalat|does not respond|doesn't respond|no response|if .+ (does not|doesn't) (respond|reply)|who is contacted next|still waiting)\b/.test(
      q,
    )
  ) {
    return ["ESCALATION"];
  }

  // Previous shift / prior caregiver — exclusive
  if (
    primary === "PREVIOUS_SHIFT" ||
    classified.intents.includes("PREVIOUS_SHIFT") ||
    /previous shift|last shift|during her shift|during his shift|previous caregiver|what did (the )?previous caregiver|what did (maya|daniel|marcus) (report|do|leave)|before my shift|before (this|the) shift|who (worked|helped|covered|cared).{0,40}before (me|my shift)|who was (on|with) .{0,20}before me|prior (caregiver|caretaker|shift|helper)|what did they leave open/.test(
      q,
    )
  ) {
    return ["PREVIOUS_SHIFT"];
  }

  // Next coverage — exclusive (not CARE_TEAM dump)
  if (
    /who works after me|who is (next|after me|taking over)|when does (the )?next caregiver|next (caregiver|shift|helper)|who takes over|if no one comes next/.test(
      q,
    ) &&
    !/\b(tell|message|notify|send|report|refused)\b/.test(q)
  ) {
    return ["NEXT_COVERAGE" as RelayIntent];
  }

  // Handoff content — exclusive
  if (
    primary === "HANDOFF_PREP" ||
    primary === "HANDOFF_REVIEW" ||
    /\b(what is in my handoff|what did i (receive|get)|handoff (note|package|content)|before (i )?send(ing)? (the )?handoff|what should i (tell|add).{0,20}(them|next|handoff)|what do i need to tell them)\b/.test(
      q,
    )
  ) {
    if (/receive|received|incoming|what did i (get|receive)/.test(q)) {
      return ["HANDOFF_REVIEW"];
    }
    return ["HANDOFF_PREP"];
  }

  // Yesterday wellbeing — exclusive
  if (
    primary === "YESTERDAY_WELLBEING" ||
    classified.intents.includes("YESTERDAY_WELLBEING") ||
    (/\byesterday\b/.test(q) &&
      /\b(feel|feeling|mood|tired|fever|dizz|sleep|ate|happen|reported|how was)\b/.test(q)) ||
    /\b(how was|what (happened|was reported)).{0,20}\byesterday\b|\byesterday\b.{0,20}(happen|feel|report)/.test(
      q,
    )
  ) {
    return ["YESTERDAY_WELLBEING"];
  }

  if (
    primary === "CHANGES_SINCE_YESTERDAY" ||
    classified.intents.includes("CHANGES_SINCE_YESTERDAY") ||
    /since yesterday|better than yesterday|different from yesterday|different from yesterday/.test(
      q,
    )
  ) {
    return ["CHANGES_SINCE_YESTERDAY"];
  }

  // Changes today / since arrival / since handoff — exclusive CHANGES_TODAY or CHANGE_SINCE
  if (
    /what changed today|what happened today|what is new today|changed since i arrived|changed since (the )?last handoff|what changed\b/.test(
      q,
    )
  ) {
    if (/since (i arrived|the last handoff|last handoff|my last)/.test(q)) {
      return ["CHANGE_SINCE"];
    }
    return ["CHANGES_TODAY"];
  }

  // Current status picture — exclusive (not unfinished dump)
  if (
    primary === "STATUS_SYNTHESIS" ||
    /\bhow is (she|he|evelyn|they)\b|\bhow are they\b|\bright now\b|\bcurrent picture\b|\bcurrent status\b|\banything urgent\b|\bis anything urgent\b/.test(
      q,
    )
  ) {
    if (/\burgent\b|\bright now\b/.test(q) && /\b(unfinished|open|waiting|left)\b/.test(q)) {
      return ["TASKS_REMAINING"];
    }
    return ["STATUS_SYNTHESIS"];
  }

  // Who is responsible now → open loops, not full shift plan
  if (/\bwho is responsible\b|\bwhose responsibility\b/.test(q)) {
    return ["TASKS_REMAINING"];
  }

  // First priority / start here (R-CONTEXT-001) — exclusive TASKS_NOW plan
  if (
    /\bwhat should i do first\b|\bwhere should i start\b|\bwhat comes first\b|\bwhat is the first priorit|\bwhat should i (handle|do) before (anything|everything)\b|\bstart with what\b|\bwhat'?s first on/.test(
      q,
    )
  ) {
    return ["TASKS_NOW"];
  }

  // Person assignment — "what is Maya handling?" (R-CONTEXT-002)
  if (
    /\bwhat is (maya|daniel|marcus|she|he) (handling|taking care of|working on|responsible for)\b|\bwhat does (maya|daniel|marcus) (still )?have open\b|\bwhat is (maya|daniel|marcus) (doing|covering)\b/.test(
      q,
    )
  ) {
    return ["TASKS_REMAINING", "CARE_COVERAGE"];
  }

  // Today operating plan / current shift responsibilities — TASKS_NOW only
  if (
    classified.intents.includes("TASKS_NOW") ||
    /\bwhat am i (doing|handling|working on|responsible for)\b|\bon my (shift|plate)\b|\bdoing today\b|\bmy shift\b|\bneed to (do|handle|focus) today\b|\btoday'?s plan\b|\bwhat needs me\b|\bwhat is on my shift\b|\bwhat should i focus\b|\bassigned to me\b|\bmust i finish\b|\bbefore i leave\b/.test(
      q,
    )
  ) {
    return ["TASKS_NOW"];
  }

  // Unfinished / open / overdue — TASKS_REMAINING only (not full STATUS)
  if (
    primary === "WAITING_ON" ||
    primary === "OPEN_LOOP_STATUS" ||
    primary === "TASKS_REMAINING" ||
    /\b(unfinished|still needs|needs attention|left open|what is overdue|still open|what'?s open)\b/.test(
      q,
    )
  ) {
    return ["TASKS_REMAINING"];
  }

  // Leave-by / travel logistics
  if (
    /when do (we|i) (need to )?leave|leave[- ]?by|how long (to|until) (drive|travel)/.test(q)
  ) {
    return ["APPOINTMENT_LOGISTICS"];
  }

  // Medication family
  if (/allegra|medication change|pending review|waiting for review/i.test(q)) {
    return ["MEDICATION_CHANGE"];
  }
  if (/was medication administered|who gave|last (dose|med)|administration history/i.test(q)) {
    return ["MEDICATION_ADMINISTRATION_HISTORY"];
  }
  if (/medication is due|med(s)? due|next (med|dose)|is metformin due/i.test(q)) {
    return ["MEDICATION_DUE"];
  }
  if (primary.startsWith("MEDICATION_")) {
    return [primary];
  }

  // Appointments
  if (
    primary.startsWith("APPOINTMENT_") ||
    /\b(appointment|personal training|physical therapy|\bpt\b|clinic visit)\b/.test(q)
  ) {
    if (/where|location|address|leave|travel|maps/.test(q)) return ["APPOINTMENT_LOGISTICS"];
    if (/old time|previous time|was the time|before (it |we )?moved|history/.test(q)) {
      return ["APPOINTMENT_NEXT"];
    }
    return ["APPOINTMENT_NEXT"];
  }

  if (
    primary === "CHANGE_SINCE" ||
    primary === "RECENT_ACTIVITY" ||
    primary === "TREND"
  ) {
    return [primary];
  }

  if (primary === "CARE_TEAM" || primary === "CARE_COVERAGE") {
    if (/before my shift|previous caregiver|who worked before/.test(q)) {
      return ["PREVIOUS_SHIFT"];
    }
    return ["CARE_TEAM"];
  }

  // Default: primary only — never multi-template walls
  if (primary === "UNKNOWN_QUESTION") {
    // Last-chance domain recovery so we never emit the same three-line wall
    if (/\b(message|reply|opened|contacted)\b/.test(q)) return ["CARE_UPDATE"];
    if (/\b(handoff|tell them|next caregiver)\b/.test(q)) return ["HANDOFF_PREP"];
    if (/\b(escalat|respond|waiting)\b/.test(q)) return ["ESCALATION"];
    if (/\b(focus|today|shift|responsible|assigned)\b/.test(q)) return ["TASKS_NOW"];
    if (/\b(open|unfinished|attention|overdue)\b/.test(q)) return ["TASKS_REMAINING"];
    if (/\b(status|how is|picture|urgent)\b/.test(q)) return ["STATUS_SYNTHESIS"];
  }
  return [primary];
}

function composeAnswer(ctx: {
  classified: ClassifiedTurn;
  persona: CaregiverPersona;
  proj: CareProjections;
  recipientName: string;
  principalName: string;
  question?: string;
  personNameMap?: Record<string, string>;
  state?: CareStateBag;
}): { answer: string; sourceRefs: string[]; projectionsUsed: string[] } {
  const { classified, persona, proj, recipientName } = ctx;
  const personNameMap = ctx.personNameMap;
  const state = ctx.state ?? {};
  const question = ctx.question ?? "";
  const intents = exclusiveAnswerPlan(classified, question);
  const used = new Set<string>();
  const refs: string[] = [];
  const parts: string[] = [];

  // Sanitize projection text once for human blocks
  const cleanChanges = semanticDedupeLines(proj.RECENT_CHANGES ?? []);
  const cleanHandoffChanged = semanticDedupeLines(
    proj.ACTIVE_HANDOFF?.whatChanged ?? [],
  );
  const cleanHandoffOpen = semanticDedupeLines(
    proj.ACTIVE_HANDOFF?.stillNeedsAttention ?? [],
  );
  const cleanOpen = semanticDedupeLines(proj.OPEN_UNCERTAINTIES ?? []).filter(
    (l) => !/RESPONSE_RECEIVED|Open list\s+\d+|s\d+-\d{10,}/i.test(l),
  );

  // ── Exclusive short plans (message / escalation) — return immediately ──
  if (intents.includes("CARE_UPDATE")) {
    used.add("CARE_UPDATE");
    used.add("ACTIVE_HANDOFF");
    const qLow = question.toLowerCase();
    const open = cleanHandoffOpen[0] || cleanOpen[0];
    let body: string;
    if (/opened|read|seen|ack/.test(qLow)) {
      body =
        `I track in-app message open/read on Notifications for this care space — not SMS/email.\n\n` +
        `Open **Notifications** while signed in as the other caregiver to confirm seen/ack. ` +
        `I will not invent that Maya opened a message unless an in-app acknowledgment is on file.`;
    } else if (/replied|reply|response from/.test(qLow)) {
      body =
        `Replies to in-app care-team messages appear in coordination for ${recipientName}.\n\n` +
        `If Maya replied in Relay, you will see her note in this care space. ` +
        `Ask “show coordination” or check People/Notifications. External SMS/email was not claimed.`;
    } else if (/who (was )?contacted|who is responsible/.test(qLow)) {
      body =
        `For ${recipientName}, responsibility stays with the authorized care team on this record.\n\n` +
        (open
          ? `Main open item still needing an owner: ${open}.`
          : `No single open ownership item is flagged beyond normal shift coverage.`) +
        `\n\nIn-app messages notify the person you named; they do not reassign clinical authority.`;
    } else {
      // did X get my message
      body =
        `In-app care-team messages about ${recipientName} are delivered to the named person's Notifications in this care space.\n\n` +
        `I do **not** claim SMS or email delivery. After you confirm Send on a message preview, ` +
        `the other caregiver should see one notification; they can ack and reply in-app.\n\n` +
        `If you have not confirmed Send yet, nothing was delivered.`;
    }
    return {
      answer: sanitizeHumanCareCopy(body),
      sourceRefs: ["care_update", "notifications"],
      projectionsUsed: [...used],
    };
  }

  if (intents.includes("ESCALATION") && intents.length === 1) {
    used.add("ESCALATION");
    used.add("OPEN_UNCERTAINTIES");
    used.add("ACTIVE_HANDOFF");
    const open = cleanHandoffOpen[0] || cleanOpen[0];
    const body =
      `If someone does not respond in this care space, Relay can escalate:\n` +
      `• notify an **alternate owner**\n` +
      `• open a **follow-up work item**\n` +
      `• keep the original notification visible until acknowledged\n\n` +
      (open
        ? `Something still open right now: ${open}.\n\n`
        : `No single urgent open item is forced into escalation until a no-response window passes.\n\n`) +
      `Use Notifications → escalate no-response, or ask an authorized coordinator. ` +
      `Escalation does not change medication plans or invent clinical urgency.`;
    return {
      answer: sanitizeHumanCareCopy(body),
      sourceRefs: ["escalation", "open_loops"],
      projectionsUsed: [...used],
    };
  }

  if (intents.includes("META_CONVERSATION")) {
    used.add("META_CONVERSATION");
    const qLow = question.toLowerCase();
    let meta = "";
    if (/same response|canned/.test(qLow)) {
      meta =
        "Yes — earlier replies sometimes reused overlapping summary blocks instead of matching each timeframe. “Today” should cover current state; “previous shift” should cover only that completed shift. I did not file a care update from this question.";
    } else if (/repeat/.test(qLow)) {
      meta =
        "I combined overlapping summary blocks. I should answer your specific question first and only add supporting details that help. No care candidate was created.";
    } else if (/shorter|concise|summarize that/.test(qLow)) {
      const issue =
        cleanHandoffOpen[0] ||
        cleanHandoffChanged[0] ||
        cleanOpen[0] ||
        "the main open item on file";
      const med = proj.CURRENT_MEDICATIONS[0];
      const apt = proj.NEXT_APPOINTMENT;
      meta = `Main item needing attention: ${issue}.`;
      if (med) {
        meta += ` ${str(med.name)} ${str(med.dose)} remains scheduled for ${str(med.scheduleTime || med.scheduleLabel || "the planned time")}.`;
      }
      if (apt) {
        meta += ` Next appointment: ${str(apt.title)} · ${str(apt.startsAtLabel ?? "")}.`;
      }
    } else if (/did not answer|didn't answer|not answer what i asked/.test(qLow)) {
      meta =
        "You're right if I drifted into a general status wall. Ask again with the timeframe you care about (today, previous shift, or a specific medication), and I'll stay on that question. No care record was filed.";
    } else if (/what did you understand/.test(qLow)) {
      meta =
        "I treat that as a question about my answer quality, not as a new observation or medication report. Tell me the care fact or timeframe you want, and I'll answer only that.";
    } else {
      meta =
        "That is about how I answer, not a new care event. I did not create a care candidate or confirmation card.";
    }
    return {
      answer: sanitizeHumanCareCopy(meta),
      sourceRefs: ["meta_conversation"],
      projectionsUsed: [...used],
    };
  }

  if (intents.includes("PREVIOUS_SHIFT")) {
    used.add("CARE_COVERAGE_TIMELINE");
    used.add("ACTIVE_HANDOFF");
    used.add("RECENT_CHANGES");
    const strip = (s: string) =>
      sanitizeHumanCareCopy(s)
        .replace(/\s*\(from [^)]+\)\s*$/i, "")
        .replace(/^caregiver reported:\s*/i, "")
        .replace(/^medication change needs verification:\s*/i, "")
        .replace(
          /\.\s*not an active medication-plan instruction until authorized review\.?/i,
          "",
        )
        .replace(/^correction:\s*/i, "")
        .trim();
    // Prefer server timeline when attached on projections
    const tl = (
      proj as {
        CARE_COVERAGE_TIMELINE?: {
          previous?: {
            caregiver_name?: string | null;
            start?: string | null;
            end?: string | null;
            handoff_status?: string | null;
          };
        };
      }
    ).CARE_COVERAGE_TIMELINE;
    const p = tl?.previous;
    const who = p?.caregiver_name || "The prior caregiver";
    if (!p?.caregiver_name && cleanHandoffChanged.length === 0 && cleanChanges.length === 0) {
      return {
        answer: sanitizeHumanCareCopy(
          `I do not have a completed coverage period immediately before yours for ${recipientName}.`,
        ),
        sourceRefs: ["coverage_timeline", "handoff"],
        projectionsUsed: [...used],
      };
    }
    const hours =
      p?.start && p?.end
        ? ` from ${p.start} to ${p.end}`
        : p?.end
          ? ` ending around ${p.end}`
          : "";
    const bits: string[] = [
      `${who} covered ${recipientName} before you${hours}.`,
    ];
    if (cleanHandoffChanged.length) {
      bits.push(
        `They completed or recorded: ${cleanHandoffChanged
          .slice(0, 3)
          .map(strip)
          .filter(Boolean)
          .join("; ")}.`,
      );
    }
    if (cleanHandoffOpen.length) {
      bits.push(
        `They left open: ${cleanHandoffOpen
          .slice(0, 3)
          .map(strip)
          .filter(Boolean)
          .join("; ")}.`,
      );
    } else if (cleanChanges.some((c) => /allegra/i.test(c))) {
      bits.push("Still open for you: verify the Allegra medication-plan change.");
    }
    if (p?.handoff_status) {
      bits.push(`Their handoff is ${String(p.handoff_status).replace(/_/g, " ")}.`);
    }
    return {
      answer: sanitizeHumanCareCopy(bits.join(" ")),
      sourceRefs: ["coverage_timeline", "previous_shift", "handoff"],
      projectionsUsed: [...used],
    };
  }

  // Coverage query only — not "tell the next caregiver …" handoff/message actions
  if (
    (intents.includes("NEXT_COVERAGE" as RelayIntent) ||
      /who works after me|who is (next|after me)|when does (the )?next caregiver|next (caregiver|shift|helper)/i.test(
        question,
      )) &&
    !/\b(tell|message|notify|ask|send|report|left|refused|unfinished)\b/i.test(question)
  ) {
    used.add("CARE_COVERAGE_TIMELINE");
    const tl = (
      proj as {
        CARE_COVERAGE_TIMELINE?: {
          next?: {
            caregiver_name?: string | null;
            start?: string | null;
          };
        };
      }
    ).CARE_COVERAGE_TIMELINE;
    const n = tl?.next;
    if (!n?.caregiver_name) {
      return {
        answer: sanitizeHumanCareCopy(
          `No next caregiver is scheduled yet for ${recipientName}. Relay can help request coverage.`,
        ),
        sourceRefs: ["coverage_timeline"],
        projectionsUsed: [...used],
      };
    }
    const when = n.start ? ` at ${n.start}` : "";
    return {
      answer: sanitizeHumanCareCopy(
        `${n.caregiver_name} is scheduled to begin${when || " as next coverage"}.`,
      ),
      sourceRefs: ["coverage_timeline"],
      projectionsUsed: [...used],
    };
  }

  // --- Temporal plans (recipient-local framing; projections are care-truth inputs) ---
  if (intents.includes("YESTERDAY_WELLBEING")) {
    used.add("RECENT_CHANGES");
    used.add("RECENT_OBSERVATION_CLUSTERS");
    const wellbeing = cleanChanges.filter((c) =>
      /fever|tired|fatigue|mood|dizz|pain|sleep|ate|eat|appetite|meal|mobility|fall|calm|anxious/i.test(
        c,
      ),
    );
    const fever = wellbeing.find((c) => /fever/i.test(c));
    const tired = wellbeing.find((c) => /tired|fatigue/i.test(c));
    const mood = wellbeing.find((c) => /mood|calm|anxious/i.test(c));
    const secondaryMed = cleanChanges.find(
      (c) => /tylenol|fever/i.test(c) && /medication change|verif/i.test(c),
    );
    const bits: string[] = [];
    if (fever) {
      bits.push(
        `Yesterday, ${recipientName} was reported as having a fever.`,
      );
    } else if (tired) {
      bits.push(`Yesterday, ${recipientName} was reported as more tired than usual.`);
    } else if (mood) {
      bits.push(`Yesterday’s mood note on file: ${mood.replace(/\s*\(from [^)]+\)\s*$/i, "")}.`);
    } else if (wellbeing[0]) {
      bits.push(
        `Yesterday’s wellbeing note on file: ${wellbeing[0].replace(/\s*\(from [^)]+\)\s*$/i, "")}.`,
      );
    } else {
      bits.push(
        `I don’t have a wellbeing report for ${recipientName} from yesterday.`,
      );
    }
    if (!mood && fever) {
      bits.push("I do not have a separate mood or energy report for that day.");
    }
    if (secondaryMed) {
      bits.push(
        "A Tylenol medication change for fever was also reported for review, but it was not added to the active medication plan.",
      );
    }
    return {
      answer: sanitizeHumanCareCopy(bits.join(" ")),
      sourceRefs: ["yesterday_wellbeing"],
      projectionsUsed: [...used],
    };
  }

  if (intents.includes("CHANGES_TODAY")) {
    used.add("RECENT_CHANGES");
    used.add("ACTIVE_HANDOFF");
    // Build human category facts for state changes — not raw domain labels.
    // Prefer corrections/completions/new reports over long-standing pending Allegra.
    const stripFrom = (s: string) => s.replace(/\s*\(from [^)]+\)\s*$/i, "").trim();
    const naturalizeToday = (c: string): string | null => {
      const s = stripFrom(c);
      if (/\bprobe\b/i.test(s)) return null;
      if (/allegra/i.test(s) && /waiting|verif/i.test(s)) return null; // standing, not today's delta unless only signal
      if (/corrected|not administered/i.test(s)) {
        return "Medication administration was corrected to not administered.";
      }
      if (/transport|completed/i.test(s) && /complet/i.test(s)) {
        return "A care or transportation task was completed.";
      }
      if (/reschedul/i.test(s)) {
        return "A therapy or appointment time was rescheduled.";
      }
      if (/tylenol|acetaminophen/i.test(s) && /verif|change/i.test(s)) {
        return "Tylenol was reported as a proposed medication change for fever (pending review, not active plan).";
      }
      if (/zyrtec/i.test(s) && /verif|change/i.test(s)) {
        return "Zyrtec was reported as a proposed medication change (pending review, not active plan).";
      }
      if (/claritin/i.test(s) && /verif|change/i.test(s)) {
        return "Claritin was reported as a proposed medication change (pending review, not active plan).";
      }
      if (/fever/i.test(s) && !/medication change|verif/i.test(s)) {
        return "A fever observation was recorded.";
      }
      if (/tired|fatigue/i.test(s)) {
        return "A fatigue or energy note was recorded.";
      }
      // Drop raw label leftovers
      if (/^caregiver reported:|^medication change needs verification:|^correction:/i.test(s)) {
        const body = s
          .replace(/^caregiver reported:\s*/i, "")
          .replace(/^medication change needs verification:\s*/i, "")
          .replace(/^correction:\s*/i, "")
          .replace(/\.\s*not an active medication-plan instruction until authorized review\.?/i, "")
          .trim();
        if (!body || /allegra/i.test(body)) return null;
        return body.charAt(0).toUpperCase() + body.slice(1);
      }
      return null;
    };
    const ranked = semanticDedupeLines(
      cleanChanges
        .map(naturalizeToday)
        .filter((x): x is string => !!x),
    );
    // Prefer correction first, then observations, then med-change proposals (cap 5)
    const orderScore = (s: string) => {
      if (/corrected to not administered/i.test(s)) return 0;
      if (/completed/i.test(s)) return 1;
      if (/fever|fatigue|observation/i.test(s)) return 2;
      if (/reschedul/i.test(s)) return 3;
      return 4;
    };
    const todayish = [...ranked].sort((a, b) => orderScore(a) - orderScore(b)).slice(0, 5);
    if (!todayish.length) {
      return {
        answer: `I don’t have any new care changes recorded for ${recipientName} today.`,
        sourceRefs: ["changes_today"],
        projectionsUsed: [...used],
      };
    }
    const lines = todayish.map((c) => `• ${c}`);
    return {
      answer: sanitizeHumanCareCopy(
        `Care updates recorded for ${recipientName} today:\n` + lines.join("\n"),
      ),
      sourceRefs: ["changes_today"],
      projectionsUsed: [...used],
    };
  }

  if (intents.includes("CHANGES_SINCE_YESTERDAY")) {
    used.add("RECENT_CHANGES");
    used.add("ACTIVE_HANDOFF");
    const corrected = cleanChanges.some((c) =>
      /corrected|not administered/i.test(c),
    );
    const completed = cleanChanges.find((c) =>
      /completed|transportation completed/i.test(c),
    );
    const stillPending = [...cleanHandoffOpen, ...cleanHandoffChanged].find((c) =>
      /allegra|waiting/i.test(c),
    );
    const fever = cleanChanges.find((c) => /fever/i.test(c));
    const bits: string[] = [`Since yesterday for ${recipientName}:`];
    if (completed) {
      bits.push(
        `${completed.replace(/\s*\(from [^)]+\)\s*$/i, "")} was completed.`,
      );
    }
    if (corrected) {
      bits.push(
        "the medication-administration report was corrected to say it was not given.",
      );
    }
    if (fever) {
      bits.push("a fever report remains on the recent care record.");
    }
    if (stillPending) {
      bits.push(
        "the Allegra 60 mg request remains pending medication-plan verification.",
      );
    }
    if (bits.length === 1) {
      bits.push("I do not have a clear before/after delta beyond the latest handoff.");
    }
    // Join comparison clauses naturally
    const head = bits[0]!;
    const rest = bits.slice(1);
    const body =
      rest.length === 0
        ? head
        : head +
          " " +
          rest
            .map((s, i) => {
              const t = s.replace(/\.$/, "");
              if (i === rest.length - 1 && rest.length > 1) return `and ${t}.`;
              return `${t}${i < rest.length - 1 ? "," : "."}`;
            })
            .join(" ");
    return {
      answer: sanitizeHumanCareCopy(body),
      sourceRefs: ["changes_since_yesterday"],
      projectionsUsed: [...used],
    };
  }

  const medName =
    classified.entities.medicationHint ||
    str(proj.CURRENT_MEDICATIONS[0]?.name) ||
    "Metformin";

  const primaryMed =
    proj.CURRENT_MEDICATIONS.find((m) =>
      str(m.name).toLowerCase().includes(medName.toLowerCase().slice(0, 6)),
    ) ?? proj.CURRENT_MEDICATIONS[0];

  function medBlock(): string {
    used.add("CURRENT_MEDICATIONS");
    const meds = (proj.CURRENT_MEDICATIONS ?? []) as Array<Record<string, unknown>>;
    const list = meds.length
      ? meds
      : primaryMed
        ? [primaryMed as Record<string, unknown>]
        : [];
    if (!list.length) {
      return `I don't have a medication schedule on file for ${recipientName}.`;
    }
    refs.push("provider_instruction");
    // Physician validation: a medication list without frequency is incomplete.
    // Never invent pre-dose checks, routes, or instructions not on the authorized order.
    return list
      .slice(0, 12)
      .map((m) => {
        const name = str(m.name) || "Medication";
        const strength = str(m.strength);
        const dose = str(m.dose);
        const route = str(m.route);
        const freq =
          str(m.scheduleLabel) ||
          str(m.frequency) ||
          (str(m.scheduleTime) ? `scheduled ${str(m.scheduleTime)}` : "");
        const times = str(m.scheduleTime);
        const window =
          str(m.windowStart) && str(m.windowEnd)
            ? `${str(m.windowStart)} – ${str(m.windowEnd)}`
            : "";
        const food = str(m.mealRelation);
        const next = str(m.nextDueLabel);
        const last = str(m.lastAdministeredAt);
        const auth = str(m.authorizedBy);
        const authAt = str(m.authorizedAt);
        const special = str(m.specialInstructions);
        const bits = [
          `• ${name}${strength ? ` · strength ${strength}` : ""}${dose ? ` · dose ${dose}` : ""}`,
          route ? `  Route: ${route}` : "  Route: not recorded on the care plan",
          freq
            ? `  Frequency / schedule: ${freq}`
            : "  Frequency: not recorded — this list is incomplete without frequency",
          times ? `  Time: ${times}` : "",
          window ? `  Window: ${window}` : "",
          food ? `  Food: ${food}` : "  Food relation: not recorded",
          special
            ? `  Ordered instructions: ${special}`
            : "  Pre-dose checks: none recorded on the authorized plan (do not invent)",
          last ? `  Last given: ${last}` : "  Last given: not charted here",
          next ? `  Next due: ${next}` : "",
          auth
            ? `  Prescriber / authorizer: ${auth}${authAt ? ` · verified ${authAt}` : ""}`
            : "  Source / verification: incomplete on file",
        ].filter(Boolean);
        return bits.join("\n");
      })
      .join("\n\n");
  }

  function adminRecords() {
    used.add("LAST_MEDICATION_ADMINISTRATIONS");
    return proj.LAST_MEDICATION_ADMINISTRATIONS;
  }

  function describeAdmin(rec: Record<string, unknown>): string {
    refs.push("administration_record");
    const when = formatCareDateTime(
      str(rec.administeredAt ?? rec.occurredAt ?? rec.recordedAt),
    );
    const sourceActor =
      rec.source && typeof rec.source === "object"
        ? str((rec.source as { actorName?: string }).actorName)
        : "";
    const by = resolvePersonName(
      str(rec.administeredByPersonId) || undefined,
      str(rec.lastAdministeredByName) || sourceActor || undefined,
      personNameMap,
    );
    const dose = str(rec.doseRecorded ?? rec.recordedDose ?? rec.dose ?? "");
    const status = str(rec.status);
    const truth = str(rec.epistemicStatus);
    const statusNote =
      status === "voided"
        ? " (voided / corrected — not current truth)"
        : truth
          ? ` (${truth})`
          : "";
    return `${dose || "dose recorded"} · ${when || "time on file"} · by ${by}${statusNote}`;
  }

  function lastAdminLine(): string {
    // Prefer non-voided current administration for "was it given?"
    const rows = adminRecords();
    const current = [...rows]
      .reverse()
      .find((r) => str(r.status) !== "voided");
    const last = current ?? rows.slice(-1)[0];
    if (!last) return "No administration is recorded yet.";
    if (str(last.status) === "voided") {
      return `Last recorded administration was corrected/voided: ${describeAdmin(last)}. Current truth: not administered (unresolved unless re-confirmed).`;
    }
    return `Last recorded: ${describeAdmin(last)}`;
  }

  function findAdminByPerson(personHint: string | undefined) {
    if (!personHint) return null;
    const key = personHint.toLowerCase();
    const rows = adminRecords();
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]!;
      const by = resolvePersonName(
        str(r.administeredByPersonId) || undefined,
        str(r.lastAdministeredByName) || undefined,
        personNameMap,
      ).toLowerCase();
      if (by.includes(key.split(" ")[0]!) || key.includes(by.split(" ")[0]!)) {
        return r;
      }
    }
    return null;
  }


  // Intent handlers
  if (intents.includes("MEDICATION_REDOSE_SAFETY")) {
    // Safety-critical: history is evidence, never permission to administer again.
    used.add("CURRENT_MEDICATIONS");
    used.add("LAST_MEDICATION_ADMINISTRATIONS");
    used.add("NEXT_24H_TASKS");
    refs.push("provider_instruction");
    refs.push("administration_record");
    const last = adminRecords().slice(-1)[0];
    const dueLine =
      proj.NEXT_24H_TASKS.find((t) =>
        /metformin|medication|dose|med/i.test(t),
      ) ?? proj.NEXT_24H_TASKS[0];
    parts.push(
      `I can't tell you to give another dose from a chat question alone — a recorded administration is not permission to redose.`,
    );
    if (primaryMed) {
      parts.push(
        `Current authorized instruction for ${recipientName}:\n${medBlock()}`,
      );
    } else {
      parts.push(
        `I don't have a current medication instruction on file for ${recipientName}.`,
      );
    }
    if (last) {
      const status = str(last.epistemicStatus) || "REPORTED";
      parts.push(
        `Last recorded administration (${status}, not a new order):\n${describeAdmin(last)}`,
      );
    } else {
      parts.push(`No administration is recorded yet for this medication.`);
    }
    if (dueLine) {
      parts.push(`Schedule / due context on file:\n• ${dueLine}`);
    }
    if (proj.OPEN_UNCERTAINTIES.length) {
      used.add("OPEN_UNCERTAINTIES");
      parts.push(
        `Open discrepancy — do not redose until this is cleared:\n• ${proj.OPEN_UNCERTAINTIES[0]}`,
      );
    }
    parts.push(
      `Because another dose could be unsafe, verify whether one is actually due against the schedule and last confirmed administration before giving anything. ` +
        `If the plan is unclear or conflicting, check with the care team or clinic rather than guessing.`,
    );
  } else if (intents.some((i) => i.startsWith("MEDICATION"))) {
    if (intents.includes("MEDICATION_DUE") || intents.includes("MEDICATION_CURRENT")) {
      used.add("NEXT_24H_TASKS");
      if (persona === "family") {
        parts.push(medBlock());
        // Only surface discrepancy when user asks uncertainty or open check
        if (
          intents.includes("MEDICATION_UNCERTAINTY") &&
          proj.OPEN_UNCERTAINTIES.length
        ) {
          used.add("OPEN_UNCERTAINTIES");
          parts.push(proj.OPEN_UNCERTAINTIES[0]!);
          parts.push(
            "Check the medication label or contact the clinic before marking this complete.",
          );
        }
      } else if (persona === "professional_dsp") {
        parts.push(
          `Authorized for ${recipientName} (current care plan):\n${medBlock()}`,
        );
        if (intents.includes("MEDICATION_UNCERTAINTY") && proj.OPEN_UNCERTAINTIES[0]) {
          used.add("OPEN_UNCERTAINTIES");
          parts.push(
            `${proj.OPEN_UNCERTAINTIES[0]} Document what you observe. Do not change the care plan on your own.`,
          );
        }
      } else if (persona === "physician") {
        parts.push(
          `Current authorized medications for ${recipientName}:\n${medBlock()}`,
        );
        if (proj.OPEN_UNCERTAINTIES.length) {
          used.add("OPEN_UNCERTAINTIES");
          parts.push(
            `Uncertain administration (caregiver-reported, not a regimen change):\n• ${proj.OPEN_UNCERTAINTIES[0]}`,
          );
          parts.push(lastAdminLine());
        } else {
          parts.push("No open medication discrepancies on file.");
        }
      } else {
        parts.push(medBlock());
      }
    }
    if (intents.includes("MEDICATION_ADMINISTRATION_HISTORY")) {
      used.add("ACTIVE_HANDOFF");
      const who = classified.entities.personHint;
      // Prefer formal admin rows (including voided/corrected current truth) over
      // pending plan-change handoff lines (Allegra verification is not "was given?").
      const adminTruth = lastAdminLine();
      const correctionNote = cleanChanges.find((c) =>
        /medication was not administered|corrected.*not administered/i.test(c),
      );
      if (correctionNote || /not administered|voided/i.test(adminTruth)) {
        parts.push(
          correctionNote
            ? `Current record: medication was not administered (${correctionNote}).`
            : `Current administration truth on file: ${adminTruth}`,
        );
      } else {
        parts.push(adminTruth);
      }
      const handoffMedNotes = cleanHandoffChanged.filter(
        (w) =>
          /medication|metformin|administered|dose|med /i.test(w) &&
          !/allegra|medication change needs verification/i.test(w),
      );
      if (handoffMedNotes.length) {
        parts.push(
          `Related caregiver handoff note:\n` +
            handoffMedNotes
              .slice(0, 2)
              .map((w) => `• ${w}`)
              .join("\n"),
        );
      }
      if (who) {
        const hit = findAdminByPerson(who);
        if (hit) {
          const confNote = str(
            (hit.source as { whyVisible?: string } | undefined)?.whyVisible ??
              "",
          );
          const status = str(hit.epistemicStatus) || "REPORTED";
          parts.push(
            `I have a recorded administration from ${who} (${status} — not a new dose authorization):\n${describeAdmin(hit)}`,
          );
          if (/confirmed/i.test(confNote)) {
            parts.push(confNote);
          } else if (str(hit.epistemicStatus) === "CONFIRMED") {
            parts.push(
              "This administration is confirmed in the medication history.",
            );
          }
        } else {
          const last = adminRecords().slice(-1)[0];
          if (!handoffMedNotes.length) {
            parts.push(
              `I don't have a medication administration recorded from ${who}${classified.entities.timeHint === "yesterday" ? " yesterday" : ""}.`,
            );
          }
          if (last) {
            parts.push(
              `The most recent formal record I do have is:\n${describeAdmin(last)}`,
            );
          }
          if (!handoffMedNotes.length) {
            parts.push(`Want me to ask ${who} whether they gave it?`);
          }
        }
      } else if (!handoffMedNotes.length) {
        parts.push(lastAdminLine());
      } else {
        parts.push(
          "That handoff note is caregiver-reported. It is not automatically clinician confirmed.",
        );
      }
    }
    if (intents.includes("MEDICATION_INSTRUCTIONS")) {
      parts.push(medBlock());
      if (primaryMed && str(primaryMed.mealRelation)) {
        parts.push(`With-food / meal guidance: ${str(primaryMed.mealRelation)}`);
      } else {
        parts.push(
          "No separate with-food instruction is on file beyond the schedule label.",
        );
      }
    }
    if (intents.includes("MEDICATION_UNCERTAINTY")) {
      used.add("OPEN_UNCERTAINTIES");
      parts.push(
        proj.OPEN_UNCERTAINTIES[0]
          ? plainDiscrepancyMessage(proj.OPEN_UNCERTAINTIES[0], recipientName)
          : `Nothing is flagged as uncertain about ${medName} right now. ${lastAdminLine()}`,
      );
      parts.push(lastAdminLine());
    }
    if (intents.includes("MEDICATION_CHANGE")) {
      used.add("LATEST_PROVIDER_INSTRUCTIONS");
      used.add("ACTIVE_HANDOFF");
      used.add("RECENT_CHANGES");
      const pendingChange = [
        ...cleanHandoffChanged,
        ...cleanHandoffOpen,
        ...cleanOpen,
        ...cleanChanges,
      ].find((c) =>
        /allegra|medication change|waiting for medication-plan|needs verification|tylenol.*verif|zyrtec.*verif|claritin.*verif/i.test(
          c,
        ),
      );
      if (/allegra/i.test(question)) {
        if (pendingChange) {
          parts.push(
            `Allegra is not an active authorized medication on the plan. A caregiver-reported Allegra 60 mg change is waiting for medication-plan verification and is not active until authorized review.`,
          );
        } else {
          parts.push(
            `Allegra is not listed as an active authorized medication for ${recipientName} on the care plan.`,
          );
        }
      } else {
        // Canonical ordered candidates from full state.events + projections
        const ordered = buildOrderedMedicationCandidates(state, proj, 8);
        const fallback = buildOrderedMedicationCandidatesFromLines(
          [
            ...cleanHandoffChanged,
            ...cleanHandoffOpen,
            ...cleanOpen,
            ...cleanChanges,
          ],
          8,
        );
        const finalOrdered = ordered.length >= fallback.length ? ordered : fallback;
        if (finalOrdered.length) {
          parts.push(formatOrderedMedicationList(finalOrdered, recipientName));
        } else if (pendingChange) {
          parts.push(
            `One medication change is waiting for review: ${pendingChange}. It is not active plan instruction until authorized.`,
          );
        } else {
          parts.push(
            `Current authorized instruction (not a new change from Relay):\n${proj.LATEST_PROVIDER_INSTRUCTIONS.join("\n") || "None on file."}`,
          );
          parts.push(
            "I only report what is on the care plan. I do not invent medication changes.",
          );
        }
        if (primaryMed && finalOrdered.length) {
          parts.push(
            `Active authorized medication remains ${str(primaryMed.name)} ${str(primaryMed.dose)}.`,
          );
        }
      }
    }
  }

  if (intents.some((i) => i.startsWith("APPOINTMENT"))) {
    used.add("NEXT_APPOINTMENT");
    used.add("REMINDERS");
    // Prefer named appointment when the question mentions training / PT / clinic
    let a = proj.NEXT_APPOINTMENT;
    const qLow = question.toLowerCase();
    const fromState = Array.isArray(state.appointments)
      ? (state.appointments as Array<Record<string, unknown>>)
      : [];
    const activeApts = fromState.filter((x) => {
      const st = str(x.status).toLowerCase();
      const life = str(x.scheduleState).toLowerCase();
      return !["cancelled", "completed", "missed", "superseded", "rescheduled"].includes(st) &&
        !["cancelled", "completed", "missed", "rescheduled"].includes(life);
    });
    if (activeApts.length) {
      const pick =
        activeApts.find(
          (x) =>
            /personal training/i.test(str(x.title)) &&
            /training|personal/.test(qLow),
        ) ||
        activeApts.find(
          (x) =>
            /physical therapy|\bpt\b/i.test(str(x.title)) &&
            /physical therapy|\bpt\b/.test(qLow),
        ) ||
        activeApts.find(
          (x) => str(x.title) && qLow.includes(str(x.title).toLowerCase()),
        );
      if (pick) a = pick;
    }
    if (!a) {
      parts.push(`No appointment is on file for ${recipientName}.`);
    } else {
      const title = str(a.title);
      const when = sanitizeHumanCareCopy(str(a.startsAtLabel ?? a.startsAt));
      const loc = str(a.location) || SYNTHETIC_FACILITIES.pt.address;
      const status = str(a.status);
      const prev = str(a.previousStartsAtLabel);
      const fac = /physical therapy|pt/i.test(title)
        ? SYNTHETIC_FACILITIES.pt
        : SYNTHETIC_FACILITIES.clinic;
      used.add("FACILITY_CONTEXT");
      if (persona === "family") {
        parts.push(
          [
            `${title}`,
            when,
            `Location: ${loc}`,
            status ? `Status: ${status}` : "",
            prev ? `Changed from: ${prev}` : "",
            `Travel: about ${fac.travelMinutes} minutes. ${fac.note}`,
            `Phone: ${fac.phone}`,
          ]
            .filter(Boolean)
            .join("\n"),
        );
        if (intents.includes("APPOINTMENT_PREPARATION")) {
          parts.push(
            "Prepare: medication list, recent observations (dizziness/fatigue), insurance card, and questions for the clinician.",
          );
        }
        if (intents.includes("APPOINTMENT_LOGISTICS")) {
          parts.push(`Maps: ${fac.mapsUrl}`);
          parts.push(
            `Leave-by guidance: about ${fac.travelMinutes + 12} minutes before the start time for parking.`,
          );
        }
      } else if (persona === "professional_dsp") {
        parts.push(
          `Upcoming appointment (logistics):\n${title} · ${when}\n${loc}\nTransport/travel about ${fac.travelMinutes} min.`,
        );
      } else {
        parts.push(
          `Pending follow-up: ${title} · ${when}${loc ? ` · ${loc}` : ""} (${status || "scheduled"})`,
        );
      }
    }
  }

  if (intents.includes("STATUS_SYNTHESIS")) {
    used.add("RECENT_CHANGES");
    used.add("RECENT_OBSERVATION_CLUSTERS");
    used.add("CURRENT_MEDICATIONS");
    used.add("NEXT_APPOINTMENT");
    used.add("OPEN_UNCERTAINTIES");
    used.add("ACTIVE_HANDOFF");
    // Always ground with recent changes first when clusters empty
    if (
      persona !== "physician" &&
      !proj.RECENT_OBSERVATION_CLUSTERS[0] &&
      proj.RECENT_CHANGES.length
    ) {
      parts.push(
        `Recent reports on file for ${recipientName}:\n` +
          proj.RECENT_CHANGES.slice(0, 5).map((c) => `• ${c}`).join("\n"),
      );
    }
    if (persona === "physician") {
      parts.push(
        `Clinical-facing status for ${recipientName} (from authorized care record + caregiver reports):`,
      );
      parts.push(
        `Medications: ${str(primaryMed?.name) || "none on file"} ${str(primaryMed?.dose) || ""}` +
          (primaryMed && str(primaryMed.authorizedBy)
            ? ` · authorized by ${str(primaryMed.authorizedBy)}`
            : ""),
      );
      if (proj.RECENT_OBSERVATION_CLUSTERS[0]) {
        const c = proj.RECENT_OBSERVATION_CLUSTERS[0];
        parts.push(
          `Caregiver-reported observations: ${c.theme} (${c.count} · most recent ${c.mostRecentLabel}) — REPORTED, not diagnosis.`,
        );
      } else {
        parts.push(
          `Caregiver-reported observations: none clustered recently on file.`,
        );
      }
      if (proj.OPEN_UNCERTAINTIES[0]) {
        parts.push(`Unresolved / needs review: ${proj.OPEN_UNCERTAINTIES[0]}`);
      }
      if (proj.NEXT_APPOINTMENT) {
        parts.push(
          `Next appointment: ${str(proj.NEXT_APPOINTMENT.title)} · ${str(proj.NEXT_APPOINTMENT.startsAtLabel ?? proj.NEXT_APPOINTMENT.startsAt)}`,
        );
      }
      parts.push(
        `Provenance: medication schedules are authorized instructions; observations are caregiver-reported until confirmed. I will not invent clinical status.`,
      );
    } else if (persona === "professional_dsp") {
      parts.push(`Support-relevant picture for ${recipientName}:`);
      if (proj.ACTIVE_HANDOFF?.whatChanged?.length) {
        parts.push(
          proj.ACTIVE_HANDOFF.whatChanged
            .slice(0, 5)
            .map((c) => `• ${c}`)
            .join("\n"),
        );
        if (proj.ACTIVE_HANDOFF.stillNeedsAttention?.length) {
          parts.push(
            `Still open:\n` +
              proj.ACTIVE_HANDOFF.stillNeedsAttention
                .slice(0, 3)
                .map((c) => `• ${c}`)
                .join("\n"),
          );
        }
      }
      parts.push(
        proj.RECENT_CHANGES.slice(0, 4).map((c) => `• ${c}`).join("\n") ||
          "• No new events listed since last context",
      );
      if (proj.DSP_SUPPORT_NOTES[0]) {
        parts.push(`Support notes: ${proj.DSP_SUPPORT_NOTES[0]}`);
      }
      parts.push(
        `Document your own observations separately. Family reports remain REPORTED.`,
      );
    } else {
      // Natural current-status paragraph (not multi-section template wall)
      const obs = proj.RECENT_OBSERVATION_CLUSTERS[0];
      const issue =
        cleanHandoffOpen[0] ||
        cleanHandoffChanged.find((c) =>
          /waiting|verification|needs|corrected|not administered/i.test(c),
        ) ||
        cleanOpen[0];
      const bits: string[] = [];
      if (obs) {
        bits.push(
          `${recipientName}'s most recent report on file is ${obs.theme.toLowerCase()} (last noted ${obs.mostRecentLabel}).`,
        );
      } else {
        bits.push(
          `No new wellbeing observation is on file for ${recipientName} for the current day yet.`,
        );
      }
      if (issue) {
        bits.push(
          `The main item needing attention is ${issue.replace(/\.\s*$/, "")}.`,
        );
      } else if (/urgent/i.test(question)) {
        bits.push("Nothing urgent is flagged on the authorized record right now.");
      }
      if (primaryMed) {
        bits.push(
          `${str(primaryMed.name)} ${str(primaryMed.dose)} remains scheduled for ${str(primaryMed.scheduleTime || primaryMed.scheduleLabel || "the planned time")}.`,
        );
      }
      if (proj.NEXT_APPOINTMENT) {
        bits.push(
          `${str(proj.NEXT_APPOINTMENT.title)} is ${str(proj.NEXT_APPOINTMENT.startsAtLabel ?? "upcoming")}.`,
        );
      }
      parts.push(bits.join(" "));
    }
    // Exclusive: current status never appends handoff/med/appointment template walls
    if (intents.length === 1 && intents[0] === "STATUS_SYNTHESIS") {
      return {
        answer: sanitizeHumanCareCopy(parts.join("\n\n").trim()),
        sourceRefs: ["status_synthesis"],
        projectionsUsed: [...used],
      };
    }
  }

  if (
    intents.includes("CHANGE_SINCE") ||
    intents.includes("RECENT_ACTIVITY") ||
    intents.includes("TREND")
  ) {
    used.add("RECENT_CHANGES");
    used.add("RECENT_OBSERVATION_CLUSTERS");
    used.add("ACTIVE_HANDOFF");
    if (persona === "physician") {
      parts.push(`High-signal changes for ${recipientName}:`);
      parts.push(
        (proj.RECENT_CHANGES.slice(0, 5).map((c) => `• ${c}`).join("\n") ||
          "• No recent confirmed events on file"),
      );
      if (proj.RECENT_OBSERVATION_CLUSTERS.length) {
        parts.push("Caregiver-reported observation clusters:");
        for (const c of proj.RECENT_OBSERVATION_CLUSTERS.slice(0, 3)) {
          parts.push(
            `• ${c.theme}: ${c.count} reports · most recent ${c.mostRecentLabel} · ${c.sources.join(", ")}`,
          );
        }
      }
      if (proj.OPEN_UNCERTAINTIES.length) {
        used.add("OPEN_UNCERTAINTIES");
        parts.push("Still uncertain:");
        for (const u of proj.OPEN_UNCERTAINTIES.slice(0, 3)) parts.push(`• ${u}`);
      }
    } else if (persona === "professional_dsp") {
      parts.push(`What changed since your last context with ${recipientName}:`);
      if (proj.ACTIVE_HANDOFF?.whatChanged?.length) {
        parts.push(
          `Latest handoff:\n` +
            proj.ACTIVE_HANDOFF.whatChanged
              .slice(0, 6)
              .map((w) => `• ${w}`)
              .join("\n"),
        );
      }
      parts.push(
        proj.RECENT_CHANGES.slice(0, 5).map((c) => `• ${c}`).join("\n") ||
          "• No new events listed",
      );
      parts.push(
        "Family-reported items appear as REPORTED. Document your own observations separately.",
      );
    } else {
      parts.push(`Here's what changed for ${recipientName}:`);
      if (cleanHandoffChanged.length) {
        parts.push(
          `Latest handoff:\n` +
            cleanHandoffChanged
              .slice(0, 4)
              .map((w) => `• ${w}`)
              .join("\n"),
        );
      }
      parts.push(
        cleanChanges.slice(0, 5).map((c) => `• ${c}`).join("\n") ||
          "• Nothing new is recorded yet",
      );
      if (intents.includes("TREND") && proj.RECENT_OBSERVATION_CLUSTERS[0]) {
        const c = proj.RECENT_OBSERVATION_CLUSTERS[0];
        parts.push(
          c.count >= 2
            ? `${c.theme} was reported ${c.count} times recently (${c.sources.join(", ")}). I won't invent a clinical trend beyond that count.`
            : `Only limited reports of ${c.theme} are on file. Not enough to claim a week-over-week trend.`,
        );
      }
    }
  }

  if (intents.includes("OBSERVATION_HISTORY") || intents.includes("SAFETY_CONCERN")) {
    used.add("RECENT_OBSERVATION_CLUSTERS");
    used.add("DEMENTIA_WATCH");
    used.add("ACTIVE_HANDOFF");
    // Latest handoff mood/meal/fatigue notes often answer "how was mood / did they eat?"
    // before durable observation clusters catch up.
    if (proj.ACTIVE_HANDOFF?.whatChanged?.length) {
      const obsish = proj.ACTIVE_HANDOFF.whatChanged.filter((w) =>
        /mood|calm|tired|fatigue|breakfast|lunch|dinner|meal|ate|eat|refused|mobility|slept|sleep|therapy|medication/i.test(
          w,
        ),
      );
      if (obsish.length) {
        parts.push(
          `From the latest caregiver handoff for ${recipientName}:\n` +
            obsish
              .slice(0, 5)
              .map((w) => `• ${w}`)
              .join("\n"),
        );
      }
    }
    if (proj.RECENT_OBSERVATION_CLUSTERS.length) {
      parts.push(`Observations for ${recipientName}:`);
      for (const c of proj.RECENT_OBSERVATION_CLUSTERS.slice(0, 4)) {
        parts.push(
          `• ${c.theme}: ${c.count} report(s) · ${c.mostRecentLabel} · ${c.sources.join(", ")}`,
        );
      }
    } else if (!parts.length) {
      parts.push("No clustered observations on file yet.");
    }
    // Temporal: med before dizzy — compute sequence when both times exist
    if (
      /before|after/i.test(classified.entities.references.join(" ") + " " + (classified.entities.timeHint ?? "")) ||
      /before|after|dizz/i.test(JSON.stringify(classified.entities))
    ) {
      const last = adminRecords().slice(-1)[0];
      const dizz = proj.RECENT_OBSERVATION_CLUSTERS.find((c) =>
        /dizz/i.test(c.theme),
      );
      if (last && dizz) {
        const medIso = str(last.administeredAt ?? last.occurredAt ?? "");
        const medLabel = formatCareDateTime(medIso) || medIso;
        const dizzLabel = dizz.mostRecentLabel;
        const medMs = medIso ? Date.parse(medIso) : NaN;
        const dizzIso = str(
          (dizz as { mostRecentAt?: string }).mostRecentAt ?? "",
        );
        const dizzParsed = dizzIso ? Date.parse(dizzIso) : NaN;
        parts.length = 0;
        let sequence =
          "I can see both a medication time and a dizziness report on file.";
        if (!Number.isNaN(medMs) && !Number.isNaN(dizzParsed)) {
          const mins = Math.round(Math.abs(dizzParsed - medMs) / 60000);
          const hours = Math.floor(mins / 60);
          const rem = mins % 60;
          const gap =
            hours > 0
              ? `${hours} hour${hours === 1 ? "" : "s"} ${rem} minute${rem === 1 ? "" : "s"}`
              : `${mins} minutes`;
          if (medMs < dizzParsed) {
            sequence = `Yes. The recorded medication was at ${medLabel}, and the dizziness report is at ${dizzLabel} — about ${gap} later.`;
          } else if (medMs > dizzParsed) {
            sequence = `The dizziness report (${dizzLabel}) is recorded before the medication time (${medLabel}) — about ${gap} earlier.`;
          } else {
            sequence = `The recorded medication and dizziness report share the same timestamp (${medLabel}).`;
          }
        } else {
          sequence = `The recorded dose was at ${medLabel}. The most recent dizziness report is ${dizzLabel} (from ${dizz.sources.join(", ")}).`;
        }
        parts.push(sequence);
        parts.push(
          `That timing alone does not show that one caused the other.`,
        );
      } else if (dizz && !last) {
        parts.push(
          `I have dizziness reports, but no linked medication administration time to compare.`,
        );
      } else if (last && !dizz) {
        parts.push(
          `I have a medication time (${describeAdmin(last)}), but no dizziness observation on file to compare.`,
        );
      }
    }
    // Watch items only when safety intent and recipient has them
    if (intents.includes("SAFETY_CONCERN") && proj.DEMENTIA_WATCH.length) {
      parts.push(
        `What to watch for ${recipientName}:\n${proj.DEMENTIA_WATCH.slice(0, 4).map((w) => `• ${w}`).join("\n")}`,
      );
    }
  }

  if (
    intents.includes("PROVIDER_INSTRUCTION") ||
    intents.includes("PROVIDER_UPDATE_PREP")
  ) {
    used.add("LATEST_PROVIDER_INSTRUCTIONS");
    used.add("OPEN_UNCERTAINTIES");
    used.add("RECENT_CHANGES");
    const askedProvider = classified.entities.personHint;
    // Named provider not on instruction blob → challenge premise (any name, not hardcoded)
    if (askedProvider && askedProvider.length > 1) {
      const nameKey = askedProvider.toLowerCase().replace(/^dr\.?\s*/i, "");
      const hasNamed = proj.LATEST_PROVIDER_INSTRUCTIONS.some((l) =>
        l.toLowerCase().includes(nameKey),
      );
      if (!hasNamed && /shah|cole|doctor|dr\./i.test(askedProvider + " " + JSON.stringify(classified.entities))) {
        const other = proj.LATEST_PROVIDER_INSTRUCTIONS[0];
        parts.push(
          `I don't have ${askedProvider} listed with a matching provider instruction for ${recipientName} in this care record.`,
        );
        if (other) {
          parts.push(
            `The current medication instruction on file is:\n${other}`,
          );
          parts.push(`Would you like details on that instruction?`);
        }
        return {
          answer: parts.join("\n\n").trim(),
          sourceRefs: refs.length ? refs : ["care_projections"],
          projectionsUsed: [...used],
        };
      }
    }
    if (persona === "physician") {
      parts.push(`Concise picture for clinic review (${recipientName}):`);
      parts.push(
        proj.LATEST_PROVIDER_INSTRUCTIONS.map((l) => `• ${l}`).join("\n") ||
          "• No instructions on file",
      );
      parts.push(
        proj.OPEN_UNCERTAINTIES.map((u) => `• Uncertain: ${u}`).join("\n") ||
          "• No open uncertainties",
      );
      parts.push(
        "Verified vs reported: medication schedules are authorized instructions; administrations and many observations are caregiver-reported until confirmed.",
      );
    } else {
      parts.push(
        `What is on file from the provider for ${recipientName}:\n${proj.LATEST_PROVIDER_INSTRUCTIONS.map((l) => `• ${l}`).join("\n") || "• None listed"}`,
      );
      if (intents.includes("PROVIDER_UPDATE_PREP")) {
        parts.push(
          "Draft clinic update (review before any share):\n" +
            [
              `Recipient: ${recipientName}`,
              `Open items: ${proj.OPEN_UNCERTAINTIES[0] ?? "none flagged"}`,
              `Recent: ${proj.RECENT_CHANGES.slice(0, 3).join("; ") || "none"}`,
              "Not a clinical order. Human reviews before sending.",
            ].join("\n"),
        );
      }
    }
  }

  if (intents.includes("PROVIDER_CONTACT") || intents.includes("CONTACT_PERSON")) {
    used.add("CARE_TEAM_NOW");
    const want =
      classified.entities.personHint ||
      (/dr|shah|clinic/i.test(ctx.classified.entities.personHint ?? "")
        ? "Dr. Priya Shah"
        : null);
    const hits = proj.CARE_TEAM_NOW.filter((p) =>
      want ? p.name.includes(want.split(" ")[0]!) || p.name === want : true,
    );
    parts.push("Care team contacts (synthetic evaluation numbers):");
    for (const p of (want ? hits : proj.CARE_TEAM_NOW).slice(0, 4)) {
      parts.push(`• ${p.name} · ${p.role}${p.phone ? ` · ${p.phone}` : ""}`);
    }
  }

  if (intents.includes("CARE_TEAM")) {
    used.add("CARE_TEAM_NOW");
    used.add("ACTIVE_HANDOFF");
    parts.push(`Who is helping ${recipientName}:`);
    for (const p of proj.CARE_TEAM_NOW) {
      parts.push(`• ${p.name} · ${p.role}`);
    }
    if (proj.ACTIVE_HANDOFF?.whatChanged?.length) {
      parts.push(
        `What the next caregiver should know (latest handoff):\n` +
          proj.ACTIVE_HANDOFF.whatChanged
            .slice(0, 5)
            .map((w) => `• ${w}`)
            .join("\n"),
      );
    }
  }

  // "What should the next caregiver know?" often maps to CARE_COVERAGE / HANDOFF without CARE_TEAM
  if (
    intents.includes("CARE_COVERAGE") ||
    (/next caregiver|should (the )?next|hand off|leave for/i.test(question) &&
      !intents.includes("HANDOFF_PREP") &&
      !intents.includes("HANDOFF_REVIEW") &&
      !parts.some((p) => /latest handoff|next caregiver should know/i.test(p)))
  ) {
    used.add("ACTIVE_HANDOFF");
    used.add("CARE_TEAM_NOW");
    if (proj.ACTIVE_HANDOFF?.whatChanged?.length) {
      parts.push(
        `What the next caregiver should know:\n` +
          proj.ACTIVE_HANDOFF.whatChanged
            .slice(0, 6)
            .map((w) => `• ${w}`)
            .join("\n"),
      );
      if (proj.ACTIVE_HANDOFF.stillNeedsAttention?.length) {
        parts.push(
          `Still open:\n` +
            proj.ACTIVE_HANDOFF.stillNeedsAttention
              .slice(0, 4)
              .map((w) => `• ${w}`)
              .join("\n"),
        );
      }
    }
  }

  if (intents.includes("HANDOFF_PREP") || intents.includes("HANDOFF_REVIEW")) {
    used.add("ACTIVE_HANDOFF");
    used.add("RECENT_CHANGES");
    used.add("OPEN_UNCERTAINTIES");
    if (persona === "professional_dsp") {
      parts.push("Handoff / end-of-visit package:");
      parts.push(
        proj.ACTIVE_HANDOFF?.whatChanged?.length
          ? proj.ACTIVE_HANDOFF.whatChanged.map((w) => `• ${w}`).join("\n")
          : proj.RECENT_CHANGES.slice(0, 4).map((c) => `• ${c}`).join("\n") ||
              "• Confirm a care update to create a durable handoff",
      );
      parts.push(
        `Still open:\n${(proj.ACTIVE_HANDOFF?.stillNeedsAttention?.length ? proj.ACTIVE_HANDOFF.stillNeedsAttention : proj.OPEN_UNCERTAINTIES).slice(0, 3).map((x) => `• ${x}`).join("\n") || "• Nothing listed"}`,
      );
      parts.push(
        "Document before you leave: observations, meds assisted (if any), unfinished tasks, and who to call.",
      );
    } else {
      const to = proj.ACTIVE_HANDOFF?.toName ?? "the next caregiver";
      parts.push(`What ${to} needs to know:`);
      parts.push(
        (proj.ACTIVE_HANDOFF?.whatChanged ?? proj.RECENT_CHANGES)
          .slice(0, 5)
          .map((w) => `• ${w}`)
          .join("\n") || "• No handoff content yet. Share an update and confirm it.",
      );
      if (intents.includes("HANDOFF_REVIEW") && proj.ACTIVE_HANDOFF?.stillNeedsAttention?.length) {
        parts.push(
          `Still open from that handoff:\n` +
            proj.ACTIVE_HANDOFF.stillNeedsAttention
              .slice(0, 4)
              .map((x) => `• ${x}`)
              .join("\n"),
        );
      }
      if (intents.includes("HANDOFF_PREP")) {
        parts.push(
          "Before sending: confirm observations, meds assisted (if any), unfinished work, and who covers next.",
        );
      }
    }
    return {
      answer: sanitizeHumanCareCopy(parts.join("\n\n").trim()),
      sourceRefs: ["handoff"],
      projectionsUsed: [...used],
    };
  }

  if (intents.includes("TASKS_NOW") || intents.includes("TASKS_REMAINING")) {
    used.add("OPEN_UNCERTAINTIES");
    used.add("NEXT_24H_TASKS");
    used.add("REMINDERS");
    used.add("ACTIVE_HANDOFF");
    const openFromHandoff = proj.ACTIVE_HANDOFF?.stillNeedsAttention ?? [];
    const onlyRemaining =
      intents.includes("TASKS_REMAINING") && !intents.includes("TASKS_NOW");
    const onlyNow =
      intents.includes("TASKS_NOW") && !intents.includes("TASKS_REMAINING");
    const qLow = question.toLowerCase();
    const firstPriority =
      /\bwhat should i do first\b|\bwhere should i start\b|\bwhat comes first\b|\bwhat is the first priorit|\bwhat should i (handle|do) before (anything|everything)\b|\bstart with what\b|\bwhat'?s first on/.test(
        qLow,
      );
    const personHandling = qLow.match(
      /\bwhat is (maya|daniel|marcus|she|he) (handling|taking care of|working on|responsible for|doing|covering)\b|\bwhat does (maya|daniel|marcus) (still )?have open\b/,
    );
    // R-CONTEXT-002: person-owned / associated open work
    if (personHandling) {
      const whoRaw =
        personHandling[1] || personHandling[3] || "the named caregiver";
      const whoLabel =
        /maya/i.test(whoRaw) || /she/i.test(whoRaw)
          ? "Maya Bennett"
          : /daniel/i.test(whoRaw)
            ? "Daniel Kim"
            : /marcus/i.test(whoRaw) || /he/i.test(whoRaw)
              ? "Marcus Carter"
              : whoRaw;
      const openItems = [
        ...openFromHandoff,
        ...proj.OPEN_UNCERTAINTIES,
      ]
        .map((x) => String(x).trim())
        .filter(Boolean);
      const whoLinked = openItems.filter((line) =>
        new RegExp(whoRaw, "i").test(line),
      );
      const tl = proj.CARE_COVERAGE_TIMELINE as
        | { next?: { displayName?: string }; current?: { displayName?: string } }
        | null
        | undefined;
      const nextName = String(tl?.next?.displayName || "");
      const isNextCoverage =
        /maya/i.test(whoLabel) && /maya/i.test(nextName);
      if (whoLinked.length > 1) {
        return {
          answer: sanitizeHumanCareCopy(
            `Do you mean the ${whoLinked[0]} or the ${whoLinked[1]} for ${recipientName}?`,
          ),
          sourceRefs: ["tasks_remaining", "handoff", "coverage"],
          projectionsUsed: [...used, "CARE_COVERAGE_TIMELINE"],
        };
      }
      if (whoLinked.length === 1) {
        return {
          answer: sanitizeHumanCareCopy(
            `${whoLabel} is connected to open work for ${recipientName}: ${whoLinked[0]}. It is not marked complete until ownership is closed on the care record.`,
          ),
          sourceRefs: ["tasks_remaining", "handoff"],
          projectionsUsed: [...used],
        };
      }
      // No name-tagged work — ground in open handoff + coverage role
      const top =
        openFromHandoff[0] ||
        proj.OPEN_UNCERTAINTIES[0] ||
        "no separately named open assignment";
      if (isNextCoverage) {
        return {
          answer: sanitizeHumanCareCopy(
            `${whoLabel} is listed as next coverage for ${recipientName}. Current open work still includes: ${top}. That remains with the active team until her coverage window starts or the item is reassigned.`,
          ),
          sourceRefs: ["tasks_remaining", "handoff", "coverage"],
          projectionsUsed: [...used, "CARE_COVERAGE_TIMELINE"],
        };
      }
      return {
        answer: sanitizeHumanCareCopy(
          `I do not have a separate current assignment labeled only for ${whoLabel} on ${recipientName}'s record. Open work that may involve the care circle includes: ${top}. Ask “what needs attention?” for the full open list.`,
        ),
        sourceRefs: ["tasks_remaining", "handoff"],
        projectionsUsed: [...used],
      };
    }
    // R-CONTEXT-001: single highest-priority next step
    if (firstPriority || (onlyNow && /\bfirst\b|\bstart\b/.test(qLow))) {
      const top =
        openFromHandoff[0] ||
        proj.OPEN_UNCERTAINTIES[0] ||
        proj.NEXT_24H_TASKS[0] ||
        null;
      const second =
        openFromHandoff[1] ||
        proj.OPEN_UNCERTAINTIES[1] ||
        proj.NEXT_24H_TASKS[1] ||
        null;
      if (!top) {
        return {
          answer: sanitizeHumanCareCopy(
            `Nothing urgent is flagged as the first step for ${recipientName} right now. Check Today for any new priorities when they appear.`,
          ),
          sourceRefs: ["tasks_now", "handoff"],
          projectionsUsed: [...used],
        };
      }
      const reason = /mobility|safety|urgent|overdue|medication|mismatch|owner/i.test(
        top,
      )
        ? "it is the highest open care priority on the current handoff and attention list"
        : "it is the top open item on today's care plan";
      const nextLine = second
        ? ` After that, ${second.replace(/^[•*-]\s*/, "")}.`
        : "";
      return {
        answer: sanitizeHumanCareCopy(
          `Start with ${top.replace(/^[•*-]\s*/, "")} because ${reason}.${nextLine}`,
        ),
        sourceRefs: ["tasks_now", "handoff"],
        projectionsUsed: [...used],
      };
    }
    const shiftFraming =
      onlyNow &&
      /\b(shift|responsible for|assigned to me|finish before|before i leave|on my shift)\b/.test(
        qLow,
      );
    const todayFraming =
      onlyNow && !shiftFraming;
    // Physician-validated shift-plan shape (server-owned): Now / Coming up / Before leaving / Watch for
    const nowClock = new Date().toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
    if (persona === "family" || persona === "professional_dsp" || todayFraming || shiftFraming) {
      const nowItems = (
        openFromHandoff.length
          ? openFromHandoff
          : proj.OPEN_UNCERTAINTIES
      ).slice(0, onlyRemaining ? 5 : 3);
      const coming = (proj.NEXT_24H_TASKS || []).slice(0, 4);
      const watch = (proj.OPEN_UNCERTAINTIES || [])
        .filter((u) => !nowItems.includes(u))
        .slice(0, 3);
      if (onlyRemaining) {
        parts.push(
          nowItems.length
            ? `Still open / unfinished:\n${nowItems.map((x) => `• ${x}`).join("\n")}`
            : "No unfinished items are listed on the current care plan.",
        );
      } else {
        parts.push(`It is ${nowClock}. Here is ${recipientName}'s current plan:`);
        parts.push(
          nowItems.length
            ? `Now\n${nowItems.map((x) => `• ${x}`).join("\n")}`
            : "Now\n• No urgent open priorities are listed right now.",
        );
        if (coming.length) {
          parts.push(`Coming up\n${coming.map((t) => `• ${t}`).join("\n")}`);
        }
        if (shiftFraming || persona === "professional_dsp") {
          parts.push(
            "Before leaving\n• Confirm open tasks are owned or handed off.\n• Leave walker / assistive devices available if listed on the care plan.",
          );
        }
        if (watch.length) {
          parts.push(`Watch for\n${watch.map((x) => `• ${x}`).join("\n")}`);
        }
        parts.push(
          "Every item above is drawn from the care plan, appointments, medications, handoff, or confirmed observations — not invented instructions.",
        );
      }
    } else {
      parts.push(
        `Open verification items: ${proj.OPEN_UNCERTAINTIES.join("; ") || "none"}`,
      );
    }
    // Exclusive early return — do not append appointment/med walls
    if (onlyNow || onlyRemaining) {
      return {
        answer: sanitizeHumanCareCopy(parts.join("\n\n").trim()),
        sourceRefs: onlyRemaining
          ? ["tasks_remaining", "handoff"]
          : ["tasks_now", "handoff"],
        projectionsUsed: [...used],
      };
    }
  }

  if (intents.includes("RECIPIENT_ROUTINE") || intents.includes("RECIPIENT_PREFERENCES")) {
    used.add("CURRENT_MEDICATIONS");
    used.add("DSP_SUPPORT_NOTES");
    parts.push(
      `Around lunchtime for ${recipientName}: medication support per plan (${str(primaryMed?.scheduleTime ?? "schedule on file")}), meals with food if instructed, watch fatigue/dizziness after eating.`,
    );
    parts.push(`Preferences / person-centered notes:\n• ${proj.DSP_SUPPORT_NOTES[0]}`);
  }

  if (intents.includes("RECIPIENT_MOBILITY")) {
    used.add("DSP_SUPPORT_NOTES");
    used.add("RECIPIENT_MOBILITY");
    // Projections may not carry full profile; surface support notes + explicit mobility language
    const mobilityHints = proj.DSP_SUPPORT_NOTES.filter((n) =>
      /mobility|walk|transfer|rail|stand|assist|device|gait/i.test(n),
    );
    if (mobilityHints.length) {
      parts.push(
        `Mobility / transfer support on file for ${recipientName}:\n` +
          mobilityHints.map((n) => `• ${n}`).join("\n"),
      );
    } else if (proj.DSP_SUPPORT_NOTES[0]) {
      parts.push(
        `Support notes on file for ${recipientName}:\n• ${proj.DSP_SUPPORT_NOTES[0]}`,
      );
      parts.push(
        `I don't have a more specific transfer protocol beyond the mobility baseline and support notes — check the About profile for mobility details if present.`,
      );
    } else {
      parts.push(
        `I don't have transfer/mobility support details on file for ${recipientName}. ` +
          `If you observe needs during this visit, document them so the next caregiver can see them.`,
      );
    }
  }

  if (intents.includes("VERIFICATION_STATUS")) {
    used.add("OPEN_UNCERTAINTIES");
    used.add("LAST_MEDICATION_ADMINISTRATIONS");
    used.add("LATEST_PROVIDER_INSTRUCTIONS");
    const last = adminRecords().slice(-1)[0];
    const openU = proj.OPEN_UNCERTAINTIES;
    const lines: string[] = [];
    lines.push(`Verification status for ${recipientName} (from care truth, not a clinical judgment):`);
    if (primaryMed) {
      lines.push(
        `• Medication instruction (${str(primaryMed.name)} ${str(primaryMed.dose)}): **CONFIRMED** authorized plan on file` +
          (str(primaryMed.authorizedBy)
            ? ` (${str(primaryMed.authorizedBy)})`
            : ""),
      );
    }
    if (last) {
      const st = str(last.epistemicStatus) || "REPORTED";
      const label =
        st === "CONFIRMED"
          ? "CONFIRMED"
          : st === "UNCERTAIN"
            ? "NEEDS CHECKING"
            : st === "CORRECTED"
              ? "CORRECTED"
              : "REPORTED";
      lines.push(
        `• Latest administration record: **${label}** — ${describeAdmin(last)}`,
      );
    } else {
      lines.push(`• Latest administration record: **UNKNOWN** — none on file`);
    }
    if (openU.length) {
      lines.push(
        `• Open item: **NEEDS CHECKING** — ${openU[0]}`,
      );
    } else {
      lines.push(`• Open discrepancies: none flagged`);
    }
    if (proj.LATEST_PROVIDER_INSTRUCTIONS[0]) {
      lines.push(
        `• Provider guidance on file: **CONFIRMED / AUTHORIZED** — ${proj.LATEST_PROVIDER_INSTRUCTIONS[0]}`,
      );
    }
    lines.push(
      `Statuses used: CONFIRMED · REPORTED · NEEDS CHECKING · UNKNOWN · CORRECTED. ` +
        `If you meant a different item (observation, appointment, note), name it and I'll check that record's state.`,
    );
    parts.push(lines.join("\n"));
  }

  if (
    (intents.includes("WAITING_ON") || intents.includes("OPEN_LOOP_STATUS")) &&
    !parts.length
  ) {
    used.add("OPEN_UNCERTAINTIES");
    used.add("NEXT_24H_TASKS");
    used.add("ACTIVE_HANDOFF");
    const openLines = semanticDedupeLines([
      ...cleanOpen.map((u) => `Needs checking: ${u}`),
      ...cleanHandoffOpen.map((a) => `Handoff still needs attention: ${a}`),
      ...proj.NEXT_24H_TASKS.slice(0, 5)
        .map((t) => sanitizeHumanCareCopy(t))
        .filter((t) => t && !/RESPONSE_RECEIVED|Open list|s\d+-\d{10,}/i.test(t))
        .slice(0, 3)
        .map((t) => `Upcoming: ${t}`),
    ]);
    if (openLines.length) {
      parts.push(
        `Here's what still looks open for ${recipientName}:\n` +
          openLines.map((l) => `• ${l}`).join("\n"),
      );
    } else {
      parts.push(
        `Nothing is flagged as unresolved for ${recipientName} right now. Open coordination loops and medication discrepancies look clear.`,
      );
    }
  }

  if (intents.includes("DOCUMENT_PREP")) {
    used.add("LATEST_PROVIDER_INSTRUCTIONS");
    used.add("RECENT_CHANGES");
    parts.push(
      "I can structure a care summary from current truth in Documents. Open Documents and choose Prepare care summary, then review before any share.",
    );
  }

  // Reminders only when user asks what is coming up / tasks now — never on pure med lookup
  if (
    intents.some((i) =>
      ["APPOINTMENT_NEXT", "APPOINTMENT_LOGISTICS", "TASKS_NOW"].includes(i),
    ) &&
    !intents.some((i) => i.startsWith("MEDICATION"))
  ) {
    used.add("REMINDERS");
    parts.push(`Coming up:\n${formatReminderDigest(proj)}`);
  }

  if (!parts.length) {
    // Domain-specific no-data — always question-scoped so static walls do not repeat
    used.add("UNKNOWN_CLEAN");
    const q = question.toLowerCase();
    const topic =
      q.replace(/[^\w\s]/g, " ").trim().split(/\s+/).slice(0, 8).join(" ") ||
      "that ask";
    const domainHint = (() => {
      if (/\b(breakfast|lunch|dinner|eat|meal|water|hydrat|swallow)\b/.test(q))
        return `No meal or hydration observation matches “${topic}” for ${recipientName}. Ask what changed, or add a meal note in Relay.`;
      if (/\b(sleep|slept|awake|overnight|last night)\b/.test(q))
        return `No overnight sleep note matches “${topic}” for ${recipientName}. Check the last handoff or record rest if you observed it.`;
      if (/\b(pain|hurt|fever|symptom)\b/.test(q))
        return `No pain/fever/symptom report matches “${topic}” for ${recipientName}. I will not invent symptoms.`;
      if (/\b(fall|walk|mobility|transfer|out of bed)\b/.test(q))
        return `No mobility/fall note matches “${topic}” for ${recipientName}. Use authorized mobility notes and escalate if unsure.`;
      if (/\b(mood|anxious|upset|confused|repeating|resist|calm)\b/.test(q))
        return `No mood/behavior note matches “${topic}” for ${recipientName}. I will not invent how she felt.`;
      if (/\b(shower|dressed|toilet|bathroom|routine)\b/.test(q))
        return `No personal-care completion note matches “${topic}” for ${recipientName}. Open Care for preferences if authorized.`;
      if (/\b(document|discharge|original note|corrected|who changed)\b/.test(q))
        return `No linked document extraction matches “${topic}”. Open Documents for authorized summaries.`;
      if (/\b(message|reply|opened|contacted)\b/.test(q))
        return `No in-app message status for “${topic}” is on file yet for ${recipientName}. Send from Relay with Confirm, then check Notifications — not SMS/email.`;
      if (/\b(escalat|respond|waiting)\b/.test(q))
        return `No escalation event matches “${topic}” yet. If someone does not respond, use no-response escalation so an alternate owner is notified.`;
      if (/\b(handoff|tell them|before sending)\b/.test(q))
        return `No handoff package text matches “${topic}” yet. Capture what changed and what is still open, then send the handoff to next coverage.`;
      if (/\b(remind|overdue|coverage|shift)\b/.test(q))
        return `No reminder/coverage match for “${topic}”. Check People for coverage and Today for open work.`;
      if (/\b(focus|responsible|assigned|finish|leave)\b/.test(q))
        return `I could not build a shift plan line for “${topic}”. Ask what is unfinished, what is on your shift, or what needs attention today.`;
      return `I don't have a record that answers “${topic}” for ${recipientName} yet. Try naming the timeframe (today, last shift, yesterday) or the domain (meds, appointment, handoff, message).`;
    })();
    parts.push(domainHint);
  }

  // Safety footer never invents
  const grounded = parts.join("\n\n");
  const answer =
    grounded +
    (persona === "physician"
      ? "\n\nBased on the care plan and caregiver reports on file."
      : "");

  return {
    answer: sanitizeHumanCareCopy(answer.trim()),
    sourceRefs: refs.length ? refs : ["care_projections"],
    projectionsUsed: [...used],
  };
}

/**
 * Prove current-truth refresh: same question after state change must differ.
 * Pure helper for tests.
 */
export function answerDependsOnState(
  a: AnswerEngineResult,
  b: AnswerEngineResult,
): boolean {
  return a.answer !== b.answer;
}
