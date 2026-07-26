/**
 * Field-level minimum-necessary enforcement for care API responses.
 * PRINCIPLE: Do not retrieve broad PHI and filter only in the client.
 * Extends relationship AccessScope categories into concrete domain capabilities.
 */

import type { CareStore } from "../store/memory-store.js";
import type {
  AccessScope,
  CareRecipient,
  CareRecipientProfile,
  CurrentCareState,
} from "../types.js";
import { evaluateAccess } from "./access.js";

/** Canonical care data domains for policy matrix. */
export type CareDataDomain =
  | "demographics_basic"
  | "demographics_sensitive"
  | "preferences_routines"
  | "daily_observations"
  | "meals_hydration"
  | "mobility"
  | "symptoms"
  | "appointments"
  | "schedules_coverage"
  | "medication_plan"
  | "medication_admin"
  | "clinical_documents"
  | "diagnoses"
  | "emergency_profile"
  | "behavioral_notes"
  | "communications"
  | "legal_representative"
  | "insurance"
  | "access_records"
  | "audit_history"
  | "exports"
  | "handoffs";

export type CareCapability =
  | "view_daily_care"
  | "view_medication_plan"
  | "record_medication_admin"
  | "view_clinical_documents"
  | "view_emergency_profile"
  | "view_legal_authority"
  | "export_record"
  | "manage_access"
  | "view_audit"
  | "view_demographics_full"
  | "view_insurance";

export interface DomainCapabilities {
  domains: CareDataDomain[];
  capabilities: CareCapability[];
  controlling: boolean;
}

const ALL_DOMAINS: CareDataDomain[] = [
  "demographics_basic",
  "demographics_sensitive",
  "preferences_routines",
  "daily_observations",
  "meals_hydration",
  "mobility",
  "symptoms",
  "appointments",
  "schedules_coverage",
  "medication_plan",
  "medication_admin",
  "clinical_documents",
  "diagnoses",
  "emergency_profile",
  "behavioral_notes",
  "communications",
  "legal_representative",
  "insurance",
  "access_records",
  "audit_history",
  "exports",
  "handoffs",
];

const ALL_CAPABILITIES: CareCapability[] = [
  "view_daily_care",
  "view_medication_plan",
  "record_medication_admin",
  "view_clinical_documents",
  "view_emergency_profile",
  "view_legal_authority",
  "export_record",
  "manage_access",
  "view_audit",
  "view_demographics_full",
  "view_insurance",
];

/** Map AccessScope information categories → domains. */
function domainsFromScope(scope: AccessScope): Set<CareDataDomain> {
  const cats = scope.informationCategories;
  const out = new Set<CareDataDomain>();
  if (cats.includes("*")) {
    for (const d of ALL_DOMAINS) out.add(d);
    return out;
  }
  // Always allow basic identity when any membership exists
  out.add("demographics_basic");
  out.add("schedules_coverage");
  for (const c of cats) {
    const cl = c.toLowerCase();
    if (cl.includes("daily") || cl.includes("observation") || cl.includes("health")) {
      out.add("daily_observations");
      out.add("meals_hydration");
      out.add("mobility");
      out.add("symptoms");
      out.add("preferences_routines");
    }
    if (cl.includes("medication")) {
      out.add("medication_plan");
      out.add("medication_admin");
    }
    if (cl.includes("appointment") || cl.includes("schedule")) {
      out.add("appointments");
      out.add("schedules_coverage");
    }
    if (cl.includes("care plan") || cl.includes("instruction")) {
      out.add("preferences_routines");
      out.add("handoffs");
    }
    if (cl.includes("clinical") || cl.includes("document") || cl.includes("diagnos")) {
      out.add("clinical_documents");
      out.add("diagnoses");
    }
    if (cl.includes("emergency")) {
      out.add("emergency_profile");
    }
    if (cl.includes("legal") || cl.includes("representative")) {
      out.add("legal_representative");
    }
    if (cl.includes("insurance")) {
      out.add("insurance");
    }
    if (cl.includes("audit") || cl.includes("access")) {
      out.add("access_records");
      out.add("audit_history");
    }
    if (cl.includes("export")) {
      out.add("exports");
    }
    if (cl.includes("communication") || cl.includes("message")) {
      out.add("communications");
    }
  }
  return out;
}

