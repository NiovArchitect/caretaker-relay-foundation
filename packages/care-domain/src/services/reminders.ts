/**
 * Care reminders — durable CARE_REM_V1 rows with supersession on source change.
 *
 * Behavioral contract (mechanism-agnostic):
 * - Appointment reschedule supersedes old reminder + leave-by, creates new ones.
 * - Medication administration confirmation resolves due/verification reminders.
 * - Corrected schedules recalculate future reminders.
 * - Timezone stored on each reminder for household display consistency.
 */

import type { CareStore } from "../store/memory-store.js";
import type { Appointment, CareUpdate, SourceRef } from "../types.js";
import {
  createNotificationIfNew,
  markResolved,
  listNotificationsForPrincipal,
} from "./notifications.js";

export const REM_PREFIX = "CARE_REM_V1:";

export type ReminderType =
  | "APPOINTMENT_UPCOMING"
  | "LEAVE_SOON"
  | "MEDICATION_UPCOMING"
  | "MEDICATION_DUE"
  | "MEDICATION_VERIFICATION";

export type ReminderStatus =
  | "scheduled"
  | "due"
  | "superseded"
  | "resolved"
  | "cancelled";

export type CareReminder = {
  id: string;
  careRecipientId: string;
  /** Who should see it; null = care-team ambient (rendered per principal scope). */
  principalId?: string | null;
  sourceType: "appointment" | "medication_schedule" | "medication_admin";
  sourceId: string;
  sourceVersion: string;
  type: ReminderType;
  title: string;
  body: string;
  scheduledAt: string;
  windowStart?: string;
  windowEnd?: string;
  timezone: string;
  status: ReminderStatus;
  createdAt: string;
  supersededAt?: string | null;
  resolvedAt?: string | null;
  dedupeKey: string;
  metadata?: Record<string, unknown>;
};

function src(actorId: string, actorName: string): SourceRef {
  return {
    id: `src-rem-${Date.now().toString(36)}`,
    kind: "system_derived",
    label: "Care reminder",
    actorPersonId: actorId,
    actorName,
    recordedAt: new Date().toISOString(),
    whyVisible: "Derived from current care schedule",
  };
}

export function encodeReminder(r: CareReminder): CareUpdate {
  return {
    id: r.id,
    careRecipientId: r.careRecipientId,
    toPersonId: r.principalId ?? "system",
    summary: REM_PREFIX + JSON.stringify(r),
    status: r.status === "scheduled" || r.status === "due" ? "ready" : "ready",
    safetyClass: r.type === "MEDICATION_DUE" ? "moderate" : "low",
    source: src("system", "System"),
  };
}

export function decodeReminder(u: CareUpdate): CareReminder | null {
  if (!u.summary.startsWith(REM_PREFIX)) return null;
  try {
    return JSON.parse(u.summary.slice(REM_PREFIX.length)) as CareReminder;
  } catch {
    return null;
  }
}

