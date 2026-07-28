/**
 * Governed schedule proposals — handoff/schedule language never mutates
 * appointments silently. Authorized human must confirm or reject.
 * Durable via CareUpdate CARE_SCHED_PROPOSAL_V1 (no schema migration).
 */

import type { CareStore } from "../store/memory-store.js";
import { evaluateAccess } from "./access.js";
import { createNotificationIfNew } from "./notifications.js";
import { reconcileTransportAfterAppointment } from "./care-work-items.js";

export type ScheduleProposalStatus =
  | "proposed"
  | "confirmed"
  | "rejected"
  | "cancelled";

export type ScheduleProposal = {
  id: string;
  careRecipientId: string;
  handoffId?: string | null;
  sourceText: string;
  proposedTitle: string;
  proposedStartsAtLabel: string;
  proposedStartsAt?: string | null;
  replacesAppointmentId?: string | null;
  status: ScheduleProposalStatus;
  createdByPersonId: string;
  createdByDisplayName: string;
  confirmedByPersonId?: string | null;
  confirmedAt?: string | null;
  rejectedByPersonId?: string | null;
  rejectedAt?: string | null;
  rejectionReason?: string | null;
  resultingAppointmentId?: string | null;
  createdAt: string;
  updatedAt: string;
};

const PREFIX = "CARE_SCHED_PROPOSAL_V1:";

function encode(p: ScheduleProposal): string {
  return PREFIX + JSON.stringify(p);
}

function decode(summary: string): ScheduleProposal | null {
  if (!summary.startsWith(PREFIX)) return null;
  try {
    return JSON.parse(summary.slice(PREFIX.length)) as ScheduleProposal;
  } catch {
    return null;
  }
}

function save(store: CareStore, p: ScheduleProposal): ScheduleProposal {
  store.addUpdate({
    id: p.id,
    careRecipientId: p.careRecipientId,
    toPersonId: "care-circle",
    summary: encode(p),
    status: p.status === "proposed" ? "ready" : "sent",
    safetyClass: "moderate",
    source: {
      id: `src-sched-prop-${p.id}`,
      kind: "system_derived",
      label: "Schedule proposal (requires confirmation)",
      actorPersonId: p.createdByPersonId,
      actorName: p.createdByDisplayName,
      recordedAt: p.updatedAt,
      whyVisible:
        "Handoff schedule language is a proposal until an authorized person confirms",
    },
  });
  return p;
}

