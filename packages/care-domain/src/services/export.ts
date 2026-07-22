/**
 * Authorized data portability export.
 * Human-readable + structured (+ FHIR stubs where mapped).
 * Not EMR integration.
 */

import type { CareStore } from "../store/memory-store.js";
import { evaluateAccess } from "./access.js";
import {
  mapAppointment,
  mapCareRecipientToPatient,
  mapConsent,
  mapMedAdmin,
  mapMedRequest,
  mapObservation,
  mapProvenance,
  mapTask,
} from "../fhir/mapping.js";
import type { CurrentCareState } from "../types.js";

export interface CareExportResult {
  ok: true;
  format: "json" | "markdown";
  careRecipientId: string;
  exportedAt: string;
  evidenceMode: "SYNTHETIC_FOUNDATION_BACKED";
  claim: "FHIR_MAPPED_NOT_EMR_INTEGRATED";
  humanReadable: string;
  structured: {
    careRecipient: unknown;
    state: CurrentCareState | undefined;
    fhir: unknown[];
  };
}

export function exportCareData(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
  format: "json" | "markdown" = "json",
): CareExportResult | { ok: false; code: string; message: string } {
  const access = evaluateAccess(store, actorPersonId, careRecipientId, {
    requiredAction: "view_plan",
  });
  // Allow * or view_plan or receive_updates for limited export
  const soft = evaluateAccess(store, actorPersonId, careRecipientId);
  if (!soft.allowed) {
    return { ok: false, code: soft.code, message: soft.reason };
  }

  const recipient = store.getRecipient(careRecipientId);
  if (!recipient) {
    return {
      ok: false,
      code: "UNKNOWN_RECIPIENT",
      message: "Care recipient not found",
    };
  }

  const state = store.getCurrentState(careRecipientId);
  const fhir: unknown[] = [mapCareRecipientToPatient(recipient)];
  if (state) {
    for (const o of state.observations) fhir.push(mapObservation(o));
    for (const a of state.appointments) fhir.push(mapAppointment(a));
    for (const t of state.tasks) fhir.push(mapTask(t));
    for (const s of state.medicationSchedules) fhir.push(mapMedRequest(s));
    for (const m of state.medicationRecords) fhir.push(mapMedAdmin(m));
    for (const e of state.events.slice(0, 50)) {
      if (e.source) fhir.push(mapProvenance(e.source, `Observation/${e.id}`));
    }
  }
  for (const c of store
    .listAudit({ careRecipientId })
    .filter((a) => a.action === "CONSENT_GRANTED")
    .slice(0, 0)) {
    void c;
  }
  // Consent records via relationships
  for (const rel of store.getRelationships(careRecipientId)) {
    const consent = store.getConsent(careRecipientId, rel.personId);
    if (consent) fhir.push(mapConsent(consent));
  }

  const human = [
    `# Care export — ${recipient.displayName}`,
    `Exported at: ${new Date().toISOString()}`,
    `Exporter: ${actorPersonId}`,
    `Access: ${soft.reason}`,
    `Claim: FHIR-mapped structures included; NOT an EMR integration.`,
    "",
    "## Current events",
    ...(state?.events.map(
      (e) =>
        `- [${e.epistemicStatus}] ${e.type}: ${e.statement} (source: ${e.source.label})`,
    ) ?? ["(none)"]),
    "",
    "## Handoffs",
    ...(state?.handoffs.map(
      (h) =>
        `- ${h.createdAt}: changed=${h.whatChanged.join("; ")}`,
    ) ?? ["(none)"]),
    "",
    "## Appointments",
    ...(state?.appointments.map(
      (a) => `- ${a.title}: ${a.startsAtLabel ?? a.startsAt} (${a.status})`,
    ) ?? ["(none)"]),
    "",
    "## Notes",
    "- Corrections preserve prior evidence in the system of record.",
    "- Unauthorized parties must not receive this export.",
  ].join("\n");

  store.writeAudit({
    at: new Date().toISOString(),
    actorPersonId,
    action: "CARE_EXPORT",
    careRecipientId,
    householdId: recipient.householdId,
    details: {
      format,
      fhirResourceCount: fhir.length,
      access: access.allowed ? access.reason : soft.reason,
    },
  });

  return {
    ok: true,
    format,
    careRecipientId,
    exportedAt: new Date().toISOString(),
    evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
    claim: "FHIR_MAPPED_NOT_EMR_INTEGRATED",
    humanReadable: human,
    structured: {
      careRecipient: recipient,
      state,
      fhir,
    },
  };
}
