/**
 * Ambient care OS — ETL, role projection, schedule, actions, ICS.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  createCareRuntime,
  ingestCareEvent,
  buildTimeline,
  buildRoleProjection,
  upsertScheduleItem,
  transitionSchedule,
  buildIcsCalendar,
  calendarOAuthStatus,
  proposeCareAction,
  executeCareAction,
  listProposedActions,
  isConsequentialAction,
  people,
} from "@caretaker-relay/care-domain";

describe("ambient care OS loop", () => {
  let store: ReturnType<typeof createCareRuntime>["store"];

  beforeEach(() => {
    ({ store } = createCareRuntime({ seedOlivia: true, mode: "fixture" }));
  });

  it("ingests family report with provenance and timeline", () => {
    const r = ingestCareEvent(store, {
      careRecipientId: "cr-olivia",
      actorPrincipalId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      actorActiveRole: "family_primary",
      sourceKind: "family_report",
      type: "observation",
      title: "Ate lunch",
      statement: "Evelyn ate most of her lunch and drank water.",
      eventAt: "2026-07-26T19:00:00Z",
      reportAt: "2026-07-26T19:05:00Z",
      confidenceLabel: "reported",
      truthState: "reported",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.actorPrincipalId).toBe(people.sadeil.id);
    expect(r.event.eventAt).toBe("2026-07-26T19:00:00Z");
    expect(r.event.reportAt).toBe("2026-07-26T19:05:00Z");
    expect(r.event.dedupeKey).toBeTruthy();
    expect(r.deduped).toBe(false);
    const tl = buildTimeline(store, "cr-olivia");
    expect(tl.some((e) => e.id === r.event.id)).toBe(true);
  });

  it("dedupes identical ingest", () => {
    const input = {
      careRecipientId: "cr-olivia",
      actorPrincipalId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      sourceKind: "family_report" as const,
      type: "observation" as const,
      title: "Mood",
      statement: "Calm afternoon",
      eventAt: "2026-07-26T20:00:00Z",
      idempotencyKey: "mood-1",
    };
    const a = ingestCareEvent(store, input);
    const b = ingestCareEvent(store, input);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.deduped).toBe(true);
      expect(b.event.id).toBe(a.event.id);
    }
  });

  it("denies ingest without relationship", () => {
    const r = ingestCareEvent(store, {
      careRecipientId: "cr-olivia",
      actorPrincipalId: people.unauthorized.id,
      actorDisplayName: "Unauthorized",
      sourceKind: "family_report",
      type: "observation",
      title: "Nope",
      statement: "Should not land",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toMatch(/NO_RELATIONSHIP|REVOKED|EXPIRED/);
  });

  it("DSP projection is shift-scoped (no clinical domain dump)", () => {
    ingestCareEvent(store, {
      careRecipientId: "cr-olivia",
      actorPrincipalId: people.walter.id,
      actorDisplayName: people.walter.displayName,
      actorActiveRole: "dsp",
      sourceKind: "dsp_shift",
      type: "shift_observation",
      title: "Mobility",
      statement: "Steady with walker this shift",
    });
    const proj = buildRoleProjection(store, people.walter.id, "cr-olivia");
    expect(proj.ok).toBe(true);
    if (!proj.ok) return;
    expect(proj.projection.role).toBe("dsp");
    expect(proj.projection.shift?.assignmentActive).toBe(true);
    expect(proj.projection.priorities[0]).toMatch(/Shift/i);
  });

  it("clinician projection emphasizes evidence", () => {
    const proj = buildRoleProjection(store, people.drShah.id, "cr-olivia");
    expect(proj.ok).toBe(true);
    if (!proj.ok) return;
    expect(proj.projection.role).toBe("clinician");
    expect(proj.projection.clinical).toBeTruthy();
  });

  it("family projection has operational priorities", () => {
    const proj = buildRoleProjection(store, people.sadeil.id, "cr-olivia");
    expect(proj.ok).toBe(true);
    if (!proj.ok) return;
    expect(proj.projection.role).toBe("family_friend");
    expect(proj.projection.today).toBeTruthy();
  });

  it("schedule create + reschedule + ics", () => {
    const created = upsertScheduleItem(store, {
      careRecipientId: "cr-olivia",
      actorPrincipalId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      title: "Physical therapy",
      startsAt: "2026-07-28T20:00:00Z",
      startsAtLabel: "Monday 1:00 PM",
      location: "North County PT",
      scheduleState: "confirmed",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const moved = transitionSchedule(store, {
      careRecipientId: "cr-olivia",
      appointmentId: created.appointment.id,
      actorPrincipalId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      scheduleState: "rescheduled",
      newStartsAt: "2026-07-28T21:00:00Z",
      newStartsAtLabel: "Monday 2:00 PM",
    });
    expect(moved.ok).toBe(true);
    const ics = buildIcsCalendar(store, "cr-olivia");
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("Physical therapy");
    expect(ics).toContain("BEGIN:VEVENT");
  });

  it("consequential actions require confirmation then execute", () => {
    expect(isConsequentialAction("notify_helpers")).toBe(true);
    const prop = proposeCareAction(store, {
      careRecipientId: "cr-olivia",
      actorPrincipalId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      type: "notify_helpers",
      title: "Heads up",
      summary: "PT moved to 2pm",
      payload: { body: "PT moved to 2pm" },
    });
    expect(prop.ok).toBe(true);
    if (!prop.ok) return;
    expect(prop.requiresConfirmation).toBe(true);
    expect(prop.action.status).toBe("proposed");
    const done = executeCareAction(store, {
      careRecipientId: "cr-olivia",
      actionId: prop.action.id,
      actorPrincipalId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      decision: "approve",
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.action.status).toBe("executed");
    expect(listProposedActions(store, "cr-olivia").length).toBeGreaterThan(0);
  });

  it("shift handoff action produces handoff event", () => {
    const prop = proposeCareAction(store, {
      careRecipientId: "cr-olivia",
      actorPrincipalId: people.walter.id,
      actorDisplayName: people.walter.displayName,
      type: "complete_shift_handoff",
      title: "Shift handoff",
      summary: "Ate well; next med at 6pm",
      payload: {
        whatChanged: ["Ate well"],
        stillNeedsAttention: ["Evening med"],
      },
    });
    expect(prop.ok).toBe(true);
    if (!prop.ok) return;
    const done = executeCareAction(store, {
      careRecipientId: "cr-olivia",
      actionId: prop.action.id,
      actorPrincipalId: people.walter.id,
      actorDisplayName: people.walter.displayName,
      decision: "approve",
    });
    expect(done.ok).toBe(true);
    const hos = store.getHandoffs("cr-olivia");
    expect(hos.length).toBeGreaterThan(0);
  });

  it("calendar oauth is honest when unconfigured", () => {
    const st = calendarOAuthStatus();
    expect(st.mode === "unavailable" || st.mode === "live").toBe(true);
    if (!st.configured) {
      expect(st.message.toLowerCase()).toMatch(/not configured|ics|internal/);
    }
  });

  it("external booking never faked", () => {
    const r = proposeCareAction(store, {
      careRecipientId: "cr-olivia",
      actorPrincipalId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      type: "book_external",
      title: "Book specialist",
      summary: "Should fail honestly",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EXTERNAL_UNAVAILABLE");
  });
});
