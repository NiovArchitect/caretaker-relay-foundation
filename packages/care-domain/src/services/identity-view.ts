/**
 * Identity resolution at the view-model boundary.
 * Ordinary caregiver surfaces must never render raw principal / relationship IDs.
 */

import type { CareStore } from "../store/memory-store.js";

const LAB_NAMES: Record<string, string> = {
  "p-sadeil": "Marcus Carter",
  "p-maya": "Maya Bennett",
  "p-walter": "Daniel Kim",
  "p-dr-shah": "Dr. Priya Shah",
  "p-unauthorized": "Unauthorized relative",
};

export type IdentityView = {
  person_id: string;
  display_name: string;
  role_label: string | null;
  /** Safe for caregiver UI */
  public_label: string;
};

/** Resolve a durable display name; never returns p-* as the public label. */
export function resolvePersonDisplayName(
  store: CareStore,
  personId: string | null | undefined,
): string {
  if (!personId) return "A care helper";
  const p = store.getPerson(personId);
  if (p?.displayName && !/^p-[a-z0-9-]+$/i.test(p.displayName) && p.displayName.length > 1) {
    return p.displayName;
  }
  if (LAB_NAMES[personId]) return LAB_NAMES[personId];
  if (/^p-acct-/i.test(personId)) return "A care helper";
  if (/^p-/i.test(personId)) return "A care helper";
  return personId.length > 24 ? "A care helper" : personId;
}

export function buildIdentityView(
  store: CareStore,
  personId: string,
  careRecipientId?: string,
): IdentityView {
  const display_name = resolvePersonDisplayName(store, personId);
  let role_label: string | null = null;
  if (careRecipientId) {
    const rel = store.getRelationship(careRecipientId, personId);
    role_label = rel?.roleLabel ?? rel?.role ?? null;
  }
  return {
    person_id: personId,
    display_name,
    role_label,
    public_label: role_label ? `${display_name} · ${role_label}` : display_name,
  };
}

/** Strip raw system IDs from any caregiver-facing string at the boundary. */
export function redactSystemIds(text: string): string {
  return String(text ?? "")
    .replace(/\bp-acct-[a-z0-9]+\b/gi, "a care helper")
    .replace(/\bp-[a-z0-9-]+\b/gi, "a care helper")
    .replace(/\bcr-[a-z0-9-]+\b/gi, "this care recipient")
    .replace(/\brel-[a-z0-9-]+\b/gi, "a care relationship")
    .replace(/\bwork-[a-z0-9-]+\b/gi, "a care task")
    .replace(/\bho-[a-z0-9-]+\b/gi, "a handoff")
    .replace(/\bnotif-[a-z0-9-]+\b/gi, "a notification")
    .replace(/\bshift-[a-z0-9-]+\b/gi, "a shift")
    .replace(/\bapt-[a-z0-9-]+\b/gi, "an appointment")
    .replace(/\bevt-[a-z0-9-]+\b/gi, "a care event")
    .replace(/\bCampaign\s+ID[A-Za-z0-9]+\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
