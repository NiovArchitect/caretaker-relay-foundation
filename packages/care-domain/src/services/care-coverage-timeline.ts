/**
 * Canonical CareCoverageTimeline — single server-owned previous/current/next coverage.
 * Consumers: Relay, Today, My Shift, handoffs, role-aware work filters.
 * No per-screen independent inference.
 */

import type { CareStore } from "../store/memory-store.js";
import { listShiftAssignments, type ShiftAssignment } from "./dsp-assignment.js";
import { listCoverage } from "./care-coverage.js";
import {
  getHandoffLifecycle,
  ensureHandoffLifecycle,
  type HandoffLifecycle,
} from "./handoff-lifecycle.js";
import { resolvePersonDisplayName } from "./identity-view.js";

export type CoverageType =
  | "scheduled_shift"
  | "ongoing_primary_family_coverage"
  | "temporary_family_coverage"
  | "professional_assignment"
  | "documentation_window"
  | "clinical_oversight"
  | "review_authority"
  | "care_team_membership"
  | "access_only"
  | "no_current_coverage";

export type CareCoverageParty = {
  coverage_id: string | null;
  caregiver_id: string | null;
  caregiver_name: string | null;
  role: string | null;
  start: string | null;
  end: string | null;
  status: string | null;
  coverage_type?: CoverageType;
  handoff_id?: string | null;
  handoff_status?: string | null;
  is_ongoing_primary_coverage?: boolean;
  documentation_window_end?: string | null;
  shift_id?: string | null;
};

export type CareCoverageTimeline = {
  tenant_id: string;
  care_space_id: string;
  recipient_id: string;
  recipient_timezone: string;
  principal_id: string;
  previous: CareCoverageParty;
  current: CareCoverageParty;
  next: CareCoverageParty;
  collaboration: {
    previous_contact_option: string | null;
    next_contact_option: string | null;
    current_outgoing_handoff_id: string | null;
    current_outgoing_handoff_status: string | null;
    next_acknowledgment_state: string | null;
    next_handoff_deadline: string | null;
  };
  authority: "server";
  built_at: string;
};

function emptyParty(): CareCoverageParty {
  return {
    coverage_id: null,
    caregiver_id: null,
    caregiver_name: null,
    role: null,
    start: null,
    end: null,
    status: null,
  };
}

function nameOf(store: CareStore, personId: string | null | undefined): string | null {
  if (!personId) return null;
  return resolvePersonDisplayName(store, personId);
}

function isTerminalShift(s: ShiftAssignment): boolean {
  return ["completed", "expired", "cancelled", "declined", "missed", "revoked", "replaced"].includes(
    s.status,
  );
}

function isActiveish(s: ShiftAssignment, now: number): boolean {
  if (["active", "accepted", "scheduled"].includes(s.status)) {
    const start = Date.parse(s.shiftStart);
    const end = Date.parse(s.shiftEnd);
    if (Number.isNaN(start) || Number.isNaN(end)) return s.status === "active";
    // Active window ± 15m documentation grace for "active"
    if (s.status === "active") return now <= end + 15 * 60e3;
    if (s.status === "scheduled" || s.status === "accepted") return start > now;
    return start <= now && now <= end;
  }
  return false;
}

function fromShift(
  store: CareStore,
  s: ShiftAssignment,
  type: CoverageType,
): CareCoverageParty {
  return {
    coverage_id: s.id,
    shift_id: s.id,
    caregiver_id: s.assigneePersonId,
    caregiver_name:
      s.assigneeDisplayName?.length > 1
        ? s.assigneeDisplayName
        : nameOf(store, s.assigneePersonId),
    role:
      /p-walter|paid|professional|dsp/i.test(
        `${s.assigneePersonId} ${s.assigneeDisplayName}`,
      )
        ? "professional_caregiver"
        : "caregiver",
    start: s.shiftStart,
    end: s.shiftEnd,
    status: s.status,
    coverage_type: type,
    handoff_id: s.handoffId ?? null,
  };
}

