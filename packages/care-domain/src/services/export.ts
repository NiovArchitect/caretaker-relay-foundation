/**
 * Authorized data portability export.
 * Human-readable care record + structured (+ FHIR stubs where mapped).
 * Not EMR integration.
 *
 * Presentation rules:
 * - Never surface raw ISO "…Z" as the primary human timestamp.
 * - Preserve full ISO only in structured export metadata.
 * - Group / collapse exact duplicates without erasing audit truth.
 * - Separate action-needed from historical noise.
 */

import type { CareStore } from "../store/memory-store.js";
import { evaluateAccess } from "./access.js";
import {
  mapAppointment,
  mapCareRecipientToPatient,
  mapConsent,
  mapMedAdmin,
  mapMedRequest,
  mapObservation,
  mapProvenance,
  mapTask,
} from "../fhir/mapping.js";
import type { CareEvent, CurrentCareState, EpistemicStatus } from "../types.js";

export interface CareExportResult {
  ok: true;
  format: "json" | "markdown";
  careRecipientId: string;
  exportedAt: string;
  evidenceMode: "SYNTHETIC_FOUNDATION_BACKED";
  claim: "FHIR_MAPPED_NOT_EMR_INTEGRATED";
  humanReadable: string;
  structured: {
    careRecipient: unknown;
    state: CurrentCareState | undefined;
    fhir: unknown[];
  };
}

const DEFAULT_TZ = "America/Los_Angeles";

function formatHumanInstant(
  iso: string | null | undefined,
  variant: "full" | "standard" | "recent" = "standard",
  now = new Date(),
  timeZone = DEFAULT_TZ,
): string {
  if (!iso) return "Time not on file";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    if (variant === "full") {
      return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone,
        timeZoneName: "short",
      }).format(d);
    }
    const ymd = (dt: Date) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(dt);
    const time = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    }).format(d);
    const today = ymd(now);
    const target = ymd(d);
    if (variant === "recent" || variant === "standard") {
      if (target === today) {
        const std = new Intl.DateTimeFormat("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone,
          timeZoneName: "short",
        }).format(d);
        return `Today at ${time} (${std})`;
      }
      const yProbe = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      if (target === ymd(yProbe)) {
        return `Yesterday at ${time}`;
      }
    }
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
      timeZoneName: "short",
    }).format(d);
  } catch {
    return d.toLocaleString("en-US");
  }
}

function statusLabel(s: EpistemicStatus | string): string {
  switch (String(s).toUpperCase()) {
    case "CONFIRMED":
      return "Confirmed";
    case "REPORTED":
      return "Reported";
    case "UNCERTAIN":
      return "Uncertain";
    case "CONFLICTED":
      return "Needs checking";
    case "SUPERSEDED":
      return "Superseded";
    case "INFERRED":
      return "Inferred";
    default:
      return String(s || "Reported");
  }
}

function typeLabel(t: string): string {
  const s = t.toLowerCase();
  if (s.includes("med")) return "Medication";
  if (s.includes("meal")) return "Meal";
  if (s.includes("observ")) return "Observation";
  if (s.includes("appoint")) return "Appointment";
  if (s.includes("handoff")) return "Handoff";
  if (s.includes("correct")) return "Correction";
  if (s.includes("task")) return "Task";
  if (s.includes("note")) return "Note";
  if (s.includes("commun")) return "Communication";
  return t.replace(/_/g, " ");
}

function actorOf(e: CareEvent): string {
  return e.source?.actorName || e.source?.label || "Care team";
}

type EventGroup = {
  key: string;
  sample: CareEvent;
  count: number;
  firstAt: string;
  lastAt: string;
  actors: Set<string>;
};

function groupEvents(events: CareEvent[]): EventGroup[] {
  const sorted = [...events].sort((a, b) =>
    String(b.occurredAt).localeCompare(String(a.occurredAt)),
  );
  const map = new Map<string, EventGroup>();
  for (const e of sorted) {
    // Identity for collapse: type + status + normalized statement (not id)
    // Distinct occurredAt > 90s keeps separate true repeats as separate groups
    // when statements match but spaced in time → we still group exact same minute window
    const minute = String(e.occurredAt).slice(0, 16); // YYYY-MM-DDTHH:MM
    const key = `${e.type}|${e.epistemicStatus}|${e.statement.trim().toLowerCase()}|${minute}`;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      existing.actors.add(actorOf(e));
      if (e.occurredAt < existing.firstAt) existing.firstAt = e.occurredAt;
      if (e.occurredAt > existing.lastAt) existing.lastAt = e.occurredAt;
    } else {
      map.set(key, {
        key,
        sample: e,
        count: 1,
        firstAt: e.occurredAt,
        lastAt: e.occurredAt,
        actors: new Set([actorOf(e)]),
      });
    }
  }
  return [...map.values()].sort((a, b) =>
    b.lastAt.localeCompare(a.lastAt),
  );
}

