/**
 * Bootstrap a new care space (recipient + controlling relationship).
 * Used for isolated synthetic universes — no silent membership for others.
 */

import type { CareStore } from "../store/memory-store.js";

export function createCareSpace(
  store: CareStore,
  input: {
    actorPersonId: string;
    actorDisplayName: string;
    displayName: string;
    preferredName?: string;
    timezone?: string;
  },
):
  | {
      ok: true;
      careRecipientId: string;
      relationshipId: string;
    }
  | { ok: false; code: string; message: string } {
  const name = input.displayName.trim();
  if (name.length < 2) {
    return {
      ok: false,
      code: "BAD_REQUEST",
      message: "display_name required",
    };
  }
  const now = new Date().toISOString();
  const careRecipientId = store.newId("cr");
  const householdId = store.newId("hh");
  store.upsertRecipient({
    id: careRecipientId,
    displayName: name,
    preferredName: input.preferredName?.trim() || name.split(/\s+/)[0] || name,
    householdId,
    profile: {
      primaryLanguage: "en",
      dailyRoutineSummary: `Timezone preference: ${input.timezone || "America/Los_Angeles"}`,
    },
  });
  // Ensure controller person exists
  if (!store.getPerson(input.actorPersonId)) {
    store.upsertPerson({
      id: input.actorPersonId,
      displayName: input.actorDisplayName,
      kind: "family_caregiver",
    });
  }
  const relationshipId = store.newId("rel");
  store.upsertRelationship({
    id: relationshipId,
    careRecipientId,
    personId: input.actorPersonId,
    role: "family_caregiver",
    roleLabel: "Primary family caregiver",
    responsibilities: ["coordinate care", "invite helpers", "confirm schedule"],
    access: {
      informationCategories: ["*"],
      allowedActions: ["*", "invite", "manage_access", "control"],
      canEscalate: true,
      authorityLimits: [],
    },
    status: "active",
  });
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "CARE_SPACE_CREATED",
    careRecipientId,
    details: {
      householdId,
      controller: input.actorPersonId,
      synthetic: true,
    },
  });
  return { ok: true, careRecipientId, relationshipId };
}

/** List durable CARE_REMINDER_V1 rows for consistency checks. */
export function listCareReminders(
  store: CareStore,
  careRecipientId: string,
): Array<Record<string, unknown>> {
  const PREFIX = "CARE_REMINDER_V1:";
  const out: Array<Record<string, unknown>> = [];
  for (const u of store.getUpdates(careRecipientId)) {
    if (!u.summary?.startsWith(PREFIX)) continue;
    try {
      out.push(JSON.parse(u.summary.slice(PREFIX.length)) as Record<string, unknown>);
    } catch {
      /* skip */
    }
  }
  return out;
}
