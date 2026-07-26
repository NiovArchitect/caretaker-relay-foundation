/**
 * Role-projected server data — enforced before response / Relay retrieval.
 * Never dump full state and ask the LLM to hide fields.
 */

import type { CareStore } from "../store/memory-store.js";
import type {
  Appointment,
  CareEvent,
  CareHandoff,
  CareRelationship,
  CareRelationshipRole,
  CareTask,
  CurrentCareState,
  MedicationAdministrationRecord,
  Observation,
} from "../types.js";
import {
  projectCurrentState,
  resolveDomainCapabilities,
  type DomainCapabilities,
} from "./minimum-necessary.js";
import { buildTimeline } from "./care-event-etl.js";
import { listReminders } from "./reminders.js";
import { listNotificationsForPrincipal } from "./notifications.js";
import { listCoverage } from "./care-coverage.js";

export type ProjectionRole =
  | "family_friend"
  | "care_recipient"
  | "dsp"
  | "clinician"
  | "invited"
  | "unknown";

export function mapRelationshipToProjectionRole(
  role: CareRelationshipRole | string | undefined,
  actorPersonId: string,
  careRecipientId: string,
): ProjectionRole {
  if (actorPersonId === careRecipientId) return "care_recipient";
  const r = (role ?? "").toLowerCase();
  if (
    /dsp|direct_support|paid_caregiver|professional|nurse/.test(r)
  ) {
    return "dsp";
  }
  if (/physician|clinician|provider|therapist/.test(r)) return "clinician";
  if (/friend|neighbor|invited/.test(r)) return "family_friend";
  if (/spouse|parent|adult_child|sibling|family|care_coordinator|other/.test(r)) {
    return "family_friend";
  }
  return "unknown";
}

export function resolveActiveProjectionRole(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
): { role: ProjectionRole; relationship?: CareRelationship } {
  if (actorPersonId === careRecipientId) {
    return { role: "care_recipient" };
  }
  const rel = store.getRelationship(careRecipientId, actorPersonId);
  if (!rel || rel.status !== "active") {
    return { role: "unknown" };
  }
  return {
    role: mapRelationshipToProjectionRole(
      rel.role,
      actorPersonId,
      careRecipientId,
    ),
    relationship: rel,
  };
}

export type RoleCareProjection = {
  role: ProjectionRole;
  careRecipientId: string;
  recipientName: string;
  orientation: string;
  priorities: string[];
  today: {
    whatChanged: string[];
    unresolved: string[];
    upcoming: string[];
    whoHelping: string[];
    overdue: string[];
  };
  schedule: Appointment[];
  tasks: CareTask[];
  events: CareEvent[];
  observations: Observation[];
  handoffs: CareHandoff[];
  medicationRecords: MedicationAdministrationRecord[];
  reminders: Array<{ id: string; title: string; scheduledAt: string; type: string }>;
  notifications: Array<{ id: string; title: string; body: string; type: string }>;
  coverage: string[];
  conflicts: Array<{ eventId: string; conflictWithIds: string[] }>;
  pendingApprovals: Array<{ id: string; title: string; kind: string }>;
  redacted_domains: string[];
  shift?: {
    assignmentActive: boolean;
    roleLabel: string;
    scheduleNotes?: string;
    briefing: string[];
  };
  clinical?: {
    trends: string[];
    reportedVsConfirmed: Array<{ statement: string; truth: string }>;
    openQuestions: string[];
  };
  privacy?: {
    helpers: Array<{ personId: string; roleLabel: string; status: string }>;
    accessNote: string;
  };
  /** State bag for Relay retrieval (already role-filtered). */
  relayState: CurrentCareState;
};

