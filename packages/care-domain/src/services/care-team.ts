/**
 * Scalable care-team identity resolution.
 *
 * Person ≠ role ≠ permission ≠ organization.
 * Authority decisions MUST use CareRelationship + scope + status + effective dates,
 * never display-name string equality or hardcoded person IDs in business logic.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareRelationship, Person } from "../types.js";

export type CareTeamRoleKind =
  | "primary_physician"
  | "physician"
  | "provider"
  | "family_caregiver"
  | "adult_child"
  | "professional_dsp"
  | "paid_caregiver"
  | "service"
  | "other";

export type CareTeamMemberView = {
  personId: string;
  displayName: string;
  relationshipId: string;
  careRecipientId: string;
  role: string;
  roleLabel: string;
  roleKind: CareTeamRoleKind;
  organizationId?: string;
  organizationName?: string;
  status: CareRelationship["status"];
  validFrom?: string;
  validTo?: string;
  scopeCategories: string[];
  allowedActions: string[];
  canEscalate: boolean;
  isCurrent: boolean;
};

function classifyRoleKind(role: string, roleLabel: string): CareTeamRoleKind {
  const blob = `${role} ${roleLabel}`.toLowerCase();
  if (/primary\s*care|pcp|primary physician/.test(blob)) return "primary_physician";
  if (/physician|md|do\b|clinician/.test(blob)) return "physician";
  if (/provider|doctor/.test(blob)) return "provider";
  if (/paid|dsp|professional|in-home|agency/.test(blob)) return "professional_dsp";
  if (/adult.?child|daughter|son/.test(blob)) return "adult_child";
  if (/family|friend|spouse|unpaid/.test(blob)) return "family_caregiver";
  if (/pt|therapy|service/.test(blob)) return "service";
  return "other";
}

function isCurrentlyEffective(rel: CareRelationship, now = new Date()): boolean {
  if (rel.status === "revoked" || rel.status === "expired") return false;
  if (rel.status !== "active") return false;
  if (rel.startDate) {
    const s = Date.parse(rel.startDate);
    if (!Number.isNaN(s) && s > now.getTime()) return false;
  }
  if (rel.endDate) {
    const e = Date.parse(rel.endDate);
    if (!Number.isNaN(e) && e < now.getTime()) return false;
  }
  return true;
}

/** List care-team memberships for a recipient (data-driven). */
export function listCareTeam(
  store: CareStore,
  careRecipientId: string,
  opts?: { includeInactive?: boolean; now?: Date },
): CareTeamMemberView[] {
  const now = opts?.now ?? new Date();
  const out: CareTeamMemberView[] = [];
  for (const rel of store.getRelationships(careRecipientId)) {
    const current = isCurrentlyEffective(rel, now);
    if (!current && !opts?.includeInactive) continue;
    const person = store.getPerson(rel.personId);
    const orgId = (rel as CareRelationship & { organizationId?: string })
      .organizationId;
    const orgName = (rel as CareRelationship & { organizationName?: string })
      .organizationName;
    out.push({
      personId: rel.personId,
      displayName: person?.displayName ?? rel.personId,
      relationshipId: rel.id,
      careRecipientId,
      role: rel.role,
      roleLabel: rel.roleLabel,
      roleKind: classifyRoleKind(rel.role, rel.roleLabel),
      organizationId: orgId,
      organizationName: orgName,
      status: rel.status,
      validFrom: rel.startDate,
      validTo: rel.endDate,
      scopeCategories: rel.access.informationCategories ?? [],
      allowedActions: rel.access.allowedActions ?? [],
      canEscalate: !!rel.access.canEscalate,
      isCurrent: current,
    });
  }
  return out;
}

/** Current primary/clinical provider for a recipient — from relationships, not names. */
export function resolveCurrentProvider(
  store: CareStore,
  careRecipientId: string,
): CareTeamMemberView | null {
  const team = listCareTeam(store, careRecipientId);
  const ranked = team
    .filter((m) =>
      ["primary_physician", "physician", "provider"].includes(m.roleKind),
    )
    .sort((a, b) => {
      const rank = (k: CareTeamRoleKind) =>
        k === "primary_physician" ? 0 : k === "physician" ? 1 : 2;
      return rank(a.roleKind) - rank(b.roleKind);
    });
  return ranked[0] ?? null;
}

/** Whether a person is a current care-team member with a given role kind. */
export function isCurrentTeamMember(
  store: CareStore,
  careRecipientId: string,
  personId: string,
  roleKinds?: CareTeamRoleKind[],
): boolean {
  const team = listCareTeam(store, careRecipientId);
  return team.some(
    (m) =>
      m.personId === personId &&
      m.isCurrent &&
      (!roleKinds || roleKinds.includes(m.roleKind)),
  );
}

/**
 * Resolve person on team by name hint without treating name as authority.
 * Returns matches; caller must disambiguate if >1.
 */
export function findTeamMembersByNameHint(
  store: CareStore,
  careRecipientId: string,
  nameHint: string,
  opts?: { includeInactive?: boolean },
): CareTeamMemberView[] {
  const hint = nameHint.toLowerCase().replace(/^dr\.?\s*/i, "").trim();
  if (!hint) return [];
  return listCareTeam(store, careRecipientId, {
    includeInactive: opts?.includeInactive,
  }).filter((m) => {
    const dn = m.displayName.toLowerCase().replace(/^dr\.?\s*/i, "");
    return dn.includes(hint) || hint.includes(dn.split(" ")[0] ?? "");
  });
}

/** Best human to ask for a purpose — data-driven from care team. */
export function resolveEscalationTarget(
  store: CareStore,
  careRecipientId: string,
  purpose:
    | "provider_clinical"
    | "medication_admin"
    | "appointment"
    | "general",
  excludePersonId?: string,
): CareTeamMemberView | null {
  const team = listCareTeam(store, careRecipientId).filter(
    (m) => m.personId !== excludePersonId && m.isCurrent,
  );

  if (purpose === "provider_clinical") {
    return (
      team.find((m) => m.roleKind === "primary_physician") ??
      team.find((m) => m.roleKind === "physician" || m.roleKind === "provider") ??
      null
    );
  }

  if (purpose === "medication_admin") {
    const mars = store.getMedRecords(careRecipientId);
    for (let i = mars.length - 1; i >= 0; i--) {
      const by = mars[i]!.administeredByPersonId;
      if (by && by !== excludePersonId) {
        const m = team.find((t) => t.personId === by);
        if (m) return m;
      }
    }
    return (
      team.find((m) => m.roleKind === "adult_child") ??
      team.find((m) => m.roleKind === "family_caregiver") ??
      team.find((m) => m.roleKind === "professional_dsp") ??
      null
    );
  }

  if (purpose === "appointment") {
    return (
      team.find((m) => m.roleKind === "professional_dsp") ??
      team.find((m) => m.roleKind === "family_caregiver") ??
      null
    );
  }

  return team[0] ?? null;
}

export function personOrganizationKey(
  person: Person | undefined,
  membership: CareTeamMemberView | null,
): string {
  return `${person?.id ?? "unknown"}::${membership?.organizationId ?? "no-org"}`;
}
