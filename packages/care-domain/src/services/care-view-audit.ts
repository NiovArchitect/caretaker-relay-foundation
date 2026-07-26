/**
 * Universal care-data view audit with polling suppression.
 * Emits CARE_DATA_VIEW at most once per (actor, recipient, surface) window.
 */

import type { CareStore } from "../store/memory-store.js";
import { redactAuditDetails } from "./phi-redact.js";

const DEFAULT_SUPPRESS_MS = 60_000;

export type CareViewSurface =
  | "profile"
  | "state"
  | "timeline"
  | "history"
  | "coverage"
  | "notes"
  | "today"
  | "circle"
  | "access"
  | "handoffs"
  | "export"
  | "relay_answer"
  | "understand"
  | "medications"
  | "documents"
  | "emergency"
  | "messages"
  | "coordination"
  | "notifications"
  | "reminders"
  | "orchestration"
  | "role_projection"
  | "events"
  | "schedule"
  | "actions";

const lastEmit = new Map<string, number>();

function key(
  actorPersonId: string,
  careRecipientId: string,
  surface: string,
): string {
  return `${actorPersonId}::${careRecipientId}::${surface}`;
}

/**
 * Record a meaningful care-data view. Suppresses rapid polling duplicates.
 * Returns whether an audit row was written.
 */
export function recordCareDataView(
  store: CareStore,
  input: {
    actorPersonId: string;
    careRecipientId: string;
    surface: CareViewSurface;
    outcome?: "allow" | "deny";
    authorizationSource?: string;
    purpose?: string;
    suppressMs?: number;
    extra?: Record<string, unknown>;
  },
): boolean {
  const suppress = input.suppressMs ?? DEFAULT_SUPPRESS_MS;
  const k = key(input.actorPersonId, input.careRecipientId, input.surface);
  const now = Date.now();
  const prev = lastEmit.get(k);
  if (prev != null && now - prev < suppress && input.outcome !== "deny") {
    return false;
  }
  lastEmit.set(k, now);
  // Bound map size
  if (lastEmit.size > 20_000) {
    const cutoff = now - suppress * 2;
    for (const [kk, t] of lastEmit) {
      if (t < cutoff) lastEmit.delete(kk);
    }
  }
  store.writeAudit({
    at: new Date().toISOString(),
    actorPersonId: input.actorPersonId,
    action: "CARE_DATA_VIEW",
    careRecipientId: input.careRecipientId,
    details: redactAuditDetails({
      surface: input.surface,
      outcome: input.outcome ?? "allow",
      authorization_source: input.authorizationSource,
      purpose: input.purpose,
      ...input.extra,
    }),
  });
  return true;
}

/** Test helper */
export function clearCareViewAuditSuppression(): void {
  lastEmit.clear();
}
