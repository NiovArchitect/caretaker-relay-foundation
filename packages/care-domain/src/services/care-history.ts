/**
 * Human-readable care history — not raw event IDs.
 */

import type { CareStore } from "../store/memory-store.js";
import { listCareNotes } from "./care-notes.js";

export type HistoryKind =
  | "all"
  | "medications"
  | "appointments"
  | "observations"
  | "care_notes"
  | "provider"
  | "handoffs"
  | "documents";

export type HistoryItem = {
  id: string;
  at: string;
  kind: HistoryKind | string;
  title: string;
  detail: string;
  sourceLabel?: string;
};

export function buildCareHistory(
  store: CareStore,
  careRecipientId: string,
  filter: HistoryKind = "all",
): HistoryItem[] {
  const items: HistoryItem[] = [];

  for (const m of store.getMedRecords(careRecipientId)) {
    items.push({
      id: m.id,
      at: m.administeredAt,
      kind: "medications",
      title:
        m.status === "needs_review"
          ? "Medication held for review"
          : "Medication reported",
      detail: `${m.name} · ${m.doseRecorded} · ${m.status}`,
      sourceLabel: m.source?.actorName,
    });
  }

  for (const a of store.getAppointments(careRecipientId)) {
    items.push({
      id: a.id,
      at: a.startsAt,
      kind: "appointments",
      title:
        a.status === "moved" || a.status === "cancelled"
          ? `Appointment ${a.status}`
          : "Appointment",
      detail: `${a.title} · ${a.startsAtLabel ?? a.startsAt}${
        a.location ? ` · ${a.location}` : ""
      }`,
      sourceLabel: a.source?.actorName ?? a.changeSource,
    });
  }

  for (const o of store.getObservations(careRecipientId)) {
    items.push({
      id: o.id,
      at: o.observedAt,
      kind: "observations",
      title: "Observation reported",
      detail: o.summary,
      sourceLabel: o.source?.actorName,
    });
  }

  for (const e of store.getEvents(careRecipientId)) {
    if (items.some((i) => i.id === e.id)) continue;
    items.push({
      id: e.id,
      at: e.occurredAt,
      kind: "all",
      title: "Care activity",
      detail: e.statement,
      sourceLabel: e.source?.actorName,
    });
  }

  for (const h of store.getHandoffs(careRecipientId)) {
    items.push({
      id: h.id,
      at: h.createdAt,
      kind: "handoffs",
      title: "Handoff prepared",
      detail: (h.whatChanged ?? []).slice(0, 3).join("; ") || "Handoff on file",
      sourceLabel: h.fromPersonId,
    });
  }

  for (const n of listCareNotes(store, careRecipientId)) {
    items.push({
      id: n.id,
      at: n.createdAt,
      kind: "care_notes",
      title: n.title,
      detail: n.body.slice(0, 200),
      sourceLabel: n.authorDisplayName,
    });
  }

  const filtered =
    filter === "all"
      ? items
      : items.filter((i) => i.kind === filter || (filter === "provider" && /provider|Dr\.|clinic/i.test(i.detail + i.title)));

  return filtered.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 80);
}
