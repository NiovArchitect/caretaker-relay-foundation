/**
 * Durable care-event ETL pipeline (competition-bounded).
 *
 * authenticate → authorize → validate → normalize → classify → attach provenance
 * → dedupe → conflict detect → persist → project side-effects → notify → audit
 *
 * Secondary notification/schedule failures never roll back the durable event.
 */

import type { CareStore } from "../store/memory-store.js";
import type {
  CareAuthorityBasis,
  CareConfidenceLabel,
  CareEvent,
  CareEventType,
  CareTruthState,
  EpistemicStatus,
  EvidenceMode,
  SafetyClass,
  ScheduleLifecycleState,
  SourceRef,
} from "../types.js";
import { evaluateAccess } from "./access.js";
import { createNotificationIfNew } from "./notifications.js";
import { recalculateAppointmentReminders } from "./reminders.js";

export type CareEventSourceKind =
  | "family_report"
  | "recipient_report"
  | "dsp_shift"
  | "clinician_note"
  | "relay_conversation"
  | "manual_appointment"
  | "consent_access_change"
  | "correction"
  | "system";

export type IngestCareEventInput = {
  careRecipientId: string;
  actorPrincipalId: string;
  actorDisplayName: string;
  actorActiveRole?: string;
  sourceKind: CareEventSourceKind;
  type: CareEventType;
  title: string;
  statement: string;
  eventAt?: string;
  reportAt?: string;
  timezone?: string;
  dataDomain?: string;
  purpose?: string;
  safetyClass?: SafetyClass;
  confidenceLabel?: CareConfidenceLabel;
  truthState?: CareTruthState;
  scheduleState?: ScheduleLifecycleState;
  structured?: Record<string, unknown>;
  intendedRecipientPersonId?: string;
  correctionTargetId?: string;
  correlationId?: string;
  idempotencyKey?: string;
  /** Skip notify (e.g. bulk seed). */
  silent?: boolean;
  evidenceMode?: EvidenceMode;
};

export type IngestCareEventResult =
  | {
      ok: true;
      event: CareEvent;
      deduped: boolean;
      conflictGroupId?: string;
      taskIds: string[];
      reminderIds: string[];
      notificationIds: string[];
      auditId: string;
    }
  | {
      ok: false;
      code:
        | "NO_RELATIONSHIP"
        | "REVOKED"
        | "EXPIRED"
        | "UNKNOWN_RECIPIENT"
        | "WRONG_HOUSEHOLD"
        | "MISSING_ACTION"
        | "BAD_REQUEST"
        | "UNAUTHENTICATED";
      message: string;
    };

const SOURCE_KIND_MAP: Record<
  CareEventSourceKind,
  SourceRef["kind"]
> = {
  family_report: "caregiver_text",
  recipient_report: "caregiver_text",
  dsp_shift: "professional_note",
  clinician_note: "provider_instruction",
  relay_conversation: "caregiver_speech",
  manual_appointment: "caregiver_text",
  consent_access_change: "system_derived",
  correction: "correction",
  system: "system_derived",
};

function classifyDomain(
  type: CareEventType,
  explicit?: string,
): string {
  if (explicit) return explicit;
  switch (type) {
    case "meal":
      return "meals_hydration";
    case "medication_administration":
      return "medication_admin";
    case "appointment_change":
    case "schedule_change":
    case "reminder":
      return "appointments";
    case "clinical_note":
      return "clinical_documents";
    case "shift_observation":
    case "observation":
    case "incident":
      return "daily_observations";
    case "access_change":
    case "consent_change":
      return "access_records";
    case "handoff":
      return "handoffs";
    case "correction":
      return "daily_observations";
    default:
      return "daily_observations";
  }
}

function authorityFor(
  actorId: string,
  recipientId: string,
  sourceKind: CareEventSourceKind,
): CareAuthorityBasis {
  if (sourceKind === "system") return "system";
  if (actorId === recipientId) return "self";
  if (sourceKind === "dsp_shift") return "assignment";
  if (sourceKind === "consent_access_change") return "consent";
  return "membership";
}

/**
 * Fingerprint for medication-plan change statements so distinct meds never share
 * a dedupe key (even when a client reuses a coarse idempotency prefix).
 */
