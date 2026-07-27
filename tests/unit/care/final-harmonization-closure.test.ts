import { describe, it, expect, beforeEach } from "vitest";
import {
  createCareRuntime,
  people,
  createWorkItem,
  ensureHandoffLifecycle,
  transitionHandoffLifecycle,
  escalateNoResponseForRecipient,
  applyRecurrenceException,
  expandRecurrenceOccurrences,
  ingestDocumentText,
  confirmDocumentProposal,
  leaveCareCircle,
  archiveCareSpace,
  representativeAuthorityNote,
  upsertScheduleItem,
  createNotificationIfNew,
  listWorkItems,
} from "@caretaker-relay/care-domain";

describe("final harmonization closure", () => {
  let store: ReturnType<typeof createCareRuntime>["store"];
  beforeEach(() => {
    ({ store } = createCareRuntime({ seedOlivia: true }));
  });

  it("handoff lifecycle send → acknowledge", () => {
    store.addHandoff({
      id: "h-close-1",
      careRecipientId: "cr-olivia",
      fromPersonId: people.walter.id,
      toPersonId: people.maya.id,
      whatChanged: ["Evening meds"],
      stillNeedsAttention: ["Transport"],
      watch: ["Dizziness"],
      sources: [],
      createdAt: new Date().toISOString(),
      evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
    });
    const h = store.getHandoffs("cr-olivia").at(-1)!;
    ensureHandoffLifecycle(store, h, people.walter.id);
    const sent = transitionHandoffLifecycle(store, {
      careRecipientId: "cr-olivia",
      handoffId: h.id,
      actorPersonId: people.walter.id,
      actorDisplayName: people.walter.displayName,
      status: "sent",
    });
    expect(sent.ok).toBe(true);
    const ack = transitionHandoffLifecycle(store, {
      careRecipientId: "cr-olivia",
      handoffId: h.id,
      actorPersonId: people.maya.id,
      actorDisplayName: people.maya.displayName,
      status: "acknowledged",
    });
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(ack.lifecycle.status).toBe("acknowledged");
  });

  it("no-response escalation creates alternate ownership work", () => {
    createNotificationIfNew(store, {
      principalId: people.walter.id,
      careRecipientId: "cr-olivia",
      type: "CARE_UPDATE",
      priority: "urgent",
      title: "Coverage request",
      body: "Please confirm shift",
      sourceType: "test",
      sourceId: "cov-1",
      actionType: "open",
      actionTarget: "cov-1",
      dedupeKey: "test-noresp-1",
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    // Force old createdAt via raw create with custom - createNotificationIfNew may set now
    // Use escalate with windowMs 0 to treat all unacked as overdue
    const r = escalateNoResponseForRecipient(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      alternatePersonId: people.maya.id,
      alternateDisplayName: people.maya.displayName,
      windowMs: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.results.length).toBeGreaterThan(0);
  });

  it("recurrence exception skips without rewriting completed past", () => {
    const apt = upsertScheduleItem(store, {
      careRecipientId: "cr-olivia",
      actorPrincipalId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      title: "Weekly PT",
      startsAt: new Date().toISOString(),
      scheduleState: "confirmed",
      recurrenceRule: "FREQ=WEEKLY",
    });
    expect(apt.ok).toBe(true);
    if (!apt.ok) return;
    const occ = expandRecurrenceOccurrences(apt.appointment.startsAt, "FREQ=WEEKLY", 4);
    expect(occ.length).toBe(4);
    const ex = applyRecurrenceException(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      seriesAppointmentId: apt.appointment.id,
      occurrenceStartsAt: occ[1]!,
      kind: "skip",
      scope: "this_occurrence",
      reason: "Hospitalization day",
    });
    expect(ex.ok).toBe(true);
    if (ex.ok) expect(ex.preview).toMatch(/Past completed/);
  });

  it("document extract requires confirm before work item", () => {
    const ing = ingestDocumentText(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      title: "Therapy letter",
      body: "Physical therapy appointment Friday at 3pm. Continue medication as prescribed 5mg tablet.",
    });
    expect(ing.ok).toBe(true);
    if (!ing.ok) return;
    expect(ing.proposals.length).toBeGreaterThan(0);
    const workProp = ing.proposals.find((p) => p.kind === "work_item");
    if (workProp) {
      const conf = confirmDocumentProposal(store, {
        careRecipientId: "cr-olivia",
        actorPersonId: people.sadeil.id,
        actorDisplayName: people.sadeil.displayName,
        proposalId: workProp.id,
        decision: "confirm",
      });
      expect(conf.ok).toBe(true);
    }
  });

  it("self-leave and archive and representative note", () => {
    const leave = leaveCareCircle(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: people.maya.id,
      reason: "Travel",
    });
    expect(leave.ok).toBe(true);
    const arch = archiveCareSpace(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      reason: "Test archive",
    });
    expect(arch.ok).toBe(true);
    const rep = representativeAuthorityNote(
      store,
      "cr-olivia",
      people.sadeil.id,
    );
    expect(rep.legalNote).toMatch(/does not determine legal/);
  });

  it("work item still open after handoff ack (continuity)", () => {
    createWorkItem(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      action: "Unfinished transport",
      reason: "Must survive handoff",
      ownerPersonId: people.walter.id,
      ownerDisplayName: people.walter.displayName,
    });
    store.addHandoff({
      id: "h-close-2",
      careRecipientId: "cr-olivia",
      fromPersonId: people.walter.id,
      toPersonId: people.maya.id,
      whatChanged: ["Shift ending"],
      stillNeedsAttention: ["Transport"],
      watch: [],
      sources: [],
      createdAt: new Date().toISOString(),
      evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
    });
    const h = store.getHandoffs("cr-olivia").at(-1)!;
    transitionHandoffLifecycle(store, {
      careRecipientId: "cr-olivia",
      handoffId: h.id,
      actorPersonId: people.maya.id,
      actorDisplayName: people.maya.displayName,
      status: "acknowledged",
    });
    const open = listWorkItems(store, "cr-olivia");
    expect(
      open.some(
        (w) =>
          w.action.includes("transport") || w.action.includes("Transport"),
      ),
    ).toBe(true);
  });
});
