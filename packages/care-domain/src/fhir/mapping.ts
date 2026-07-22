/**
 * FHIR boundary: real technical mapping with tests.
 * A mapping is NOT an integrated EMR connection.
 */

import { FHIR_CONCEPT_MAP } from "../types.js";
import type {
  Appointment,
  CareEvent,
  CareRecipient,
  CareTask,
  ConsentRecord,
  MedicationAdministrationRecord,
  MedicationSchedule,
  Observation,
  Person,
  SourceRef,
} from "../types.js";

export interface FhirResourceStub {
  resourceType: string;
  id: string;
  meta?: { source?: string; tag?: Array<{ system: string; code: string }> };
  [key: string]: unknown;
}

export function mapCareRecipientToPatient(r: CareRecipient): FhirResourceStub {
  return {
    resourceType: FHIR_CONCEPT_MAP.CareRecipient,
    id: r.id,
    name: [{ text: r.displayName, given: [r.preferredName ?? r.displayName] }],
    meta: {
      tag: [{ system: "https://caretaker.relay/household", code: r.householdId }],
    },
  };
}

export function mapPersonToRelatedPerson(
  p: Person,
  careRecipientId: string,
): FhirResourceStub {
  const resourceType =
    p.kind === "provider" || p.kind === "professional"
      ? "Practitioner"
      : "RelatedPerson";
  return {
    resourceType,
    id: p.id,
    name: [{ text: p.displayName }],
    patient:
      resourceType === "RelatedPerson"
        ? { reference: `Patient/${careRecipientId}` }
        : undefined,
  };
}

export function mapObservation(o: Observation): FhirResourceStub {
  return {
    resourceType: FHIR_CONCEPT_MAP.Observation,
    id: o.id,
    status: o.epistemicStatus === "CONFIRMED" ? "final" : "preliminary",
    code: { text: "Caregiver observation" },
    subject: { reference: `Patient/${o.careRecipientId}` },
    effectiveDateTime: o.observedAt,
    valueString: o.summary,
    note: [{ text: `epistemicStatus=${o.epistemicStatus}` }],
  };
}

export function mapAppointment(a: Appointment): FhirResourceStub {
  return {
    resourceType: FHIR_CONCEPT_MAP.Appointment,
    id: a.id,
    status:
      a.status === "moved"
        ? "booked"
        : a.status === "cancelled"
          ? "cancelled"
          : "booked",
    description: a.title,
    start: a.startsAt,
    comment: a.startsAtLabel,
  };
}

export function mapTask(t: CareTask): FhirResourceStub {
  return {
    resourceType: FHIR_CONCEPT_MAP.CareTask,
    id: t.id,
    status: t.status === "done" ? "completed" : "requested",
    description: t.title,
    for: { reference: `Patient/${t.careRecipientId}` },
    intent: "plan",
  };
}

export function mapMedRequest(s: MedicationSchedule): FhirResourceStub {
  return {
    resourceType: FHIR_CONCEPT_MAP.MedicationSchedule,
    id: s.id,
    status: "active",
    intent: "order",
    medicationCodeableConcept: { text: s.name },
    subject: { reference: `Patient/${s.careRecipientId}` },
    dosageInstruction: [{ text: `${s.dose} — ${s.scheduleLabel}` }],
    requester: { display: s.authorizedBy },
  };
}

export function mapMedAdmin(
  r: MedicationAdministrationRecord,
): FhirResourceStub {
  return {
    resourceType: FHIR_CONCEPT_MAP.MedicationAdministrationRecord,
    id: r.id,
    status:
      r.status === "recorded"
        ? "completed"
        : r.status === "needs_review"
          ? "on-hold"
          : "entered-in-error",
    medicationCodeableConcept: { text: r.name },
    subject: { reference: `Patient/${r.careRecipientId}` },
    effectiveDateTime: r.administeredAt,
    dosage: { text: r.doseRecorded },
    note: r.discrepancy
      ? [{ text: `DISCREPANCY: ${r.discrepancy.message}` }]
      : undefined,
  };
}

export function mapConsent(c: ConsentRecord): FhirResourceStub {
  return {
    resourceType: FHIR_CONCEPT_MAP.ConsentRecord,
    id: c.id,
    status: c.status === "active" ? "active" : "inactive",
    patient: { reference: `Patient/${c.careRecipientId}` },
    grantee: [{ reference: `RelatedPerson/${c.granteePersonId}` }],
    provision: {
      type: "permit",
      action: c.scope.allowedActions.map((a) => ({ coding: [{ code: a }] })),
    },
  };
}

export function mapProvenance(source: SourceRef, targetId: string): FhirResourceStub {
  return {
    resourceType: FHIR_CONCEPT_MAP.SourceRef,
    id: source.id,
    target: [{ reference: targetId }],
    recorded: source.recordedAt,
    agent: [
      {
        who: {
          display: source.actorName ?? "unknown",
          reference: source.actorPersonId
            ? `RelatedPerson/${source.actorPersonId}`
            : undefined,
        },
      },
    ],
    activity: { text: source.kind },
    entity: source.rawExcerpt
      ? [{ role: "source", what: { display: source.rawExcerpt } }]
      : undefined,
  };
}

export function mapCareEvent(e: CareEvent): FhirResourceStub {
  // Events often project as Observation for interoperability boundary tests
  return {
    resourceType: "Observation",
    id: e.id,
    status: e.epistemicStatus === "CONFIRMED" ? "final" : "preliminary",
    code: { text: e.type },
    subject: { reference: `Patient/${e.careRecipientId}` },
    effectiveDateTime: e.occurredAt,
    valueString: e.statement,
    note: [
      {
        text: `safetyClass=${e.safetyClass}; epistemic=${e.epistemicStatus}; evidenceMode=${e.evidenceMode}`,
      },
    ],
  };
}

export const FHIR_MAPPED_RESOURCES = [
  "Patient",
  "RelatedPerson",
  "Practitioner",
  "CareTeam",
  "CarePlan",
  "Task",
  "Observation",
  "Appointment",
  "MedicationRequest",
  "MedicationAdministration",
  "Communication",
  "Consent",
  "DocumentReference",
  "Provenance",
] as const;

export function assertFhirResourceType(
  resource: FhirResourceStub,
  expected: string,
): void {
  if (resource.resourceType !== expected) {
    throw new Error(
      `FHIR mapping expected ${expected}, got ${resource.resourceType}`,
    );
  }
}