function capabilitiesFromScope(scope: AccessScope): Set<CareCapability> {
  const caps = new Set<CareCapability>();
  const actions = scope.allowedActions;
  const cats = scope.informationCategories;
  const star =
    actions.includes("*") || cats.includes("*");

  caps.add("view_daily_care");
  if (
    star ||
    cats.some((c) => /medication/i.test(c)) ||
    actions.some((a) => /med|admin/i.test(a))
  ) {
    caps.add("view_medication_plan");
  }
  if (
    star ||
    actions.some((a) =>
      /record|admin|write|observation/i.test(a),
    )
  ) {
    caps.add("record_medication_admin");
  }
  if (star || cats.some((c) => /clinical|document|diagnos/i.test(c))) {
    caps.add("view_clinical_documents");
    caps.add("view_demographics_full");
  }
  if (star || cats.some((c) => /emergency/i.test(c))) {
    caps.add("view_emergency_profile");
  }
  if (star || cats.some((c) => /legal|representative/i.test(c))) {
    caps.add("view_legal_authority");
  }
  if (star || actions.includes("export") || cats.some((c) => /export/i.test(c))) {
    caps.add("export_record");
  }
  if (
    star ||
    actions.includes("invite") ||
    actions.includes("manage_membership")
  ) {
    caps.add("manage_access");
    caps.add("view_audit");
  }
  if (star || cats.some((c) => /insurance/i.test(c))) {
    caps.add("view_insurance");
  }
  return caps;
}

export function resolveDomainCapabilities(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
): DomainCapabilities | { denied: true; reason: string; code: string } {
  const decision = evaluateAccess(store, actorPersonId, careRecipientId);
  if (!decision.allowed) {
    return { denied: true, reason: decision.reason, code: decision.code };
  }
  const controlling =
    decision.scope.informationCategories.includes("*") ||
    decision.scope.allowedActions.includes("*") ||
    actorPersonId === careRecipientId;

  if (controlling) {
    return {
      domains: [...ALL_DOMAINS],
      capabilities: [...ALL_CAPABILITIES],
      controlling: true,
    };
  }

  return {
    domains: [...domainsFromScope(decision.scope)],
    capabilities: [...capabilitiesFromScope(decision.scope)],
    controlling: false,
  };
}

export function hasCapability(
  caps: DomainCapabilities,
  cap: CareCapability,
): boolean {
  return caps.capabilities.includes(cap);
}

export function hasDomain(
  caps: DomainCapabilities,
  domain: CareDataDomain,
): boolean {
  return caps.domains.includes(domain);
}

