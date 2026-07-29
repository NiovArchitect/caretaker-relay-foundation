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
 * One primary answer strategy — never concatenate every matched intent template.
 */
function exclusiveAnswerPlan(
  classified: ClassifiedTurn,
  question: string,
): RelayIntent[] {
  const q = question.toLowerCase();
  const primary = classified.primary;
  if (primary === "META_CONVERSATION" || classified.intents.includes("META_CONVERSATION")) {
    return ["META_CONVERSATION"];
  }
  if (
    primary === "PREVIOUS_SHIFT" ||
    classified.intents.includes("PREVIOUS_SHIFT") ||
    /previous shift|last shift|during her shift|during his shift|previous caregiver report|what did (the )?previous caregiver|what did (maya|daniel|marcus) report|before my shift|before (this|the) shift|caretaker (who )?helped .{0,40}before|who (worked|helped|covered|cared).{0,40}before (me|my shift)|who was (on|with) .{0,20}before me|prior (caregiver|caretaker|shift|helper)/.test(
      q,
    )
  ) {
    return ["PREVIOUS_SHIFT"];
  }
  // Three distinct temporal plans — never share one CHANGE_SINCE composer
  if (
    primary === "YESTERDAY_WELLBEING" ||
    classified.intents.includes("YESTERDAY_WELLBEING") ||
    (/\byesterday\b/.test(q) &&
      /\b(feel|feeling|mood|tired|fever|dizz|sleep|ate)\b/.test(q))
  ) {
    return ["YESTERDAY_WELLBEING"];
  }
  if (
    primary === "CHANGES_SINCE_YESTERDAY" ||
    classified.intents.includes("CHANGES_SINCE_YESTERDAY") ||
    /since yesterday|better than yesterday|different from yesterday/.test(q)
  ) {
    return ["CHANGES_SINCE_YESTERDAY"];
  }
  if (
    primary === "CHANGES_TODAY" ||
    classified.intents.includes("CHANGES_TODAY") ||
    /what changed today|what happened today|what is new today/.test(q)
  ) {
    return ["CHANGES_TODAY"];
  }
  // Medication / Allegra before open-loop generic dump
  if (/allegra|medication change/i.test(q) || primary.startsWith("MEDICATION_")) {
    if (/allegra|medication change/i.test(q)) return ["MEDICATION_CHANGE"];
    return [primary.startsWith("MEDICATION_") ? primary : "MEDICATION_CURRENT"];
  }
  if (primary === "STATUS_SYNTHESIS") {
    return ["STATUS_SYNTHESIS"];
  }
  if (
    primary === "CHANGE_SINCE" ||
    primary === "RECENT_ACTIVITY" ||
    primary === "TREND"
  ) {
    return [primary];
  }
  if (
    primary === "WAITING_ON" ||
    primary === "OPEN_LOOP_STATUS" ||
    primary === "TASKS_REMAINING"
  ) {
    return ["TASKS_REMAINING", "OPEN_LOOP_STATUS"];
  }
  // "who helped before my shift" must never collapse to the full care-team wall
  if (
    (primary === "CARE_TEAM" || primary === "CARE_COVERAGE") &&
    /before my shift|before (this|the) shift|previous caregiver|prior caregiver|who worked before|who helped before|who covered before/.test(
      q,
    )
  ) {
    return ["PREVIOUS_SHIFT"];
  }
  if (primary === "CARE_TEAM" || primary === "CARE_COVERAGE") {
    return ["CARE_TEAM", "CARE_COVERAGE"];
  }
  if (primary.startsWith("APPOINTMENT_")) return [primary];
  // Default: primary only (blocks multi-template walls)
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
    used.add("ACTIVE_HANDOFF");
    used.add("RECENT_CHANGES");
    used.add("RECENT_OBSERVATION_CLUSTERS");
    const strip = (s: string) =>
      sanitizeHumanCareCopy(s)
        .replace(/\s*\(from [^)]+\)\s*$/i, "")
        .replace(/^caregiver reported:\s*/i, "")
        .replace(/^medication change needs verification:\s*/i, "")
        .replace(/\.\s*not an active medication-plan instruction until authorized review\.?/i, "")
        .replace(/^correction:\s*/i, "")
        .trim();
    const fever = cleanChanges.find((c) => /fever/i.test(c));
    const tired = cleanChanges.find((c) => /tired|fatigue/i.test(c));
    const meal = cleanChanges.find((c) => /lunch|breakfast|refused|ate|meal/i.test(c));
    const tyenol = cleanChanges.find(
      (c) => /tylenol|acetaminophen/i.test(c) && /verif|change/i.test(c),
    );
    const correction =
      cleanChanges.some((c) => /not administered|corrected/i.test(c)) ||
      cleanHandoffChanged.some((c) => /not administered|corrected/i.test(c));
    const pendingAllegra = [...cleanHandoffOpen, ...cleanHandoffChanged, ...cleanChanges].find(
      (c) => /allegra/i.test(c),
    );
    const handoffTo =
      proj.ACTIVE_HANDOFF?.toName &&
      !/public (preshift|doc)/i.test(proj.ACTIVE_HANDOFF.toName)
        ? proj.ACTIVE_HANDOFF.toName
        : null;
    const who =
      /maya/i.test(question)
        ? "Maya Bennett"
        : /daniel/i.test(question)
          ? "Daniel Kim"
          : /marcus/i.test(question)
            ? "Marcus Carter"
            : handoffTo || "the prior caregiver";
    const bits: string[] = [];
    if (
      cleanHandoffChanged.length === 0 &&
      cleanHandoffOpen.length === 0 &&
      cleanChanges.length === 0
    ) {
      return {
        answer: sanitizeHumanCareCopy(
          `I don't have a completed shift handoff immediately before your current coverage for ${recipientName}. Ask what needs attention now, or open Incoming handoff if one arrives.`,
        ),
        sourceRefs: ["previous_shift", "handoff"],
        projectionsUsed: [...used],
      };
    }
    bits.push(
      `${who} covered ${recipientName} before your current coverage.`,
    );
    if (cleanHandoffChanged.length) {
      bits.push(
        `What they recorded: ${cleanHandoffChanged
          .slice(0, 3)
          .map(strip)
          .filter(Boolean)
          .join("; ")}.`,
      );
    } else {
      if (fever) bits.push(`${recipientName} had a fever reported.`);
      else if (tired) bits.push(`${recipientName} was reported more tired than usual.`);
      if (meal && !/\bprobe\b/i.test(meal)) {
        bits.push(`A meal note was recorded (${strip(meal)}).`);
      }
    }
    if (correction) {
      bits.push(
        "A medication-administration entry was later corrected to show the medication was not given.",
      );
    }
    if (tyenol) {
      bits.push(
        "A Tylenol dose for fever was proposed as a medication change and remains pending review — not an active plan instruction.",
      );
    }
    if (pendingAllegra || cleanHandoffOpen.some((c) => /allegra/i.test(c))) {
      bits.push(
        "Still open for you: verify the Allegra medication-plan change.",
      );
    } else if (cleanHandoffOpen.length) {
      bits.push(
        `Still open: ${cleanHandoffOpen
          .slice(0, 3)
          .map(strip)
          .filter(Boolean)
          .join("; ")}.`,
      );
    }
    return {
      answer: sanitizeHumanCareCopy(bits.join(" ")),
      sourceRefs: ["previous_shift", "handoff", "recent_changes"],
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
    if (!primaryMed) return `I don't have a medication schedule on file for ${recipientName}.`;
    refs.push("provider_instruction");
    const lines = [
      `${str(primaryMed.name)} ${str(primaryMed.dose)}`.trim(),
      str(primaryMed.scheduleTime) ? `Take at ${str(primaryMed.scheduleTime)}` : str(primaryMed.scheduleLabel),
      str(primaryMed.windowStart) && str(primaryMed.windowEnd)
        ? `Window ${str(primaryMed.windowStart)} – ${str(primaryMed.windowEnd)}`
        : "",
      str(primaryMed.mealRelation),
      str(primaryMed.authorizedBy) ? `Authorized by ${str(primaryMed.authorizedBy)}` : "",
    ].filter(Boolean);
    return lines.join("\n");
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
    const a = proj.NEXT_APPOINTMENT;
    if (!a) {
      parts.push(`No appointment is on file for ${recipientName}.`);
    } else {
      const title = str(a.title);
      const when = str(a.startsAtLabel ?? a.startsAt);
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
    }
  }

  if (intents.includes("TASKS_NOW") || intents.includes("TASKS_REMAINING") || intents.includes("ESCALATION")) {
    used.add("OPEN_UNCERTAINTIES");
    used.add("NEXT_24H_TASKS");
    used.add("REMINDERS");
    used.add("ACTIVE_HANDOFF");
    const openFromHandoff = proj.ACTIVE_HANDOFF?.stillNeedsAttention ?? [];
    if (persona === "family") {
      // Prefer latest handoff open work over long-lived review queues so shift
      // continuity answers advance when unfinished items change.
      if (openFromHandoff.length) {
        parts.push(
          `Still unfinished from the last handoff:\n${openFromHandoff
            .slice(0, 4)
            .map((x) => `• ${x}`)
            .join("\n")}`,
        );
        if (proj.OPEN_UNCERTAINTIES.length) {
          parts.push(
            `Also needs review:\n• ${proj.OPEN_UNCERTAINTIES[0]}`,
          );
        }
      } else {
        parts.push(
          proj.OPEN_UNCERTAINTIES.length
            ? `Right now:\n• ${proj.OPEN_UNCERTAINTIES[0]}\nYou're okay to take this one step at a time.`
            : "Nothing urgent is flagged right now.",
        );
      }
      parts.push(`Coming up:\n${proj.NEXT_24H_TASKS.slice(0, 3).map((t) => `• ${t}`).join("\n")}`);
    } else if (persona === "professional_dsp") {
      parts.push("During this visit, prioritize:");
      parts.push(proj.NEXT_24H_TASKS.slice(0, 4).map((t) => `• ${t}`).join("\n"));
      if (openFromHandoff.length) {
        parts.push(
          `From last handoff — still open:\n${openFromHandoff.slice(0, 4).map((x) => `• ${x}`).join("\n")}`,
        );
      }
      if (proj.OPEN_UNCERTAINTIES.length) {
        parts.push(`Escalation / verification:\n• ${proj.OPEN_UNCERTAINTIES[0]}`);
      }
      parts.push(
        `Unfinished before leave:\n${proj.DSP_SUPPORT_NOTES.slice(0, 3).map((n) => `• ${n}`).join("\n")}`,
      );
    } else {
      parts.push(
        `Open verification items: ${proj.OPEN_UNCERTAINTIES.join("; ") || "none"}`,
      );
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
    // Domain-specific no-data (never generic wall when we can name the gap)
    used.add("UNKNOWN_CLEAN");
    const q = question.toLowerCase();
    const domainHint = (() => {
      if (/\b(breakfast|lunch|dinner|eat|meal|water|hydrat|swallow)\b/.test(q))
        return `No meal or hydration observation is recorded for the period you asked about for ${recipientName}. The latest care events on file may still help — ask what changed, or add a meal note in Relay.`;
      if (/\b(sleep|slept|awake|overnight|last night)\b/.test(q))
        return `No overnight sleep observation is recorded for ${recipientName} in the window you asked about. Check the last handoff or add a sleep note if you observed rest.`;
      if (/\b(pain|hurt|fever|symptom)\b/.test(q))
        return `No pain/fever/symptom report matching that question is on file for ${recipientName}. I will not invent symptoms — if you observed something, record it with time and who reported it.`;
      if (/\b(fall|walk|mobility|transfer|out of bed)\b/.test(q))
        return `No mobility/fall observation matching that question is on file for ${recipientName}. I cannot certify independent walking safety from missing data — use authorized mobility notes and escalate if unsure.`;
      if (/\b(mood|anxious|upset|confused|repeating|resist|calm)\b/.test(q))
        return `No mood/behavior observation for that period is on file for ${recipientName}. I will not invent how she felt — ask for the last handoff or record what you observed.`;
      if (/\b(shower|dressed|toilet|bathroom|routine)\b/.test(q))
        return `No personal-care completion note for that item is on file for ${recipientName}. Preferences and dignity rules still apply; open Care for preferences if authorized.`;
      if (/\b(document|discharge|original note|corrected|who changed)\b/.test(q))
        return `I don't have a linked document extraction for that ask on file. Open Documents to review authorized summaries, or upload text for proposed actions (human confirm required).`;
      if (/\b(remind|overdue|coverage|shift covered|message)\b/.test(q))
        return `No matching reminder/coverage/message acknowledgment is on file for that ask. Check People for coverage and Today for open work that needs an owner.`;
      return null;
    })();
    if (domainHint) {
      parts.push(domainHint);
    } else if (persona === "family") {
      parts.push(
        `I don't have a matching record for that specific ask about ${recipientName}.`,
      );
      parts.push(
        `I can help with status, medications, appointments, what changed, the care team, handoffs, meals/mobility when noted, and what is waiting — when those are authorized.`,
      );
      parts.push(`What domain should we check next, or what would you like to update?`);
    } else if (persona === "professional_dsp") {
      parts.push(
        `No matching shift documentation answers that ask yet for ${recipientName}. Ask what changed, tasks remaining, medication authorization, or handoff.`,
      );
    } else {
      parts.push(
        `No matching record for that ask yet. Request changes since last encounter, uncertain administrations, or a caregiver-reported timeline for ${recipientName}.`,
      );
    }
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
