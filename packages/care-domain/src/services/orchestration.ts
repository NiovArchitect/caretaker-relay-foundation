/**
 * Care orchestration engine — coordinates humans around a care recipient.
 *
 * System of record: CareUpdate rows with CARE_ORCH_V1: / CARE_CAND_V1: prefixes.
 * Browser is never authority.
 *
 * Flow (conceptual):
 *   QUESTION → truth → missing → who knows → ask → response → candidate
 *   → verify (if consequential) → care truth → downstream → notify → close
 */

import type { CareStore } from "../store/memory-store.js";
import type {
  CareHandoff,
  CareUpdate,
  MedicationAdministrationRecord,
  SourceRef,
} from "../types.js";
import {
  createClarificationRequest,
  createNotificationIfNew,
  markResolved,
  listNotificationsForPrincipal,
  type CareNotification,
} from "./notifications.js";
import { resolvePersonName } from "../relay/util.js";
import { markDocumentsStaleAfterChange, prepareDocument } from "./documents.js";

export const ORCH_PREFIX = "CARE_ORCH_V1:";
export const CAND_PREFIX = "CARE_CAND_V1:";

export type OrchState =
  | "ANSWERED"
  | "MISSING_INFORMATION"
  | "CLARIFICATION_PROPOSED"
  | "CLARIFICATION_SENT"
  | "WAITING_FOR_RESPONSE"
  | "RESPONSE_RECEIVED"
  | "NEEDS_VERIFICATION"
  | "VERIFICATION_REQUESTED"
  | "VERIFIED"
  | "REJECTED"
  | "CARE_TRUTH_UPDATED"
  | "DOWNSTREAM_UPDATED"
  | "NOTIFICATIONS_SENT"
  | "RESOLVED";

export type OrchKind =
  | "caregiver_clarification"
  | "provider_clarification"
  | "medication_verification";

/** Interpreted candidate from human collaboration (distinct from understand OrchCareCandidate). */
export type OrchCareCandidate = {
  id: string;
  type: "medication_administration" | "provider_instruction" | "observation";
  careRecipientId: string;
  summary: string;
  structured: {
    medicationName?: string;
    dose?: string;
    approximateTimeLabel?: string;
    administeredAtIso?: string;
    mealRelation?: string;
    instructionText?: string;
  };
  originalEvidence: string;
  sourcePersonId: string;
  sourceDisplayName: string;
  authority: "caregiver_reported" | "professional" | "system";
  requiresVerification: boolean;
  orchestrationId: string;
  createdAt: string;
  status: "pending" | "confirmed" | "rejected";
};

export type CareOrchestration = {
  id: string;
  careRecipientId: string;
  requesterPersonId: string;
  requesterDisplayName: string;
  kind: OrchKind;
  state: OrchState;
  question: string;
  contextSummary?: string;
  targetPersonId?: string;
  targetDisplayName?: string;
  clarificationRequestId?: string;
  responseId?: string;
  responseBody?: string;
  candidateId?: string;
  marId?: string;
  providerGuidanceId?: string;
  handoffId?: string;
  confirmedByPersonId?: string;
  confirmedAt?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  waitingOnPersonId?: string;
  waitingOnDisplayName?: string;
  metadata?: Record<string, unknown>;
};

function src(
  actorPersonId: string,
  actorName: string,
  label: string,
): SourceRef {
  return {
    id: `src-orch-${Date.now().toString(36)}`,
    kind: "system_derived",
    label,
    actorPersonId,
    actorName,
    recordedAt: new Date().toISOString(),
    whyVisible: "Care orchestration",
  };
}

export function encodeOrchestration(o: CareOrchestration): CareUpdate {
  return {
    id: o.id,
    careRecipientId: o.careRecipientId,
    toPersonId: o.requesterPersonId,
    summary: ORCH_PREFIX + JSON.stringify(o),
    status: o.closedAt ? "ready" : "ready",
    safetyClass:
      o.kind === "provider_clarification" || o.kind === "medication_verification"
        ? "moderate"
        : "low",
    source: src(
      o.requesterPersonId,
      o.requesterDisplayName,
      "Care orchestration",
    ),
  };
}