function roleFilterEvents(
  events: CareEvent[],
  role: ProjectionRole,
): CareEvent[] {
  if (role === "dsp") {
    // Shift-relevant: last 36h + tasks/observations/handoffs
    const cutoff = Date.now() - 36 * 60 * 60 * 1000;
    return events.filter((e) => {
      if (e.type === "clinical_note") return false;
      if (e.dataDomain === "clinical_documents") return false;
      if (e.dataDomain === "access_records") return false;
      const t = Date.parse(e.eventAt ?? e.occurredAt);
      if (!Number.isNaN(t) && t < cutoff && e.type !== "handoff" && e.type !== "task") {
        return false;
      }
      return true;
    });
  }
  if (role === "clinician") {
    return events.filter(
      (e) =>
        e.type === "clinical_note" ||
        e.type === "observation" ||
        e.type === "medication_administration" ||
        e.type === "appointment_change" ||
        e.type === "correction" ||
        e.type === "incident" ||
        e.truthState === "confirmed" ||
        e.epistemicStatus === "CONFIRMED" ||
        e.epistemicStatus === "REPORTED",
    );
  }
  if (role === "care_recipient") {
    return events.filter(
      (e) =>
        e.type !== "clinical_note" ||
        e.actorPrincipalId === e.careRecipientId,
    );
  }
  return events;
}

/**
 * Build role-projected care surface for an authorized principal.
 * Caller must already authorize membership.
 */
