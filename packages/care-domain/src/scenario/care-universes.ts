/**
 * Independent synthetic care universes for generalization testing.
 * Must NOT depend on Evelyn/Marcus/Olivia seed IDs.
 */

import type { CareStore } from "../store/memory-store.js";
import { MemoryCareStore } from "../store/memory-store.js";
import type { CareRelationshipRole } from "../types.js";

export type CareUniverse = {
  id: string;
  label: string;
  density: "rich" | "sparse" | "conflict" | "growth" | "zero";
  householdId: string;
  recipient: { id: string; displayName: string; preferredName: string };
  actors: Array<{
    id: string;
    displayName: string;
    role: CareRelationshipRole;
    roleLabel: string;
  }>;
  primaryCaregiverId: string;
  timezone: string;
};

export const UNIVERSES: CareUniverse[] = [
  {
    id: "A_rich_family",
    label: "Alicia Monroe rich family",
    density: "rich",
    householdId: "hh-alicia",
    recipient: {
      id: "cr-alicia-monroe",
      displayName: "Alicia Monroe",
      preferredName: "Alicia",
    },
    actors: [
      {
        id: "p-jordan-monroe",
        displayName: "Jordan Monroe",
        role: "adult_child",
        roleLabel: "Primary family caregiver",
      },
      {
        id: "p-priya-patel",
        displayName: "Priya Patel",
        role: "friend",
        roleLabel: "Family / friend caregiver",
      },
    ],
    primaryCaregiverId: "p-jordan-monroe",
    timezone: "America/New_York",
  },
  {
    id: "B_sparse_new",
    label: "Thomas Reed sparse",
    density: "sparse",
    householdId: "hh-thomas",
    recipient: {
      id: "cr-thomas-reed",
      displayName: "Thomas Reed",
      preferredName: "Thomas",
    },
    actors: [
      {
        id: "p-lena-reed",
        displayName: "Lena Reed",
        role: "spouse",
        roleLabel: "Primary family caregiver",
      },
    ],
    primaryCaregiverId: "p-lena-reed",
    timezone: "America/Chicago",
  },
  {
    id: "C_dsp_idd",
    label: "Noah Brooks DSP/I-DD",
    density: "rich",
    householdId: "hh-noah",
    recipient: {
      id: "cr-noah-brooks",
      displayName: "Noah Brooks",
      preferredName: "Noah",
    },
    actors: [
      {
        id: "p-amira-cole",
        displayName: "Amira Cole",
        role: "direct_support_professional",
        roleLabel: "Professional caregiver",
      },
      {
        id: "p-ethan-brooks",
        displayName: "Ethan Brooks",
        role: "sibling",
        roleLabel: "Family caregiver",
      },
    ],
    primaryCaregiverId: "p-amira-cole",
    timezone: "America/Los_Angeles",
  },
  {
    id: "D_adrd",
    label: "Helen Park ADRD",
    density: "rich",
    householdId: "hh-helen",
    recipient: {
      id: "cr-helen-park",
      displayName: "Helen Park",
      preferredName: "Helen",
    },
    actors: [
      {
        id: "p-daniel-park",
        displayName: "Daniel Park",
        role: "adult_child",
        roleLabel: "Primary family caregiver",
      },
      {
        id: "p-sofia-park",
        displayName: "Sofia Park",
        role: "adult_child",
        roleLabel: "Family caregiver",
      },
    ],
    primaryCaregiverId: "p-daniel-park",
    timezone: "America/Denver",
  },
  {
    id: "E_mobility",
    label: "Samuel Ortiz mobility",
    density: "rich",
    householdId: "hh-samuel",
    recipient: {
      id: "cr-samuel-ortiz",
      displayName: "Samuel Ortiz",
      preferredName: "Samuel",
    },
    actors: [
      {
        id: "p-rosa-ortiz",
        displayName: "Rosa Ortiz",
        role: "spouse",
        roleLabel: "Primary family caregiver",
      },
      {
        id: "p-kai-morgan",
        displayName: "Kai Morgan",
        role: "friend",
        roleLabel: "Family / friend caregiver",
      },
    ],
    primaryCaregiverId: "p-rosa-ortiz",
    timezone: "America/Phoenix",
  },
  {
    id: "H_zero_access",
    label: "Casey New zero-access",
    density: "zero",
    householdId: "hh-none",
    recipient: {
      id: "cr-none-casey",
      displayName: "No recipient",
      preferredName: "None",
    },
    actors: [
      {
        id: "p-casey-new",
        displayName: "Casey New",
        role: "friend",
        roleLabel: "Account pending authorization",
      },
    ],
    primaryCaregiverId: "p-casey-new",
    timezone: "UTC",
  },
];

function src(
  id: string,
  actorName: string,
  actorPersonId: string,
  label: string,
) {
  return {
    id,
    kind: "caregiver_text" as const,
    label,
    actorName,
    actorPersonId,
    recordedAt: new Date().toISOString(),
    whyVisible: "Authorized care documentation",
  };
}

