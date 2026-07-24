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

/**
 * Multi-DSP / multi-recipient matrix + second org isolation.
 * Extended to support a 20-person care-team authorization matrix on one recipient.
 */
export function seedAgencyScaleFixture(store: CareStore): void {
  const recipients: CareRecipient[] = [
    { id: "cr-scale-1", displayName: "Alex Morgan", preferredName: "Alex", householdId: "hh-scale-1" },
    { id: "cr-scale-2", displayName: "Jordan Lee", preferredName: "Jordan", householdId: "hh-scale-2" },
    { id: "cr-scale-3", displayName: "Sam Rivera", preferredName: "Sam", householdId: "hh-scale-3" },
    { id: "cr-scale-4", displayName: "Casey Nguyen", preferredName: "Casey", householdId: "hh-scale-4" },
    { id: "cr-scale-5", displayName: "Riley Brooks", preferredName: "Riley", householdId: "hh-scale-5" },
    // Agency B only
    { id: "cr-bay-1", displayName: "Taylor Quinn", preferredName: "Taylor", householdId: "hh-bay-1" },
    // Large care-team recipient
    {
      id: "cr-team20",
      displayName: "Pat Okafor",
      preferredName: "Pat",
      householdId: "hh-team20",
    },
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

  // 20-person care team for cr-team20 (mix of roles)
  for (let i = 1; i <= 20; i++) {
    const kind: Person["kind"] =
      i === 1
        ? "provider"
        : i <= 4
          ? "family_caregiver"
          : i <= 16
            ? "professional"
            : "provider";
    store.upsertPerson({
      id: `p-team20-${i}`,
      displayName:
        i === 1
          ? "Dr. Amara Cole"
          : i === 2
            ? "Dr. Priya Shah"
            : `Team Member ${i}`,
      kind,
    });
  }

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

  // 20-person team on cr-team20: 18 active + 1 revoked + 1 expired
  for (let i = 1; i <= 20; i++) {
    const role: "paid_caregiver" | "physician" | "family_caregiver" =
      i === 1 || i >= 17
        ? "physician"
        : i <= 4
          ? "family_caregiver"
          : "paid_caregiver";
    const status: "active" | "revoked" | "expired" =
      i === 19 ? "revoked" : i === 20 ? "expired" : "active";
    rel(
      `rel-team20-${i}`,
      "cr-team20",
      `p-team20-${i}`,
      role,
      role === "physician"
        ? "Primary care physician"
        : role === "family_caregiver"
          ? "Family / friend caregiver"
          : "Professional caregiver",
      ORG_NORTH,
      status,
      status === "expired" ? "2026-01-01" : undefined,
    );
  }

  // Med schedules (same drug name across orgs — isolation still holds)
  for (const id of ["cr-scale-1", "cr-bay-1", "cr-team20"]) {
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
