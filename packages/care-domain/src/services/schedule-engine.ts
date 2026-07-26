/**
 * Internal scheduling engine — appointments, reschedule, coverage, ICS.
 * External calendar OAuth remains optional and is never faked.
 */

import type { CareStore } from "../store/memory-store.js";
import type {
  Appointment,
  EpistemicStatus,
  ScheduleLifecycleState,
  SourceRef,
} from "../types.js";
import { evaluateAccess } from "./access.js";
import { recalculateAppointmentReminders } from "./reminders.js";
import { createNotificationIfNew } from "./notifications.js";
import { ingestCareEvent } from "./care-event-etl.js";

const LEGACY_STATUS: Record<
  ScheduleLifecycleState,
  Appointment["status"]
> = {
  proposed: "scheduled",
  requested: "scheduled",
  tentative: "scheduled",
  confirmed: "scheduled",
  cancelled: "cancelled",
  rescheduled: "moved",
  completed: "completed",
  missed: "cancelled",
};

export type UpsertScheduleInput = {
  careRecipientId: string;
  actorPrincipalId: string;
  actorDisplayName: string;
  title: string;
  startsAt: string;
  endsAt?: string;
  startsAtLabel?: string;
  location?: string;
  scheduleState?: ScheduleLifecycleState;
  timezone?: string;
  assigneePersonId?: string;
  coveragePersonId?: string;
  recurrenceRule?: string;
  appointmentId?: string;
};

export type ScheduleResult =
  | { ok: true; appointment: Appointment }
  | { ok: false; code: string; message: string };