/** Project recipient profile to allowed fields only. */
export function projectRecipientProfile(
  recipient: CareRecipient,
  caps: DomainCapabilities,
): {
  id: string;
  displayName: string;
  preferredName?: string;
  householdId: string;
  profile: Partial<CareRecipientProfile> | null;
  redacted_fields: string[];
} {
  const redacted: string[] = [];
  const base = {
    id: recipient.id,
    displayName: recipient.displayName,
    preferredName: recipient.preferredName,
    householdId: recipient.householdId,
  };
  if (!recipient.profile) {
    return { ...base, profile: null, redacted_fields: redacted };
  }
  const p = recipient.profile;
  const out: Partial<CareRecipientProfile> = {};

  // Always safe for active membership
  if (hasDomain(caps, "demographics_basic") || caps.controlling) {
    out.pronouns = p.pronouns;
    out.primaryLanguage = p.primaryLanguage;
    out.communicationNeeds = p.communicationNeeds;
  }

  if (hasCapability(caps, "view_demographics_full") || caps.controlling) {
    out.dateOfBirth = p.dateOfBirth;
  } else if (p.dateOfBirth) {
    redacted.push("dateOfBirth");
  }

  if (hasDomain(caps, "preferences_routines") || caps.controlling) {
    out.dailyRoutineSummary = p.dailyRoutineSummary;
    out.carePreferences = p.carePreferences;
    out.likesDislikes = p.likesDislikes;
    out.dietMealConsiderations = p.dietMealConsiderations;
    out.mobilityBaseline = p.mobilityBaseline;
    out.assistiveDevices = p.assistiveDevices;
    out.cognitiveSupportNeeds = p.cognitiveSupportNeeds;
    out.supportNeeds = p.supportNeeds;
    out.careGoals = p.careGoals;
    out.careLocationSummary = p.careLocationSummary;
    out.transportationNotes = p.transportationNotes;
  } else {
    for (const f of [
      "dailyRoutineSummary",
      "carePreferences",
      "likesDislikes",
    ]) {
      redacted.push(f);
    }
  }

  if (hasDomain(caps, "diagnoses") || hasCapability(caps, "view_clinical_documents") || caps.controlling) {
    out.confirmedConditions = p.confirmedConditions;
    out.healthConcerns = p.healthConcerns;
    out.allergies = p.allergies;
    out.primaryProviderName = p.primaryProviderName;
    out.otherProviders = p.otherProviders;
  } else {
    if (p.confirmedConditions?.length) redacted.push("confirmedConditions");
    if (p.allergies?.length) redacted.push("allergies");
    if (p.healthConcerns?.length) redacted.push("healthConcerns");
  }

  if (hasCapability(caps, "view_emergency_profile") || caps.controlling) {
    out.emergencyContacts = p.emergencyContacts;
    out.safetyConsiderations = p.safetyConsiderations;
  } else {
    if (p.emergencyContacts?.length) redacted.push("emergencyContacts");
    if (p.safetyConsiderations?.length) redacted.push("safetyConsiderations");
  }

  return { ...base, profile: out, redacted_fields: redacted };
}

/** Project current care state — strip denied domains before response. */
export function projectCurrentState(
  state: CurrentCareState,
  caps: DomainCapabilities,
): CurrentCareState & { redacted_domains: CareDataDomain[] } {
  const redacted: CareDataDomain[] = [];
  const next: CurrentCareState = { ...state };

  if (!hasDomain(caps, "medication_plan") && !caps.controlling) {
    next.medicationSchedules = [];
    redacted.push("medication_plan");
  }
  if (!hasDomain(caps, "medication_admin") && !caps.controlling) {
    next.medicationRecords = [];
    redacted.push("medication_admin");
  }
  if (
    !hasDomain(caps, "daily_observations") &&
    !hasDomain(caps, "symptoms") &&
    !caps.controlling
  ) {
    next.observations = [];
    redacted.push("daily_observations");
  }
  if (!hasDomain(caps, "appointments") && !caps.controlling) {
    next.appointments = [];
    redacted.push("appointments");
  }
  if (!hasDomain(caps, "handoffs") && !caps.controlling) {
    next.handoffs = [];
    redacted.push("handoffs");
  }
  if (!hasDomain(caps, "exports") && !hasCapability(caps, "export_record") && !caps.controlling) {
    // tasks may remain if daily care allowed
  }
  if (
    !hasDomain(caps, "daily_observations") &&
    !hasDomain(caps, "meals_hydration") &&
    !caps.controlling
  ) {
    next.events = (next.events ?? []).filter(
      (e) =>
        e.type !== "meal" &&
        e.type !== "observation" &&
        e.type !== "note",
    );
  }
  if (!hasDomain(caps, "medication_admin") && !caps.controlling) {
    next.events = (next.events ?? []).filter(
      (e) => e.type !== "medication_administration",
    );
  }

  return { ...next, redacted_domains: redacted };
}

export function canViewMedicationPlan(caps: DomainCapabilities): boolean {
  return hasCapability(caps, "view_medication_plan") || caps.controlling;
}

export function canExportRecord(caps: DomainCapabilities): boolean {
  return hasCapability(caps, "export_record") || caps.controlling;
}

export function canManageAccess(caps: DomainCapabilities): boolean {
  return hasCapability(caps, "manage_access") || caps.controlling;
}

export function canViewAudit(caps: DomainCapabilities): boolean {
  return hasCapability(caps, "view_audit") || caps.controlling;
}

export { ALL_DOMAINS, ALL_CAPABILITIES };
