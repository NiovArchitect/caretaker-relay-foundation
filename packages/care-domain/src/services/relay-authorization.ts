/**
 * Authorization-before-retrieval for Relay answers.
 * The 100-question bank tests intelligence — not public access.
 */

import type { CareStore } from "../store/memory-store.js";
import { evaluateAccess } from "./access.js";
import {
  resolveDomainCapabilities,
  type CareDataDomain,
  type DomainCapabilities,
} from "./minimum-necessary.js";
import { classifyIntent, type RelayIntent } from "../relay/intents.js";
import type { CareStateBag } from "../relay/projections.js";
import {
  resolveShiftRelayAccess,
  isDocumentationIntent,
  SHIFT_DOMAIN_PRESETS,
} from "./shift-relay-access.js";
import { listInvitations } from "./invitation.js";

export type RelayAuthOutcome =
  | {
      kind: "authorized";
      domains: CareDataDomain[];
      capabilities: DomainCapabilities;
      accessReason: string;
    }
  | {
      kind: "denied";
      code: string;
      /** Safe user-facing denial — never confirms hidden data exists */
      answer: string;
    };

/** Map intent families → required care domains. */
export function domainsForIntents(intents: RelayIntent[]): CareDataDomain[] {
  const d = new Set<CareDataDomain>();
  for (const i of intents) {
    if (i.startsWith("MEDICATION")) {
      d.add("medication_plan");
      d.add("medication_admin");
    }
    if (i.startsWith("APPOINTMENT") || i === "TRANSPORTATION") {
      d.add("appointments");
      d.add("schedules_coverage");
    }
    if (
      i === "STATUS_SYNTHESIS" ||
      i === "CHANGE_SINCE" ||
      i === "RECENT_ACTIVITY" ||
      i === "TREND" ||
      i === "OBSERVATION_HISTORY"
    ) {
      d.add("daily_observations");
      d.add("meals_hydration");
      d.add("symptoms");
      d.add("behavioral_notes");
    }
    if (i === "HANDOFF_REVIEW" || i === "HANDOFF_PREP") {
      d.add("handoffs");
      d.add("daily_observations");
    }
    if (i === "CARE_TEAM" || i === "CARE_COVERAGE" || i === "CONTACT_PERSON") {
      d.add("schedules_coverage");
      d.add("communications");
    }
    if (i === "EMERGENCY_SNAPSHOT") d.add("emergency_profile");
    if (
      i === "RECIPIENT_IDENTITY" ||
      i === "RECIPIENT_PROFILE" ||
      i === "RECIPIENT_AGE" ||
      i === "RECIPIENT_DIAGNOSIS" ||
      i === "RECIPIENT_ALLERGIES"
    ) {
      d.add("demographics_basic");
      d.add("diagnoses");
    }
    if (
      i === "RECIPIENT_PREFERENCES" ||
      i === "RECIPIENT_ROUTINE" ||
      i === "RECIPIENT_MOBILITY"
    ) {
      d.add("preferences_routines");
      d.add("mobility");
    }
    if (i === "DOCUMENT_PREP" || i === "PROVIDER_INSTRUCTION") {
      d.add("clinical_documents");
    }
    if (
      i === "TASKS_NOW" ||
      i === "TASKS_REMAINING" ||
      i === "WAITING_ON" ||
      i === "ESCALATION" ||
      i === "OPEN_LOOP_STATUS"
    ) {
      d.add("daily_observations");
      d.add("schedules_coverage");
      d.add("handoffs");
    }
    if (i === "SAFETY_CONCERN") {
      d.add("symptoms");
      d.add("mobility");
      d.add("daily_observations");
    }
  }
  if (d.size === 0) {
    d.add("daily_observations");
    d.add("demographics_basic");
  }
  return [...d];
}

