/**
 * Risk-based human-in-the-loop and medication safety.
 *
 * Consequence classes govern confirmation requirements.
 * Model output is never an autonomous clinical decision.
 */

import type {
  CareCandidate,
  MedicationDiscrepancy,
  MedicationSchedule,
  SafetyClass,
  VerificationItem,
} from "../types.js";

export function classifyConsequentiality(
  eventType: CareCandidate["eventType"],
  opts?: { hasMedDiscrepancy?: boolean; clinicalShare?: boolean },
): SafetyClass {
  if (opts?.hasMedDiscrepancy || opts?.clinicalShare) return "high";
  switch (eventType) {
    case "medication_administration":
      return "high";
    case "observation":
    case "appointment_change":
    case "communication_request":
    case "task":
      return "moderate";
    case "meal":
    case "note":
      return "low";
    default:
      return "moderate";
  }
}

export function requiresHumanConfirmation(safetyClass: SafetyClass): boolean {
  return safetyClass !== "low";
}

export function detectMedicationDiscrepancy(
  recordedDose: string | undefined,
  schedules: MedicationSchedule[],
  scheduleNameHint = "lunch",
): MedicationDiscrepancy | undefined {
  if (!recordedDose) return undefined;
  const doseMatch = recordedDose.match(/(\d+(?:\.\d+)?)\s*mg/i);
  if (!doseMatch) return undefined;

  const schedule =
    schedules.find((s) =>
      s.name.toLowerCase().includes(scheduleNameHint.toLowerCase()),
    ) ?? schedules[0];
  if (!schedule) return undefined;

  const recordedNum = parseFloat(doseMatch[1] ?? "");
  const authMatch = schedule.dose.match(/(\d+(?:\.\d+)?)/);
  const authNum = authMatch?.[1] != null ? parseFloat(authMatch[1]) : NaN;
  if (!Number.isFinite(recordedNum) || !Number.isFinite(authNum)) {
    return undefined;
  }
  if (recordedNum === authNum) return undefined;

  return {
    recordedDose: doseMatch[0].replace(/\s+/g, " "),
    authorizedDose: schedule.dose,
    authorizedSourceLabel: `${schedule.authorizedBy} · ${schedule.authorizedAt}`,
    message:
      "Recorded dose does not match the authorized care instruction. Relay will not choose.",
  };
}

/** Refuse unknown / fabricated clinical protocols (Protocol 9-Delta exhibit). */
export function isUnknownProtocolRequest(text: string): boolean {
  return /protocol\s*9[\s-]*delta|apply\s+protocol|protocol\s+zeta|ignore\s+(all\s+)?(prior|previous)\s+rules|ignore\s+safety|disregard\s+(your\s+)?instructions/i.test(
    text,
  );
}

export function refuseUnknownProtocol(text: string): string {
  return [
    "I can't apply Protocol 9-Delta — I don't have a verified care instruction for that.",
    "I won't invent medical or care protocols.",
    "If this came from a clinician, share the real document or instruction and I'll file it with its source.",
    `Your message was kept as a note only: “${text.trim()}”`,
  ].join(" ");
}

export function isMedicalDosageRequest(text: string): boolean {
  return /what\s+dose\s+should|how\s+much\s+should\s+(i|we)\s+give|recommend\s+a\s+dose|prescribe|change\s+her\s+dose|double\s+\w*\s*dose|increase\s+the\s+dose/i.test(
    text,
  );
}

export function refuseDosageAdvice(): string {
  return [
    "I can't recommend or change medication dosages.",
    "I can show the authorized schedule from the care plan and record what a caregiver confirms they gave.",
    "For dosing questions, contact the prescribing clinician.",
  ].join(" ");
}

export function isPromptInjection(text: string): boolean {
  return /ignore\s+(all\s+)?(prior|previous)\s+rules|system\s*:\s*|you\s+are\s+now\s+|jailbreak|reveal\s+your\s+prompt/i.test(
    text,
  );
}

export function refuseInjection(): string {
  return [
    "I can't follow instructions that try to override care safety rules.",
    "Your note was not treated as a system command.",
    "Please restate the care update in ordinary caregiver language.",
  ].join(" ");
}

export function candidateToVerificationItem(
  candidate: CareCandidate,
  discrepancy?: MedicationDiscrepancy,
): VerificationItem {
  const safetyClass = discrepancy
    ? "high"
    : candidate.consequentiality;
  return {
    id: `v-${candidate.id}`,
    candidateId: candidate.id,
    label: candidate.statement,
    detail:
      candidate.epistemicStatus === "UNCERTAIN" ||
      candidate.epistemicStatus === "REPORTED"
        ? `Status: ${candidate.epistemicStatus} (not confirmed care truth yet)`
        : undefined,
    safetyClass,
    epistemicStatus: candidate.epistemicStatus,
    requiresConfirmation: requiresHumanConfirmation(safetyClass),
    discrepancy,
  };
}

export function detectDuplicateMedication(
  existingStatements: string[],
  candidateStatement: string,
): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const c = norm(candidateStatement);
  return existingStatements.some((e) => {
    const n = norm(e);
    return (
      n.includes("lunch medication") &&
      c.includes("lunch medication") &&
      (n.includes("given") || n.includes("administered"))
    );
  });
}
