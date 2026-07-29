/**
 * Appointment lineage: one active current appointment per semantic series;
 * past/cancelled/replaced/probe → history.
 */

import type { Appointment } from "../types.js";
import type { CareStore } from "../store/memory-store.js";
import { isSmokeResidueLine, sanitizeHumanCareCopy } from "../relay/util.js";
import { redactSystemIds } from "./identity-view.js";

export type AppointmentView = {
  id: string;
  title: string;
  status: string;
  schedule_state: string | null;
  starts_at: string;
  starts_at_label: string | null;
  ends_at: string | null;
  location: string | null;
  address: string | null;
  contact: string | null;
  navigation_hint: string | null;
  transport_hint: string | null;
  lineage_key: string;
  rescheduled_from_id: string | null;
  bucket: "active" | "history";
  detail_openable: true;
};

function lineageKey(a: Appointment): string {
  const title = sanitizeHumanCareCopy(a.title || "appointment")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 40);
  // Group PT / therapy series without collapsing unrelated visits days apart when active
  if (/physical therapy|therapy|pt\b/.test(title)) return "lineage:physical_therapy";
  if (/dental/.test(title)) return "lineage:dental";
  return `lineage:${title}`;
}

function isProbe(a: Appointment): boolean {
  return isSmokeResidueLine(`${a.title} ${a.location ?? ""} ${a.changeSource ?? ""}`);
}

function isPast(a: Appointment, now: number): boolean {
  const t = Date.parse(a.startsAt);
  if (Number.isNaN(t)) return false;
  return t < now - 2 * 3600e3;
}

export function buildAppointmentLineage(
  store: CareStore,
  careRecipientId: string,
): { active: AppointmentView[]; history: AppointmentView[] } {
  const now = Date.now();
  const raw = store.getAppointments(careRecipientId) ?? [];
  const views: AppointmentView[] = raw.map((a) => {
    const past = isPast(a, now);
    const cancelled = a.status === "cancelled" || a.scheduleState === "cancelled";
    const completed = a.status === "completed";
    const probe = isProbe(a);
    const history =
      cancelled || completed || past || probe || a.status === "moved";
    const title = redactSystemIds(sanitizeHumanCareCopy(a.title || "Appointment"));
    const loc = a.location ? redactSystemIds(a.location) : null;
    return {
      id: a.id,
      title,
      status: a.status,
      schedule_state: a.scheduleState ?? null,
      starts_at: a.startsAt,
      starts_at_label: a.startsAtLabel ?? null,
      ends_at: a.endsAt ?? null,
      location: loc,
      address: loc,
      contact: null,
      navigation_hint: loc
        ? `Open maps for ${loc}`
        : "Location not on file — ask the care team",
      transport_hint: "Ask Relay who is handling transportation",
      lineage_key: lineageKey(a),
      rescheduled_from_id: a.rescheduledFromId ?? null,
      bucket: history ? "history" : "active",
      detail_openable: true,
    };
  });

  // One active per lineage: keep soonest future / current
  const activeByKey = new Map<string, AppointmentView>();
  for (const v of views.filter((x) => x.bucket === "active")) {
    const prev = activeByKey.get(v.lineage_key);
    if (!prev) {
      activeByKey.set(v.lineage_key, v);
      continue;
    }
    if (Date.parse(v.starts_at) < Date.parse(prev.starts_at)) {
      // mark older active as history later
      activeByKey.set(v.lineage_key, v);
    }
  }
  const activeIds = new Set([...activeByKey.values()].map((v) => v.id));
  const active = [...activeByKey.values()].sort(
    (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
  );
  const history = views
    .filter((v) => v.bucket === "history" || !activeIds.has(v.id))
    .map((v) => ({ ...v, bucket: "history" as const }))
    .sort((a, b) => Date.parse(b.starts_at) - Date.parse(a.starts_at));

  return { active, history };
}