export function medicationChangeFingerprint(statement: string): string | null {
  const s = statement.trim().toLowerCase().replace(/\s+/g, " ");
  if (
    !/medication change|needs verification|waiting for medication-plan|reported dose|plan verification/i.test(
      s,
    )
  ) {
    return null;
  }
  const name =
    s.match(
      /\b(cetirizine|acetaminophen|naproxen|tylenol|zyrtec|allegra|claritin|ibuprofen|benadryl|metformin|[a-z]{4,})\b/,
    )?.[1] || "med";
  // Prefer name after "verification:" if present
  const after =
    s.match(
      /(?:medication change needs verification|needs verification)[:\s]+([a-z][a-z-]{2,})/i,
    )?.[1] || name;
  const dose = s.match(/(\d+\s*(?:mg|mcg|ml|units?))/i)?.[1]?.replace(/\s+/g, "") || "nodose";
  const reason =
    s.match(/reason[:\s]+([a-z][a-z\s-]{2,40})/i)?.[1]?.trim().slice(0, 32) || "noreason";
  return `${after}|${dose}|${reason}`;
}

export function buildDedupeKey(input: {
  careRecipientId: string;
  type: CareEventType;
  eventAt: string;
  actorPrincipalId: string;
  statement: string;
  idempotencyKey?: string;
}): string {
  const medFp = medicationChangeFingerprint(input.statement);
  if (input.idempotencyKey) {
    // Never let a shared client key collapse distinct medication candidates
    return medFp
      ? `idem:${input.careRecipientId}:${input.idempotencyKey}:med:${medFp}`
      : `idem:${input.careRecipientId}:${input.idempotencyKey}`;
  }
  if (medFp) {
    return [
      input.careRecipientId,
      "medication_plan_change",
      medFp,
      input.actorPrincipalId,
    ].join("|");
  }
  const norm = input.statement.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 120);
  return [
    input.careRecipientId,
    input.type,
    input.eventAt,
    input.actorPrincipalId,
    norm,
  ].join("|");
}

function epistemicFromTruth(t: CareTruthState | undefined): EpistemicStatus {
  switch (t) {
    case "confirmed":
      return "CONFIRMED";
    case "disputed":
      return "UNCERTAIN";
    case "cancelled":
    case "superseded":
    case "corrected":
      return "SUPERSEDED";
    default:
      return "REPORTED";
  }
}

function findDedupe(
  store: CareStore,
  careRecipientId: string,
  dedupeKey: string,
): CareEvent | undefined {
  return store
    .getEvents(careRecipientId)
    .find((e) => e.dedupeKey === dedupeKey || e.notes?.includes(`dedupe:${dedupeKey}`));
}

function detectConflicts(
  store: CareStore,
  careRecipientId: string,
  candidate: CareEvent,
): string[] {
  if (candidate.type !== "appointment_change" && candidate.type !== "schedule_change") {
    return [];
  }
  const windowStart = Date.parse(candidate.eventAt ?? candidate.occurredAt);
  if (Number.isNaN(windowStart)) return [];
  return store
    .getEvents(careRecipientId)
    .filter((e) => {
      if (e.id === candidate.id) return false;
      if (e.supersededById) return false;
      if (e.type !== "appointment_change" && e.type !== "schedule_change") return false;
      const t = Date.parse(e.eventAt ?? e.occurredAt);
      if (Number.isNaN(t)) return false;
      return Math.abs(t - windowStart) < 2 * 60 * 60 * 1000; // 2h window
    })
    .map((e) => e.id);
}

/**
 * Ingest one authorized care event with provenance + side effects.
 */
