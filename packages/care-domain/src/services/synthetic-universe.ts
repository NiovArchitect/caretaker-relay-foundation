/**
 * Server-authoritative synthetic care-universe checks for dual-mode AI.
 * Client input must never flip a real care record into synthetic mode.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareDataClassification } from "../types.js";

/**
 * Lab / competition recipient IDs that are synthetic by product design.
 * Not inferred from display names; not controllable by the browser.
 */
export const SERVER_SYNTHETIC_RECIPIENT_IDS = new Set<string>([
  "cr-olivia",
  "cr-robert",
  "cr-none",
]);

export function classifyCareRecipient(
  store: CareStore,
  careRecipientId: string,
): CareDataClassification {
  const r = store.getRecipient(careRecipientId);
  if (r?.dataClassification === "synthetic" || r?.dataClassification === "live_phi") {
    return r.dataClassification;
  }
  if (SERVER_SYNTHETIC_RECIPIENT_IDS.has(careRecipientId)) {
    return "synthetic";
  }
  // Deployment-wide synthetic competition universe (env-attested, not client)
  const envClass = (
    (typeof process !== "undefined" && process.env?.CARE_AI_DATA_CLASS) ||
    ""
  ).toLowerCase();
  if (envClass === "synthetic" || envClass === "lab") {
    return "synthetic";
  }
  return r?.dataClassification ?? "unknown";
}

export function isSyntheticCareUniverse(
  store: CareStore,
  careRecipientId: string,
): boolean {
  return classifyCareRecipient(store, careRecipientId) === "synthetic";
}

/**
 * Whether Grok-assisted understand is permitted for this recipient.
 * Mode B: synthetic only (or env synthetic). Mode C (PHI) requires dual BAA flags.
 */
export function grokAssistPermitted(
  store: CareStore,
  careRecipientId: string,
  env: NodeJS.ProcessEnv = (typeof process !== "undefined"
    ? process.env
    : {}) as NodeJS.ProcessEnv,
): { allowed: boolean; reason: string; classification: CareDataClassification } {
  const classification = classifyCareRecipient(store, careRecipientId);
  if (classification === "synthetic") {
    return {
      allowed: true,
      reason: "synthetic_universe",
      classification,
    };
  }
  const baa =
    env.CARE_AI_BAA_EXECUTED === "1" || env.CARE_AI_BAA_EXECUTED === "true";
  const phi =
    env.CARE_AI_PHI_ALLOWED === "1" || env.CARE_AI_PHI_ALLOWED === "true";
  if (baa && phi) {
    return { allowed: true, reason: "phi_mode_c_approved", classification };
  }
  return {
    allowed: false,
    reason: "live_phi_requires_baa_or_synthetic_designation",
    classification,
  };
}
