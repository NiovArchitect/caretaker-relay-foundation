/**
 * Semantic Today projection — operational eligibility, not recency alone.
 *
 * Today answers: what this caregiver needs to understand or do for this
 * recipient today and immediately. History, audit, and delivery rows belong
 * elsewhere (History / Notifications / Relay server retrieval).
 *
 * Does not rebuild PRN charting; callers still attach PRN projections.
 */

import type {
  Appointment,
  CareEvent,
  CareTask,
  Observation,
} from "../types.js";

export type TodayFamily =
  | "URGENT_SAFETY"
  | "MEDICATION_DUE"
  | "TOP_CARE_WORK"
  | "TODAY_APPOINTMENT"
  | "SHIFT_CONTINUITY"
  | "CORRECTED_TRUTH"
  | "HIGH_VALUE_OBSERVATION"
  | "EXCLUDED";

export type TodayEligibility = {
  include: boolean;
  family: TodayFamily;
  reason: string;
  rank: number; // lower = higher priority
};

const PROBE_RE =
  /\b(JL-SMOKE|JL_|TORTURE|__CR_E2E|e2e-?harness|load.?test|synthetic.?marker|smoke_harness|automated_test_probe|performance_probe|AZms)\b/i;

const TERMINAL_TASK = /^(done|completed|cancelled|canceled)$/i;

function dayBounds(nowMs: number, tz = "UTC"): { start: number; end: number } {
  // Lab-safe calendar day in UTC when tz unknown; production may pass local.
  void tz;
  const d = new Date(nowMs);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

function blobOf(...parts: Array<string | undefined | null>): string {
  return parts.filter(Boolean).join(" ");
}

export function isProbeText(text: string): boolean {
  return PROBE_RE.test(text);
}

export function evaluateTaskEligibility(
  t: CareTask,
  nowMs: number,
): TodayEligibility {
  const st = String(t.status ?? "pending");
  if (TERMINAL_TASK.test(st)) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "terminal work",
      rank: 999,
    };
  }
  const blob = blobOf(t.title, t.id);
  if (isProbeText(blob)) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "test/probe residue",
      rank: 999,
    };
  }
  const due = t.dueAt ? Date.parse(t.dueAt) : NaN;
  const overdue = !Number.isNaN(due) && due < nowMs;
  const high = t.safetyClass === "high";
  if (high || overdue) {
    return {
      include: true,
      family: high ? "URGENT_SAFETY" : "TOP_CARE_WORK",
      reason: high ? "high-safety open work" : "overdue open work",
      rank: high ? 1 : 3,
    };
  }
  return {
    include: true,
    family: "TOP_CARE_WORK",
    reason: "open non-terminal work",
    rank: 5,
  };
}

export function evaluateAppointmentEligibility(
  a: Appointment,
  nowMs: number,
): TodayEligibility {
  const blob = blobOf(a.title, a.location, a.id);
  if (isProbeText(blob)) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "test/probe residue",
      rank: 999,
    };
  }
  const status = String(a.status ?? "scheduled").toLowerCase();
  const schedule = String(a.scheduleState ?? "").toLowerCase();
  if (
    status === "cancelled" ||
    status === "completed" ||
    schedule === "cancelled" ||
    schedule === "completed" ||
    schedule === "missed"
  ) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "terminal or cancelled appointment",
      rank: 999,
    };
  }
  // Superseded lineage: moved away and replaced
  if (status === "moved" && schedule === "rescheduled") {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "superseded appointment version",
      rank: 999,
    };
  }
  const starts = Date.parse(a.startsAt);
  if (Number.isNaN(starts)) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "invalid start time",
      rank: 999,
    };
  }
  const { start: dayStart, end: dayEnd } = dayBounds(nowMs);
  const inToday = starts >= dayStart && starts < dayEnd;
  const upcoming36h = starts >= nowMs - 60 * 60 * 1000 && starts < nowMs + 36 * 60 * 60 * 1000;
  // Past appointments more than 1h ago (unless still "scheduled" today morning) drop
  if (starts < nowMs - 2 * 60 * 60 * 1000 && !inToday) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "past appointment",
      rank: 999,
    };
  }
  if (!inToday && !upcoming36h) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "outside today/near window",
      rank: 999,
    };
  }
  return {
    include: true,
    family: "TODAY_APPOINTMENT",
    reason: inToday ? "starts today" : "upcoming near window",
    rank: 4,
  };
}