export function ingestCareEvent(
  store: CareStore,
  input: IngestCareEventInput,
): IngestCareEventResult {
  if (!input.actorPrincipalId) {
    return { ok: false, code: "UNAUTHENTICATED", message: "Actor required" };
  }
  if (!input.careRecipientId || !input.statement?.trim()) {
    return { ok: false, code: "BAD_REQUEST", message: "recipient and statement required" };
  }

  const access = evaluateAccess(store, input.actorPrincipalId, input.careRecipientId, {
    requiredAction: input.type === "correction" ? "correct" : "record",
  });
  // Soft fallback: membership with any write-ish action
  const soft =
    access.allowed
      ? access
      : evaluateAccess(store, input.actorPrincipalId, input.careRecipientId);
  if (!soft.allowed) {
    return {
      ok: false,
      code: soft.code as IngestCareEventResult extends { ok: false; code: infer C }
        ? C
        : never,
      message: soft.reason,
    };
  }

  const recipient = store.getRecipient(input.careRecipientId);
  if (!recipient) {
    return { ok: false, code: "UNKNOWN_RECIPIENT", message: "Recipient not found" };
  }

  const now = new Date().toISOString();
  const eventAt = input.eventAt ?? now;
  const reportAt = input.reportAt ?? now;
  const truthState = input.truthState ?? "reported";
  const dedupeKey = buildDedupeKey({
    careRecipientId: input.careRecipientId,
    type: input.type,
    eventAt,
    actorPrincipalId: input.actorPrincipalId,
    statement: input.statement,
    idempotencyKey: input.idempotencyKey,
  });

  const existing = findDedupe(store, input.careRecipientId, dedupeKey);
  if (existing) {
    return {
      ok: true,
      event: existing,
      deduped: true,
      taskIds: [],
      reminderIds: [],
      notificationIds: [],
      auditId: store.writeAudit({
        at: now,
        actorPersonId: input.actorPrincipalId,
        action: "CARE_EVENT_DEDUPED",
        careRecipientId: input.careRecipientId,
        householdId: recipient.householdId,
        details: { eventId: existing.id, dedupeKey },
      }).id,
    };
  }

  const source: SourceRef = {
    id: store.newId("src"),
    kind: SOURCE_KIND_MAP[input.sourceKind],
    label: `${input.sourceKind} · ${input.actorDisplayName}`,
    actorName: input.actorDisplayName,
    actorPersonId: input.actorPrincipalId,
    recordedAt: reportAt,
    whyVisible: `Recorded by ${input.actorDisplayName} (${input.actorActiveRole ?? input.sourceKind}) under authorized membership.`,
    rawExcerpt: input.statement.slice(0, 240),
  };

  const event: CareEvent = {
    id: store.newId("evt"),
    careRecipientId: input.careRecipientId,
    householdId: recipient.householdId,
    type: input.type,
    title: input.title || input.statement.slice(0, 80),
    statement: input.statement.trim(),
    occurredAt: eventAt,
    eventAt,
    reportAt,
    ingestedAt: now,
    timezone: input.timezone ?? "America/Los_Angeles",
    notes: `dedupe:${dedupeKey}`,
    epistemicStatus: epistemicFromTruth(truthState),
    safetyClass: input.safetyClass ?? "low",
    source,
    confidence:
      input.confidenceLabel === "confirmed"
        ? 0.95
        : input.confidenceLabel === "inferred"
          ? 0.55
          : 0.75,
    intendedRecipientPersonId: input.intendedRecipientPersonId,
    evidenceMode: input.evidenceMode ?? "SYNTHETIC_FOUNDATION_BACKED",
    actorPrincipalId: input.actorPrincipalId,
    actorActiveRole: input.actorActiveRole,
    authorityBasis: authorityFor(
      input.actorPrincipalId,
      input.careRecipientId,
      input.sourceKind,
    ),
    dataDomain: classifyDomain(input.type, input.dataDomain),
    purpose: input.purpose ?? "care_coordination",
    sensitivity: input.safetyClass ?? "low",
    truthState,
    confidenceLabel: input.confidenceLabel ?? "reported",
    dedupeKey,
    correctionTargetId: input.correctionTargetId,
    scheduleState: input.scheduleState,
    approvalState: "none",
    executionState: "none",
    correlationId: input.correlationId ?? store.newId("corr"),
    structured: input.structured,
  };

  const conflicts = detectConflicts(store, input.careRecipientId, event);
  if (conflicts.length) {
    event.conflictWithIds = conflicts;
    event.conflictGroupId = `cg-${conflicts[0]}`;
    // Mark peer events (non-destructive)
    for (const id of conflicts) {
      const peer = store.getEvent(id);
      if (peer && !peer.conflictGroupId) {
        store.addEvent({
          ...peer,
          conflictGroupId: event.conflictGroupId,
          conflictWithIds: [...(peer.conflictWithIds ?? []), event.id],
        });
      }
    }
  }

  if (input.correctionTargetId) {
    store.supersedeEvent(input.correctionTargetId, event.id);
    event.truthState = "corrected";
    event.epistemicStatus = "CONFIRMED";
  }

  store.addEvent(event);

  const taskIds: string[] = [];
  const reminderIds: string[] = [];
  const notificationIds: string[] = [];

  // Side effects — isolated so failures don't drop the event
  try {
    if (
      input.type === "task" ||
      input.type === "observation" ||
      input.type === "incident" ||
      input.type === "shift_observation"
    ) {
      const task = store.upsertTask({
        id: store.newId("task"),
        careRecipientId: input.careRecipientId,
        title: event.title,
        dueAt: event.eventAt,
        status: "pending",
        assigneePersonId: input.intendedRecipientPersonId,
        safetyClass: event.safetyClass,
        epistemicStatus: event.epistemicStatus,
        source,
      });
      taskIds.push(task.id);
    }

    if (input.type === "appointment_change" || input.type === "schedule_change") {
      const startsAt = event.eventAt ?? event.occurredAt;
      const appt = store.upsertAppointment({
        id: store.newId("apt"),
        careRecipientId: input.careRecipientId,
        title: event.title,
        startsAt,
        startsAtLabel: input.structured?.startsAtLabel as string | undefined,
        location: input.structured?.location as string | undefined,
        status: "scheduled",
        scheduleState: input.scheduleState ?? "confirmed",
        epistemicStatus: event.epistemicStatus,
        source,
        timezone: event.timezone,
      });
      try {
        const rems = recalculateAppointmentReminders(store, {
          careRecipientId: input.careRecipientId,
          appointment: appt,
          timezone: event.timezone,
          principalIds: [input.actorPrincipalId],
        });
        for (const r of rems) reminderIds.push(r.id);
      } catch {
        /* reminders optional */
      }
    }

    if (!input.silent) {
      const members = store.getRelationships(input.careRecipientId).filter(
        (r) => r.status === "active" && r.personId !== input.actorPrincipalId,
      );
      for (const m of members.slice(0, 8)) {
        const n = createNotificationIfNew(store, {
          principalId: m.personId,
          careRecipientId: input.careRecipientId,
          type: "CARE_UPDATE",
          priority: event.safetyClass === "high" ? "important" : "attention",
          title: event.title,
          body: event.statement.slice(0, 200),
          sourceType: "care_event",
          sourceId: event.id,
          actorPersonId: input.actorPrincipalId,
          actorDisplayName: input.actorDisplayName,
          actionType: "open_timeline",
          actionTarget: event.id,
          dedupeKey: `evt-notif:${event.id}:${m.personId}`,
        });
        if (n?.id) notificationIds.push(n.id);
      }
    }
  } catch {
    /* durable event already stored */
  }

  const audit = store.writeAudit({
    at: now,
    actorPersonId: input.actorPrincipalId,
    action: "CARE_EVENT_INGESTED",
    careRecipientId: input.careRecipientId,
    householdId: recipient.householdId,
    details: {
      eventId: event.id,
      type: event.type,
      sourceKind: input.sourceKind,
      dedupeKey,
      eventAt: event.eventAt,
      reportAt: event.reportAt,
      truthState: event.truthState,
      conflictGroupId: event.conflictGroupId,
      taskIds,
      reminderIds,
      notificationIds,
      correlationId: event.correlationId,
    },
  });

  return {
    ok: true,
    event,
    deduped: false,
    conflictGroupId: event.conflictGroupId,
    taskIds,
    reminderIds,
    notificationIds,
    auditId: audit.id,
  };
}

/** Timeline projection: events newest-first, non-superseded first-class. */
export function buildTimeline(
  store: CareStore,
  careRecipientId: string,
  opts?: { includeSuperseded?: boolean; limit?: number },
): CareEvent[] {
  const limit = opts?.limit ?? 100;
  let events = store.getEvents(careRecipientId);
  if (!opts?.includeSuperseded) {
    events = events.filter((e) => !e.supersededById && e.truthState !== "superseded");
  }
  return events
    .slice()
    .sort((a, b) => {
      const ta = Date.parse(a.eventAt ?? a.occurredAt);
      const tb = Date.parse(b.eventAt ?? b.occurredAt);
      return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta);
    })
    .slice(0, limit);
}
