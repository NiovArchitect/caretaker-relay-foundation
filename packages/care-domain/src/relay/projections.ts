/**
 * Decision-ready projections — server-owned.
 * Built from authorized CurrentCareState / snapshot bags.
 */

import {
  clusterObservations,
  plainDiscrepancyMessage,
  resolvePersonName,
  str,
} from "./util.js";

/**
 * Derive leave-by from this appointment's start time (not a hardcoded 3:00).
 * travelMinutes + bufferMinutes before start, labels in local wall-clock words when possible.
 */
function leaveByLabelForAppointment(
  a: Record<string, unknown>,
  bufferMinutes: number,
  travelMinutes: number,
): string {
  const label = str(a.startsAtLabel);
  // Prefer explicit time in label e.g. "3:00 PM" or "4:30 PM"
  const m = label.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  let sessionLabel = label || str(a.startsAt) || "the appointment";
  let leaveLabel = "Leave with extra travel time";
  if (m && m[1] && m[2] && m[3]) {
    let hour = Number(m[1]);
    const min = Number(m[2]);
    const mer = m[3].toUpperCase();
    if (mer === "PM" && hour < 12) hour += 12;
    if (mer === "AM" && hour === 12) hour = 0;
    const totalMin = hour * 60 + min - bufferMinutes - travelMinutes;
    const lh = Math.floor(((totalMin % (24 * 60)) + 24 * 60) % (24 * 60) / 60);
    const lm = ((totalMin % 60) + 60) % 60;
    const merOut = lh >= 12 ? "PM" : "AM";
    const h12 = lh % 12 === 0 ? 12 : lh % 12;
    leaveLabel = `Leave by about ${h12}:${String(lm).padStart(2, "0")} ${merOut}`;
    sessionLabel = `${Number(m[1])}:${m[2]} ${mer}`;
  } else if (a.startsAt) {
    const d = new Date(String(a.startsAt));
    if (!Number.isNaN(d.getTime())) {
      const leave = new Date(d.getTime() - (bufferMinutes + travelMinutes) * 60_000);
      leaveLabel = `Leave by about ${leave.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      })}`;
      sessionLabel = d.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      });
    }
  }
  return `${leaveLabel} for a ${sessionLabel} session (about ${travelMinutes} min travel + buffer)`;
}

export type CareStateBag = {
  careRecipientId?: string;
  medicationSchedules?: Array<Record<string, unknown>>;
  medicationRecords?: Array<Record<string, unknown>>;
  appointments?: Array<Record<string, unknown>>;
  observations?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  openSafetyReviews?: Array<Record<string, unknown>>;
  tasks?: Array<Record<string, unknown>>;
};

export type CareProjections = {
  recipientId: string;
  recipientName: string;
  CURRENT_MEDICATIONS: Array<Record<string, unknown>>;
  NEXT_24H_TASKS: string[];
  NEXT_APPOINTMENT: Record<string, unknown> | null;
  OPEN_UNCERTAINTIES: string[];
  LATEST_PROVIDER_INSTRUCTIONS: string[];
  RECENT_CHANGES: string[];
  CARE_TEAM_NOW: Array<{ name: string; role: string; phone?: string }>;
  LAST_MEDICATION_ADMINISTRATIONS: Array<Record<string, unknown>>;
  RECENT_OBSERVATION_CLUSTERS: Array<{
    theme: string;
    count: number;
    sources: string[];
    mostRecentLabel: string;
    mostRecentAt?: string;
  }>;
  ACTIVE_HANDOFF: {
    whatChanged: string[];
    stillNeedsAttention: string[];
    toName?: string;
  } | null;
  REMINDERS: Array<{
    id: string;
    kind: "medication" | "appointment";
    title: string;
    whenLabel: string;
    phase: "day_before" | "hours_before" | "due" | "overdue" | "upcoming";
    leaveByLabel?: string;
    location?: string;
    mapsUrl?: string;
  }>;
  FACILITY_CONTEXT: Array<{
    name: string;
    address: string;
    phone: string;
    mapsUrl: string;
    note: string;
  }>;
  DEMENTIA_WATCH: string[];
  DSP_SUPPORT_NOTES: string[];
};