/**
 * Build the single canonical timeline for a principal viewing a recipient.
 */
export function buildCareCoverageTimeline(
  store: CareStore,
  careRecipientId: string,
  principalId: string,
): CareCoverageTimeline {
  const now = Date.now();
  const recipient = store.getRecipient(careRecipientId);
  const tenant =
    recipient?.householdId ??
    store.getRelationships(careRecipientId)?.[0]?.careRecipientId ??
    "hh-unknown";
  const tz =
    /Timezone preference:\s*([A-Za-z_/]+)/.exec(
      recipient?.profile?.dailyRoutineSummary ?? "",
    )?.[1] ?? "America/Los_Angeles";

  const shifts = listShiftAssignments(store, careRecipientId).filter(
    (s) => !["cancelled", "declined", "revoked"].includes(s.status),
  );
  const completed = shifts
    .filter((s) => s.status === "completed" || (isTerminalShift(s) && s.status !== "replaced"))
    .filter((s) => s.status === "completed")
    .sort((a, b) => Date.parse(b.shiftEnd) - Date.parse(a.shiftEnd));
  const upcoming = shifts
    .filter((s) => ["scheduled", "accepted", "invited"].includes(s.status))
    .filter((s) => Date.parse(s.shiftStart) > now - 5 * 60e3)
    .sort((a, b) => Date.parse(a.shiftStart) - Date.parse(b.shiftStart));
  const active = shifts
    .filter((s) => isActiveish(s, now))
    .sort((a, b) => Date.parse(b.shiftStart) - Date.parse(a.shiftStart));

  const rel = store.getRelationship(careRecipientId, principalId);
  const roleBlob = `${rel?.role ?? ""} ${rel?.roleLabel ?? ""} ${principalId}`;
  const isClinician =
    /physician|provider|clinician|doctor|reviewer|md\b|np\b/i.test(roleBlob) ||
    principalId === "p-dr-shah";
  const isProfessional =
    /professional|paid_caregiver|dsp|direct support/i.test(roleBlob) ||
    principalId === "p-walter";
  const isPrimaryFamily =
    !!rel &&
    rel.status === "active" &&
    !isClinician &&
    (/primary|family/i.test(`${rel.role} ${rel.roleLabel}`) ||
      (rel.access?.allowedActions ?? []).includes("*") ||
      (rel.access?.allowedActions ?? []).includes("control"));
  const isFamilyHelper =
    !!rel &&
    rel.status === "active" &&
    !isClinician &&
    !isProfessional &&
    /family|friend|adult_child/i.test(`${rel.role} ${rel.roleLabel}`);

  const slots = listCoverage(store, careRecipientId);
  // Next coverage slots must be direct-care helpers, never clinicians
  const slotNext = slots.find(
    (s) =>
      s.phase === "next" &&
      !/physician|provider|clinician|doctor/i.test(s.roleLabel ?? ""),
  );

  // PREVIOUS: latest completed *care* shift (not clinical review)
  let previous = emptyParty();
  if (completed[0]) {
    previous = fromShift(store, completed[0], "professional_assignment");
  }

  // CURRENT: role-correct typing — clinicians are not "covering a shift"
  let current = emptyParty();
  const myActive = active.find((s) => s.assigneePersonId === principalId);
  if (isClinician && !myActive) {
    current = {
      coverage_id: `clinical-${careRecipientId}-${principalId}`,
      caregiver_id: principalId,
      caregiver_name: nameOf(store, principalId),
      role: rel?.roleLabel ?? "Authorized clinical reviewer",
      start: null,
      end: null,
      status: "active",
      coverage_type: "clinical_oversight",
      is_ongoing_primary_coverage: false,
    };
  } else if (myActive) {
    current = fromShift(
      store,
      myActive,
      isProfessional ? "professional_assignment" : "scheduled_shift",
    );
    current.is_ongoing_primary_coverage = false;
    const end = Date.parse(myActive.shiftEnd);
    if (!Number.isNaN(end) && now > end) {
      current.coverage_type = "documentation_window";
      current.documentation_window_end = new Date(end + 30 * 60e3).toISOString();
    }
  } else if (isPrimaryFamily) {
    current = {
      coverage_id: `ongoing-${careRecipientId}-${principalId}`,
      caregiver_id: principalId,
      caregiver_name: nameOf(store, principalId),
      role: rel?.roleLabel ?? "Primary family caregiver",
      start: rel?.startDate ? `${rel.startDate}T00:00:00.000Z` : null,
      end: null,
      status: "active",
      coverage_type: "ongoing_primary_family_coverage",
      is_ongoing_primary_coverage: true,
    };
  } else if (isFamilyHelper) {
    current = {
      coverage_id: `family-${careRecipientId}-${principalId}`,
      caregiver_id: principalId,
      caregiver_name: nameOf(store, principalId),
      role: rel?.roleLabel ?? "Family caregiver",
      start: null,
      end: null,
      status: "active",
      coverage_type: "temporary_family_coverage",
      is_ongoing_primary_coverage: false,
    };
  } else if (isProfessional) {
    // DSP with relationship but no active formal shift
    current = {
      coverage_id: `prof-access-${careRecipientId}-${principalId}`,
      caregiver_id: principalId,
      caregiver_name: nameOf(store, principalId),
      role: rel?.roleLabel ?? "Professional caregiver",
      start: null,
      end: null,
      status: rel?.status ?? "active",
      coverage_type: "access_only",
      is_ongoing_primary_coverage: false,
    };
  } else if (rel?.status === "active") {
    current = {
      coverage_id: `member-${careRecipientId}-${principalId}`,
      caregiver_id: principalId,
      caregiver_name: nameOf(store, principalId),
      role: rel.roleLabel ?? "Care team member",
      start: null,
      end: null,
      status: "active",
      coverage_type: "care_team_membership",
      is_ongoing_primary_coverage: false,
    };
  } else {
    current = {
      ...emptyParty(),
      coverage_type: "no_current_coverage",
      status: "none",
    };
  }

  // NEXT: formal care shift or family coverage slot only — never clinicians
  let next = emptyParty();
  const nextShift = upcoming.find((s) => {
    if (s.assigneePersonId === principalId) return false;
    const r = store.getRelationship(careRecipientId, s.assigneePersonId);
    const blob = `${r?.role ?? ""} ${r?.roleLabel ?? ""} ${s.assigneePersonId}`;
    return !/physician|provider|clinician|doctor/i.test(blob);
  });
  if (nextShift) {
    const r = store.getRelationship(careRecipientId, nextShift.assigneePersonId);
    const prof = /professional|paid|dsp/i.test(
      `${r?.role ?? ""} ${r?.roleLabel ?? ""} ${nextShift.assigneePersonId}`,
    );
    next = fromShift(
      store,
      nextShift,
      prof ? "professional_assignment" : "scheduled_shift",
    );
  } else if (slotNext && slotNext.personId !== principalId) {
    next = {
      coverage_id: slotNext.id,
      caregiver_id: slotNext.personId,
      caregiver_name: slotNext.personDisplayName,
      role: slotNext.roleLabel,
      start: null,
      end: null,
      status: "planned",
      coverage_type: "temporary_family_coverage",
    };
  }

  // Handoffs: attach latest relevant lifecycle (not sender-as-previous-caregiver)
  const handoffs = store.getHandoffs(careRecipientId);
  const toMe = handoffs
    .filter((h) => h.toPersonId === principalId && h.fromPersonId !== principalId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const fromMe = handoffs
    .filter((h) => h.fromPersonId === principalId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  let prevLc: HandoffLifecycle | null = null;
  if (toMe[0]) {
    prevLc =
      getHandoffLifecycle(store, careRecipientId, toMe[0].id) ??
      ensureHandoffLifecycle(store, toMe[0], principalId);
    if (!previous.caregiver_id && toMe[0].fromPersonId) {
      // Only fill previous from handoff if no completed shift
      if (!previous.coverage_id) {
        previous = {
          coverage_id: `handoff-implied-${toMe[0].id}`,
          caregiver_id: toMe[0].fromPersonId,
          caregiver_name: nameOf(store, toMe[0].fromPersonId),
          role: "prior_helper",
          start: null,
          end: toMe[0].createdAt,
          status: prevLc.status,
          coverage_type: "professional_assignment",
          handoff_id: toMe[0].id,
          handoff_status: prevLc.status,
        };
      } else {
        previous.handoff_id = toMe[0].id;
        previous.handoff_status = prevLc.status;
      }
    } else if (previous.caregiver_id) {
      previous.handoff_id = toMe[0].id;
      previous.handoff_status = prevLc.status;
    }
  }

  let outLc: HandoffLifecycle | null = null;
  if (fromMe[0]) {
    outLc =
      getHandoffLifecycle(store, careRecipientId, fromMe[0].id) ??
      ensureHandoffLifecycle(store, fromMe[0], principalId);
  }

  return {
    tenant_id: tenant,
    care_space_id: careRecipientId,
    recipient_id: careRecipientId,
    recipient_timezone: tz,
    principal_id: principalId,
    previous,
    current,
    next,
    collaboration: {
      previous_contact_option: previous.caregiver_name
        ? `Ask ${previous.caregiver_name} about the prior coverage`
        : null,
      next_contact_option: next.caregiver_name
        ? `Notify ${next.caregiver_name} before coverage starts`
        : null,
      current_outgoing_handoff_id: fromMe[0]?.id ?? null,
      current_outgoing_handoff_status: outLc?.status ?? null,
      next_acknowledgment_state: outLc?.acknowledgedAt
        ? "acknowledged"
        : outLc?.status === "seen"
          ? "seen"
          : outLc
            ? "pending"
            : null,
      next_handoff_deadline: outLc?.deadlineAt ?? next.start,
    },
    authority: "server",
    built_at: new Date().toISOString(),
  };
}

/** Human answer blocks from timeline (Relay). */
export function formatPreviousCoverageAnswer(
  timeline: CareCoverageTimeline,
  recipientName: string,
): string {
  const p = timeline.previous;
  if (!p.caregiver_name && !p.caregiver_id) {
    return `I do not have a completed coverage period immediately before yours for ${recipientName}.`;
  }
  const name = p.caregiver_name ?? "The prior caregiver";
  const hours =
    p.start && p.end
      ? ` from ${formatLocal(p.start, timeline.recipient_timezone)} to ${formatLocal(p.end, timeline.recipient_timezone)}`
      : p.end
        ? ` ending around ${formatLocal(p.end, timeline.recipient_timezone)}`
        : "";
  const ho = p.handoff_status
    ? ` Their handoff is ${p.handoff_status.replace(/_/g, " ")}.`
    : "";
  return `${name} covered ${recipientName} before you${hours}.${ho}`.trim();
}

export function formatNextCoverageAnswer(
  timeline: CareCoverageTimeline,
  recipientName: string,
): string {
  const n = timeline.next;
  if (!n.caregiver_name && !n.caregiver_id) {
    return `No next caregiver is scheduled yet for ${recipientName}. Your current handoff will remain a draft until coverage is assigned.`;
  }
  // Never present clinical oversight as "next caregiver"
  if (
    n.coverage_type === "clinical_oversight" ||
    n.coverage_type === "review_authority"
  ) {
    return `No next caregiver is scheduled yet for ${recipientName}. A clinician may have review authority, but that is not care coverage.`;
  }
  const name = n.caregiver_name ?? "The next caregiver";
  if (n.start) {
    return `${name} is scheduled to begin at ${formatLocal(n.start, timeline.recipient_timezone)}.`;
  }
  return `${name} is listed as next coverage for ${recipientName}, but an exact start time is not on file yet.`;
}

function formatLocal(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