export function upsertScheduleItem(
  store: CareStore,
  input: UpsertScheduleInput,
): ScheduleResult {
  const access = evaluateAccess(
    store,
    input.actorPrincipalId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const state = input.scheduleState ?? "confirmed";
  const now = new Date().toISOString();
  const source: SourceRef = {
    id: store.newId("src"),
    kind: "caregiver_text",
    label: "Internal schedule",
    actorName: input.actorDisplayName,
    actorPersonId: input.actorPrincipalId,
    recordedAt: now,
    whyVisible: "Authorized schedule entry",
  };

  const existing = input.appointmentId
    ? store.getAppointments(input.careRecipientId).find((a) => a.id === input.appointmentId)
    : undefined;

  const appointment: Appointment = {
    id: existing?.id ?? store.newId("apt"),
    careRecipientId: input.careRecipientId,
    title: input.title,
    startsAt: input.startsAt,
    startsAtLabel: input.startsAtLabel,
    endsAt: input.endsAt,
    location: input.location,
    status: LEGACY_STATUS[state],
    scheduleState: state,
    epistemicStatus: "CONFIRMED" as EpistemicStatus,
    source,
    previousStartsAtLabel: existing?.startsAtLabel ?? existing?.startsAt,
    changeSource: existing ? "reschedule" : "create",
    rescheduledFromId: existing && state === "rescheduled" ? existing.id : undefined,
    timezone: input.timezone ?? "America/Los_Angeles",
    assigneePersonId: input.assigneePersonId,
    coveragePersonId: input.coveragePersonId,
    recurrenceRule: input.recurrenceRule,
  };

  store.upsertAppointment(appointment);

  recalculateAppointmentReminders(store, {
    careRecipientId: input.careRecipientId,
    appointment,
    timezone: appointment.timezone,
    principalIds: [
      input.actorPrincipalId,
      ...(input.assigneePersonId ? [input.assigneePersonId] : []),
      ...(input.coveragePersonId ? [input.coveragePersonId] : []),
    ],
  });

  ingestCareEvent(store, {
    careRecipientId: input.careRecipientId,
    actorPrincipalId: input.actorPrincipalId,
    actorDisplayName: input.actorDisplayName,
    sourceKind: "manual_appointment",
    type: existing ? "schedule_change" : "appointment_change",
    title: appointment.title,
    statement: existing
      ? `Rescheduled: ${appointment.title} → ${appointment.startsAtLabel ?? appointment.startsAt}`
      : `Scheduled: ${appointment.title} at ${appointment.startsAtLabel ?? appointment.startsAt}`,
    eventAt: appointment.startsAt,
    scheduleState: state,
    truthState: "confirmed",
    confidenceLabel: "confirmed",
    structured: {
      appointmentId: appointment.id,
      location: appointment.location,
      startsAtLabel: appointment.startsAtLabel,
    },
    silent: false,
  });

  // Notify coverage / assignee
  for (const pid of [input.assigneePersonId, input.coveragePersonId]) {
    if (!pid || pid === input.actorPrincipalId) continue;
    createNotificationIfNew(store, {
      principalId: pid,
      careRecipientId: input.careRecipientId,
      type: "APPOINTMENT_UPCOMING",
      priority: "attention",
      title: appointment.title,
      body: `Scheduled ${appointment.startsAtLabel ?? appointment.startsAt}`,
      sourceType: "appointment",
      sourceId: appointment.id,
      actorPersonId: input.actorPrincipalId,
      actorDisplayName: input.actorDisplayName,
      actionType: "open_schedule",
      actionTarget: appointment.id,
      dedupeKey: `apt:${appointment.id}:${pid}:${appointment.startsAt}`,
    });
  }

  store.writeAudit({
    at: now,
    actorPersonId: input.actorPrincipalId,
    action: existing ? "SCHEDULE_RESCHEDULED" : "SCHEDULE_CREATED",
    careRecipientId: input.careRecipientId,
    details: {
      appointmentId: appointment.id,
      scheduleState: state,
      startsAt: appointment.startsAt,
    },
  });

  return { ok: true, appointment };
}

export function transitionSchedule(
  store: CareStore,
  input: {
    careRecipientId: string;
    appointmentId: string;
    actorPrincipalId: string;
    actorDisplayName: string;
    scheduleState: ScheduleLifecycleState;
    newStartsAt?: string;
    newStartsAtLabel?: string;
  },
): ScheduleResult {
  const apt = store
    .getAppointments(input.careRecipientId)
    .find((a) => a.id === input.appointmentId);
  if (!apt) {
    return { ok: false, code: "NOT_FOUND", message: "Appointment not found" };
  }
  return upsertScheduleItem(store, {
    careRecipientId: input.careRecipientId,
    actorPrincipalId: input.actorPrincipalId,
    actorDisplayName: input.actorDisplayName,
    title: apt.title,
    startsAt: input.newStartsAt ?? apt.startsAt,
    endsAt: apt.endsAt,
    startsAtLabel: input.newStartsAtLabel ?? apt.startsAtLabel,
    location: apt.location,
    scheduleState: input.scheduleState,
    timezone: apt.timezone,
    assigneePersonId: apt.assigneePersonId,
    coveragePersonId: apt.coveragePersonId,
    recurrenceRule: apt.recurrenceRule,
    appointmentId: apt.id,
  });
}

/** RFC5545-ish .ics for internal schedule (no external provider required). */
export function buildIcsCalendar(
  store: CareStore,
  careRecipientId: string,
  opts?: { productName?: string },
): string {
  const product = opts?.productName ?? "Caretaker Relay";
  const recipient = store.getRecipient(careRecipientId);
  const apts = store
    .getAppointments(careRecipientId)
    .filter((a) => a.status !== "cancelled");

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//NIOV Labs//${product}//EN`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcs(recipient?.displayName ?? "Care schedule")}`,
  ];

  for (const a of apts) {
    const start = toIcsUtc(a.startsAt);
    const end = toIcsUtc(
      a.endsAt ?? new Date(Date.parse(a.startsAt) + 60 * 60 * 1000).toISOString(),
    );
    if (!start) continue;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${a.id}@caretaker-relay`,
      `DTSTAMP:${toIcsUtc(new Date().toISOString())}`,
      `DTSTART:${start}`,
      `DTEND:${end ?? start}`,
      `SUMMARY:${escapeIcs(a.title)}`,
      a.location ? `LOCATION:${escapeIcs(a.location)}` : "",
      `DESCRIPTION:${escapeIcs(
        `Status: ${a.scheduleState ?? a.status}. Internal Caretaker Relay schedule.`,
      )}`,
      `STATUS:${a.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.filter(Boolean).join("\r\n") + "\r\n";
}

function toIcsUtc(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    "T" +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) +
    "Z"
  );
}

function escapeIcs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function readEnv(key: string): string {
  try {
    const g = globalThis as unknown as {
      process?: { env?: Record<string, string | undefined> };
    };
    return g.process?.env?.[key] ?? "";
  } catch {
    return "";
  }
}

/** Optional Google Calendar OAuth — never fake when unconfigured. */
export function calendarOAuthStatus(): {
  provider: "google" | "none";
  configured: boolean;
  mode: "live" | "unavailable";
  message: string;
} {
  const clientId = readEnv("GOOGLE_CALENDAR_CLIENT_ID");
  const clientSecret = readEnv("GOOGLE_CALENDAR_CLIENT_SECRET");
  if (clientId && clientSecret) {
    return {
      provider: "google",
      configured: true,
      mode: "live",
      message: "Google Calendar OAuth credentials present. Connect from account settings.",
    };
  }
  return {
    provider: "none",
    configured: false,
    mode: "unavailable",
    message:
      "External calendar OAuth is not configured. Use internal schedule and .ics export.",
  };
}