export const SYNTHETIC_FACILITIES = {
  pt: {
    name: "North County Physical Therapy (synthetic evaluation location)",
    address: "1234 Coastal Care Way, Oceanside, CA 92054",
    phone: "+1-555-0140",
    mapsUrl: "https://maps.google.com/?q=Oceanside+CA+physical+therapy",
    note: "Public facility information used with a synthetic appointment for product evaluation. Not a real patient relationship.",
    travelMinutes: 18,
  },
  clinic: {
    name: "Coastal Family Medicine (synthetic evaluation location)",
    address: "880 Harbor Medical Blvd, Carlsbad, CA 92008",
    phone: "+1-555-0199",
    mapsUrl: "https://maps.google.com/?q=Carlsbad+CA+family+medicine",
    note: "Public facility information used with a synthetic care relationship for evaluation only.",
    travelMinutes: 22,
  },
} as const;

export function buildProjections(input: {
  state: CareStateBag;
  recipientName: string;
  recipientId: string;
  attentionLines?: string[];
  handoff?: {
    whatChanged: string[];
    stillNeedsAttention: string[];
    toPersonId?: string;
  } | null;
  /** Live care circle — never hard-code Evelyn/Marcus. */
  careTeam?: Array<{ name: string; role: string; phone?: string }>;
  personNameMap?: Record<string, string>;
}): CareProjections {
  const meds = input.state.medicationSchedules ?? [];
  const apts = input.state.appointments ?? [];
  const obs = input.state.observations ?? [];
  const reviews = input.state.openSafetyReviews ?? [];
  const events = input.state.events ?? [];
  const records = input.state.medicationRecords ?? [];

  const OPEN_UNCERTAINTIES = [
    ...reviews.map((r) =>
      plainDiscrepancyMessage(str(r.reason ?? r.message), input.recipientName),
    ),
    ...(input.attentionLines ?? []).map((l) =>
      plainDiscrepancyMessage(l, input.recipientName),
    ),
  ].filter(Boolean);

  const LATEST_PROVIDER_INSTRUCTIONS = meds.map((m) => {
    const name = str(m.name);
    const dose = str(m.dose);
    const when = str(m.scheduleTime ?? m.scheduleLabel);
    const by = str(m.authorizedBy);
    const meal = str(m.mealRelation);
    return [name, dose, when, meal, by ? `Authorized by ${by}` : ""]
      .filter(Boolean)
      .join(" · ");
  });

  const RECENT_CHANGES = events
    .slice()
    .reverse()
    .slice(0, 8)
    .map((e) => {
      const who =
        e.source && typeof e.source === "object"
          ? str((e.source as { actorName?: string }).actorName)
          : "";
      return `${str(e.statement ?? e.title)}${who ? ` (from ${who})` : ""}`;
    });

  const clusters = clusterObservations(obs as Array<Record<string, unknown>>);

  let NEXT_APPOINTMENT: Record<string, unknown> | null = null;
  if (apts.length) {
    const sorted = [...apts].sort((a, b) =>
      str(a.startsAt).localeCompare(str(b.startsAt)),
    );
    NEXT_APPOINTMENT = sorted[0] ?? null;
  }

  const REMINDERS: CareProjections["REMINDERS"] = [];
  for (const m of meds) {
    const name = str(m.name) || "Medication";
    const time = str(m.scheduleTime ?? "12:00 PM");
    const window = [str(m.windowStart), str(m.windowEnd)]
      .filter(Boolean)
      .join(" – ");
    REMINDERS.push({
      id: `rem-med-${str(m.id) || name}`,
      kind: "medication",
      title: `${name} ${str(m.dose)}`.trim(),
      whenLabel: window ? `${time} (window ${window})` : time,
      phase: "upcoming",
    });
  }
  for (const a of apts) {
    const title = str(a.title) || "Appointment";
    const when = str(a.startsAtLabel ?? a.startsAt);
    const isPt = /physical therapy|pt/i.test(title);
    const fac = isPt ? SYNTHETIC_FACILITIES.pt : SYNTHETIC_FACILITIES.clinic;
    // Leave-by must track THIS appointment's start — never a stale hardcoded time.
    const leaveByLabel = leaveByLabelForAppointment(a, isPt ? 30 : 45, 18);
    REMINDERS.push({
      id: `rem-apt-${str(a.id) || title}`,
      kind: "appointment",
      title,
      whenLabel: when,
      phase: "hours_before",
      leaveByLabel,
      location: str(a.location) || fac.address,
      mapsUrl: fac.mapsUrl,
    });
    // Single day-before reminder only (avoid duplicate appointment noise)
    REMINDERS.push({
      id: `rem-apt-day-${str(a.id) || title}`,
      kind: "appointment",
      title: `${title} — day-before`,
      whenLabel: `Day-before reminder for ${when}`,
      phase: "day_before",
      location: str(a.location) || fac.address,
    });
  }

  return {
    recipientId: input.recipientId,
    recipientName: input.recipientName,
    CURRENT_MEDICATIONS: meds,
    NEXT_24H_TASKS: [
      ...meds.map((m) => {
        const t = str(m.nextDueLabel ?? m.scheduleTime ?? m.scheduleLabel);
        return `${str(m.name)} ${str(m.dose)}${t ? ` · ${t}` : ""}`.trim();
      }),
      ...(NEXT_APPOINTMENT
        ? [
            `${str(NEXT_APPOINTMENT.title)} · ${str(NEXT_APPOINTMENT.startsAtLabel ?? NEXT_APPOINTMENT.startsAt)}`,
          ]
        : []),
    ],
    NEXT_APPOINTMENT,
    OPEN_UNCERTAINTIES: [...new Set(OPEN_UNCERTAINTIES)].slice(0, 6),
    LATEST_PROVIDER_INSTRUCTIONS,
    RECENT_CHANGES,
    CARE_TEAM_NOW: (input.careTeam ?? []).slice(0, 8),
    LAST_MEDICATION_ADMINISTRATIONS: records.slice(-5),
    RECENT_OBSERVATION_CLUSTERS: clusters,
    ACTIVE_HANDOFF: input.handoff
      ? {
          whatChanged: input.handoff.whatChanged,
          stillNeedsAttention: input.handoff.stillNeedsAttention,
          toName: resolvePersonName(
            input.handoff.toPersonId,
            undefined,
            input.personNameMap,
          ),
        }
      : null,
    REMINDERS,
    FACILITY_CONTEXT: [
      {
        name: SYNTHETIC_FACILITIES.pt.name,
        address: SYNTHETIC_FACILITIES.pt.address,
        phone: SYNTHETIC_FACILITIES.pt.phone,
        mapsUrl: SYNTHETIC_FACILITIES.pt.mapsUrl,
        note: SYNTHETIC_FACILITIES.pt.note,
      },
      {
        name: SYNTHETIC_FACILITIES.clinic.name,
        address: SYNTHETIC_FACILITIES.clinic.address,
        phone: SYNTHETIC_FACILITIES.clinic.phone,
        mapsUrl: SYNTHETIC_FACILITIES.clinic.mapsUrl,
        note: SYNTHETIC_FACILITIES.clinic.note,
      },
    ],
    // Watchlist only when observations/meds exist — not bound to a named fixture
    DEMENTIA_WATCH:
      clusters.length || meds.length
        ? [
            "Medication timing and with-food instructions when on plan",
            "Dizziness or balance changes after meals when reported",
            "Fatigue compared with recent baseline when reported",
            "Hydration and meal completion when tracked",
            "Mobility safety around transfers when notes exist",
          ]
        : [],
    DSP_SUPPORT_NOTES: [
      `Person-centered: respect ${input.recipientName}'s pace and preferences`,
      "Document observations before leaving; do not invent clinical conclusions",
      "Medication assist only per current authorized care plan",
      "Escalate unresolved medication mismatch to authorized family/clinic contacts",
      "Share only role-authorized information with the next caregiver",
    ],
  };
}

export function formatReminderDigest(p: CareProjections): string {
  if (!p.REMINDERS.length) return "No upcoming medication or appointment reminders.";
  return p.REMINDERS.slice(0, 6)
    .map((r) => {
      const bits = [
        r.kind === "medication" ? "Medication" : "Appointment",
        r.title,
        r.whenLabel,
        r.leaveByLabel,
        r.location,
      ].filter(Boolean);
      return `• ${bits.join(" · ")}`;
    })
    .join("\n");
}
