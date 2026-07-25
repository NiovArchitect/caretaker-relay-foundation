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
import { extractDoseFromText } from "./dose-units.js";
import { resolveEffectiveAt } from "./care-time.js";

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
  const times = resolveEffectiveAt(
    partial.statement + " " + (partial.timeLabel ?? ""),
    new Date(source.recordedAt || Date.now()),
  );
  return {
    id: `cand-${idx}-${Date.now().toString(36)}`,
    eventType: partial.eventType,
    recordedAt: times.recordedAt,
    effectiveAt: times.effectiveAt,
    timePrecision: times.precision,
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
    const aroundNine =
      /around nine|at nine|about nine|9\s*(am|a\.m\.)?|nine o'?clock/.test(
        lower,
      );
    const timeLabel = aroundNoon
      ? "around noon"
      : aroundNine
        ? "around 9:00"
        : undefined;
    candidates.push(
      mkCandidate(
        {
          eventType: "meal",
          statement: aroundNoon
            ? "Meal around noon"
            : aroundNine
              ? "Breakfast / meal around 9:00"
              : "Meal recorded",
          epistemicStatus: "REPORTED",
          confidence: timeLabel ? 0.9 : 0.7,
          timeLabel,
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
  }

  
  // Uncertain medication by color/description — never invent identity/dose
  if (/blue (one|pill|pills)|pink (one|pill)|white (one|pill)|took (the |some )?pills?|not (sure|positive)|might have taken|already set some pills/.test(lower)) {
    const uncertain = /not (sure|positive)|think|maybe|might|not certain|i'?m not/.test(lower);
    candidates.push(
      mkCandidate(
        {
          eventType: "medication_administration",
          statement: uncertain
            ? "Medication reported with uncertainty (color/description only — identity and dose unknown)"
            : "Medication reported without matching authorized identity",
          epistemicStatus: "UNCERTAIN",
          confidence: 0.4,
          recordedDose: /blue/.test(lower) ? "unidentified blue tablet(s)" : "unidentified tablet(s)",
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
    uncertainties.push(
      "Medication identity/dose not established from color or vague description. Human verification required.",
    );
  }

  // Provider / PT schedule refusal or unavailability
  if (
    /(pt|physical therapy|thursday|appointment).{0,40}(won'?t work|will not work|can'?t make|cannot make|doesn'?t work)/.test(
      lower,
    ) ||
    /(won'?t work|will not work).{0,40}(pt|physical therapy|thursday|appointment)/.test(
      lower,
    ) ||
    /pt (called|said).{0,60}(won'?t|will not|can'?t|cannot)/.test(lower)
  ) {
    candidates.push(
      mkCandidate(
        {
          eventType: "appointment_change",
          statement:
            "PT/appointment timing problem reported (needs reschedule confirmation)",
          epistemicStatus: "REPORTED",
          confidence: 0.7,
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
    uncertainties.push(
      "New appointment time not specified — needs human confirmation.",
    );
  }

// Soft observation — MUST remain reported/uncertain, not "has fatigue" diagnosis
  // Positive / neutral wellbeing is valid caregiver evidence (REPORTED, not "needs checking")
  if (
    /feels?\s+(very\s+)?(good|great|well|better|fine|ok|okay|herself|himself|comfortable|energetic)|seems?\s+(very\s+)?(good|great|well|better|fine|herself|himself|comfortable|energetic|off)|ate well|slept (well|poorly|badly|ok)|appears?\s+comfortable|more energetic|in good spirits|in a good mood|doing (well|better|fine)/i.test(
      lower,
    )
  ) {
    const negative = /not\s+(good|well|fine)|poorly|badly|off\b/.test(lower);
    const slept = /slept/.test(lower);
    const ate = /ate/.test(lower);
    let statement = "Caregiver reported: general wellbeing / feels good";
    if (slept && /poor|bad/.test(lower))
      statement = "Caregiver reported: slept poorly";
    else if (slept) statement = "Caregiver reported: slept well";
    else if (ate) statement = "Caregiver reported: ate well";
    else if (negative)
      statement = "Caregiver reported: seems off / not their usual self";
    else if (/energetic|energy/.test(lower))
      statement = "Caregiver reported: more energetic than usual";
    else if (/comfortable/.test(lower))
      statement = "Caregiver reported: appears comfortable";
    candidates.push(
      mkCandidate(
        {
          eventType: "observation",
          statement,
          epistemicStatus: "REPORTED",
          confidence: 0.88,
          consequentiality: "low",
          timeLabel: /\btoday\b/.test(lower)
            ? "today"
            : /\bnow\b|right now/.test(lower)
              ? "now"
              : undefined,
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
  } else if (
    /tired|fatigue|fatigued|exhausted|weaker|seemed|dizzy|dizziness|light[- ]?headed/.test(
      lower,
    )
  ) {
    const soft = /seemed|a little|more tired than usual/.test(lower);
    const dizzy = /dizzy|dizziness|light[- ]?headed/.test(lower);
    candidates.push(
      mkCandidate(
        {
          eventType: "observation",
          statement: dizzy
            ? "Caregiver reported: dizziness when getting up"
            : soft
              ? "Caregiver reported: seemed more tired than usual"
              : "Caregiver reported tiredness",
          // Soft caregiver observations are REPORTED evidence, not clinical NEEDS CHECKING
          epistemicStatus: "REPORTED",
          confidence: soft || dizzy ? 0.75 : 0.65,
          consequentiality: dizzy ? "moderate" : "low",
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
  }

  // Appointment / schedule changes (PT or caregiver visit timing)
  const hasPt = /pt|physical therapy|appointment/.test(lower);
  const mayaTiming =
    /\bmaya\b/.test(lower) &&
    /\b(coming|arriving|visit|instead of|around three|around 3|3\s*pm|2\s*pm)\b/.test(
      lower,
    );
  if (hasPt || mayaTiming) {
    if (
      hasPt &&
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
    } else if (mayaTiming) {
      const toThree =
        /around three|around 3|3\s*(pm|p\.m\.)?|three o'?clock/.test(lower);
      const insteadOfTwo = /instead of two|instead of 2/.test(lower);
      candidates.push(
        mkCandidate(
          {
            eventType: "appointment_change",
            statement: toThree
              ? insteadOfTwo
                ? "Maya visit time changed to around 3:00 (was ~2:00)"
                : "Maya visit around 3:00"
              : "Maya visit time change reported",
            epistemicStatus: "REPORTED",
            confidence: 0.82,
            timeLabel: toThree ? "around 3:00" : undefined,
            intendedRecipientName: "Maya",
            intendedRecipientPersonId: "p-maya",
          },
          ctx,
          careRecipientName,
          source,
          ++i,
        ),
      );
    } else if (hasPt && /\b(moved|reschedul|to)\b/.test(lower)) {
      // Capture clock times: 2:30, 3:00, 14:30, 4:15 pm, etc.
      const clock = text.match(
        /\b(\d{1,2})(?::(\d{2}))\s*(am|pm|AM|PM)?\b/,
      );
      const dayMatch = text.match(
        /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
      );
      if (clock) {
        const hh = clock[1];
        const mm = clock[2] ?? "00";
        const mer = (clock[3] ?? "PM").toUpperCase();
        const timeLabel = `${hh}:${mm} ${mer}`;
        const day = dayMatch?.[1] ?? "Thursday";
        candidates.push(
          mkCandidate(
            {
              eventType: "appointment_change",
              statement: `PT moved to ${day} at ${timeLabel}`,
              epistemicStatus: "REPORTED",
              confidence: 0.88,
              timeLabel,
              dateLabel: day,
            },
            ctx,
            careRecipientName,
            source,
            ++i,
          ),
        );
      } else {
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
  }

  // Medication states must NOT collapse: negation / intent / completed / uncertain
  const medTopic =
    /medication|meds|dose|mg|lunch med|pills?|tablets?|blue pills?/i.test(
      lower,
    ) ||
    (/gave|administered|took|take|give/.test(lower) &&
      /med|dose|lunch|pill|tablet/.test(lower));
  const negatedMed =
    /\b(did\s+not|didn't|not)\s+(give|gave|administer)/i.test(text) ||
    /\b(did\s+not|didn't)\b.*\b(medication|meds|dose)\b/i.test(lower) ||
    /\b(definitely\s+did\s+not|never\s+got|did\s+not\s+get|didn't\s+get)\b/i.test(
      lower,
    ) ||
    /\b(not\s+get|never\s+received)\b.*\b(medication|meds|dose|it)\b/i.test(
      lower,
    );
  const intentMed =
    /\b(going to|will|gonna|plan to|about to)\b.*\b(give|administer)\b/i.test(
      text,
    ) ||
    /\b(give|administer)\b.*\b(later|tonight|this evening)\b/i.test(lower);
  const uncertainMed =
    /\b(i think|maybe|might have|may have|not sure if|possibly|forgot whether|don't remember if|do not remember if)\b.*\b(gave|give|administered|walter|got|medication|meds)\b/i.test(
      lower,
    ) ||
    /\b(think|maybe|might|may have|forgot|unsure|uncertain)\b.*\b(medication|meds|gave|give|got)\b/i.test(
      lower,
    ) ||
    /\b(whether\s+i\s+gave|if\s+i\s+gave|if\s+she\s+got|if\s+he\s+got)\b/i.test(
      lower,
    );

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
  } else if (medTopic && /gave|administered|took|taken|given/.test(lower)) {
    // Capture value+unit (mg, g, mcg, mL, textual forms) — not mg-only.
    // Also capture count phrases like "two of the blue pills" without inventing strength.
    let extracted = opts?.recordedDoseOverride ?? extractDoseFromText(text);
    const bluePills = /(?:two|2)\s+(?:of\s+the\s+)?blue\s+pills?\b/i.test(text);
    const pillCount = text.match(
      /\b(one|two|three|four|five|1|2|3|4|5)\s+(?:of\s+(?:the\s+)?)?(?:blue\s+)?pills?\b/i,
    );
    if (!extracted && pillCount) {
      const word = pillCount[1]!.toLowerCase();
      const n =
        word === "one"
          ? "1"
          : word === "two"
            ? "2"
            : word === "three"
              ? "3"
              : word === "four"
                ? "4"
                : word === "five"
                  ? "5"
                  : word;
      extracted = `${n} tablets`;
    }
    const dose = extracted ?? undefined;
    const ambiguousColorPills = bluePills || (!dose && /pills?|tablets?/.test(lower));
    candidates.push(
      mkCandidate(
        {
          eventType: "medication_administration",
          statement: ambiguousColorPills
            ? dose
              ? `Medication reported given (${dose}) — identity/strength needs checking`
              : "Medication reported given — amount/identity unclear"
            : dose
              ? `Lunch medication marked as given (${dose})`
              : "Lunch medication marked as given (as scheduled)",
          epistemicStatus: ambiguousColorPills ? "UNCERTAIN" : "REPORTED",
          confidence: ambiguousColorPills ? 0.55 : 0.85,
          recordedDose: dose,
          timeLabel: ambiguousColorPills ? undefined : "lunch",
          consequentiality: "high",
        },
        ctx,
        careRecipientName,
        source,
        ++i,
      ),
    );
    if (ambiguousColorPills) {
      uncertainties.push(
        "Medication report is ambiguous (e.g. color/count without matching strength). Relay will not guess the dose.",
      );
    }
  }

  // Communication / keep another caregiver in the loop
  if (
    /let maya know|tell maya|update maya|maya know|make sure she knows|make sure maya|can you make sure she|caught up|what.?s going on/.test(
      lower,
    ) &&
    (/\bmaya\b/.test(lower) ||
      /make sure she knows|what.?s going on/.test(lower))
  ) {
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
    const scheduleSummary = (opts.schedules ?? []).map((s) => ({
      name: s.name,
      dose: s.dose,
      schedule: s.scheduleLabel,
      authorizedBy: s.authorizedBy,
    }));
    const result = await opts.provider.generateResponse({
      system: EXTRACTION_SYSTEM,
      user: text,
      context: JSON.stringify({
        careRecipientId: ctx.careRecipientId,
        careRecipientName,
        actor: ctx.actorDisplayName,
        authorizedMedicationSchedules: scheduleSummary,
        note: "Candidates only; do not execute actions. Do not invent doses or diagnoses. If caregiver uses color-only pill language, mark UNCERTAIN.",
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
