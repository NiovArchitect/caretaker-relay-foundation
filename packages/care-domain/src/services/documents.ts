/**
 * Prepared care documents with freshness / staleness tracking.
 * SoR via CareUpdate CARE_DOC_V1: prefix.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareUpdate, SourceRef } from "../types.js";

export const DOC_PREFIX = "CARE_DOC_V1:";

export type DocumentFreshness =
  | "CURRENT"
  | "UPDATE_AVAILABLE"
  | "STALE"
  | "SUPERSEDED"
  | "NEEDS_REVIEW";

export type CareDocument = {
  id: string;
  careRecipientId: string;
  documentType:
    | "provider_summary"
    | "caregiver_handoff"
    | "daily_summary"
    | "medication_review";
  title: string;
  body: string;
  preparedAt: string;
  preparedByPersonId: string;
  sourceRefs: string[];
  sourceEventIds: string[];
  freshness: DocumentFreshness;
  staleReason?: string;
  supersededById?: string;
};

function src(actorId: string, actorName: string): SourceRef {
  return {
    id: `src-doc-${Date.now().toString(36)}`,
    kind: "system_derived",
    label: "Prepared care document",
    actorPersonId: actorId,
    actorName,
    recordedAt: new Date().toISOString(),
    whyVisible: "Prepared in-app document for authorized caregivers",
  };
}

export function encodeDocument(d: CareDocument): CareUpdate {
  return {
    id: d.id,
    careRecipientId: d.careRecipientId,
    toPersonId: d.preparedByPersonId,
    summary: DOC_PREFIX + JSON.stringify(d),
    status: d.freshness === "STALE" || d.freshness === "SUPERSEDED" ? "ready" : "ready",
    safetyClass: "low",
    source: src(d.preparedByPersonId, "Relay"),
  };
}

export function decodeDocument(u: CareUpdate): CareDocument | null {
  if (!u.summary.startsWith(DOC_PREFIX)) return null;
  try {
    return JSON.parse(u.summary.slice(DOC_PREFIX.length)) as CareDocument;
  } catch {
    return null;
  }
}

export function listDocuments(
  store: CareStore,
  careRecipientId: string,
): CareDocument[] {
  const byId = new Map<string, CareDocument>();
  for (const u of store.getUpdates(careRecipientId)) {
    const d = decodeDocument(u);
    if (d) byId.set(d.id, d);
  }
  return [...byId.values()].sort((a, b) =>
    b.preparedAt.localeCompare(a.preparedAt),
  );
}

export function prepareDocument(
  store: CareStore,
  input: {
    careRecipientId: string;
    documentType: CareDocument["documentType"];
    title: string;
    body: string;
    preparedByPersonId: string;
    sourceRefs?: string[];
    sourceEventIds?: string[];
  },
): CareDocument {
  const now = new Date().toISOString();
  // Supersede prior same-type CURRENT docs
  for (const d of listDocuments(store, input.careRecipientId)) {
    if (
      d.documentType === input.documentType &&
      (d.freshness === "CURRENT" || d.freshness === "UPDATE_AVAILABLE")
    ) {
      store.addUpdate(
        encodeDocument({
          ...d,
          freshness: "SUPERSEDED",
          staleReason: "A newer document of this type was prepared.",
          supersededById: `pending`,
        }),
      );
    }
  }
  const doc: CareDocument = {
    id: `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    careRecipientId: input.careRecipientId,
    documentType: input.documentType,
    title: input.title,
    body: input.body,
    preparedAt: now,
    preparedByPersonId: input.preparedByPersonId,
    sourceRefs: input.sourceRefs ?? [],
    sourceEventIds: input.sourceEventIds ?? [],
    freshness: "CURRENT",
  };
  store.addUpdate(encodeDocument(doc));
  return doc;
}

/**
 * After care truth changes, mark documents prepared before the change as STALE.
 */
export function markDocumentsStaleAfterChange(
  store: CareStore,
  careRecipientId: string,
  changeAt: string,
  reason: string,
): number {
  let n = 0;
  for (const d of listDocuments(store, careRecipientId)) {
    if (d.freshness === "SUPERSEDED") continue;
    if (d.preparedAt <= changeAt && d.freshness === "CURRENT") {
      store.addUpdate(
        encodeDocument({
          ...d,
          freshness: "STALE",
          staleReason: reason,
        }),
      );
      n++;
    } else if (d.freshness === "CURRENT") {
      store.addUpdate(
        encodeDocument({
          ...d,
          freshness: "UPDATE_AVAILABLE",
          staleReason: reason,
        }),
      );
      n++;
    }
  }
  return n;
}

export function freshnessHumanLabel(f: DocumentFreshness): string {
  switch (f) {
    case "CURRENT":
      return "Current";
    case "UPDATE_AVAILABLE":
      return "Update available";
    case "STALE":
      return "Out of date";
    case "SUPERSEDED":
      return "Replaced";
    case "NEEDS_REVIEW":
      return "Needs review";
  }
}
