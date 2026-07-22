/**
 * Understand step: natural caregiver language → structured care candidates.
 *
 * Production path: Foundation LLMProvider abstraction (JSON extraction).
 * Fixture path: deterministic extractor, explicitly EvidenceMode = FIXTURE.
 *
 * Model output is ALWAYS a candidate representation.
 * Governance + human confirmation determine what becomes authoritative.
 * Regex/fixture extractor is NOT the production intelligence path.
 */

import type { LLMProvider } from "../llm/provider.js";
import type {
  AuthCareContext,
  CareCandidate,
  CareEventType,
  EpistemicStatus,
  EvidenceMode,
  MedicationSchedule,
  SafetyClass,
  SourceRef,
  UnderstoodCareSlice,
  VerificationBundle,
} from "../types.js";
import {
  classifyConsequentiality,
  detectMedicationDiscrepancy,
  isMedicalDosageRequest,
  isPromptInjection,
  isUnknownProtocolRequest,
  refuseDosageAdvice,
  refuseInjection,
  refuseUnknownProtocol,
  candidateToVerificationItem,
} from "./safety.js";

export interface UnderstandOptions {
  /**
   * fixture — deterministic lab extractor (EvidenceMode FIXTURE).
   * llm — call injected Foundation LLMProvider (live or scripted).
   */
  mode: "fixture" | "llm";
  provider?: LLMProvider;
  schedules?: MedicationSchedule[];
  /** Override recorded dose for med discrepancy lab cases. */
  recordedDoseOverride?: string;
  now?: string;
}

const EXTRACTION_SYSTEM = `You are Caretaker Relay's structured extraction component for caregiver coordination.
You do NOT diagnose, prescribe, or execute actions.
Return ONLY valid JSON matching this schema:
{
  "candidates": [
    {
      "eventType": "meal|observation|appointment_change|medication_administration|communication_request|task|note",
      "statement": "string",
      "timeLabel": "string|null",
      "dateLabel": "string|null",
      "confidence": 0.0-1.0,
      "epistemicStatus": "REPORTED|INFERRED|UNCERTAIN|CONFLICTED",
      "intendedRecipientName": "string|null",
      "recordedDose": "string|null"
    }
  ],
  "uncertainties": ["string"]
}
Rules:
- Soft observations like "seemed tired" are REPORTED or UNCERTAIN, never confirmed clinical diagnoses.
- Ambiguous times stay UNCERTAIN.
- Medication statements are candidates only; never invent doses.
- Do not invent protocols or clinical instructions.
- Prefer uncertainty over fabricated certainty.`;

function sourceRef(
  ctx: AuthCareContext,
  rawText: string,
  now: string,
): SourceRef {
  return {
    id: `src-${ctx.sessionId}-${Date.now().toString(36)}`,
    kind: "caregiver_text",
    label: "Caregiver care update",
    actorName: ctx.actorDisplayName,
    actorPersonId: ctx.actorPersonId,
    recordedAt: now,
    whyVisible: `${ctx.actorDisplayName} shared a care update in this session.`,
    rawExcerpt: rawText.slice(0, 280),
  };
}

function mkCandidate(
  partial: {
    eventType: CareEventType;
    statement: string;
    epistemicStatus: EpistemicStatus;
    confidence: number;
    timeLabel?: string;
    dateLabel?: string;
    intendedRecipientName?: string;
    intendedRecipientPersonId?: string;
    recordedDose?: string;
    consequentiality?: SafetyClass;
  },
  ctx: AuthCareContext,
  careRecipientName: string,
  source: SourceRef,
  idx: number,
): CareCandidate {
  const consequentiality =
    partial.consequentiality ??
    classifyConsequentiality(partial.eventType, {
      hasMedDiscrepancy: Boolean(
        partial.recordedDose && /\d/.test(partial.recordedDose),
      ),
    });
  return {
    id: `cand-${idx}-${Date.now().toString(36)}`,
    eventType: partial.eventType,
    statement: partial.statement,
    careRecipientId: ctx.careRecipientId,
    careRecipientName,
    sourceSpeakerPersonId: ctx.actorPersonId,
    sourceSpeakerName: ctx.actorDisplayName,
    timeLabel: partial.timeLabel,
    dateLabel: partial.dateLabel,
    confidence: partial.confidence,
    epistemicStatus: partial.epistemicStatus,
    consequentiality,
    intendedRecipientName: partial.intendedRecipientName,
    intendedRecipientPersonId: partial.intendedRecipientPersonId,
    recordedDose: partial.recordedDose,
    sourceReference: source,
    actionable: false,
  };
}

/**
 * Deterministic fixture extractor for golden tests and demos.
 * Marked EvidenceMode FIXTURE — not production intelligence.
 */