export function listReminders(
  store: CareStore,
  careRecipientId: string,
  opts?: { includeTerminal?: boolean },
): CareReminder[] {
  const byId = new Map<string, CareReminder>();
  for (const u of store.getUpdates(careRecipientId)) {
    const r = decodeReminder(u);
    if (!r) continue;
    const prev = byId.get(r.id);
    if (!prev || (r.supersededAt ?? r.resolvedAt ?? r.createdAt) >= (prev.supersededAt ?? prev.resolvedAt ?? prev.createdAt)) {
      byId.set(r.id, r);
    }
  }
  let rows = [...byId.values()];
  if (!opts?.includeTerminal) {
    rows = rows.filter(
      (r) => r.status === "scheduled" || r.status === "due",
    );
  }
  return rows.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

function saveReminder(store: CareStore, r: CareReminder): CareReminder {
  store.addUpdate(encodeReminder(r));
  return r;
}

/** Supersede all active reminders for a source id. */
export function supersedeRemindersForSource(
  store: CareStore,
  careRecipientId: string,
  sourceId: string,
  reason: string,
): number {
  const now = new Date().toISOString();
  let n = 0;
  for (const r of listReminders(store, careRecipientId, {
    includeTerminal: true,
  })) {
    if (r.sourceId !== sourceId) continue;
    if (r.status === "superseded" || r.status === "cancelled" || r.status === "resolved")
      continue;
    saveReminder(store, {
      ...r,
      status: "superseded",
      supersededAt: now,
      metadata: { ...r.metadata, supersedeReason: reason },
    });
    n++;
  }
  return n;
}

function parseStartsAt(apt: Appointment): Date | null {
  const raw = apt.startsAt;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function iso(d: Date): string {
  return d.toISOString();
}

/**
 * Recalculate appointment reminders from current appointment truth.
 * Leaves travel buffer minutes configurable (default 45 for leave-by before start).
 */
export function recalculateAppointmentReminders(
  store: CareStore,
  input: {
    careRecipientId: string;
    appointment: Appointment;
    timezone?: string;
    leaveByMinutesBefore?: number;
    reminderMinutesBefore?: number;
    principalIds?: string[];
  },
): CareReminder[] {
  const tz = input.timezone ?? "America/Los_Angeles";
  const leaveMin = input.leaveByMinutesBefore ?? 45;
  const remMin = input.reminderMinutesBefore ?? 120;
  const start = parseStartsAt(input.appointment);
  if (!start) return [];

  const version =
    input.appointment.previousStartsAtLabel ||
    input.appointment.startsAt ||
    input.appointment.id;
  const sourceVersion = `${input.appointment.id}:${version}:${input.appointment.startsAt}`;

  supersedeRemindersForSource(
    store,
    input.careRecipientId,
    input.appointment.id,
    "Appointment time changed or recalculated",
  );

  const created: CareReminder[] = [];
  const now = new Date().toISOString();
  const remAt = new Date(start.getTime() - remMin * 60_000);
  const leaveAt = new Date(start.getTime() - leaveMin * 60_000);
  const whenLabel =
    input.appointment.startsAtLabel ?? input.appointment.startsAt;

  const base = {
    careRecipientId: input.careRecipientId,
    sourceType: "appointment" as const,
    sourceId: input.appointment.id,
    sourceVersion,
    timezone: tz,
    status: "scheduled" as const,
    createdAt: now,
    supersededAt: null,
    resolvedAt: null,
  };

  // Unique ids even when Date.now() is identical across consecutive creates
  // (suite flakes collapsed upcoming+leave onto one row and lost supersede count).
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const upcoming: CareReminder = {
    ...base,
    id: `rem-apt-up-${input.appointment.id}-${stamp}-u`,
    type: "APPOINTMENT_UPCOMING",
    title: `Upcoming: ${input.appointment.title}`,
    body: `Scheduled for ${whenLabel}. Location: ${input.appointment.location ?? "see care plan"}.`,
    scheduledAt: iso(remAt),
    windowStart: iso(remAt),
    windowEnd: iso(start),
    dedupeKey: `apt-upcoming:${input.appointment.id}:${sourceVersion}`,
    metadata: { startsAt: input.appointment.startsAt, whenLabel },
  };
  const leave: CareReminder = {
    ...base,
    id: `rem-apt-leave-${input.appointment.id}-${stamp}-l`,
    type: "LEAVE_SOON",
    title: `Leave soon for ${input.appointment.title}`,
    body: `Leave by about ${leaveAt.toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
    })} for a ${whenLabel} appointment (travel buffer ~${leaveMin} min).`,
    scheduledAt: iso(leaveAt),
    windowStart: iso(leaveAt),
    windowEnd: iso(start),
    dedupeKey: `apt-leave:${input.appointment.id}:${sourceVersion}`,
    metadata: {
      startsAt: input.appointment.startsAt,
      leaveByMinutesBefore: leaveMin,
      whenLabel,
    },
  };

  saveReminder(store, upcoming);
  saveReminder(store, leave);
  created.push(upcoming, leave);

  // Notify primary principals about schedule change (not spam — one attention notif)
  for (const pid of input.principalIds ?? ["p-sadeil", "p-walter"]) {
    createNotificationIfNew(store, {
      principalId: pid,
      careRecipientId: input.careRecipientId,
      type: "APPOINTMENT_UPCOMING",
      priority: "attention",
      title: `Appointment updated: ${input.appointment.title}`,
      body: `Now scheduled for ${whenLabel}. Old reminders were superseded.`,
      sourceType: "appointment",
      sourceId: input.appointment.id,
      actionType: "open_appointment",
      actionTarget: `appointment:${input.appointment.id}`,
      // Stable active key (no sourceVersion) so edits do not flood unread inbox
      dedupeKey: `apt-change-notif:${input.appointment.id}:${pid}`,
    });
  }

  return created;
}

/** Create medication due/upcoming reminders from schedule. */
export function recalculateMedicationReminders(
  store: CareStore,
  input: {
    careRecipientId: string;
    scheduleId: string;
    name: string;
    dose: string;
    /** ISO for next due */
    nextDueAt: string;
    windowStart?: string;
    windowEnd?: string;
    timezone?: string;
  },
): CareReminder[] {
  const tz = input.timezone ?? "America/Los_Angeles";
  const sourceVersion = `${input.scheduleId}:${input.nextDueAt}`;
  supersedeRemindersForSource(
    store,
    input.careRecipientId,
    input.scheduleId,
    "Medication schedule or due time recalculated",
  );
  const now = new Date().toISOString();
  const due: CareReminder = {
    id: `rem-med-due-${input.scheduleId}-${Date.now().toString(36)}`,
    careRecipientId: input.careRecipientId,
    sourceType: "medication_schedule",
    sourceId: input.scheduleId,
    sourceVersion,
    type: "MEDICATION_DUE",
    title: `${input.name} ${input.dose} due`.trim(),
    body: `Due at ${input.nextDueAt}${
      input.windowStart && input.windowEnd
        ? ` (window ${input.windowStart}–${input.windowEnd})`
        : ""
    }.`,
    scheduledAt: input.nextDueAt,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    timezone: tz,
    status: "scheduled",
    createdAt: now,
    dedupeKey: `med-due:${input.scheduleId}:${sourceVersion}`,
  };
  saveReminder(store, due);
  return [due];
}

/**
 * After medication administration confirmed, resolve due/verification reminders
 * for that schedule and stop further due pings for this administration window.
 */
export function resolveMedicationRemindersAfterAdmin(
  store: CareStore,
  input: {
    careRecipientId: string;
    scheduleId?: string;
    principalId?: string;
  },
): number {
  const now = new Date().toISOString();
  let n = 0;
  for (const r of listReminders(store, input.careRecipientId, {
    includeTerminal: true,
  })) {
    if (r.status !== "scheduled" && r.status !== "due") continue;
    if (
      r.type !== "MEDICATION_DUE" &&
      r.type !== "MEDICATION_UPCOMING" &&
      r.type !== "MEDICATION_VERIFICATION"
    )
      continue;
    if (input.scheduleId && r.sourceId !== input.scheduleId) continue;
    saveReminder(store, {
      ...r,
      status: "resolved",
      resolvedAt: now,
      metadata: { ...r.metadata, resolvedBy: "medication_admin_confirmed" },
    });
    n++;
  }
  if (input.principalId) {
    for (const notif of listNotificationsForPrincipal(
      store,
      input.principalId,
      input.careRecipientId,
    )) {
      if (
        notif.type === "MEDICATION_DUE" ||
        notif.type === "MEDICATION_VERIFICATION" ||
        notif.type === "MEDICATION_UPCOMING"
      ) {
        if (!notif.resolvedAt) {
          markResolved(store, input.principalId, notif.id);
          n++;
        }
      }
    }
  }
  return n;
}

/** Active reminders for answer engine / Today projection. */
export function activeReminderLabels(
  store: CareStore,
  careRecipientId: string,
): string[] {
  return listReminders(store, careRecipientId).map(
    (r) => `${r.title} · ${r.scheduledAt} (${r.type}, ${r.timezone})`,
  );
}

/**
 * Reschedule appointment helper: update appointment + recalculate reminders.
 */
export function rescheduleAppointment(
  store: CareStore,
  input: {
    careRecipientId: string;
    appointmentId: string;
    newStartsAt: string;
    newStartsAtLabel: string;
    previousStartsAtLabel?: string;
    principalIds?: string[];
    timezone?: string;
  },
): { appointment: Appointment; reminders: CareReminder[] } | null {
  const apts = store.getAppointments(input.careRecipientId);
  const cur = apts.find((a) => a.id === input.appointmentId);
  if (!cur) return null;
  const next: Appointment = {
    ...cur,
    startsAt: input.newStartsAt,
    startsAtLabel: input.newStartsAtLabel,
    previousStartsAtLabel:
      input.previousStartsAtLabel ?? cur.startsAtLabel ?? cur.startsAt,
    changeSource: "care_correction",
  };
  store.upsertAppointment(next);
  const reminders = recalculateAppointmentReminders(store, {
    careRecipientId: input.careRecipientId,
    appointment: next,
    timezone: input.timezone,
    principalIds: input.principalIds,
  });
  return { appointment: next, reminders };
}
