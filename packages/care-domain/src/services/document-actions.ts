/**
 * Bounded document-to-action: preserve text body, extract proposals, require confirm.
 * Not OCR/PDF parsing — honest paste/upload-text pipeline.
 */

import type { CareStore } from "../store/memory-store.js";
import { evaluateAccess } from "./access.js";
import { createWorkItem } from "./care-work-items.js";
import { upsertScheduleItem } from "./schedule-engine.js";
import { openMedicationMismatch } from "./conflict-center.js";

export type DocumentRecord = {
  id: string;
  careRecipientId: string;
  title: string;
  body: string;
  classification: string;
  uploadedByPersonId: string;
  uploadedByDisplayName: string;
  createdAt: string;
  originalPreserved: true;
};

export type ProposedAction = {
  id: string;
  kind: "work_item" | "schedule" | "conflict" | "note";
  title: string;
  detail: string;
  confidence: "low" | "medium" | "high";
  sourceExcerpt: string;
  status: "proposed" | "confirmed" | "rejected";
};

const DOC_PREFIX = "CARE_DOC_V1:";
const PROP_PREFIX = "CARE_DOC_PROP_V1:";

function encodeDoc(d: DocumentRecord): string {
  return DOC_PREFIX + JSON.stringify(d);
}
function decodeDoc(s: string): DocumentRecord | null {
  if (!s.startsWith(DOC_PREFIX)) return null;
  try {
    return JSON.parse(s.slice(DOC_PREFIX.length)) as DocumentRecord;
  } catch {
    return null;
  }
}

export function listCareTextDocuments(
  store: CareStore,
  careRecipientId: string,
): DocumentRecord[] {
  const out: DocumentRecord[] = [];
  for (const u of store.getUpdates(careRecipientId)) {
    const d = decodeDoc(u.summary);
    if (d) out.push(d);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function ingestDocumentText(
  store: CareStore,
  input: {
    careRecipientId: string;
    actorPersonId: string;
    actorDisplayName: string;
    title: string;
    body: string;
  },
):
  | { ok: true; document: DocumentRecord; proposals: ProposedAction[] }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const body = input.body.trim();
  if (body.length < 8) {
    return {
      ok: false,
      code: "EMPTY_DOCUMENT",
      message: "Document body is empty",
    };
  }
  const now = new Date().toISOString();
  const classification = /therapy|pt |physical therapy/i.test(body)
    ? "therapy_note"
    : /medication|dose|mg|tablet/i.test(body)
      ? "medication_instruction"
      : /appointment|visit|friday|monday/i.test(body)
        ? "appointment_letter"
        : "general_care_document";

  const document: DocumentRecord = {
    id: store.newId("doc"),
    careRecipientId: input.careRecipientId,
    title: input.title.trim() || "Care document",
    body,
    classification,
    uploadedByPersonId: input.actorPersonId,
    uploadedByDisplayName: input.actorDisplayName,
    createdAt: now,
    originalPreserved: true,
  };
  store.addUpdate({
    id: document.id,
    careRecipientId: input.careRecipientId,
    toPersonId: input.actorPersonId,
    summary: encodeDoc(document),
    status: "ready",
    safetyClass: "moderate",
    source: {
      id: `src-doc-${document.id}`,
      kind: "caregiver_text",
      label: "Uploaded care document (text)",
      actorPersonId: input.actorPersonId,
      actorName: input.actorDisplayName,
      recordedAt: now,
      whyVisible: "Authorized document on care record",
    },
  });

  const proposals = extractProposals(document);
  for (const p of proposals) {
    store.addUpdate({
      id: p.id,
      careRecipientId: input.careRecipientId,
      toPersonId: input.actorPersonId,
      summary:
        PROP_PREFIX +
        JSON.stringify({ ...p, documentId: document.id, careRecipientId: input.careRecipientId }),
      status: "ready",
      safetyClass: "low",
      source: {
        id: `src-prop-${p.id}`,
        kind: "system_derived",
        label: "Document extraction proposal",
        actorPersonId: input.actorPersonId,
        actorName: "Caretaker Relay",
        recordedAt: now,
        whyVisible: "AI/heuristic proposal — not confirmed care truth",
      },
    });
  }

  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "DOCUMENT_INGESTED",
    careRecipientId: input.careRecipientId,
    details: {
      documentId: document.id,
      classification,
      proposalCount: proposals.length,
    },
  });
  return { ok: true, document, proposals };
}