export function evaluateEventEligibility(
  e: CareEvent,
  nowMs: number,
): TodayEligibility {
  const blob = blobOf(e.title, e.statement, e.notes, e.type, e.id);
  if (isProbeText(blob)) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "test/probe residue",
      rank: 999,
    };
  }
  if (e.supersededById || e.truthState === "superseded" || e.truthState === "cancelled") {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "superseded or cancelled truth",
      rank: 999,
    };
  }
  // Delivery / audit-ish types out of primary Today
  if (
    e.type === "reminder" ||
    e.type === "access_change" ||
    e.type === "consent_change"
  ) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "audit/delivery event",
      rank: 999,
    };
  }

  const when = Date.parse(e.eventAt || e.occurredAt);
  const { start: dayStart, end: dayEnd } = dayBounds(nowMs);
  const inToday = !Number.isNaN(when) && when >= dayStart && when < dayEnd;

  if (e.type === "correction" || e.truthState === "corrected") {
    return {
      include: true,
      family: "CORRECTED_TRUTH",
      reason: "corrected current truth",
      rank: 2,
    };
  }

  if (e.type === "incident" || e.safetyClass === "high") {
    return {
      include: true,
      family: "URGENT_SAFETY",
      reason: "urgent safety-class event",
      rank: 1,
    };
  }

  if (e.type === "handoff" && inToday) {
    return {
      include: true,
      family: "SHIFT_CONTINUITY",
      reason: "today handoff continuity",
      rank: 6,
    };
  }

  if (
    (e.type === "medication_administration" || e.type === "schedule_change") &&
    inToday
  ) {
    return {
      include: true,
      family: "MEDICATION_DUE",
      reason: "today medication/schedule fact",
      rank: 4,
    };
  }

  if (e.type === "observation" && inToday) {
    return {
      include: true,
      family: "HIGH_VALUE_OBSERVATION",
      reason: "today observation",
      rank: 7,
    };
  }

  // Older completed-looking history stays out
  if (!Number.isNaN(when) && when < dayStart) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "history-only past event",
      rank: 999,
    };
  }

  if (inToday) {
    return {
      include: true,
      family: "SHIFT_CONTINUITY",
      reason: "today non-terminal care fact",
      rank: 8,
    };
  }

  return {
    include: false,
    family: "EXCLUDED",
    reason: "not operationally eligible for Today",
    rank: 999,
  };
}

export function evaluateObservationEligibility(
  o: Observation,
  nowMs: number,
): TodayEligibility {
  const blob = blobOf(o.summary, o.id, ...(o.tags ?? []));
  if (isProbeText(blob)) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "test/probe residue",
      rank: 999,
    };
  }
  const when = Date.parse(o.observedAt);
  const { start: dayStart, end: dayEnd } = dayBounds(nowMs);
  const inToday = !Number.isNaN(when) && when >= dayStart && when < dayEnd;
  if (!inToday) {
    return {
      include: false,
      family: "EXCLUDED",
      reason: "observation not from today",
      rank: 999,
    };
  }
  // Prefer observations that change care
  const highValue =
    /pain|fall|refus|dizzy|fever|rash|breath|seizure|bleed|confusion|mobility|sleep|appetite|mood/i.test(
      blob,
    );
  return {
    include: true,
    family: "HIGH_VALUE_OBSERVATION",
    reason: highValue ? "today high-value observation" : "today observation",
    rank: highValue ? 5 : 9,
  };
}

export type SemanticTodaySlices = {
  events: CareEvent[];
  tasks: CareTask[];
  appointments: Appointment[];
  observations: Observation[];
  open_safety_reviews: unknown[];
  meta: {
    selection: "semantic_eligibility_v1";
    primary_work_cap: number;
    event_cap: number;
    appointment_cap: number;
    observation_cap: number;
    safety_cap: number;
    excluded_counts: Record<string, number>;
  };
};

/**
 * Build semantic Today slices from current state collections.
 * Caps remain; ranking is eligibility-first, then time.
 */