/** Seed a store with one universe — no Olivia fixture. */
export function seedCareUniverse(
  universe: CareUniverse,
  store: CareStore = new MemoryCareStore(),
): CareStore {
  const now = new Date().toISOString();
  const actor0 = universe.actors[0]!;

  store.upsertRecipient({
    id: universe.recipient.id,
    displayName: universe.recipient.displayName,
    preferredName: universe.recipient.preferredName,
    householdId: universe.householdId,
    profile: {
      primaryLanguage: "English",
      communicationNeeds: ["Prefers plain language"],
      carePreferences: ["Short updates"],
      mobilityBaseline:
        universe.id === "E_mobility"
          ? "Needs transfer support; walker available"
          : "Baseline not fully documented",
      emergencyContacts: [
        {
          name: actor0.displayName,
          relationship: "Primary caregiver",
          phone: "(555) 100-0001",
        },
      ],
    },
  });

  for (const a of universe.actors) {
    store.upsertPerson({
      id: a.id,
      displayName: a.displayName,
      kind:
        a.role === "direct_support_professional"
          ? "professional"
          : "family_caregiver",
    });
    if (universe.density === "zero") continue;
    store.upsertRelationship({
      id: `rel-${universe.recipient.id}-${a.id}`,
      careRecipientId: universe.recipient.id,
      personId: a.id,
      role: a.role,
      roleLabel: a.roleLabel,
      responsibilities: ["Care coordination"],
      access: {
        informationCategories: ["*"],
        allowedActions: ["*"],
        canEscalate: true,
        authorityLimits: [],
      },
      status: "active",
    });
  }

  if (universe.density === "zero") return store;

  if (universe.density === "sparse") {
    store.upsertAppointment({
      id: store.newId("apt"),
      careRecipientId: universe.recipient.id,
      title: "Primary care follow-up",
      startsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      startsAtLabel: "Next week · 10:00 AM",
      status: "scheduled",
      epistemicStatus: "REPORTED",
      source: src(
        store.newId("src"),
        actor0.displayName,
        actor0.id,
        "Caregiver-scheduled",
      ),
    });
    return store;
  }

  store.upsertMedSchedule({
    id: store.newId("med"),
    careRecipientId: universe.recipient.id,
    name: "Metformin",
    dose: "500 mg",
    scheduleLabel: "With lunch",
    scheduleTime: "12:00 PM",
    authorizedBy: "Primary care physician",
    authorizedAt: now,
    mealRelation: "With food",
    source: src(
      store.newId("src"),
      "Primary care physician",
      "system",
      "Care plan",
    ),
  });

  store.addEvent({
    id: store.newId("evt"),
    careRecipientId: universe.recipient.id,
    householdId: universe.householdId,
    type: "observation",
    title: "Caregiver report",
    statement: `${universe.recipient.preferredName} seemed more tired after lunch (caregiver-reported).`,
    occurredAt: new Date(Date.now() - 3600_000).toISOString(),
    epistemicStatus: "REPORTED",
    safetyClass: "low",
    source: src(
      store.newId("src"),
      actor0.displayName,
      actor0.id,
      "Caregiver report",
    ),
    evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
  });

  store.addObservation({
    id: store.newId("obs"),
    careRecipientId: universe.recipient.id,
    summary: "Fatigue after lunch",
    observedAt: new Date(Date.now() - 3600_000).toISOString(),
    epistemicStatus: "REPORTED",
    source: src(
      store.newId("src"),
      actor0.displayName,
      actor0.id,
      "Observation",
    ),
  });

  store.upsertAppointment({
    id: store.newId("apt"),
    careRecipientId: universe.recipient.id,
    title: "Physical therapy",
    startsAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    startsAtLabel: "Friday · 2:00 PM",
    location: "Community PT (synthetic)",
    status: "scheduled",
    epistemicStatus: "REPORTED",
    source: src(store.newId("src"), actor0.displayName, actor0.id, "Schedule"),
  });

  store.addHandoff({
    id: store.newId("ho"),
    careRecipientId: universe.recipient.id,
    fromPersonId: actor0.id,
    toPersonId: universe.actors[1]?.id ?? actor0.id,
    whatChanged: [
      `Meal completed; ${universe.recipient.preferredName} reported fatigue`,
    ],
    stillNeedsAttention: ["Afternoon rest check", "Hydration"],
    watch: ["Dizziness when standing"],
    sources: [],
    createdAt: now,
    evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
  });

  return store;
}

export function renderQuestionTemplate(
  template: string,
  u: CareUniverse,
): string {
  const r = u.recipient;
  const caregiver = u.actors[0];
  return template
    .replaceAll("{recipient_preferred_name}", r.preferredName)
    .replaceAll("{recipient_first_name}", r.preferredName)
    .replaceAll("{recipient_display_name}", r.displayName)
    .replaceAll("{caregiver_name}", caregiver?.displayName ?? "Caregiver")
    .replaceAll(
      "{helper_name}",
      u.actors[1]?.displayName ?? caregiver?.displayName ?? "Helper",
    );
}

/** Map bank questions to templates (strip Evelyn-specific names). */
export function questionToTemplate(question: string): string {
  return question
    .replace(/\bEvelyn Carter\b/gi, "{recipient_display_name}")
    .replace(/\bEvelyn\b/gi, "{recipient_preferred_name}")
    .replace(/\bevenlyn\b/gi, "{recipient_preferred_name}")
    .replace(/\bMarcus\b/gi, "{caregiver_name}")
    .replace(/\bMaya\b/gi, "{helper_name}")
    .replace(/\bDaniel\b/gi, "{helper_name}");
}