function lineForGroup(g: EventGroup): string {
  const e = g.sample;
  const when = formatHumanInstant(g.lastAt, "standard");
  const who = [...g.actors].join(", ");
  const status = statusLabel(e.epistemicStatus);
  const kind = typeLabel(e.type);
  const mult =
    g.count > 1
      ? ` · ${g.count}× same-minute records (kept for audit; showing latest)`
      : "";
  const span =
    g.count > 1 && g.firstAt !== g.lastAt
      ? ` · first ${formatHumanInstant(g.firstAt, "standard")}`
      : "";
  return `- **${status}** · ${kind} · ${when}${mult}${span}\n  ${e.statement}\n  Source: ${who}${e.source?.label && e.source.label !== who ? ` (${e.source.label})` : ""}`;
}

function isActionNeeded(e: CareEvent): boolean {
  const s = String(e.epistemicStatus).toUpperCase();
  return s === "CONFLICTED" || s === "UNCERTAIN";
}

function isCurrentView(e: CareEvent): boolean {
  return !e.supersededById && String(e.epistemicStatus).toUpperCase() !== "SUPERSEDED";
}

function buildHumanReadable(
  recipientName: string,
  actorPersonId: string,
  accessReason: string,
  state: CurrentCareState | undefined,
  now: Date,
): string {
  const events = state?.events ?? [];
  const current = events.filter(isCurrentView);
  const superseded = events.filter((e) => !isCurrentView(e));
  const action = current.filter(isActionNeeded);
  const rest = current.filter((e) => !isActionNeeded(e));

  const todayYmd = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

  const todays = rest.filter((e) => {
    try {
      return (
        new Intl.DateTimeFormat("en-CA", {
          timeZone: DEFAULT_TZ,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(e.occurredAt)) === todayYmd
      );
    } catch {
      return false;
    }
  });

  const byType = (types: string[]) =>
    rest.filter((e) => types.some((t) => e.type === t || e.type.includes(t)));

  const meals = byType(["meal"]);
  const meds = byType(["medication_administration"]);
  const obs = byType(["observation"]);
  const other = rest.filter(
    (e) =>
      !["meal", "medication_administration", "observation"].includes(e.type),
  );

  const sections: string[] = [
    `# Care record — ${recipientName}`,
    "",
    `**Prepared:** ${formatHumanInstant(now.toISOString(), "full")}`,
    `**Prepared for export by:** care principal \`${actorPersonId}\``,
    `**Access basis:** ${accessReason}`,
    `**Claim:** FHIR-mapped structures included; **not** an EMR integration.`,
    `**Timezone for display:** Pacific Time (America/Los_Angeles). Stored times remain UTC in the system of record.`,
    "",
    "---",
    "",
    "## Action needed",
  ];

  if (action.length === 0) {
    sections.push("- Nothing is flagged as conflicted or uncertain right now.");
  } else {
    for (const g of groupEvents(action)) {
      sections.push(lineForGroup(g));
      sections.push(
        `  **Safe next steps:** verify the label / care plan, confirm with an authorized care-team member, record who confirmed and when. Do not invent a dose. Preserve the original report.`,
      );
    }
  }

  sections.push("", "## Today’s timeline");
  if (todays.length === 0) {
    sections.push("- No events dated today on file for this recipient.");
  } else {
    for (const g of groupEvents(todays)) sections.push(lineForGroup(g));
  }

  sections.push("", "## Meals and hydration");
  if (meals.length === 0) sections.push("- None listed in current events.");
  else for (const g of groupEvents(meals)) sections.push(lineForGroup(g));

  sections.push("", "## Medication administration and checks");
  if (meds.length === 0) sections.push("- None listed in current events.");
  else for (const g of groupEvents(meds)) sections.push(lineForGroup(g));

  if (state?.medicationSchedules?.length) {
    sections.push("", "### Authorized medication schedule (plan)");
    for (const m of state.medicationSchedules) {
      sections.push(
        `- ${m.name} ${m.dose ?? ""} — ${m.scheduleLabel ?? m.scheduleTime ?? "schedule on file"}${m.authorizedBy ? ` · authorized by ${m.authorizedBy}` : ""}`,
      );
    }
  }

  sections.push("", "## Symptoms and observations");
  if (obs.length === 0 && !(state?.observations?.length)) {
    sections.push("- None listed.");
  } else {
    for (const g of groupEvents(obs)) sections.push(lineForGroup(g));
    if (state?.observations?.length) {
      // Trend note without collapsing clinical identity
      const themes = new Map<string, number>();
      for (const o of state.observations) {
        const t = (o.summary || "").toLowerCase();
        const key = /tired|fatigue/.test(t)
          ? "fatigue / tiredness"
          : /dizz/.test(t)
            ? "dizziness"
            : o.summary.slice(0, 40);
        themes.set(key, (themes.get(key) ?? 0) + 1);
      }
      const multi = [...themes.entries()].filter(([, n]) => n >= 2);
      if (multi.length) {
        sections.push("", "### Observation pattern (counts, not a diagnosis)");
        for (const [theme, n] of multi) {
          sections.push(
            `- “${theme}” appears in ${n} observation record(s). Treat as repeated reporting, not automatic clinical trend.`,
          );
        }
      }
    }
  }

  sections.push("", "## Other care events");
  if (other.length === 0) sections.push("- None beyond the sections above.");
  else for (const g of groupEvents(other)) sections.push(lineForGroup(g));

  sections.push("", "## Appointments");
  if (!state?.appointments?.length) {
    sections.push("- None on file.");
  } else {
    for (const a of state.appointments) {
      const when =
        a.startsAtLabel ||
        formatHumanInstant(a.startsAt, "standard") ||
        "Time on file";
      sections.push(
        `- **${a.title}** · ${when} · ${a.status}${a.location ? ` · ${a.location}` : ""}`,
      );
    }
  }

  sections.push("", "## Handoffs");
  if (!state?.handoffs?.length) {
    sections.push("- No saved handoff yet.");
  } else {
    for (const h of state.handoffs) {
      sections.push(
        `- **${formatHumanInstant(h.createdAt, "standard")}**`,
        `  Changed: ${h.whatChanged.join("; ") || "—"}`,
        `  Still needs attention: ${h.stillNeedsAttention.join("; ") || "Nothing listed"}`,
        h.watch?.length ? `  Watch: ${h.watch.join("; ")}` : "",
      );
    }
  }

  if (superseded.length) {
    sections.push("", "## Corrections and superseded records");
    sections.push(
      "_Prior evidence is retained. These items are not current care truth._",
    );
    for (const g of groupEvents(superseded).slice(0, 20)) {
      sections.push(lineForGroup(g));
    }
  }

  sections.push(
    "",
    "## How to read this record",
    "- **Reported** means a caregiver shared it; it is not automatically confirmed care truth.",
    "- **Confirmed** means an authorized confirmation path accepted it.",
    "- **Needs checking** / **Uncertain** means do not close the item without verification.",
    "- Repeated lines with a count are same-minute duplicates collapsed for readability; the system of record still holds each event id.",
    "- Full machine timestamps remain available in the structured export / audit store.",
  );

  return sections.filter((l) => l !== undefined).join("\n");
}

export function exportCareData(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
  format: "json" | "markdown" = "json",
): CareExportResult | { ok: false; code: string; message: string } {
  const access = evaluateAccess(store, actorPersonId, careRecipientId, {
    requiredAction: "view_plan",
  });
  const soft = evaluateAccess(store, actorPersonId, careRecipientId);
  if (!soft.allowed) {
    return { ok: false, code: soft.code, message: soft.reason };
  }

  const recipient = store.getRecipient(careRecipientId);
  if (!recipient) {
    return {
      ok: false,
      code: "UNKNOWN_RECIPIENT",
      message: "Care recipient not found",
    };
  }

  const state = store.getCurrentState(careRecipientId);
  const fhir: unknown[] = [mapCareRecipientToPatient(recipient)];
  if (state) {
    for (const o of state.observations) fhir.push(mapObservation(o));
    for (const a of state.appointments) fhir.push(mapAppointment(a));
    for (const t of state.tasks) fhir.push(mapTask(t));
    for (const s of state.medicationSchedules) fhir.push(mapMedRequest(s));
    for (const m of state.medicationRecords) fhir.push(mapMedAdmin(m));
    for (const e of state.events.slice(0, 50)) {
      if (e.source) fhir.push(mapProvenance(e.source, `Observation/${e.id}`));
    }
  }
  for (const rel of store.getRelationships(careRecipientId)) {
    const consent = store.getConsent(careRecipientId, rel.personId);
    if (consent) fhir.push(mapConsent(consent));
  }

  const now = new Date();
  const exportedAt = now.toISOString();
  const human = buildHumanReadable(
    recipient.displayName,
    actorPersonId,
    soft.reason,
    state,
    now,
  );

  store.writeAudit({
    at: exportedAt,
    actorPersonId,
    action: "CARE_EXPORT",
    careRecipientId,
    householdId: recipient.householdId,
    details: {
      format,
      fhirResourceCount: fhir.length,
      access: access.allowed ? access.reason : soft.reason,
      humanTimestampPolicy: "display_local_pacific_store_utc",
    },
  });

  return {
    ok: true,
    format,
    careRecipientId,
    exportedAt,
    evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
    claim: "FHIR_MAPPED_NOT_EMR_INTEGRATED",
    humanReadable: human,
    structured: {
      careRecipient: recipient,
      state,
      fhir,
    },
  };
}