export function decodeOrchestration(u: CareUpdate): CareOrchestration | null {
  if (!u.summary.startsWith(ORCH_PREFIX)) return null;
  try {
    return JSON.parse(u.summary.slice(ORCH_PREFIX.length)) as CareOrchestration;
  } catch {
    return null;
  }
}

export function encodeCandidate(c: OrchCareCandidate): CareUpdate {
  return {
    id: c.id,
    careRecipientId: c.careRecipientId,
    toPersonId: c.sourcePersonId,
    summary: CAND_PREFIX + JSON.stringify(c),
    status: c.status === "pending" ? "blocked_pending_verify" : "ready",
    safetyClass: c.requiresVerification ? "high" : "moderate",
    source: src(c.sourcePersonId, c.sourceDisplayName, "Care candidate"),
  };
}

export function decodeCandidate(u: CareUpdate): OrchCareCandidate | null {
  if (!u.summary.startsWith(CAND_PREFIX)) return null;
  try {
    return JSON.parse(u.summary.slice(CAND_PREFIX.length)) as OrchCareCandidate;
  } catch {
    return null;
  }
}

export function listOrchestrations(
  store: CareStore,
  careRecipientId: string,
): CareOrchestration[] {
  const byId = new Map<string, CareOrchestration>();
  for (const u of store.getUpdates(careRecipientId)) {
    const o = decodeOrchestration(u);
    if (!o) continue;
    const prev = byId.get(o.id);
    if (!prev || o.updatedAt >= prev.updatedAt) byId.set(o.id, o);
  }
  return [...byId.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function getOrchestration(
  store: CareStore,
  careRecipientId: string,
  orchId: string,
): CareOrchestration | null {
  return listOrchestrations(store, careRecipientId).find((o) => o.id === orchId) ?? null;
}

export function listOpenOrchestrations(
  store: CareStore,
  careRecipientId: string,
  principalId?: string,
): CareOrchestration[] {
  return listOrchestrations(store, careRecipientId).filter((o) => {
    if (o.state === "RESOLVED" || o.state === "REJECTED" || o.closedAt) return false;
    if (principalId && o.requesterPersonId !== principalId) {
      // Also show if principal is the waiting target
      if (o.waitingOnPersonId !== principalId) return false;
    }
    return true;
  });
}

export function getCandidate(
  store: CareStore,
  careRecipientId: string,
  candidateId: string,
): OrchCareCandidate | null {
  for (const u of store.getUpdates(careRecipientId)) {
    const c = decodeCandidate(u);
    if (c?.id === candidateId) return c;
  }
  return null;
}

function saveOrch(store: CareStore, o: CareOrchestration): CareOrchestration {
  const next = { ...o, updatedAt: new Date().toISOString() };
  store.addUpdate(encodeOrchestration(next));
  return next;
}

function saveCand(store: CareStore, c: OrchCareCandidate): OrchCareCandidate {
  store.addUpdate(encodeCandidate(c));
  return c;
}

/** Best-contact heuristics for a recipient (not hardcoded Maya). */
export function selectBestContact(
  store: CareStore,
  careRecipientId: string,
  purpose:
    | "medication_admin"
    | "provider_instruction"
    | "appointment"
    | "general",
  excludePersonId?: string,
): { personId: string; displayName: string; reason: string } | null {
  const rels = store
    .getRelationships(careRecipientId)
    .filter((r) => r.status === "active" && r.personId !== excludePersonId);

  if (purpose === "provider_instruction") {
    const md = rels.find((r) => /physician|provider|primary care/i.test(r.role + r.roleLabel));
    if (md) {
      const p = store.getPerson(md.personId);
      return {
        personId: md.personId,
        displayName: p?.displayName ?? resolvePersonName(md.personId),
        reason: "authorized clinical provider",
      };
    }
  }

  if (purpose === "medication_admin") {
    // Prefer recent administrator who is not the asker, else adult child / family
    const mars = store.getMedRecords(careRecipientId);
    for (let i = mars.length - 1; i >= 0; i--) {
      const by = mars[i]!.administeredByPersonId;
      if (by && by !== excludePersonId) {
        const p = store.getPerson(by);
        if (p) {
          return {
            personId: by,
            displayName: p.displayName,
            reason: "recent medication administrator",
          };
        }
      }
    }
    const family = rels.find((r) =>
      /adult_child|family|friend/i.test(r.role + r.roleLabel),
    );
    if (family) {
      const p = store.getPerson(family.personId);
      return {
        personId: family.personId,
        displayName: p?.displayName ?? resolvePersonName(family.personId),
        reason: "family caregiver in care circle",
      };
    }
  }

  // DSP / professional
  const dsp = rels.find((r) => /paid|professional|dsp/i.test(r.role + r.roleLabel));
  if (dsp && purpose !== "provider_instruction") {
    const p = store.getPerson(dsp.personId);
    return {
      personId: dsp.personId,
      displayName: p?.displayName ?? resolvePersonName(dsp.personId),
      reason: "professional caregiver on the team",
    };
  }

  const any = rels[0];
  if (!any) return null;
  const p = store.getPerson(any.personId);
  return {
    personId: any.personId,
    displayName: p?.displayName ?? resolvePersonName(any.personId),
    reason: "authorized care circle member",
  };
}

/**
 * Start clarification orchestration + durable request + target notification.
 */
export function startClarificationOrchestration(
  store: CareStore,
  input: {
    careRecipientId: string;
    requesterPersonId: string;
    requesterDisplayName: string;
    targetPersonId: string;
    targetDisplayName: string;
    question: string;
    contextSummary?: string;
    kind?: OrchKind;
  },
): {
  orchestration: CareOrchestration;
  requestId: string;
  notification: CareNotification;
} {
  const kind: OrchKind =
    input.kind ??
    (input.targetPersonId === "p-dr-shah" ||
    /physician|provider|dr\.|doctor/i.test(input.targetDisplayName)
      ? "provider_clarification"
      : "caregiver_clarification");

  const { request, notification } = createClarificationRequest(store, {
    careRecipientId: input.careRecipientId,
    requesterPersonId: input.requesterPersonId,
    requesterDisplayName: input.requesterDisplayName,
    targetPersonId: input.targetPersonId,
    targetDisplayName: input.targetDisplayName,
    question: input.question,
    contextSummary: input.contextSummary,
  });

  const now = new Date().toISOString();
  const orch: CareOrchestration = {
    id: `orch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    careRecipientId: input.careRecipientId,
    requesterPersonId: input.requesterPersonId,
    requesterDisplayName: input.requesterDisplayName,
    kind,
    state: "WAITING_FOR_RESPONSE",
    question: input.question,
    contextSummary: input.contextSummary,
    targetPersonId: input.targetPersonId,
    targetDisplayName: input.targetDisplayName,
    clarificationRequestId: request.id,
    createdAt: now,
    updatedAt: now,
    waitingOnPersonId: input.targetPersonId,
    waitingOnDisplayName: input.targetDisplayName,
    metadata: { notificationId: notification.id },
  };
  saveOrch(store, orch);
  return { orchestration: orch, requestId: request.id, notification };
}

/** Parse natural caregiver response into a structured candidate. */
export function interpretClarificationResponse(input: {
  orchestration: CareOrchestration;
  responseBody: string;
  responderPersonId: string;
  responderDisplayName: string;
  medicationName?: string;
  dose?: string;
}): OrchCareCandidate {
  const body = input.responseBody.trim();
  const lower = body.toLowerCase();
  const isProvider = input.orchestration.kind === "provider_clarification";

  // Time extraction
  let approximateTimeLabel: string | undefined;
  let administeredAtIso: string | undefined;
  const timeMatch =
    body.match(/\b(\d{1,2}:\d{2}\s*(?:am|pm)?)\b/i) ||
    body.match(/\b(\d{1,2}\s*(?:am|pm))\b/i) ||
    body.match(/\b(around\s+)?(noon|midnight|lunch|breakfast|dinner)\b/i);
  if (timeMatch) {
    approximateTimeLabel = timeMatch[0]!.replace(/^around\s+/i, "around ").trim();
  }
  if (/noon|12(:00)?\s*pm|lunch/i.test(body)) {
    approximateTimeLabel = approximateTimeLabel ?? "around 12:00 PM";
  }
  // Synthetic ISO for "yesterday lunch" if not precise
  if (approximateTimeLabel && !administeredAtIso) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    const hm = approximateTimeLabel.match(/(\d{1,2}):(\d{2})/);
    if (hm) {
      let h = Number(hm[1]);
      const m = Number(hm[2]);
      if (/pm/i.test(approximateTimeLabel) && h < 12) h += 12;
      if (/am/i.test(approximateTimeLabel) && h === 12) h = 0;
      d.setUTCHours(h + 7, m, 0, 0); // rough PDT→UTC for lab
    } else if (/noon|lunch/i.test(approximateTimeLabel)) {
      d.setUTCHours(19, 10, 0, 0);
    }
    administeredAtIso = d.toISOString();
  }

  const mealRelation = /after\s+(she\s+)?ate|with\s+(lunch|food|meal)|after\s+eating/i.test(
    body,
  )
    ? "after eating"
    : /with\s+food/i.test(body)
      ? "with food"
      : undefined;

  const now = new Date().toISOString();
  if (isProvider) {
    return {
      id: `cand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      type: "provider_instruction",
      careRecipientId: input.orchestration.careRecipientId,
      summary: `Provider guidance from ${input.responderDisplayName}`,
      structured: {
        instructionText: body,
      },
      originalEvidence: body,
      sourcePersonId: input.responderPersonId,
      sourceDisplayName: input.responderDisplayName,
      authority: "professional",
      requiresVerification: false, // professional source — still not auto clinical rewrite of regimen
      orchestrationId: input.orchestration.id,
      createdAt: now,
      status: "pending",
    };
  }

  const gave = /\b(yes|gave|administered|i did|took)\b/i.test(lower);
  return {
    id: `cand-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: "medication_administration",
    careRecipientId: input.orchestration.careRecipientId,
    summary: gave
      ? `${input.responderDisplayName} reported giving medication${
          approximateTimeLabel ? ` ${approximateTimeLabel}` : ""
        }`
      : `${input.responderDisplayName} replied about medication`,
    structured: {
      medicationName: input.medicationName ?? "Metformin",
      dose: input.dose ?? "500 mg",
      approximateTimeLabel,
      administeredAtIso,
      mealRelation,
    },
    originalEvidence: body,
    sourcePersonId: input.responderPersonId,
    sourceDisplayName: input.responderDisplayName,
    authority: "caregiver_reported",
    requiresVerification: true,
    orchestrationId: input.orchestration.id,
    createdAt: now,
    status: "pending",
  };
}

/**
 * After Maya/provider responds: attach response, create candidate, notify requester
 * with verification prompt (not auto care truth).
 */
export function advanceOrchestrationOnResponse(
  store: CareStore,
  input: {
    careRecipientId: string;
    requestId: string;
    responseId: string;
    responseBody: string;
    responderPersonId: string;
    responderDisplayName: string;
  },
): {
  orchestration: CareOrchestration;
  candidate: OrchCareCandidate;
  notification: CareNotification;
  coordinatorMessage: string;
} | null {
  const open = listOrchestrations(store, input.careRecipientId).find(
    (o) =>
      o.clarificationRequestId === input.requestId &&
      o.state === "WAITING_FOR_RESPONSE",
  );
  // Fallback: match any open orch for this request
  const orch =
    open ??
    listOrchestrations(store, input.careRecipientId).find(
      (o) => o.clarificationRequestId === input.requestId && !o.closedAt,
    );
  if (!orch) return null;

  const schedules = store.getMedSchedules(input.careRecipientId);
  const med = schedules[0];
  const candidate = interpretClarificationResponse({
    orchestration: orch,
    responseBody: input.responseBody,
    responderPersonId: input.responderPersonId,
    responderDisplayName: input.responderDisplayName,
    medicationName: med?.name,
    dose: med?.dose,
  });
  saveCand(store, candidate);

  const nextState: OrchState =
    candidate.requiresVerification || candidate.type === "medication_administration"
      ? "NEEDS_VERIFICATION"
      : "RESPONSE_RECEIVED";

  const updated = saveOrch(store, {
    ...orch,
    state: nextState,
    responseId: input.responseId,
    responseBody: input.responseBody,
    candidateId: candidate.id,
    waitingOnPersonId:
      nextState === "NEEDS_VERIFICATION" ? orch.requesterPersonId : undefined,
    waitingOnDisplayName:
      nextState === "NEEDS_VERIFICATION" ? orch.requesterDisplayName : undefined,
  });

  let coordinatorMessage: string;
  if (candidate.type === "medication_administration") {
    const when =
      candidate.structured.approximateTimeLabel ?? "at a time they described";
    const meal = candidate.structured.mealRelation
      ? ` ${candidate.structured.mealRelation}`
      : "";
    coordinatorMessage =
      `${input.responderDisplayName} says they gave ${candidate.structured.medicationName ?? "the medication"} ${when}${meal}.\n\n` +
      `That is a possible administration from ${input.responderDisplayName}'s report — not confirmed care history yet.\n\n` +
      `Because medication administration is safety-sensitive, please review and confirm before it becomes part of the official medication record.`;
  } else {
    coordinatorMessage =
      `${input.responderDisplayName} replied:\n\n"${input.responseBody.slice(0, 400)}"\n\n` +
      `This is professional guidance. I can include it in current care context for authorized caregivers.`;
  }

  const notification = createNotificationIfNew(store, {
    principalId: orch.requesterPersonId,
    careRecipientId: input.careRecipientId,
    type:
      candidate.type === "provider_instruction"
        ? "PROVIDER_UPDATE"
        : "CLARIFICATION_RESPONSE",
    priority: "important",
    title:
      candidate.type === "provider_instruction"
        ? `${input.responderDisplayName} replied about care guidance`
        : `${input.responderDisplayName} replied about medication`,
    body: coordinatorMessage.slice(0, 280),
    sourceType: "orchestration_response",
    sourceId: updated.id,
    actorPersonId: input.responderPersonId,
    actorDisplayName: input.responderDisplayName,
    actionType: "open_verification",
    actionTarget: `orchestration:${updated.id}:candidate:${candidate.id}`,
    dedupeKey: `orch-resp:${updated.id}:${input.responseId}`,
    metadata: {
      orchestrationId: updated.id,
      candidateId: candidate.id,
      coordinatorMessage,
    },
  });

  return {
    orchestration: updated,
    candidate,
    notification,
    coordinatorMessage,
  };
}

/**
 * Confirm candidate → care truth + downstream (handoff, notifications resolve).
 */
export function confirmCandidate(
  store: CareStore,
  input: {
    careRecipientId: string;
    candidateId: string;
    confirmerPersonId: string;
    confirmerDisplayName: string;
  },
): {
  orchestration: CareOrchestration;
  candidate: OrchCareCandidate;
  mar?: MedicationAdministrationRecord;
  handoff?: CareHandoff;
  providerGuidanceId?: string;
} | null {
  const candidate = getCandidate(store, input.careRecipientId, input.candidateId);
  if (!candidate || candidate.status !== "pending") return null;
  const orch = getOrchestration(
    store,
    input.careRecipientId,
    candidate.orchestrationId,
  );
  if (!orch) return null;

  const now = new Date().toISOString();
  let mar: MedicationAdministrationRecord | undefined;
  let providerGuidanceId: string | undefined;

  if (candidate.type === "medication_administration") {
    const schedules = store.getMedSchedules(input.careRecipientId);
    const schedule = schedules.find(
      (s) =>
        s.name.toLowerCase() ===
        (candidate.structured.medicationName ?? "").toLowerCase(),
    ) ?? schedules[0];
    mar = {
      id: `mar-orch-${Date.now().toString(36)}`,
      careRecipientId: input.careRecipientId,
      scheduleId: schedule?.id,
      name: candidate.structured.medicationName ?? schedule?.name ?? "Medication",
      doseRecorded: candidate.structured.dose ?? schedule?.dose ?? "",
      administeredAt:
        candidate.structured.administeredAtIso ?? now,
      administeredByPersonId: candidate.sourcePersonId,
      status: "recorded",
      epistemicStatus: "CONFIRMED",
      source: {
        id: `src-confirm-${Date.now().toString(36)}`,
        kind: "caregiver_text",
        label: "Confirmed medication administration",
        actorName: input.confirmerDisplayName,
        actorPersonId: input.confirmerPersonId,
        recordedAt: now,
        whyVisible: `${candidate.sourceDisplayName} reported; ${input.confirmerDisplayName} confirmed.`,
        rawExcerpt: candidate.originalEvidence,
      },
    };
    store.addMedRecord(mar);
  } else if (candidate.type === "provider_instruction") {
    providerGuidanceId = `pguid-${Date.now().toString(36)}`;
    // Durable professional communication as CareUpdate
    store.addUpdate({
      id: providerGuidanceId,
      careRecipientId: input.careRecipientId,
      toPersonId: orch.requesterPersonId,
      summary:
        "PROVIDER_GUIDANCE_V1:" +
        JSON.stringify({
          id: providerGuidanceId,
          careRecipientId: input.careRecipientId,
          text: candidate.structured.instructionText ?? candidate.originalEvidence,
          sourcePersonId: candidate.sourcePersonId,
          sourceDisplayName: candidate.sourceDisplayName,
          orchestrationId: orch.id,
          createdAt: now,
          status: "current",
        }),
      status: "ready",
      safetyClass: "moderate",
      source: {
        id: `src-prov-${Date.now().toString(36)}`,
        kind: "provider_instruction",
        label: "Provider guidance",
        actorName: candidate.sourceDisplayName,
        actorPersonId: candidate.sourcePersonId,
        recordedAt: now,
        whyVisible: `${candidate.sourceDisplayName} provided professional guidance.`,
        rawExcerpt: candidate.originalEvidence,
      },
    });
  }

  const confirmedCand = saveCand(store, {
    ...candidate,
    status: "confirmed",
  });

  // Refresh / create handoff reflecting new truth
  const handoff = buildOrRefreshHandoff(store, {
    careRecipientId: input.careRecipientId,
    fromPersonId: input.confirmerPersonId,
    toPersonId: "p-walter",
    whatChanged: [
      candidate.type === "medication_administration"
        ? `${candidate.sourceDisplayName} reported giving ${candidate.structured.medicationName ?? "medication"}${
            candidate.structured.approximateTimeLabel
              ? ` ${candidate.structured.approximateTimeLabel}`
              : ""
          }; confirmed by ${input.confirmerDisplayName}.`
        : `Provider guidance from ${candidate.sourceDisplayName}: ${(
            candidate.structured.instructionText ?? ""
          ).slice(0, 160)}`,
    ],
    stillNeedsAttention:
      candidate.type === "provider_instruction"
        ? ["Follow provider guidance; contact clinic if symptoms worsen."]
        : [],
    watch:
      candidate.type === "medication_administration"
        ? ["Watch for dizziness or unusual fatigue after medication."]
        : ["Follow updated clinical guidance."],
  });

  // Resolve related verification notifications for requester
  for (const n of listNotificationsForPrincipal(
    store,
    orch.requesterPersonId,
    input.careRecipientId,
  )) {
    if (
      n.sourceId === orch.id ||
      (n.metadata &&
        (n.metadata as { orchestrationId?: string }).orchestrationId === orch.id)
    ) {
      markResolved(store, orch.requesterPersonId, n.id);
    }
  }

  // Notify care circle of closed loop (signal over noise — requester + DSP)
  createNotificationIfNew(store, {
    principalId: orch.requesterPersonId,
    careRecipientId: input.careRecipientId,
    type: "CARE_UPDATE",
    priority: "attention",
    title: "Care record updated",
    body:
      candidate.type === "medication_administration"
        ? `Medication administration from ${candidate.sourceDisplayName} is now confirmed in the care history.`
        : `Provider guidance from ${candidate.sourceDisplayName} is now in current care context.`,
    sourceType: "orchestration_resolved",
    sourceId: orch.id,
    actorPersonId: input.confirmerPersonId,
    actorDisplayName: input.confirmerDisplayName,
    actionType: "open_care",
    actionTarget: `orchestration:${orch.id}`,
    dedupeKey: `orch-closed:${orch.id}`,
  });

  if (handoff.toPersonId && handoff.toPersonId !== orch.requesterPersonId) {
    createNotificationIfNew(store, {
      principalId: handoff.toPersonId,
      careRecipientId: input.careRecipientId,
      type: "HANDOFF_READY",
      priority: "attention",
      title: "Handoff updated",
      body: `Care handoff for this recipient includes a new confirmed update.`,
      sourceType: "handoff",
      sourceId: handoff.id,
      actorPersonId: input.confirmerPersonId,
      actorDisplayName: input.confirmerDisplayName,
      actionType: "open_handoff",
      actionTarget: `handoff:${handoff.id}`,
      dedupeKey: `handoff-refresh:${handoff.id}:${handoff.toPersonId}`,
    });
  }

  // Document staleness + prepared daily summary refresh
  markDocumentsStaleAfterChange(
    store,
    input.careRecipientId,
    now,
    "Care truth changed after document was prepared.",
  );
  prepareDocument(store, {
    careRecipientId: input.careRecipientId,
    documentType:
      candidate.type === "provider_instruction"
        ? "provider_summary"
        : "daily_summary",
    title:
      candidate.type === "provider_instruction"
        ? "Updated provider guidance summary"
        : "Updated care day summary",
    body:
      candidate.type === "medication_administration"
        ? `Confirmed administration: ${candidate.structured.medicationName ?? "medication"} reported by ${candidate.sourceDisplayName}; confirmed by ${input.confirmerDisplayName}.`
        : `Provider guidance from ${candidate.sourceDisplayName}: ${candidate.originalEvidence.slice(0, 400)}`,
    preparedByPersonId: input.confirmerPersonId,
    sourceRefs: [candidate.id, orch.id],
    sourceEventIds: mar ? [mar.id] : providerGuidanceId ? [providerGuidanceId] : [],
  });

  const updated = saveOrch(store, {
    ...orch,
    state: "RESOLVED",
    candidateId: confirmedCand.id,
    marId: mar?.id,
    providerGuidanceId,
    handoffId: handoff.id,
    confirmedByPersonId: input.confirmerPersonId,
    confirmedAt: now,
    closedAt: now,
    waitingOnPersonId: undefined,
    waitingOnDisplayName: undefined,
  });

  return {
    orchestration: updated,
    candidate: confirmedCand,
    mar,
    handoff,
    providerGuidanceId,
  };
}

export function rejectCandidate(
  store: CareStore,
  input: {
    careRecipientId: string;
    candidateId: string;
    actorPersonId: string;
    actorDisplayName: string;
    reason?: string;
  },
): CareOrchestration | null {
  const candidate = getCandidate(store, input.careRecipientId, input.candidateId);
  if (!candidate) return null;
  const orch = getOrchestration(
    store,
    input.careRecipientId,
    candidate.orchestrationId,
  );
  if (!orch) return null;
  saveCand(store, { ...candidate, status: "rejected" });
  return saveOrch(store, {
    ...orch,
    state: "REJECTED",
    closedAt: new Date().toISOString(),
    waitingOnPersonId: undefined,
    waitingOnDisplayName: undefined,
    metadata: {
      ...orch.metadata,
      rejectReason: input.reason,
      rejectedBy: input.actorPersonId,
    },
  });
}

function buildOrRefreshHandoff(
  store: CareStore,
  input: {
    careRecipientId: string;
    fromPersonId: string;
    toPersonId: string;
    whatChanged: string[];
    stillNeedsAttention: string[];
    watch: string[];
  },
): CareHandoff {
  const existing = store.getHandoffs(input.careRecipientId);
  const latest = existing[existing.length - 1];
  const now = new Date().toISOString();
  const handoff: CareHandoff = {
    id: latest?.id ?? `ho-orch-${Date.now().toString(36)}`,
    careRecipientId: input.careRecipientId,
    fromPersonId: input.fromPersonId,
    toPersonId: input.toPersonId,
    whatChanged: [
      ...input.whatChanged,
      ...(latest?.whatChanged ?? []).slice(0, 4),
    ].slice(0, 8),
    stillNeedsAttention: [
      ...input.stillNeedsAttention,
      ...(latest?.stillNeedsAttention ?? []).filter(
        (x) => !/medication check|verify.*maya|waiting on/i.test(x),
      ),
    ].slice(0, 6),
    watch: [...input.watch, ...(latest?.watch ?? [])].slice(0, 6),
    sources: latest?.sources ?? [],
    createdAt: now,
    evidenceMode: "FIXTURE",
  };
  store.addHandoff(handoff);
  return handoff;
}

/** Human-readable open-loop summary for Relay answers. */
export function summarizeOpenLoops(
  store: CareStore,
  careRecipientId: string,
  principalId?: string,
): {
  open: CareOrchestration[];
  lines: string[];
  waitingOnNames: string[];
} {
  const open = listOpenOrchestrations(store, careRecipientId, principalId);
  const waitingOnNames = [
    ...new Set(
      open
        .map((o) => o.waitingOnDisplayName)
        .filter((x): x is string => !!x),
    ),
  ];
  const lines = open.map((o) => {
    if (o.state === "WAITING_FOR_RESPONSE") {
      return `Waiting on ${o.waitingOnDisplayName ?? "someone"}: ${o.question.slice(0, 120)}`;
    }
    if (o.state === "NEEDS_VERIFICATION") {
      return `Needs your review: ${o.responseBody?.slice(0, 120) ?? o.question.slice(0, 120)}`;
    }
    return `${o.state}: ${o.question.slice(0, 100)}`;
  });
  return { open, lines, waitingOnNames };
}

export function listProviderGuidance(
  store: CareStore,
  careRecipientId: string,
): Array<{ id: string; text: string; sourceDisplayName: string; createdAt: string }> {
  const out: Array<{
    id: string;
    text: string;
    sourceDisplayName: string;
    createdAt: string;
  }> = [];
  for (const u of store.getUpdates(careRecipientId)) {
    if (!u.summary.startsWith("PROVIDER_GUIDANCE_V1:")) continue;
    try {
      const g = JSON.parse(u.summary.slice("PROVIDER_GUIDANCE_V1:".length)) as {
        id: string;
        text: string;
        sourceDisplayName: string;
        createdAt: string;
        status?: string;
      };
      if (g.status === "stale") continue;
      out.push({
        id: g.id,
        text: g.text,
        sourceDisplayName: g.sourceDisplayName,
        createdAt: g.createdAt,
      });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