export function fixtureExtract(
  rawText: string,
  ctx: AuthCareContext,
  careRecipientName: string,
  opts?: { recordedDoseOverride?: string; now?: string },
): UnderstoodCareSlice {
  const text = rawText.trim();
  const now = opts?.now ?? new Date().toISOString();
  const source = sourceRef(ctx, text, now);
  const lower = text.toLowerCase();
  const candidates: CareCandidate[] = [];
  const uncertainties: string[] = [];
  let i = 0;

  if (!text) {
    return emptySlice(ctx, careRecipientName, text, "FIXTURE");
  }

  // Meal
  if (/ate|meal|lunch|breakfast|dinner|noon/.test(lower)) {
    const aroundNoon = /around noon|at noon|noon|12\s*pm|12:00/.test(lower);
    candidates.push(
      mkCandidate(
        {
          eventType: "meal",
          statement: aroundNoon ? "Meal around noon" : "Meal recorded",
          epistemicStatus: "REPORTED",
          confidence: aroundNoon ? 0.9 : 0.7,
          timeLabel: aroundNoon ? "around noon" : undefined,
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
  }

  // Soft observation — MUST remain reported/uncertain, not "has fatigue" diagnosis
  if (/tired|fatigue|fatigued|exhausted|weaker|seemed/.test(lower)) {
    const soft = /seemed|a little|more tired than usual/.test(lower);
    candidates.push(
      mkCandidate(
        {
          eventType: "observation",
          statement: soft
            ? "Caregiver reported: seemed more tired than usual"
            : "Caregiver reported tiredness",
          epistemicStatus: soft ? "REPORTED" : "UNCERTAIN",
          confidence: soft ? 0.75 : 0.55,
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
  }

  // Appointment
  if (/pt|physical therapy|appointment/.test(lower)) {
    if (
      /\b(might|may|maybe|possibly)\b/.test(lower) &&
      /\b(move|moved|reschedul\w*)\b/.test(lower)
    ) {
      candidates.push(
        mkCandidate(
          {
            eventType: "appointment_change",
            statement: "PT might move (not confirmed)",
            epistemicStatus: "UNCERTAIN",
            confidence: 0.4,
          },
          ctx,
          careRecipientName,
          source,
          ++i,
        ),
      );
      uncertainties.push("Appointment change is uncertain / not confirmed");
    } else if (/2:30|14:30/.test(lower) && /moved|reschedul|to/.test(lower)) {
      candidates.push(
        mkCandidate(
          {
            eventType: "appointment_change",
            statement: "PT moved to Thursday at 2:30 PM",
            epistemicStatus: "REPORTED",
            confidence: 0.88,
            timeLabel: "2:30 PM",
            dateLabel: "Thursday",
          },
          ctx,
          careRecipientName,
          source,
          ++i,
        ),
      );
    } else if (/moved|reschedul/.test(lower)) {
      candidates.push(
        mkCandidate(
          {
            eventType: "appointment_change",
            statement: "Appointment time changed",
            epistemicStatus: "UNCERTAIN",
            confidence: 0.5,
          },
          ctx,
          careRecipientName,
          source,
          ++i,
        ),
      );
      uncertainties.push("New appointment time not fully clear");
    }
  }

  // Medication states must NOT collapse: negation / intent / completed / uncertain
  const medTopic =
    /medication|meds|dose|mg|lunch med/i.test(lower) ||
    (/gave|administered|took|give/.test(lower) && /med|dose|lunch/.test(lower));
  const negatedMed =
    /\b(did\s+not|didn't|not)\s+(give|gave|administer)/i.test(text) ||
    /\b(did\s+not|didn't)\b.*\b(medication|meds|dose)\b/i.test(lower);
  const intentMed =
    /\b(going to|will|gonna|plan to|about to)\b.*\b(give|administer)\b/i.test(
      text,
    ) ||
    /\b(give|administer)\b.*\b(later|tonight|this evening)\b/i.test(lower);
  const uncertainMed =
    /\b(i think|maybe|might have|may have|not sure if|possibly)\b.*\b(gave|give|administered|walter)\b/i.test(
      lower,
    ) ||
    /\b(think|maybe|might|may have)\b.*\b(medication|meds)\b/i.test(lower);

  if (negatedMed) {
    candidates.push(
      mkCandidate(
        {
          eventType: "note",
          statement: "Caregiver stated lunch medication was NOT given",
          epistemicStatus: "REPORTED",
          confidence: 0.9,
          consequentiality: "high",
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
    uncertainties.push(
      "Negative medication statement — must not create MedicationAdministration=given",
    );
  } else if (intentMed && medTopic) {
    candidates.push(
      mkCandidate(
        {
          eventType: "task",
          statement: "Intent: give lunch medication later (not yet administered)",
          epistemicStatus: "REPORTED",
          confidence: 0.8,
          consequentiality: "high",
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
    uncertainties.push(
      "Future medication intent — must not create MedicationAdministration=given",
    );
  } else if (uncertainMed && medTopic) {
    candidates.push(
      mkCandidate(
        {
          eventType: "note",
          statement:
            "Uncertain medication report (e.g. thinks someone may have given it) — not confirmed administration",
          epistemicStatus: "UNCERTAIN",
          confidence: 0.4,
          consequentiality: "high",
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
    uncertainties.push(
      "Uncertain medication attribution — do not record as given without verification",
    );
  } else if (medTopic && /gave|administered|took|given/.test(lower)) {
    const doseMatch = text.match(/(\d+(?:\.\d+)?)\s*mg/i);
    const dose =
      opts?.recordedDoseOverride ?? doseMatch?.[0] ?? undefined;
    candidates.push(
      mkCandidate(
        {
          eventType: "medication_administration",
          statement: dose
            ? `Lunch medication marked as given (${dose})`
            : "Lunch medication marked as given (as scheduled)",
          epistemicStatus: "REPORTED",
          confidence: 0.85,
          recordedDose: dose,
          timeLabel: "lunch",
          consequentiality: "high",
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
  }

  // Communication
  if (/let maya know|tell maya|update maya|maya know/.test(lower)) {
    candidates.push(
      mkCandidate(
        {
          eventType: "communication_request",
          statement: "Update ready for Maya",
          epistemicStatus: "REPORTED",
          confidence: 0.9,
          intendedRecipientName: "Maya",
          intendedRecipientPersonId: "p-maya",
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
  }

  if (/transport|ride|drive/.test(lower)) {
    candidates.push(
      mkCandidate(
        {
          eventType: "task",
          statement: "Confirm transportation",
          epistemicStatus: "REPORTED",
          confidence: 0.8,
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
  }

  if (candidates.length === 0) {
    uncertainties.push(
      "I heard you, but I'm not sure what to file yet. You can correct me.",
    );
  }

  return toSlice(candidates, uncertainties, text, ctx, careRecipientName, "FIXTURE");
}

function emptySlice(
  ctx: AuthCareContext,
  careRecipientName: string,
  rawText: string,
  mode: EvidenceMode,
): UnderstoodCareSlice {
  return {
    candidates: [],
    meals: [],
    observations: [],
    appointmentChanges: [],
    medicationEvents: [],
    communicationRequests: [],
    tasks: [],
    uncertainties: ["Empty message"],
    rawText,
    careRecipientId: ctx.careRecipientId,
    careRecipientName,
    evidenceMode: mode,
  };
}

function toSlice(
  candidates: CareCandidate[],
  uncertainties: string[],
  rawText: string,
  ctx: AuthCareContext,
  careRecipientName: string,
  mode: EvidenceMode,
  model?: { provider: string; model: string },
): UnderstoodCareSlice {
  const pick = (t: CareEventType) =>
    candidates.filter((c) => c.eventType === t).map((c) => c.statement);
  return {
    candidates,
    meals: pick("meal"),
    observations: pick("observation"),
    appointmentChanges: pick("appointment_change"),
    medicationEvents: pick("medication_administration"),
    communicationRequests: pick("communication_request"),
    tasks: pick("task"),
    uncertainties: [
      ...uncertainties,
      ...candidates
        .filter((c) => c.epistemicStatus === "UNCERTAIN")
        .map((c) => c.statement),
    ],
    rawText,
    careRecipientId: ctx.careRecipientId,
    careRecipientName,
    evidenceMode: mode,
    modelProvider: model?.provider,
    modelName: model?.model,
  };
}

function parseLlmJson(
  text: string,
  ctx: AuthCareContext,
  careRecipientName: string,
  source: SourceRef,
  rawText: string,
  model: { provider: string; model: string },
): UnderstoodCareSlice {
  try {
    const cleaned = text.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(cleaned) as {
      candidates?: Array<Record<string, unknown>>;
      uncertainties?: string[];
    };
    const candidates: CareCandidate[] = [];
    let i = 0;
    for (const c of parsed.candidates ?? []) {
      const eventType = String(c.eventType ?? "note") as CareEventType;
      candidates.push(
        mkCandidate(
          {
            eventType,
            statement: String(c.statement ?? ""),
            epistemicStatus: (String(
              c.epistemicStatus ?? "REPORTED",
            ) as EpistemicStatus),
            confidence: Number(c.confidence ?? 0.5),
            timeLabel: c.timeLabel ? String(c.timeLabel) : undefined,
            dateLabel: c.dateLabel ? String(c.dateLabel) : undefined,
            intendedRecipientName: c.intendedRecipientName
              ? String(c.intendedRecipientName)
              : undefined,
            recordedDose: c.recordedDose ? String(c.recordedDose) : undefined,
          },
          ctx,
          careRecipientName,
          source,
          ++i,
        ),
      );
    }
    return toSlice(
      candidates,
      parsed.uncertainties ?? [],
      rawText,
      ctx,
      careRecipientName,
      "LIVE_FOUNDATION_BACKED",
      model,
    );
  } catch {
    return toSlice(
      [
        mkCandidate(
          {
            eventType: "note",
            statement: "Could not parse model extraction; saved as note",
            epistemicStatus: "UNCERTAIN",
            confidence: 0.2,
          },
          ctx,
          careRecipientName,
          source,
          1,
        ),
      ],
      ["Model output was not valid structured JSON"],
      rawText,
      ctx,
      careRecipientName,
      "LIVE_FOUNDATION_BACKED",
      model,
    );
  }
}

export async function understandCareInput(
  rawText: string,
  ctx: AuthCareContext,
  careRecipientName: string,
  opts: UnderstandOptions,
): Promise<
  | { kind: "refusal"; message: string; evidenceMode: EvidenceMode }
  | { kind: "understood"; slice: UnderstoodCareSlice }
> {
  const text = rawText.trim();
  if (isUnknownProtocolRequest(text) || isPromptInjection(text)) {
    if (isPromptInjection(text) && !isUnknownProtocolRequest(text)) {
      return {
        kind: "refusal",
        message: refuseInjection(),
        evidenceMode: opts.mode === "fixture" ? "FIXTURE" : "LIVE_FOUNDATION_BACKED",
      };
    }
    return {
      kind: "refusal",
      message: refuseUnknownProtocol(text),
      evidenceMode: opts.mode === "fixture" ? "FIXTURE" : "LIVE_FOUNDATION_BACKED",
    };
  }
  if (isMedicalDosageRequest(text)) {
    return {
      kind: "refusal",
      message: refuseDosageAdvice(),
      evidenceMode: opts.mode === "fixture" ? "FIXTURE" : "LIVE_FOUNDATION_BACKED",
    };
  }

  if (opts.mode === "llm") {
    if (!opts.provider) {
      throw new Error(
        "Understand mode=llm requires an injected Foundation LLMProvider",
      );
    }
    const now = opts.now ?? new Date().toISOString();
    const source = sourceRef(ctx, text, now);
    const result = await opts.provider.generateResponse({
      system: EXTRACTION_SYSTEM,
      user: text,
      context: JSON.stringify({
        careRecipientId: ctx.careRecipientId,
        careRecipientName,
        actor: ctx.actorDisplayName,
        note: "Candidates only; do not execute actions.",
      }),
    });
    if (!result.ok) {
      // Fail closed to uncertainty — do not invent
      return {
        kind: "understood",
        slice: toSlice(
          [
            mkCandidate(
              {
                eventType: "note",
                statement: "Model unavailable; saved raw note for human review",
                epistemicStatus: "UNCERTAIN",
                confidence: 0.1,
              },
              ctx,
              careRecipientName,
              source,
              1,
            ),
          ],
          [result.fallback_message],
          text,
          ctx,
          careRecipientName,
          "LIVE_FOUNDATION_BACKED",
          { provider: result.provider, model: "unavailable" },
        ),
      };
    }
    return {
      kind: "understood",
      slice: parseLlmJson(
        result.text,
        ctx,
        careRecipientName,
        source,
        text,
        { provider: result.provider, model: result.model },
      ),
    };
  }

  // FIXTURE mode — explicit
  return {
    kind: "understood",
    slice: fixtureExtract(text, ctx, careRecipientName, {
      recordedDoseOverride: opts.recordedDoseOverride,
      now: opts.now,
    }),
  };
}

export function toVerificationBundle(
  understood: UnderstoodCareSlice,
  schedules: MedicationSchedule[] = [],
): VerificationBundle {
  const items = understood.candidates.map((c) => {
    const discrepancy =
      c.eventType === "medication_administration"
        ? detectMedicationDiscrepancy(c.recordedDose, schedules)
        : undefined;
    return candidateToVerificationItem(c, discrepancy);
  });
  for (const u of understood.uncertainties) {
    if (!items.some((i) => i.label === u)) {
      items.push({
        id: `v-unc-${items.length + 1}`,
        candidateId: "uncertainty",
        label: u,
        safetyClass: "low",
        epistemicStatus: "UNCERTAIN",
        requiresConfirmation: false,
      });
    }
  }
  return {
    title: "I got this",
    items,
    understood,
    evidenceMode: understood.evidenceMode,
  };
}
