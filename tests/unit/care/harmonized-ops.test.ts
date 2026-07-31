import { describe, it, expect, beforeEach } from "vitest";
import {
  createCareRuntime,
  people,
  createWorkItem,
  claimWorkItem,
  transitionWorkItem,
  listNeedsOwner,
  listWorkItems,
  escalateOverdueWork,
  buildSinceLastVisit,
  buildEmergencyCard,
  assertActiveRecipientContext,
  calendarTruthForAppointment,
  projectHandoffForRole,
  shiftBoundaryChecklist,
  createShiftAssignment,
  labelFromEpistemic,
} from "@caretaker-relay/care-domain";

describe("harmonized ambient care ops", () => {
  let store: ReturnType<typeof createCareRuntime>["store"];
  beforeEach(() => {
    ({ store } = createCareRuntime({ seedOlivia: true }));
  });

  it("creates unassigned work and supports claim → complete", () => {
    const created = createWorkItem(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      action: "Confirm PT appointment transport",
      reason: "Needs an owner before tomorrow",
      priority: "high",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.item.status).toBe("available_to_claim");
    expect(listNeedsOwner(store, "cr-olivia").length).toBeGreaterThan(0);

    const claimed = claimWorkItem(store, {
      careRecipientId: "cr-olivia",
      workItemId: created.item.id,
      actorPersonId: people.maya.id,
      actorDisplayName: people.maya.displayName,
    });
    expect(claimed.ok).toBe(true);
    if (!claimed.ok) return;
    expect(claimed.item.ownerPersonId).toBe(people.maya.id);
    // Product claim lifecycle uses "accepted" (assigned owner); "claimed" is legacy alias
    expect(["accepted", "claimed"]).toContain(claimed.item.status);

    const done = transitionWorkItem(store, {
      careRecipientId: "cr-olivia",
      workItemId: created.item.id,
      actorPersonId: people.maya.id,
      actorDisplayName: people.maya.displayName,
      status: "completed",
      completionEvidence: "Transport confirmed with sister",
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.item.status).toBe("completed");
    expect(
      listWorkItems(store, "cr-olivia").find((w) => w.id === created.item.id),
    ).toBeUndefined();
  });

  it("escalates overdue work without silent drop", () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const created = createWorkItem(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      action: "Evening medication check-in",
      reason: "No acknowledgment",
      dueAt: past,
      ownerPersonId: people.walter.id,
      ownerDisplayName: people.walter.displayName,
      backupOwnerPersonId: people.sadeil.id,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const escalated = escalateOverdueWork(
      store,
      "cr-olivia",
      people.sadeil.id,
      people.sadeil.displayName,
    );
    expect(escalated.length).toBeGreaterThan(0);
    expect(escalated[0]?.status).toBe("escalated");
  });

  it("builds since-last-visit and emergency card for authorized family", () => {
    createWorkItem(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      action: "Refill prescription",
      reason: "Needs owner",
    });
    const brief = buildSinceLastVisit(
      store,
      people.sadeil.id,
      "cr-olivia",
      new Date(Date.now() - 48 * 3600_000).toISOString(),
    );
    expect(brief.ok).toBe(true);
    if (!brief.ok) return;
    expect(brief.briefing.plainSummary.length).toBeGreaterThan(0);
    expect(brief.briefing.needsOwner.length).toBeGreaterThan(0);

    const card = buildEmergencyCard(store, people.sadeil.id, "cr-olivia");
    expect(card.ok).toBe(true);
    if (!card.ok) return;
    expect(card.card.preferredName.toLowerCase()).toMatch(/olivia|evelyn/);
    expect(card.card.accessNote.toLowerCase()).toMatch(/audit/);
  });

  it("guards multi-recipient context for consequential actions", () => {
    const ok = assertActiveRecipientContext({
      requestedRecipientId: "cr-olivia",
      sessionActiveRecipientId: "cr-olivia",
      confirmRecipientId: "cr-olivia",
    });
    expect(ok.ok).toBe(true);

    const mismatch = assertActiveRecipientContext({
      requestedRecipientId: "cr-olivia",
      sessionActiveRecipientId: "cr-robert",
    });
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.code).toBe("RECIPIENT_CONTEXT_MISMATCH");

    const unconfirmed = assertActiveRecipientContext({
      requestedRecipientId: "cr-olivia",
      sessionActiveRecipientId: "cr-olivia",
      confirmRecipientId: "cr-robert",
    });
    expect(unconfirmed.ok).toBe(false);
    if (unconfirmed.ok) return;
    expect(unconfirmed.code).toBe("RECIPIENT_CONFIRMATION_REQUIRED");
  });

  it("labels calendar truth and evidence honestly", () => {
    const t = calendarTruthForAppointment("scheduled", "scheduled");
    expect(t.state).toBe("scheduled_in_relay");
    expect(t.honestNote.toLowerCase()).toMatch(/provider|export|internal/);
    expect(labelFromEpistemic("INFERRED")).toBe("ai_inference");
    expect(labelFromEpistemic(undefined, "corrected", "correction")).toBe(
      "correction",
    );
  });

  it("projects handoff by role and enforces shift-end boundary", () => {
    store.addHandoff({
      id: "h-test-1",
      careRecipientId: "cr-olivia",
      fromPersonId: people.walter.id,
      toPersonId: people.maya.id,
      whatChanged: ["Evening meds given as planned"],
      stillNeedsAttention: ["Morning transport"],
      watch: ["Dizziness reports"],
      sources: [],
      createdAt: new Date().toISOString(),
      evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
    });
    const handoffs = store.getHandoffs("cr-olivia");
    const latest = handoffs[handoffs.length - 1];
    expect(latest).toBeTruthy();
    if (!latest) return;
    const family = projectHandoffForRole(store, latest, "family");
    expect(family.plainLanguage.toLowerCase()).toMatch(/family|handoff/);
    const dsp = projectHandoffForRole(store, latest, "dsp");
    expect(dsp.plainLanguage.toLowerCase()).toMatch(/shift|incomplete|task/);

    createWorkItem(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      action: "Unfinished evening checklist",
      reason: "Still open at shift end",
      ownerPersonId: people.walter.id,
      ownerDisplayName: people.walter.displayName,
    });
    const shift = createShiftAssignment(store, {
      careRecipientId: "cr-olivia",
      assignerPersonId: people.sadeil.id,
      assignerDisplayName: people.sadeil.displayName,
      assigneePersonId: people.walter.id,
      assigneeDisplayName: people.walter.displayName,
      shiftStart: new Date(Date.now() - 3600_000).toISOString(),
      shiftEnd: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(shift.ok).toBe(true);
    if (!shift.ok) return;
    const boundary = shiftBoundaryChecklist(
      store,
      "cr-olivia",
      shift.assignment.id,
    );
    expect(boundary.handoffRequired).toBe(true);
    expect(boundary.message.toLowerCase()).toMatch(/handoff|replacement|drop/);
  });

  it("denies zero-access stranger on work and emergency", () => {
    const denied = createWorkItem(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-stranger",
      actorDisplayName: "Stranger",
      action: "Should fail",
      reason: "No membership",
    });
    expect(denied.ok).toBe(false);
    const card = buildEmergencyCard(store, "p-stranger", "cr-olivia");
    expect(card.ok).toBe(false);
  });
});
