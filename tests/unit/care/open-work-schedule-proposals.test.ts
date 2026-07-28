import { describe, expect, it } from "vitest";
import { MemoryCareStore } from "../../../packages/care-domain/src/store/memory-store.js";
import {
  claimWorkItem,
  declineWorkItem,
  listNeedsOwner,
  listWorkItems,
  seedWorkItemsFromHandoff,
} from "../../../packages/care-domain/src/services/care-work-items.js";
import {
  confirmScheduleProposal,
  extractScheduleProposalsFromHandoff,
  listScheduleProposals,
  rejectScheduleProposal,
} from "../../../packages/care-domain/src/services/schedule-proposals.js";

function seedCircle(store: MemoryCareStore) {
  const rid = "cr-test-open-work";
  store.upsertRecipient({
    id: rid,
    displayName: "Test Recipient",
    preferredName: "Test",
    timezone: "America/Los_Angeles",
  } as never);
  for (const [id, name] of [
    ["p-a", "Alice Out"],
    ["p-b", "Bob In"],
    ["p-c", "Cara Coord"],
  ] as const) {
    store.upsertPerson({ id, displayName: name } as never);
    store.upsertRelationship({
      id: `rel-${id}`,
      careRecipientId: rid,
      personId: id,
      roleLabel: "caregiver",
      status: "active",
      domains: ["*"],
    } as never);
  }
  return rid;
}

describe("open-work ownership and schedule proposals", () => {
  it("seeds unassigned work from handoff and keeps ack separate from accept", () => {
    const store = new MemoryCareStore();
    const rid = seedCircle(store);
    const seeded = seedWorkItemsFromHandoff(store, {
      careRecipientId: rid,
      handoffId: "ho-1",
      actorPersonId: "p-a",
      actorDisplayName: "Alice Out",
      stillNeedsAttention: ["Transportation incomplete"],
    });
    expect(seeded).toHaveLength(1);
    expect(seeded[0]!.status).toBe("available_to_claim");
    expect(seeded[0]!.ownerPersonId).toBeNull();
    expect(listNeedsOwner(store, rid)).toHaveLength(1);

    const accepted = claimWorkItem(store, {
      careRecipientId: rid,
      workItemId: seeded[0]!.id,
      actorPersonId: "p-b",
      actorDisplayName: "Bob In",
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.item.status).toBe("accepted");
      expect(accepted.item.ownerPersonId).toBe("p-b");
      expect(accepted.item.status).not.toBe("completed");
    }

    const second = claimWorkItem(store, {
      careRecipientId: rid,
      workItemId: seeded[0]!.id,
      actorPersonId: "p-c",
      actorDisplayName: "Cara Coord",
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("ALREADY_OWNED");
  });

  it("decline keeps work open for another owner", () => {
    const store = new MemoryCareStore();
    const rid = seedCircle(store);
    const seeded = seedWorkItemsFromHandoff(store, {
      careRecipientId: rid,
      handoffId: "ho-2",
      actorPersonId: "p-a",
      actorDisplayName: "Alice Out",
      stillNeedsAttention: ["Watch fatigue"],
    });
    const d = declineWorkItem(store, {
      careRecipientId: rid,
      workItemId: seeded[0]!.id,
      actorPersonId: "p-b",
      actorDisplayName: "Bob In",
      reason: "Cannot take transport today",
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.item.status).toBe("available_to_claim");
      expect(d.item.ownerPersonId).toBeNull();
      expect(d.item.declineReason).toMatch(/Cannot take/);
    }
    expect(listWorkItems(store, rid).some((w) => w.id === seeded[0]!.id)).toBe(
      true,
    );
  });

  it("handoff schedule language creates proposal; confirm updates appointment", () => {
    const store = new MemoryCareStore();
    const rid = seedCircle(store);
    store.upsertAppointment({
      id: "apt-old",
      careRecipientId: rid,
      title: "Physical therapy",
      startsAt: new Date(Date.now() + 3600e3).toISOString(),
      startsAtLabel: "around 3:00",
      status: "scheduled",
      scheduleState: "confirmed",
      epistemicStatus: "CONFIRMED",
    });
    const props = extractScheduleProposalsFromHandoff(store, {
      careRecipientId: rid,
      handoffId: "ho-3",
      actorPersonId: "p-a",
      actorDisplayName: "Alice Out",
      whatChanged: ["Therapy rescheduled to later slot"],
    });
    expect(props.length).toBeGreaterThanOrEqual(1);
    expect(listScheduleProposals(store, rid)[0]!.status).toBe("proposed");
    // Silent mutation must not have happened
    expect(
      store.getAppointments(rid).find((a) => a.id === "apt-old")?.status,
    ).toBe("scheduled");

    const conf = confirmScheduleProposal(store, {
      careRecipientId: rid,
      proposalId: props[0]!.id,
      actorPersonId: "p-c",
      actorDisplayName: "Cara Coord",
      confirmedStartsAtLabel: "Tomorrow 4:30 PM",
    });
    expect(conf.ok).toBe(true);
    if (conf.ok) {
      expect(conf.proposal.status).toBe("confirmed");
      const next = store.getAppointments(rid).find((a) => a.id === conf.appointmentId);
      expect(next?.title).toMatch(/Physical therapy|therapy/i);
      const old = store.getAppointments(rid).find((a) => a.id === "apt-old");
      expect(old?.status).toBe("cancelled");
    }
  });

  it("reject leaves prior appointment current", () => {
    const store = new MemoryCareStore();
    const rid = seedCircle(store);
    store.upsertAppointment({
      id: "apt-keep",
      careRecipientId: rid,
      title: "Physical therapy",
      startsAt: new Date(Date.now() + 3600e3).toISOString(),
      startsAtLabel: "around 3:00",
      status: "scheduled",
      scheduleState: "confirmed",
      epistemicStatus: "CONFIRMED",
    });
    const props = extractScheduleProposalsFromHandoff(store, {
      careRecipientId: rid,
      handoffId: "ho-4",
      actorPersonId: "p-a",
      actorDisplayName: "Alice Out",
      whatChanged: ["Appointment moved to later"],
    });
    const rej = rejectScheduleProposal(store, {
      careRecipientId: rid,
      proposalId: props[0]!.id,
      actorPersonId: "p-c",
      actorDisplayName: "Cara Coord",
    });
    expect(rej.ok).toBe(true);
    expect(store.getAppointments(rid).find((a) => a.id === "apt-keep")?.status).toBe(
      "scheduled",
    );
  });

  it("seed + extract cover completeShiftHandoff side effects", () => {
    const store = new MemoryCareStore();
    const rid = seedCircle(store);
    seedWorkItemsFromHandoff(store, {
      careRecipientId: rid,
      handoffId: "ho-shift",
      actorPersonId: "p-a",
      actorDisplayName: "Alice Out",
      stillNeedsAttention: ["Transportation incomplete"],
    });
    extractScheduleProposalsFromHandoff(store, {
      careRecipientId: rid,
      handoffId: "ho-shift",
      actorPersonId: "p-a",
      actorDisplayName: "Alice Out",
      whatChanged: ["Calm mood", "Therapy rescheduled to later slot"],
    });
    expect(listNeedsOwner(store, rid).some((w) => /Transport/i.test(w.action))).toBe(
      true,
    );
    expect(listScheduleProposals(store, rid).length).toBeGreaterThanOrEqual(1);
  });
});