export function listScheduleProposals(
  store: CareStore,
  careRecipientId: string,
  opts?: { includeTerminal?: boolean },
): ScheduleProposal[] {
  const byId = new Map<string, ScheduleProposal>();
  for (const u of store.getUpdates(careRecipientId)) {
    const p = decode(u.summary);
    if (p) byId.set(p.id, p);
  }
  let rows = [...byId.values()];
  if (!opts?.includeTerminal) {
    rows = rows.filter((p) => p.status === "proposed");
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Extract schedule-like lines from handoff text into proposals (not appointments). */
export function extractScheduleProposalsFromHandoff(
  store: CareStore,
  input: {
    careRecipientId: string;
    handoffId: string;
    actorPersonId: string;
    actorDisplayName: string;
    whatChanged: string[];
    stillNeedsAttention?: string[];
  },
): ScheduleProposal[] {
  const lines = [
    ...input.whatChanged,
    ...(input.stillNeedsAttention ?? []),
  ];
  const out: ScheduleProposal[] = [];
  const existing = listScheduleProposals(store, input.careRecipientId, {
    includeTerminal: true,
  });
  const apts = store.getAppointments(input.careRecipientId);
  const current =
    apts.find((a) => a.status !== "cancelled" && a.scheduleState !== "cancelled") ??
    apts[0];

  for (const line of lines) {
    if (
      !/reschedul|moved to|move (to|the)|new time|later slot|earlier slot|appointment.*(change|update)|therapy.*(reschedul|moved)|pt\s+(to|at)/i.test(
        line,
      )
    ) {
      continue;
    }
    if (
      existing.some(
        (p) =>
          p.handoffId === input.handoffId &&
          p.sourceText === line &&
          p.status === "proposed",
      )
    ) {
      continue;
    }
    const now = new Date().toISOString();
    const prop: ScheduleProposal = {
      id: store.newId("sprop"),
      careRecipientId: input.careRecipientId,
      handoffId: input.handoffId,
      sourceText: line,
      proposedTitle: /therapy|pt\b|physical/i.test(line)
        ? "Physical therapy (proposed reschedule)"
        : /clinic|doctor|provider/i.test(line)
          ? "Clinic visit (proposed reschedule)"
          : "Appointment (proposed change)",
      proposedStartsAtLabel: /later/i.test(line)
        ? "Later slot (exact time needs confirmation)"
        : /earlier/i.test(line)
          ? "Earlier slot (exact time needs confirmation)"
          : "Time proposed in handoff — confirm exact time",
      proposedStartsAt: null,
      replacesAppointmentId: current?.id ?? null,
      status: "proposed",
      createdByPersonId: input.actorPersonId,
      createdByDisplayName: input.actorDisplayName,
      createdAt: now,
      updatedAt: now,
    };
    save(store, prop);
    out.push(prop);
    for (const rel of store.getRelationships(input.careRecipientId)) {
      if (rel.status !== "active") continue;
      createNotificationIfNew(store, {
        principalId: rel.personId,
        careRecipientId: input.careRecipientId,
        type: "CARE_UPDATE",
        priority: "attention",
        title: "Schedule change needs confirmation",
        body: `${line} · Not applied until confirmed.`,
        sourceType: "schedule_proposal",
        sourceId: prop.id,
        actorPersonId: input.actorPersonId,
        actorDisplayName: input.actorDisplayName,
        actionType: "open_schedule_proposal",
        actionTarget: prop.id,
        dedupeKey: `sched-prop:${prop.id}:${rel.personId}`,
      });
    }
  }
  return out;
}

export function confirmScheduleProposal(
  store: CareStore,
  input: {
    careRecipientId: string;
    proposalId: string;
    actorPersonId: string;
    actorDisplayName: string;
    confirmedStartsAt?: string;
    confirmedStartsAtLabel?: string;
  },
):
  | { ok: true; proposal: ScheduleProposal; appointmentId: string }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const prop = listScheduleProposals(store, input.careRecipientId, {
    includeTerminal: true,
  }).find((p) => p.id === input.proposalId);
  if (!prop) {
    return { ok: false, code: "NOT_FOUND", message: "Proposal not found" };
  }
  if (prop.status !== "proposed") {
    return {
      ok: false,
      code: "NOT_PROPOSED",
      message: `Proposal is already ${prop.status}`,
    };
  }
  const now = new Date().toISOString();
  const startsAt =
    input.confirmedStartsAt ??
    new Date(Date.now() + 24 * 3600e3).toISOString();
  const startsAtLabel =
    input.confirmedStartsAtLabel ??
    prop.proposedStartsAtLabel ??
    "Confirmed reschedule";

  // Supersede old appointment as next
  if (prop.replacesAppointmentId) {
    const old = store
      .getAppointments(input.careRecipientId)
      .find((a) => a.id === prop.replacesAppointmentId);
    if (old) {
      store.upsertAppointment({
        ...old,
        status: "cancelled",
        scheduleState: "cancelled",
        title: `${old.title} (superseded)`,
      });
    }
  }

  const aptId = store.newId("apt");
  const title = prop.proposedTitle.replace(/\s*\(proposed[^)]*\)/i, "").trim();
  store.upsertAppointment({
    id: aptId,
    careRecipientId: input.careRecipientId,
    title,
    startsAt,
    startsAtLabel,
    status: "scheduled",
    scheduleState: "confirmed",
    epistemicStatus: "CONFIRMED",
    rescheduledFromId: prop.replacesAppointmentId ?? undefined,
    changeSource: `schedule_proposal:${prop.id}`,
  });

  // Durable reminder reconciliation (old superseded; new active)
  const REM_PREFIX = "CARE_REMINDER_V1:";
  for (const u of store.getUpdates(input.careRecipientId)) {
    if (!u.summary?.startsWith(REM_PREFIX)) continue;
    try {
      const rem = JSON.parse(u.summary.slice(REM_PREFIX.length)) as {
        id: string;
        appointmentId?: string;
        status?: string;
        title?: string;
      };
      if (
        rem.appointmentId === prop.replacesAppointmentId ||
        /physical therapy|pt\b|appointment/i.test(rem.title ?? "")
      ) {
        store.addUpdate({
          ...u,
          summary:
            REM_PREFIX +
            JSON.stringify({
              ...rem,
              status: "superseded",
              supersededBy: aptId,
              supersededAt: now,
            }),
          status: "sent",
        });
      }
    } catch {
      /* skip */
    }
  }
  const leaveBy = new Date(Date.parse(startsAt) - 30 * 60e3).toISOString();
  const remId = store.newId("rem");
  store.addUpdate({
    id: remId,
    careRecipientId: input.careRecipientId,
    toPersonId: "care-circle",
    summary:
      REM_PREFIX +
      JSON.stringify({
        id: remId,
        kind: "appointment",
        appointmentId: aptId,
        title: `${title} reminder`,
        whenLabel: startsAtLabel,
        leaveByLabel: `Leave by ~${new Date(leaveBy).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
        status: "active",
        createdAt: now,
      }),
    status: "ready",
    safetyClass: "moderate",
    source: {
      id: `src-rem-${remId}`,
      kind: "system_derived",
      label: "Reminder after confirmed schedule change",
      actorPersonId: input.actorPersonId,
      actorName: input.actorDisplayName,
      recordedAt: now,
      whyVisible: "Governed appointment confirmation reconciled reminders",
    },
  });

  // Transportation / open work due times follow the confirmed appointment
  reconcileTransportAfterAppointment(store, {
    careRecipientId: input.careRecipientId,
    actorPersonId: input.actorPersonId,
    actorDisplayName: input.actorDisplayName,
    appointmentId: aptId,
    startsAt,
    startsAtLabel,
  });

  const next: ScheduleProposal = {
    ...prop,
    status: "confirmed",
    confirmedByPersonId: input.actorPersonId,
    confirmedAt: now,
    proposedStartsAt: startsAt,
    proposedStartsAtLabel: startsAtLabel,
    resultingAppointmentId: aptId,
    updatedAt: now,
  };
  save(store, next);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "SCHEDULE_PROPOSAL_CONFIRMED",
    careRecipientId: input.careRecipientId,
    details: {
      proposalId: prop.id,
      appointmentId: aptId,
      superseded: prop.replacesAppointmentId,
      reminders_reconciled: true,
      transport_reconciled: true,
    },
  });
  createNotificationIfNew(store, {
    principalId: input.actorPersonId,
    careRecipientId: input.careRecipientId,
    type: "CARE_UPDATE",
    priority: "attention",
    title: "Schedule confirmed",
    body: `${title} · ${startsAtLabel}. Transportation and reminders updated.`,
    sourceType: "schedule_proposal",
    sourceId: prop.id,
    actorPersonId: input.actorPersonId,
    actorDisplayName: input.actorDisplayName,
    actionType: "open_schedule",
    actionTarget: aptId,
    dedupeKey: `sched-confirmed:${aptId}`,
  });
  return { ok: true, proposal: next, appointmentId: aptId };
}

export function rejectScheduleProposal(
  store: CareStore,
  input: {
    careRecipientId: string;
    proposalId: string;
    actorPersonId: string;
    actorDisplayName: string;
    reason?: string;
  },
):
  | { ok: true; proposal: ScheduleProposal }
  | { ok: false; code: string; message: string } {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const prop = listScheduleProposals(store, input.careRecipientId, {
    includeTerminal: true,
  }).find((p) => p.id === input.proposalId);
  if (!prop) {
    return { ok: false, code: "NOT_FOUND", message: "Proposal not found" };
  }
  if (prop.status !== "proposed") {
    return {
      ok: false,
      code: "NOT_PROPOSED",
      message: `Proposal is already ${prop.status}`,
    };
  }
  const now = new Date().toISOString();
  const next: ScheduleProposal = {
    ...prop,
    status: "rejected",
    rejectedByPersonId: input.actorPersonId,
    rejectedAt: now,
    rejectionReason: input.reason ?? "Rejected",
    updatedAt: now,
  };
  save(store, next);
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "SCHEDULE_PROPOSAL_REJECTED",
    careRecipientId: input.careRecipientId,
    details: { proposalId: prop.id, reason: next.rejectionReason },
  });
  return { ok: true, proposal: next };
}
