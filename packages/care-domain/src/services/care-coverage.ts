/**
 * Recipient-centered care coverage / involvement.
 * Not workforce management — who is helping this person now and next.
 */

import type { CareUpdate, SourceRef } from "../types.js";
import type { CareStore } from "../store/memory-store.js";

export type CoverageSlot = {
  id: string;
  careRecipientId: string;
  personId: string;
  personDisplayName: string;
  roleLabel: string;
  /** helping_now | next | planned */
  phase: "helping_now" | "next" | "planned";
  /** Human flexible timing — may be imprecise */
  untilLabel?: string;
  expectedAroundLabel?: string;
  notes?: string;
  updatedAt: string;
};

const COVER_PREFIX = "CARE_COVER_V1:";

export function encodeCoverage(slot: CoverageSlot): string {
  return `${COVER_PREFIX}${JSON.stringify(slot)}`;
}

export function listCoverage(
  store: CareStore,
  careRecipientId: string,
): CoverageSlot[] {
  const byId = new Map<string, CoverageSlot>();
  for (const u of store.getUpdates(careRecipientId)) {
    const blob = u.summary ?? "";
    if (!blob.startsWith(COVER_PREFIX)) continue;
    try {
      const slot = JSON.parse(blob.slice(COVER_PREFIX.length)) as CoverageSlot;
      byId.set(slot.id, slot);
    } catch {
      /* skip */
    }
  }
  return [...byId.values()].sort((a, b) => {
    const order = { helping_now: 0, next: 1, planned: 2 };
    return order[a.phase] - order[b.phase];
  });
}

export function upsertCoverage(
  store: CareStore,
  slot: CoverageSlot,
  source: SourceRef,
): CareUpdate {
  return store.addUpdate({
    id: store.newId("upd"),
    careRecipientId: slot.careRecipientId,
    toPersonId: slot.personId,
    summary: encodeCoverage(slot),
    source,
    status: "ready",
    safetyClass: "low",
  });
}

export function formatCoverageHuman(slots: CoverageSlot[]): string {
  if (!slots.length) {
    return "Coverage for this person is not listed yet.";
  }
  const lines: string[] = [];
  for (const s of slots) {
    if (s.phase === "helping_now") {
      lines.push(
        `Helping now: ${s.personDisplayName}${s.roleLabel ? ` · ${s.roleLabel}` : ""}${
          s.untilLabel ? `\nUntil about ${s.untilLabel}` : ""
        }`,
      );
    } else if (s.phase === "next") {
      lines.push(
        `Next: ${s.personDisplayName}${
          s.expectedAroundLabel ? `\nExpected around ${s.expectedAroundLabel}` : ""
        }`,
      );
    } else {
      lines.push(
        `Planned: ${s.personDisplayName}${
          s.expectedAroundLabel ? ` · ${s.expectedAroundLabel}` : ""
        }`,
      );
    }
  }
  return lines.join("\n\n");
}

/** Seed synthetic lab coverage for Evelyn (Marcus now → Maya next). */
export function seedDefaultCoverage(
  store: CareStore,
  careRecipientId: string,
): void {
  if (listCoverage(store, careRecipientId).length > 0) return;
  if (careRecipientId !== "cr-olivia") return;
  const now = new Date().toISOString();
  const src: SourceRef = {
    id: "src-coverage-seed",
    kind: "system_derived",
    label: "Care coverage (synthetic lab)",
    actorName: "Caretaker Relay",
    recordedAt: now,
    whyVisible: "Lab seed for caregiver orientation.",
  };
  upsertCoverage(
    store,
    {
      id: "cover-marcus-now",
      careRecipientId,
      personId: "p-sadeil",
      personDisplayName: "Marcus Carter",
      roleLabel: "Primary family caregiver",
      phase: "helping_now",
      untilLabel: "4:00 PM",
      updatedAt: now,
    },
    src,
  );
  upsertCoverage(
    store,
    {
      id: "cover-maya-next",
      careRecipientId,
      personId: "p-maya",
      personDisplayName: "Maya Bennett",
      roleLabel: "Family / friend caregiver",
      phase: "next",
      expectedAroundLabel: "4:30 PM",
      notes: "Handoff prepared before transition when possible",
      updatedAt: now,
    },
    src,
  );
}
