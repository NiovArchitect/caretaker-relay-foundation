/**
 * Clinician evidence-summary — concise, provenance-first, no care-circle admin.
 */

import type { CareStore } from "../store/memory-store.js";
import { evaluateAccess } from "./access.js";
import { resolveActiveProjectionRole } from "./role-projection.js";
import { buildTimeline } from "./care-event-etl.js";
import { listConflicts } from "./conflict-center.js";

export type ClinicalSummary = {
  careRecipientId: string;
  recipientName: string;
  generatedAt: string;
  recentChanges: Array<{
    statement: string;
    truth: string;
    eventAt?: string;
    reportAt?: string;
    source?: string;
    confidence?: string;
  }>;
  trends: string[];
  caregiverReports: string[];
  recipientReports: string[];
  reportedVsConfirmed: Array<{ statement: string; status: string }>;
  medicationPlan: Array<{ name: string; dose: string; schedule: string }>;
  medicationAdministrations: Array<{
    name: string;
    dose: string;
    at: string;
    status: string;
  }>;
  uncertainOrMissed: string[];
  appointments: Array<{ title: string; when: string; status: string }>;
  unresolvedQuestions: string[];
  corrections: Array<{ previous: string; corrected: string; at: string }>;
  documents: Array<{ id: string; title: string }>;
  careTeamQuestions: string[];
  openConflicts: number;
  boundaries: string[];
};

export function buildClinicalSummary(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
):
  | { ok: true; summary: ClinicalSummary }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(store, actorPersonId, careRecipientId);
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const { role } = resolveActiveProjectionRole(
    store,
    actorPersonId,
    careRecipientId,
  );
  if (role !== "clinician" && role !== "unknown") {
    // Allow controlling family for demo? No — clinicians only for this surface.
    // Lab physicians map to clinician; if family controlling, still allow read-only demo with note
  }
  const isClinician = role === "clinician";
  if (!isClinician) {
    // Soft allow if relationship role is physician-like
    const rel = store.getRelationship(careRecipientId, actorPersonId);
    if (!rel || !/physician|clinician|provider|therapist|nurse/i.test(rel.role + rel.roleLabel)) {
      return {
        ok: false,
        code: "FORBIDDEN",
        message: "Clinical summary requires a clinical relationship",
      };
    }
  }

  const recipient = store.getRecipient(careRecipientId);
  const timeline = buildTimeline(store, careRecipientId, { limit: 40 });
  const recentChanges = timeline.slice(0, 12).map((e) => ({
    statement: e.statement,
    truth: e.truthState ?? e.epistemicStatus,
    eventAt: e.eventAt ?? e.occurredAt,
    reportAt: e.reportAt ?? e.source?.recordedAt,
    source: e.source?.label ?? e.source?.actorName,
    confidence: e.confidenceLabel ?? (e.confidence != null ? String(e.confidence) : undefined),
  }));

  const caregiverReports = timeline
    .filter((e) => e.source?.kind === "caregiver_text" || e.source?.kind === "caregiver_speech")
    .slice(0, 8)
    .map((e) => e.statement);
  const recipientReports = timeline
    .filter((e) => e.actorPrincipalId === careRecipientId)
    .slice(0, 8)
    .map((e) => e.statement);

  const medicationPlan = store.getMedSchedules(careRecipientId).map((m) => ({
    name: m.name,
    dose: m.dose,
    schedule: m.scheduleLabel,
  }));
  const medicationAdministrations = store
    .getMedRecords(careRecipientId)
    .slice(-10)
    .map((m) => ({
      name: m.name,
      dose: m.doseRecorded,
      at: m.administeredAt,
      status: m.status,
    }));

  const tasks = store.getTasks(careRecipientId);
  const uncertainOrMissed = [
    ...timeline
      .filter(
        (e) =>
          e.epistemicStatus === "UNCERTAIN" ||
          e.truthState === "disputed" ||
          (e.conflictWithIds?.length ?? 0) > 0,
      )
      .map((e) => e.statement),
    ...tasks
      .filter((t) => t.status === "pending")
      .map((t) => `Open task: ${t.title}`),
  ].slice(0, 10);

  const appointments = store.getAppointments(careRecipientId).map((a) => ({
    title: a.title,
    when: a.startsAtLabel ?? a.startsAt,
    status: a.scheduleState ?? a.status,
  }));

  const corrections = store.getCorrections(careRecipientId).map((c) => ({
    previous: c.previousValue,
    corrected: c.correctedValue,
    at: c.correctedAt,
  }));

  let documents: ClinicalSummary["documents"] = [];
  try {
    // documents service optional
    documents = [];
  } catch {
    documents = [];
  }

  const conflicts = listConflicts(store, careRecipientId);

  const summary: ClinicalSummary = {
    careRecipientId,
    recipientName: recipient?.displayName ?? careRecipientId,
    generatedAt: new Date().toISOString(),
    recentChanges,
    trends: recentChanges.slice(0, 6).map((r) => r.statement),
    caregiverReports,
    recipientReports,
    reportedVsConfirmed: recentChanges.map((r) => ({
      statement: r.statement,
      status: r.truth,
    })),
    medicationPlan,
    medicationAdministrations,
    uncertainOrMissed,
    appointments,
    unresolvedQuestions: uncertainOrMissed.slice(0, 5),
    corrections,
    documents,
    careTeamQuestions: [
      "Any new side effects since the last visit?",
      "Has mobility changed this week?",
      "Are medication times consistent across caregivers?",
    ],
    openConflicts: conflicts.length,
    boundaries: [
      "No care-circle administration from this surface",
      "No autonomous diagnosis or treatment change",
      "Reported data is labeled separately from confirmed",
      "Consequential actions require human confirmation",
    ],
  };
  return { ok: true, summary };
}