export function buildRoleProjection(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
):
  | { ok: true; projection: RoleCareProjection }
  | { ok: false; code: string; message: string } {
  const caps = resolveDomainCapabilities(store, actorPersonId, careRecipientId);
  if ("denied" in caps && caps.denied) {
    return { ok: false, code: caps.code, message: caps.reason };
  }

  const { role, relationship } = resolveActiveProjectionRole(
    store,
    actorPersonId,
    careRecipientId,
  );
  const recipient = store.getRecipient(careRecipientId);
  const raw = store.getCurrentState(careRecipientId) ?? {
    careRecipientId,
    householdId: recipient?.householdId ?? "",
    events: store.getEvents(careRecipientId),
    observations: store.getObservations(careRecipientId),
    appointments: store.getAppointments(careRecipientId),
    tasks: store.getTasks(careRecipientId),
    medicationRecords: store.getMedRecords(careRecipientId),
    medicationSchedules: store.getMedSchedules(careRecipientId),
    handoffs: store.getHandoffs(careRecipientId),
    openSafetyReviews: store.getSafetyReviews(careRecipientId).filter(
      (s) => s.status === "open",
    ),
    lastUpdatedAt: new Date().toISOString(),
  };

  const projected = projectCurrentState(raw, caps as DomainCapabilities);
  const timeline = roleFilterEvents(
    buildTimeline(store, careRecipientId, { limit: 80 }),
    role,
  );

  const whatChanged = timeline.slice(0, 8).map((e) => e.statement);
  const unresolved = projected.tasks
    .filter((t) => t.status === "pending" || t.status === "in_progress")
    .map((t) => t.title);
  const upcoming = projected.appointments
    .filter((a) => a.status === "scheduled" || a.status === "moved")
    .slice(0, 5)
    .map((a) => `${a.title} · ${a.startsAtLabel ?? a.startsAt}`);
  const helpers = store
    .getRelationships(careRecipientId)
    .filter((r) => r.status === "active")
    .map((r) => r.roleLabel || r.role);
  const overdue = projected.tasks
    .filter((t) => {
      if (t.status === "done" || t.status === "cancelled") return false;
      if (!t.dueAt) return false;
      return Date.parse(t.dueAt) < Date.now();
    })
    .map((t) => t.title);

  const conflicts = timeline
    .filter((e) => (e.conflictWithIds?.length ?? 0) > 0)
    .map((e) => ({
      eventId: e.id,
      conflictWithIds: e.conflictWithIds ?? [],
    }));

  const reminders = listReminders(store, careRecipientId).map((r) => ({
    id: r.id,
    title: r.title,
    scheduledAt: r.scheduledAt,
    type: r.type,
  }));

  const notifications = listNotificationsForPrincipal(
    store,
    actorPersonId,
    careRecipientId,
  )
    .filter((n) => !n.resolvedAt)
    .slice(0, 20)
    .map((n) => ({
      id: n.id,
      title: n.title,
      body: n.body,
      type: n.type,
    }));

  let coverage: string[] = [];
  try {
    coverage = listCoverage(store, careRecipientId).map(
      (c) =>
        `${c.personDisplayName} · ${c.roleLabel} (${c.phase})${
          c.notes ? `: ${c.notes}` : ""
        }`,
    );
  } catch {
    coverage = helpers;
  }

  const baseRelay: CurrentCareState = {
    ...projected,
    events: timeline,
    observations:
      role === "dsp"
        ? projected.observations.slice(-10)
        : projected.observations,
    handoffs: projected.handoffs.slice(0, 3),
  };

  const orientation =
    role === "dsp"
      ? "Shift-scoped view: assigned tasks, recent observations, and handoff only."
      : role === "clinician"
        ? "Evidence-linked clinical summary with provenance. Not care-circle administration."
        : role === "care_recipient"
          ? "Your schedule, helpers, and privacy — on your terms."
          : "Today’s operational priorities, what changed, and who helps next.";

  const priorities =
    role === "dsp"
      ? ["Shift priorities", "Required tasks", "Observations", "Handoff"]
      : role === "clinician"
        ? ["Recent changes", "Medications", "Observations", "Open questions"]
        : role === "care_recipient"
          ? ["My schedule", "Who is helping", "Preferences", "Privacy"]
          : [
              "What needs you",
              "Appointments & transport",
              "Meals, mobility, mood",
              "Who is helping next",
            ];

  const projection: RoleCareProjection = {
    role,
    careRecipientId,
    recipientName: recipient?.displayName ?? careRecipientId,
    orientation,
    priorities,
    today: {
      whatChanged,
      unresolved,
      upcoming,
      whoHelping: helpers,
      overdue,
    },
    schedule: projected.appointments,
    tasks: projected.tasks,
    events: timeline,
    observations: baseRelay.observations,
    handoffs: projected.handoffs,
    medicationRecords: projected.medicationRecords,
    reminders,
    notifications,
    coverage,
    conflicts,
    pendingApprovals: projected.openSafetyReviews.map((s) => ({
      id: s.id,
      title: s.reason,
      kind: "safety_review",
    })),
    redacted_domains: projected.redacted_domains as string[],
    relayState: baseRelay,
  };

  if (role === "dsp" && relationship) {
    projection.shift = {
      assignmentActive: relationship.status === "active",
      roleLabel: relationship.roleLabel,
      scheduleNotes: relationship.scheduleNotes,
      briefing: [
        ...whatChanged.slice(0, 3),
        ...unresolved.slice(0, 3),
        ...upcoming.slice(0, 2),
      ],
    };
  }

  if (role === "clinician") {
    projection.clinical = {
      trends: whatChanged.slice(0, 6),
      reportedVsConfirmed: timeline.slice(0, 10).map((e) => ({
        statement: e.statement,
        truth: e.truthState ?? e.epistemicStatus,
      })),
      openQuestions: unresolved,
    };
  }

  if (role === "care_recipient") {
    projection.privacy = {
      helpers: store
        .getRelationships(careRecipientId)
        .map((r) => ({
          personId: r.personId,
          roleLabel: r.roleLabel,
          status: r.status,
        })),
      accessNote:
        "You control who can help. Revoke access any time from People / Access.",
    };
  }

  return { ok: true, projection };
}

/** Filter a state bag for Relay retrieval by active role. */
export function roleAwareRelayState(
  store: CareStore,
  actorPersonId: string,
  careRecipientId: string,
): CurrentCareState | undefined {
  const built = buildRoleProjection(store, actorPersonId, careRecipientId);
  if (!built.ok) return undefined;
  return built.projection.relayState;
}