export function authorizeRelayQuestion(
  store: CareStore,
  input: {
    principalId: string;
    careRecipientId: string;
    roleLabel: string;
    question: string;
    /** Optional clock for shift-window tests */
    nowMs?: number;
  },
): RelayAuthOutcome {
  if (
    !input.principalId ||
    input.principalId.startsWith("pending-local") ||
    input.principalId === "anonymous"
  ) {
    return {
      kind: "denied",
      code: "UNAUTHENTICATED",
      answer:
        "You need to sign in before I can answer care questions. Sign-in alone does not open any care profile.",
    };
  }

  // Invited-not-accepted: invitation exists but no active membership.
  // Check before generic NO_RELATIONSHIP so denial is precise.
  {
    const rel = store.getRelationship(
      input.careRecipientId,
      input.principalId,
    );
    if (!rel || rel.status !== "active") {
      const pendingInvite = listInvitations(store, input.careRecipientId).find(
        (i) =>
          i.inviteePersonId === input.principalId && i.status === "pending",
      );
      if (pendingInvite) {
        return {
          kind: "denied",
          code: "INVITED_NOT_ACCEPTED",
          answer:
            "Your invitation has not been accepted yet. Accept the invitation to join this care profile before I can answer care questions.",
        };
      }
    }
  }

  // Shift-scoped path (DSP / paid caregiver assignment window)
  const shift = resolveShiftRelayAccess(store, {
    principalId: input.principalId,
    careRecipientId: input.careRecipientId,
    roleLabel: input.roleLabel,
    nowMs: input.nowMs,
  });
  if (shift.kind === "denied") {
    return {
      kind: "denied",
      code: shift.code,
      answer: shift.answer,
    };
  }

  const access = evaluateAccess(
    store,
    input.principalId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    // Safe denial — do not confirm whether the recipient has data
    if (access.code === "NO_RELATIONSHIP" || access.code === "UNKNOWN_RECIPIENT") {
      return {
        kind: "denied",
        code: access.code,
        answer:
          "You do not currently have authorized access to a care profile for that request. An invitation, approval, or assignment is required.",
      };
    }
    if (access.code === "REVOKED" || access.code === "EXPIRED") {
      return {
        kind: "denied",
        code: access.code,
        answer:
          "Your care access for this person is no longer active. I cannot share care details with expired or revoked access.",
      };
    }
    return {
      kind: "denied",
      code: access.code,
      answer:
        "I can't access that information with your current care permissions.",
    };
  }

  const capsRaw = resolveDomainCapabilities(
    store,
    input.principalId,
    input.careRecipientId,
  );
  if ("denied" in capsRaw && capsRaw.denied) {
    return {
      kind: "denied",
      code: capsRaw.code,
      answer:
        "I can't access that information with your current care permissions.",
    };
  }
  let caps = capsRaw as DomainCapabilities;
  const classified = classifyIntent(input.question, undefined, {
    recipientFirstNames: [],
  });
  const needed = domainsForIntents(classified.intents);

  // Intersect with shift window domains when applicable
  if (shift.kind === "authorized") {
    if (shift.documentationOnly && !isDocumentationIntent(classified.intents)) {
      return {
        kind: "denied",
        code: "DOCUMENTATION_WINDOW_ONLY",
        answer: SHIFT_DOMAIN_PRESETS.DENY_DOC_ONLY,
      };
    }
    const shiftSet = new Set(shift.domains);
    const intersected = caps.domains.filter((d) => shiftSet.has(d));
    // pre_shift / active: domains must come from shift intersection (not full family scope)
    caps = {
      ...caps,
      controlling: false,
      domains: intersected.length ? intersected : shift.domains,
    };
  }

  const permitted = new Set(caps.domains);
  const allowedNeeded = needed.filter((d) => permitted.has(d));

  if (needed.length > 0 && allowedNeeded.length === 0 && !caps.controlling) {
    if (caps.domains.length === 0) {
      return {
        kind: "denied",
        code: "DOMAIN_OUT_OF_SCOPE",
        answer:
          "I can't access that information with your current care permissions.",
      };
    }
    const onlyMed =
      needed.every(
        (d) => d === "medication_plan" || d === "medication_admin",
      ) &&
      !permitted.has("medication_plan") &&
      !permitted.has("medication_admin");
    if (onlyMed) {
      return {
        kind: "denied",
        code: "DOMAIN_OUT_OF_SCOPE",
        answer:
          "You can participate in this care space, but medication information is not included in your current access.",
      };
    }
    // Other domain miss — safe denial without revealing hidden data
    return {
      kind: "denied",
      code: "DOMAIN_OUT_OF_SCOPE",
      answer:
        "I can't access that information with your current care permissions.",
    };
  }

  return {
    kind: "authorized",
    domains: caps.controlling
      ? caps.domains
      : allowedNeeded.length
        ? allowedNeeded
        : caps.domains,
    capabilities: caps,
    accessReason:
      shift.kind === "authorized"
        ? `shift:${shift.phase}:${access.reason}`
        : access.reason,
  };
}

/** Strip state bag fields the principal may not see. */
export function filterStateByDomains(
  state: CareStateBag,
  domains: CareDataDomain[],
  controlling: boolean,
): CareStateBag {
  if (controlling || domains.includes("medication_plan" as CareDataDomain) && domains.length > 10) {
    // broad access
  }
  const has = (d: CareDataDomain) => domains.includes(d);
  const next: CareStateBag = {
    careRecipientId: state.careRecipientId,
    medicationSchedules: has("medication_plan")
      ? state.medicationSchedules
      : [],
    medicationRecords: has("medication_admin")
      ? state.medicationRecords
      : [],
    appointments: has("appointments") ? state.appointments : [],
    observations:
      has("daily_observations") ||
      has("meals_hydration") ||
      has("symptoms") ||
      has("behavioral_notes")
        ? state.observations
        : [],
    events:
      has("daily_observations") || has("handoffs")
        ? state.events
        : [],
    openSafetyReviews: has("medication_admin") || has("symptoms")
      ? state.openSafetyReviews
      : [],
    tasks: has("daily_observations") || has("schedules_coverage")
      ? state.tasks
      : [],
  };
  return next;
}

export function auditRelayAccess(
  store: CareStore,
  input: {
    principalId: string;
    careRecipientId: string;
    question: string;
    outcome: "answered" | "denied" | "no_data";
    code?: string;
    domains?: string[];
    intent?: string;
  },
): void {
  store.writeAudit({
    at: new Date().toISOString(),
    actorPersonId: input.principalId,
    action:
      input.outcome === "denied"
        ? "RELAY_ANSWER_DENIED"
        : "RELAY_ANSWER_ACCESSED",
    careRecipientId: input.careRecipientId,
    details: {
      outcome: input.outcome,
      code: input.code,
      domains: input.domains,
      intent: input.intent,
      // Do not store full natural-language answer or full question PHI dump
      question_len: input.question.length,
      question_preview: input.question.slice(0, 80),
    },
  });
}