function extractProposals(doc: DocumentRecord): ProposedAction[] {
  const proposals: ProposedAction[] = [];
  const body = doc.body;
  const dateMatch = body.match(
    /\b((?:mon|tues|wednes|thurs|fri|satur|sun)day|tomorrow|friday|monday|next week)[^.!?\n]{0,40}/i,
  );
  if (dateMatch) {
    proposals.push({
      id: `prop-sched-${doc.id}`,
      kind: "schedule",
      title: "Proposed schedule item from document",
      detail: dateMatch[0].trim(),
      confidence: "medium",
      sourceExcerpt: dateMatch[0].trim().slice(0, 120),
      status: "proposed",
    });
  }
  if (/medication|dose|mg|tablet|prescription/i.test(body)) {
    proposals.push({
      id: `prop-work-${doc.id}`,
      kind: "work_item",
      title: "Review medication instruction from document",
      detail: "Confirm with authorized caregiver before changing the plan",
      confidence: "medium",
      sourceExcerpt: body.slice(0, 120),
      status: "proposed",
    });
  }
  if (/conflict|mismatch|disagre|wrong dose/i.test(body)) {
    proposals.push({
      id: `prop-conf-${doc.id}`,
      kind: "conflict",
      title: "Possible conflict mentioned in document",
      detail: "Open conflict center only after human confirmation",
      confidence: "low",
      sourceExcerpt: body.slice(0, 120),
      status: "proposed",
    });
  }
  if (proposals.length === 0) {
    proposals.push({
      id: `prop-note-${doc.id}`,
      kind: "note",
      title: "File document for care circle awareness",
      detail: "No structured actions detected — keep as reference",
      confidence: "low",
      sourceExcerpt: body.slice(0, 80),
      status: "proposed",
    });
  }
  return proposals;
}

export function confirmDocumentProposal(
  store: CareStore,
  input: {
    careRecipientId: string;
    actorPersonId: string;
    actorDisplayName: string;
    proposalId: string;
    decision: "confirm" | "reject";
  },
):
  | { ok: true; result: string }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  let proposal: ProposedAction | null = null;
  let documentId = "";
  for (const u of store.getUpdates(input.careRecipientId)) {
    if (!u.summary.startsWith(PROP_PREFIX)) continue;
    try {
      const raw = JSON.parse(u.summary.slice(PROP_PREFIX.length)) as ProposedAction & {
        documentId?: string;
      };
      if (raw.id === input.proposalId) {
        proposal = raw;
        documentId = raw.documentId ?? "";
        break;
      }
    } catch {
      /* skip */
    }
  }
  if (!proposal) {
    return { ok: false, code: "NOT_FOUND", message: "Proposal not found" };
  }
  if (input.decision === "reject") {
    store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: input.actorPersonId,
      action: "DOCUMENT_PROPOSAL_REJECTED",
      careRecipientId: input.careRecipientId,
      details: { proposalId: input.proposalId, documentId },
    });
    return { ok: true, result: "Proposal rejected — original document preserved" };
  }

  if (proposal.kind === "work_item") {
    const w = createWorkItem(store, {
      careRecipientId: input.careRecipientId,
      actorPersonId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      action: proposal.title,
      reason: `From document ${documentId}: ${proposal.detail}`,
      evidenceKind: "report",
    });
    if (!w.ok) return { ok: false, code: w.code, message: w.message };
    return {
      ok: true,
      result: `Work item created (${w.item.id}) — requires ownership`,
    };
  }
  if (proposal.kind === "schedule") {
    const starts = new Date(Date.now() + 3 * 24 * 3600_000).toISOString();
    const s = upsertScheduleItem(store, {
      careRecipientId: input.careRecipientId,
      actorPrincipalId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      title: proposal.detail.slice(0, 80) || "Document-derived appointment",
      startsAt: starts,
      startsAtLabel: "Proposed from document — not provider-confirmed",
      scheduleState: "requested",
    });
    if (!s.ok) return { ok: false, code: s.code, message: s.message };
    return {
      ok: true,
      result: `Schedule item proposed (${s.appointment.id}) — internal only until provider confirms`,
    };
  }
  if (proposal.kind === "conflict") {
    openMedicationMismatch(store, {
      careRecipientId: input.careRecipientId,
      actorPersonId: input.actorPersonId,
      actorDisplayName: input.actorDisplayName,
      medicationName: "Document-reported medication",
      reportedAmount: "see document",
      planAmount: "see plan",
    });
    return { ok: true, result: "Conflict opened for human resolution" };
  }
  return { ok: true, result: "Document retained as reference note" };
}