export function buildSemanticTodaySlices(input: {
  events?: CareEvent[];
  tasks?: CareTask[];
  appointments?: Appointment[];
  observations?: Observation[];
  openSafetyReviews?: unknown[];
  nowMs?: number;
  primaryWorkCap?: number;
}): SemanticTodaySlices {
  const nowMs = input.nowMs ?? Date.now();
  const primaryWorkCap = input.primaryWorkCap ?? 3;
  const excluded_counts: Record<string, number> = {};

  const bump = (reason: string) => {
    excluded_counts[reason] = (excluded_counts[reason] || 0) + 1;
  };

  const eventsRanked = (input.events ?? [])
    .map((e) => ({ e, el: evaluateEventEligibility(e, nowMs) }))
    .filter((x) => {
      if (!x.el.include) {
        bump(x.el.reason);
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.el.rank !== b.el.rank) return a.el.rank - b.el.rank;
      const ta = Date.parse(a.e.eventAt || a.e.occurredAt) || 0;
      const tb = Date.parse(b.e.eventAt || b.e.occurredAt) || 0;
      return tb - ta;
    })
    .map((x) => x.e)
    .slice(0, 12);

  const tasksEligible = (input.tasks ?? [])
    .map((t) => ({ t, el: evaluateTaskEligibility(t, nowMs) }))
    .filter((x) => {
      if (!x.el.include) {
        bump(x.el.reason);
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.el.rank !== b.el.rank) return a.el.rank - b.el.rank;
      const da = a.t.dueAt ? Date.parse(a.t.dueAt) : Number.POSITIVE_INFINITY;
      const db = b.t.dueAt ? Date.parse(b.t.dueAt) : Number.POSITIVE_INFINITY;
      return da - db;
    });

  // Cap primary work to 3 unless high-safety overflow
  const primary: CareTask[] = [];
  const overflow: CareTask[] = [];
  for (const x of tasksEligible) {
    if (x.el.family === "URGENT_SAFETY") {
      primary.push(x.t);
      continue;
    }
    if (primary.filter((p) => p.safetyClass !== "high").length < primaryWorkCap) {
      primary.push(x.t);
    } else {
      overflow.push(x.t);
    }
  }
  // Keep emergency high-safety even past cap (already added); soft cap total 8
  const tasks = [...primary, ...overflow.filter((t) => t.safetyClass === "high")].slice(
    0,
    8,
  );
  for (const t of overflow) {
    if (!tasks.includes(t)) bump("work beyond primary cap");
  }

  // Appointments: active lineage only — dedupe by title+day preferring latest id
  const apptEligible = (input.appointments ?? [])
    .map((a) => ({ a, el: evaluateAppointmentEligibility(a, nowMs) }))
    .filter((x) => {
      if (!x.el.include) {
        bump(x.el.reason);
        return false;
      }
      return true;
    });
  const byKey = new Map<string, Appointment>();
  for (const { a } of apptEligible) {
    const day = a.startsAt.slice(0, 10);
    const key = `${(a.title || "").toLowerCase()}|${day}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, a);
      continue;
    }
    // Prefer non-moved, later startsAt
    if (prev.status === "moved" && a.status !== "moved") {
      byKey.set(key, a);
      bump("superseded appointment version");
      continue;
    }
    if (Date.parse(a.startsAt) >= Date.parse(prev.startsAt)) {
      byKey.set(key, a);
      bump("stale appointment version");
    }
  }
  const appointments = [...byKey.values()]
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, 12);

  const observations = (input.observations ?? [])
    .map((o) => ({ o, el: evaluateObservationEligibility(o, nowMs) }))
    .filter((x) => {
      if (!x.el.include) {
        bump(x.el.reason);
        return false;
      }
      return true;
    })
    .sort((a, b) => a.el.rank - b.el.rank)
    .map((x) => x.o)
    .slice(0, 8);

  const open_safety_reviews = (input.openSafetyReviews ?? []).slice(0, 8);

  return {
    events: eventsRanked,
    tasks,
    appointments,
    observations,
    open_safety_reviews,
    meta: {
      selection: "semantic_eligibility_v1",
      primary_work_cap: primaryWorkCap,
      event_cap: 12,
      appointment_cap: 12,
      observation_cap: 8,
      safety_cap: 8,
      excluded_counts,
    },
  };
}
