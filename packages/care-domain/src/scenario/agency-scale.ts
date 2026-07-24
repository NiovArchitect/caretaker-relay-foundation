/**
 * Multi-agency, multi-DSP scale fixture for access isolation tests.
 * Synthetic evaluation only — not field-validated.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareRecipient, Person } from "../types.js";

export const ORG_NORTH = {
  id: "org-north-coast",
  name: "North Coast Support Services",
};
export const ORG_BAY = {
  id: "org-bay-care",
  name: "Bay Care Partners",
};

/** 5 DSPs, 5 recipients, cross-assignment matrix + second org isolation. */
export function seedAgencyScaleFixture(store: CareStore): void {
  const recipients: CareRecipient[] = [
    { id: "cr-scale-1", displayName: "Alex Morgan", preferredName: "Alex", householdId: "hh-scale-1" },
    { id: "cr-scale-2", displayName: "Jordan Lee", preferredName: "Jordan", householdId: "hh-scale-2" },
    { id: "cr-scale-3", displayName: "Sam Rivera", preferredName: "Sam", householdId: "hh-scale-3" },
    { id: "cr-scale-4", displayName: "Casey Nguyen", preferredName: "Casey", householdId: "hh-scale-4" },
    { id: "cr-scale-5", displayName: "Riley Brooks", preferredName: "Riley", householdId: "hh-scale-5" },
    // Agency B only
    { id: "cr-bay-1", displayName: "Taylor Quinn", preferredName: "Taylor", householdId: "hh-bay-1" },
  ];
  for (const r of recipients) store.upsertRecipient(r);

  const dsps: Person[] = [
    { id: "p-dsp-a", displayName: "DSP Avery Chen", kind: "professional" },
    { id: "p-dsp-b", displayName: "DSP Blake Ortiz", kind: "professional" },
    { id: "p-dsp-c", displayName: "DSP Cameron Wu", kind: "professional" },
    { id: "p-dsp-d", displayName: "DSP Devon Park", kind: "professional" },
    { id: "p-dsp-e", displayName: "DSP Ellis Grant", kind: "professional" },
    { id: "p-bay-dsp", displayName: "DSP Avery Chen", kind: "professional" }, // name collision across orgs
  ];
  for (const p of dsps) store.upsertPerson(p);

  // Name collision: two Priya Shah persons different orgs
  store.upsertPerson({
    id: "p-shah-coastal",
    displayName: "Dr. Priya Shah",
    kind: "provider",
  });
  store.upsertPerson({
    id: "p-shah-bay",
    displayName: "Dr. Priya Shah",
    kind: "provider",
  });

  function rel(
    id: string,
    careRecipientId: string,
    personId: string,
    role: "paid_caregiver" | "physician" | "family_caregiver",
    roleLabel: string,
    org: { id: string; name: string },
    status: "active" | "revoked" | "expired" = "active",
    endDate?: string,
  ) {
    store.upsertRelationship({
      id,
      careRecipientId,
      personId,
      role,
      roleLabel,
      responsibilities: [roleLabel],
      access: {
        informationCategories: ["Care tasks", "Care instructions", "Appointments", "*"],
        allowedActions: ["record_observations", "complete_tasks", "view_schedule", "view_plan"],
        canEscalate: true,
        authorityLimits: [],
      },
      status,
      startDate: "2026-01-01",
      endDate,
      organizationId: org.id,
      organizationName: org.name,
    });
  }

  // DSP A: 1,2
  rel("rel-sa1", "cr-scale-1", "p-dsp-a", "paid_caregiver", "Professional caregiver", ORG_NORTH);
  rel("rel-sa2", "cr-scale-2", "p-dsp-a", "paid_caregiver", "Professional caregiver", ORG_NORTH);
  // DSP B: 2,3
  rel("rel-sb2", "cr-scale-2", "p-dsp-b", "paid_caregiver", "Professional caregiver", ORG_NORTH);
  rel("rel-sb3", "cr-scale-3", "p-dsp-b", "paid_caregiver", "Professional caregiver", ORG_NORTH);
  // DSP C: 4
  rel("rel-sc4", "cr-scale-4", "p-dsp-c", "paid_caregiver", "Professional caregiver", ORG_NORTH);
  // DSP D: 1,5
  rel("rel-sd1", "cr-scale-1", "p-dsp-d", "paid_caregiver", "Professional caregiver", ORG_NORTH);
  rel("rel-sd5", "cr-scale-5", "p-dsp-d", "paid_caregiver", "Professional caregiver", ORG_NORTH);
  // DSP E: revoked on 3
  rel(
    "rel-se3",
    "cr-scale-3",
    "p-dsp-e",
    "paid_caregiver",
    "Professional caregiver",
    ORG_NORTH,
    "revoked",
  );

  // Bay org only
  rel("rel-bay1", "cr-bay-1", "p-bay-dsp", "paid_caregiver", "Professional caregiver", ORG_BAY);
  rel("rel-bay-shah", "cr-bay-1", "p-shah-bay", "physician", "Primary care physician", ORG_BAY);

  // North provider for scale-1
  rel(
    "rel-n-shah",
    "cr-scale-1",
    "p-shah-coastal",
    "physician",
    "Primary care physician",
    ORG_NORTH,
  );

  // Med schedules (same drug name across orgs — isolation still holds)
  for (const id of ["cr-scale-1", "cr-bay-1"]) {
    store.upsertMedSchedule({
      id: `med-${id}`,
      careRecipientId: id,
      name: "Lisinopril",
      dose: "10 mg",
      scheduleLabel: "Morning",
      authorizedBy: id === "cr-bay-1" ? "Dr. Priya Shah (Bay)" : "Dr. Priya Shah (North)",
      authorizedAt: "2026-06-01",
      source: {
        id: `src-med-${id}`,
        kind: "provider_instruction",
        label: "Medication instruction",
        actorName: "Dr. Priya Shah",
        recordedAt: "2026-06-01T00:00:00Z",
        whyVisible: "Authorized instruction for this recipient only",
      },
    });
  }
}
