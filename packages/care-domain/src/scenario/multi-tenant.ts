/**
 * Multi-organization / multi-tenant isolation fixture.
 * Three independent companies with overlapping display names.
 * Synthetic evaluation only.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareRecipient, Person, CareRelationshipRole } from "../types.js";

export const TENANTS = {
  A: { id: "org-company-a", name: "Harbor Home Support" },
  B: { id: "org-company-b", name: "Summit Care Agency" },
  C: { id: "org-company-c", name: "Lakeside Family Care" },
  PROVIDER_CLINIC: { id: "org-provider-clinic", name: "Coastal Family Medicine" },
} as const;

function person(id: string, displayName: string, kind: Person["kind"]): Person {
  return { id, displayName, kind };
}

function recipient(
  id: string,
  displayName: string,
  householdId: string,
): CareRecipient {
  return { id, displayName, preferredName: displayName.split(" ")[0]!, householdId };
}

function rel(
  store: CareStore,
  id: string,
  careRecipientId: string,
  personId: string,
  role: CareRelationshipRole,
  roleLabel: string,
  org: { id: string; name: string },
  status: "active" | "revoked" | "expired" = "active",
) {
  store.upsertRelationship({
    id,
    careRecipientId,
    personId,
    role,
    roleLabel,
    responsibilities: [roleLabel],
    access: {
      informationCategories: ["*"],
      allowedActions: ["*"],
      canEscalate: true,
      authorityLimits: [],
    },
    status,
    startDate: "2026-01-01",
    organizationId: org.id,
    organizationName: org.name,
  });
}

/** Seed three company silos + external provider clinic relationship. */
export function seedMultiTenantFixture(store: CareStore): void {
  // —— Company A ——
  store.upsertRecipient(recipient("cr-a-evelyn", "Evelyn Carter", "hh-a-evelyn"));
  store.upsertPerson(person("p-a-marcus", "Marcus Carter", "family_caregiver"));
  store.upsertPerson(person("p-a-maya", "Maya Bennett", "family_caregiver"));
  store.upsertPerson(person("p-a-daniel", "Daniel Kim", "professional"));
  store.upsertPerson(person("p-a-dsp1", "DSP Avery Chen", "professional"));
  // External provider (not agency employee)
  store.upsertPerson(person("p-prov-shah", "Dr. Priya Shah", "provider"));
  rel(store, "rel-a-marcus", "cr-a-evelyn", "p-a-marcus", "family_caregiver", "Primary family caregiver", TENANTS.A);
  rel(store, "rel-a-maya", "cr-a-evelyn", "p-a-maya", "adult_child", "Family / friend caregiver", TENANTS.A);
  rel(store, "rel-a-daniel", "cr-a-evelyn", "p-a-daniel", "paid_caregiver", "Professional caregiver", TENANTS.A);
  rel(store, "rel-a-dsp1", "cr-a-evelyn", "p-a-dsp1", "paid_caregiver", "Professional caregiver", TENANTS.A);
  rel(
    store,
    "rel-a-shah",
    "cr-a-evelyn",
    "p-prov-shah",
    "physician",
    "Primary care physician",
    TENANTS.PROVIDER_CLINIC,
  );
  store.upsertMedSchedule({
    id: "med-a-metformin",
    careRecipientId: "cr-a-evelyn",
    name: "Metformin",
    dose: "500 mg",
    scheduleLabel: "Take with food at lunch",
    authorizedBy: "Dr. Priya Shah",
    authorizedAt: "2026-07-01",
    source: {
      id: "src-a-med",
      kind: "provider_instruction",
      label: "Provider instruction",
      actorName: "Dr. Priya Shah",
      actorPersonId: "p-prov-shah",
      recordedAt: "2026-07-01T00:00:00Z",
      whyVisible: "Authorized for Evelyn at Harbor Home Support",
    },
  });

  // —— Company B (same display names, different IDs) ——
  store.upsertRecipient(recipient("cr-b-evelyn", "Evelyn Carter", "hh-b-evelyn"));
  store.upsertPerson(person("p-b-marcus", "Marcus Carter", "family_caregiver"));
  store.upsertPerson(person("p-b-daniel", "Daniel Kim", "professional"));
  store.upsertPerson(person("p-b-dsp1", "DSP Avery Chen", "professional"));
  store.upsertPerson(person("p-b-shah", "Dr. Priya Shah", "provider")); // name collision, different org
  rel(store, "rel-b-marcus", "cr-b-evelyn", "p-b-marcus", "family_caregiver", "Primary family caregiver", TENANTS.B);
  rel(store, "rel-b-daniel", "cr-b-evelyn", "p-b-daniel", "paid_caregiver", "Professional caregiver", TENANTS.B);
  rel(store, "rel-b-dsp1", "cr-b-evelyn", "p-b-dsp1", "paid_caregiver", "Professional caregiver", TENANTS.B);
  rel(store, "rel-b-shah", "cr-b-evelyn", "p-b-shah", "physician", "Primary care physician", TENANTS.B);
  store.upsertMedSchedule({
    id: "med-b-lisinopril",
    careRecipientId: "cr-b-evelyn",
    name: "Lisinopril",
    dose: "10 mg",
    scheduleLabel: "Morning",
    authorizedBy: "Dr. Priya Shah",
    authorizedAt: "2026-07-01",
    source: {
      id: "src-b-med",
      kind: "provider_instruction",
      label: "Provider instruction",
      actorName: "Dr. Priya Shah",
      actorPersonId: "p-b-shah",
      recordedAt: "2026-07-01T00:00:00Z",
      whyVisible: "Authorized for Evelyn at Summit Care Agency only",
    },
  });

  // —— Company C ——
  store.upsertRecipient(recipient("cr-c-robert", "Robert Hale", "hh-c-robert"));
  store.upsertPerson(person("p-c-marcus", "Marcus Carter", "family_caregiver"));
  store.upsertPerson(person("p-c-dsp1", "DSP Avery Chen", "professional"));
  store.upsertPerson(person("p-c-cole", "Dr. Amara Cole", "provider"));
  rel(store, "rel-c-marcus", "cr-c-robert", "p-c-marcus", "family_caregiver", "Primary family caregiver", TENANTS.C);
  rel(store, "rel-c-dsp1", "cr-c-robert", "p-c-dsp1", "paid_caregiver", "Professional caregiver", TENANTS.C);
  rel(store, "rel-c-cole", "cr-c-robert", "p-c-cole", "physician", "Primary care physician", TENANTS.C);
  store.upsertMedSchedule({
    id: "med-c-lisinopril",
    careRecipientId: "cr-c-robert",
    name: "Lisinopril",
    dose: "10 mg",
    scheduleLabel: "Morning",
    authorizedBy: "Dr. Amara Cole",
    authorizedAt: "2026-07-01",
    source: {
      id: "src-c-med",
      kind: "provider_instruction",
      label: "Provider instruction",
      actorName: "Dr. Amara Cole",
      actorPersonId: "p-c-cole",
      recordedAt: "2026-07-01T00:00:00Z",
      whyVisible: "Authorized for Robert at Lakeside Family Care",
    },
  });

  // Same human, multi-org memberships: p-a-daniel also works for Company C on Robert
  store.upsertPerson(person("p-a-daniel", "Daniel Kim", "professional")); // already exists
  rel(store, "rel-c-daniel", "cr-c-robert", "p-a-daniel", "paid_caregiver", "Professional caregiver", TENANTS.C);
}
