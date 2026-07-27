/**
 * Recurrence exceptions — skip/pause/this-only without mutating completed past.
 * Durable via CareUpdate CARE_RECURRENCE_EX_V1.
 */

import type { CareStore } from "../store/memory-store.js";
import { evaluateAccess } from "./access.js";
import { upsertScheduleItem } from "./schedule-engine.js";

export type RecurrenceScope =
  | "this_occurrence"
  | "this_and_future"
  | "entire_series";

export type RecurrenceExceptionKind =
  | "skip"
  | "cancel"
  | "pause"
  | "resume"
  | "reschedule";

export type RecurrenceException = {
  id: string;
  careRecipientId: string;
  seriesAppointmentId: string;
  occurrenceStartsAt: string;
  kind: RecurrenceExceptionKind;
  scope: RecurrenceScope;
  newStartsAt?: string | null;
  reason?: string;
  createdByPersonId: string;
  createdAt: string;
};

const PREFIX = "CARE_RECURRENCE_EX_V1:";

function encode(e: RecurrenceException): string {
  return PREFIX + JSON.stringify(e);
}

function decode(summary: string): RecurrenceException | null {
  if (!summary.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(summary.slice(PREFIX.length)) as RecurrenceException;
  } catch {
    return null;
  }
}

export function listRecurrenceExceptions(
  store: CareStore,
  careRecipientId: string,
  seriesAppointmentId?: string,
): RecurrenceException[] {
  const out: RecurrenceException[] = [];
  for (const u of store.getUpdates(careRecipientId)) {
    const e = decode(u.summary);
    if (!e) continue;
    if (seriesAppointmentId && e.seriesAppointmentId !== seriesAppointmentId)
      continue;
    out.push(e);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function applyRecurrenceException(
  store: CareStore,
  input: {
    careRecipientId: string;
    actorPersonId: string;
    actorDisplayName: string;
    seriesAppointmentId: string;
    occurrenceStartsAt: string;
    kind: RecurrenceExceptionKind;
    scope: RecurrenceScope;
    newStartsAt?: string | null;
    reason?: string;
  },
):
  | { ok: true; exception: RecurrenceException; preview: string }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const series = store
    .getAppointments(input.careRecipientId)
    .find((a) => a.id === input.seriesAppointmentId);
  if (!series) {
    return { ok: false, code: "NOT_FOUND", message: "Series appointment not found" };
  }
  // Never mutate past completed
  if (series.status === "completed") {
    return {
      ok: false,
      code: "PAST_COMPLETED",
      message: "Past completed events cannot be rewritten by series exception",
    };
  }
  const now = new Date().toISOString();
  const exception: RecurrenceException = {
    id: store.newId("rex"),
    careRecipientId: input.careRecipientId,
    seriesAppointmentId: input.seriesAppointmentId,
    occurrenceStartsAt: input.occurrenceStartsAt,
    kind: input.kind,
    scope: input.scope,
    newStartsAt: input.newStartsAt ?? null,
    reason: input.reason,
    createdByPersonId: input.actorPersonId,
    createdAt: now,
  };
  store.addUpdate({
    id: exception.id,
    careRecipientId: input.careRecipientId,
    toPersonId: "care-circle",
    summary: encode(exception),
    status: "ready",
    safetyClass: "low",
    source: {
      id: `src-rex-${exception.id}`,
      kind: "system_derived",
      label: "Recurrence exception",
      actorPersonId: input.actorPersonId,
      actorName: input.actorDisplayName,
      recordedAt: now,
      whyVisible: "Series exception recorded without rewriting history",
    },
  });

  // this_occurrence reschedule creates a one-off appointment
  if (input.kind === "reschedule" && input.newStartsAt) {
    upsertScheduleItem(store, {
      careRecipientId: input.careRecipientId,
      actorPrincipalId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      title: `${series.title} (exception)`,
      startsAt: input.newStartsAt,
      startsAtLabel: input.newStartsAt,
      location: series.location,
      scheduleState: "confirmed",
      recurrenceRule: undefined,
    });
  }
  if (input.kind === "cancel" && input.scope === "entire_series") {
    store.upsertAppointment({
      ...series,
      status: "cancelled",
      scheduleState: "cancelled",
    });
  }

  const preview = [
    `Series: ${series.title}`,
    `Exception: ${input.kind} (${input.scope})`,
    `Occurrence: ${input.occurrenceStartsAt}`,
    input.newStartsAt ? `New time: ${input.newStartsAt}` : null,
    "Past completed events unchanged. History retained.",
  ]
    .filter(Boolean)
    .join(" · ");

  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "RECURRENCE_EXCEPTION_APPLIED",
    careRecipientId: input.careRecipientId,
    details: {
      exceptionId: exception.id,
      seriesId: series.id,
      kind: input.kind,
      scope: input.scope,
    },
  });
  return { ok: true, exception, preview };
}

/** Expand simple weekly/daily rule for next N occurrences (bounded, honest). */
export function expandRecurrenceOccurrences(
  startsAt: string,
  recurrenceRule: string | undefined,
  count = 8,
): string[] {
  if (!recurrenceRule) return [startsAt];
  const base = Date.parse(startsAt);
  if (Number.isNaN(base)) return [startsAt];
  const rule = recurrenceRule.toUpperCase();
  let stepMs = 7 * 24 * 60 * 60 * 1000;
  if (rule.includes("DAILY") || rule.includes("FREQ=DAILY")) {
    stepMs = 24 * 60 * 60 * 1000;
  } else if (rule.includes("WEEKLY") || rule.includes("FREQ=WEEKLY")) {
    stepMs = 7 * 24 * 60 * 60 * 1000;
  } else if (rule.includes("MONTHLY") || rule.includes("FREQ=MONTHLY")) {
    stepMs = 30 * 24 * 60 * 60 * 1000;
  }
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(new Date(base + i * stepMs).toISOString());
  }
  return out;
}
