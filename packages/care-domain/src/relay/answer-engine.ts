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
  str as utilStr,
} from "./util.js";

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
  let classified = classifyIntent(input.question, input.priorEntities);
  if (input.resolveMemory) {
    classified = input.resolveMemory(classified, input.question);
  }

  const proj = buildProjections({
    state: input.state,
    recipientId: input.recipientId,
    recipientName: input.recipientName,
    attentionLines: input.attentionLines,
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

function composeAnswer(ctx: {
  classified: ClassifiedTurn;
  persona: CaregiverPersona;
  proj: CareProjections;
  recipientName: string;
  principalName: string;
}): { answer: string; sourceRefs: string[]; projectionsUsed: string[] } {
  const { classified, persona, proj, recipientName } = ctx;
  const intents = classified.intents;
  const used = new Set<string>();
  const refs: string[] = [];
  const parts: string[] = [];

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

  function lastAdminLine(): string {
    used.add("LAST_MEDICATION_ADMINISTRATIONS");
    const last = proj.LAST_MEDICATION_ADMINISTRATIONS.slice(-1)[0];
    if (!last) return "No administration is recorded yet.";
    refs.push("administration_record");
    const when = formatCareDateTime(
      str(last.administeredAt ?? last.occurredAt ?? last.recordedAt),
    );
    const by = resolvePersonName(
      str(last.administeredByPersonId) || undefined,
      str(last.lastAdministeredByName) || undefined,
    );
    const dose = str(last.doseRecorded ?? last.recordedDose ?? last.dose ?? "");
    return `Last recorded: ${dose || "dose recorded"} · ${when || "time on file"} · by ${by}`;
  }

  // Intent handlers
  if (intents.some((i) => i.startsWith("MEDICATION"))) {
    if (intents.includes("MEDICATION_DUE") || intents.includes("MEDICATION_CURRENT")) {
      used.add("NEXT_24H_TASKS");
      if (persona === "family") {
        parts.push(
          `Next for ${recipientName}:\n${medBlock()}`,
        );
        if (proj.OPEN_UNCERTAINTIES.length) {
          used.add("OPEN_UNCERTAINTIES");
          parts.push(
            `Still needs checking:\n• ${proj.OPEN_UNCERTAINTIES[0]}`,
          );
          parts.push("Next: check the medication label or contact the clinic before marking complete.");
        }
      } else if (persona === "professional_dsp") {
        parts.push(
          `Authorized medication support for ${recipientName} (per current care plan):\n${medBlock()}`,
        );
        parts.push(lastAdminLine());
        if (proj.OPEN_UNCERTAINTIES.length) {
          used.add("OPEN_UNCERTAINTIES");
          parts.push(
            `Unresolved medication question:\n• ${proj.OPEN_UNCERTAINTIES[0]}\nDocument what you observe. Do not change the care plan on your own.`,
          );
        }
        used.add("DSP_SUPPORT_NOTES");
        parts.push(`DSP note: ${proj.DSP_SUPPORT_NOTES[2]}`);
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
      parts.push(lastAdminLine());
      if (classified.entities.personHint) {
        parts.push(
          `You asked about ${classified.entities.personHint}. I attribute administrations by recorded person when available.`,
        );
      }
      if (classified.entities.timeHint === "yesterday") {
        parts.push(
          "Time focus: yesterday's record when present on the administration history.",
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
      parts.push(
        `Current authorized instruction (not a new change from Relay):\n${proj.LATEST_PROVIDER_INSTRUCTIONS.join("\n") || "None on file."}`,
      );
      parts.push(
        "I only report what is on the care plan. I do not invent medication changes.",
      );
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

  if (
    intents.includes("CHANGE_SINCE") ||
    intents.includes("RECENT_ACTIVITY") ||
    intents.includes("TREND")
  ) {
    used.add("RECENT_CHANGES");
    used.add("RECENT_OBSERVATION_CLUSTERS");
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
      parts.push(
        proj.RECENT_CHANGES.slice(0, 5).map((c) => `• ${c}`).join("\n") ||
          "• No new events listed",
      );
      parts.push(
        "Family-reported items appear as REPORTED. Document your own observations separately.",
      );
    } else {
      parts.push(`Here's what changed for ${recipientName}:`);
      parts.push(
        proj.RECENT_CHANGES.slice(0, 5).map((c) => `• ${c}`).join("\n") ||
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
    if (proj.RECENT_OBSERVATION_CLUSTERS.length) {
      parts.push(`Observations for ${recipientName}:`);
      for (const c of proj.RECENT_OBSERVATION_CLUSTERS.slice(0, 4)) {
        parts.push(
          `• ${c.theme}: ${c.count} report(s) · ${c.mostRecentLabel} · ${c.sources.join(", ")}`,
        );
      }
    } else {
      parts.push("No clustered observations on file yet.");
    }
    // Temporal: med before dizzy — only if evidence exists
    if (/before|after/i.test(classified.entities.references.join(" ")) || classified.intents.includes("OBSERVATION_HISTORY")) {
      const hasDizz = proj.RECENT_OBSERVATION_CLUSTERS.some((c) =>
        /dizz/i.test(c.theme),
      );
      const hasAdmin = proj.LAST_MEDICATION_ADMINISTRATIONS.length > 0;
      if (hasDizz && hasAdmin) {
        parts.push(
          "I have both dizziness reports and medication administration times on file, but I will not invent a causal link. Compare the timestamps in Care if you need sequence.",
        );
      } else if (hasDizz && !hasAdmin) {
        parts.push(
          "Dizziness is reported, but I don't have enough linked timing evidence to say whether it was before or after a specific dose.",
        );
      }
    }
    if (intents.includes("SAFETY_CONCERN") || persona === "family") {
      parts.push(`Watch items (dementia-aware support):\n${proj.DEMENTIA_WATCH.slice(0, 4).map((w) => `• ${w}`).join("\n")}`);
    }
  }

  if (
    intents.includes("PROVIDER_INSTRUCTION") ||
    intents.includes("PROVIDER_UPDATE_PREP")
  ) {
    used.add("LATEST_PROVIDER_INSTRUCTIONS");
    used.add("OPEN_UNCERTAINTIES");
    used.add("RECENT_CHANGES");
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
    parts.push(`Who is helping ${recipientName}:`);
    for (const p of proj.CARE_TEAM_NOW) {
      parts.push(`• ${p.name} · ${p.role}`);
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
    if (persona === "family") {
      parts.push(
        proj.OPEN_UNCERTAINTIES.length
          ? `Right now:\n• ${proj.OPEN_UNCERTAINTIES[0]}\nYou're okay to take this one step at a time.`
          : "Nothing urgent is flagged right now.",
      );
      parts.push(`Coming up:\n${proj.NEXT_24H_TASKS.slice(0, 3).map((t) => `• ${t}`).join("\n")}`);
    } else if (persona === "professional_dsp") {
      parts.push("During this visit, prioritize:");
      parts.push(proj.NEXT_24H_TASKS.slice(0, 4).map((t) => `• ${t}`).join("\n"));
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

  if (intents.includes("DOCUMENT_PREP")) {
    used.add("LATEST_PROVIDER_INSTRUCTIONS");
    used.add("RECENT_CHANGES");
    parts.push(
      "I can structure a care summary from current truth in Documents. Open Documents and choose Prepare care summary, then review before any share.",
    );
  }

  // Reminders digest on task/appointment questions
  if (
    intents.some((i) =>
      ["APPOINTMENT_NEXT", "APPOINTMENT_LOGISTICS", "TASKS_NOW", "MEDICATION_DUE"].includes(
        i,
      ),
    )
  ) {
    used.add("REMINDERS");
    parts.push(`Reminders (rule-based, not an LLM timer):\n${formatReminderDigest(proj)}`);
  }

  if (!parts.length) {
    // Unknown — still give decision-ready snapshot minimum
    used.add("NEXT_24H_TASKS");
    used.add("OPEN_UNCERTAINTIES");
    if (persona === "family") {
      parts.push(
        `I can help with medications, appointments, what changed, handoffs, and contacts for ${recipientName}.`,
      );
      parts.push(
        proj.OPEN_UNCERTAINTIES[0]
          ? `Right now: ${proj.OPEN_UNCERTAINTIES[0]}`
          : `Coming up: ${proj.NEXT_24H_TASKS[0] ?? "see Care for the full picture"}`,
      );
    } else if (persona === "professional_dsp") {
      parts.push(
        `Ask me what changed, what to complete, medication authorization, documentation, or escalation for ${recipientName}.`,
      );
    } else {
      parts.push(
        `Ask for changes since last encounter, uncertain administrations, or a concise caregiver-reported timeline for ${recipientName}.`,
      );
    }
  }

  // Safety footer never invents
  const grounded = parts.join("\n\n");
  const answer =
    grounded +
    (persona === "physician"
      ? "\n\nSources are care-plan and caregiver-reported records. Not a complete chart."
      : "");

  return {
    answer: answer.trim(),
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
