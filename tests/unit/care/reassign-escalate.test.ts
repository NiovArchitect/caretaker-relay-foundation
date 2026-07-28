import { describe, expect, it } from "vitest";
import { MemoryCareStore } from "../../../packages/care-domain/src/store/memory-store.js";
import {
  claimWorkItem,
  createWorkItem,
  declineWorkItem,
  escalateWorkItem,
  reassignWorkItem,
} from "../../../packages/care-domain/src/services/care-work-items.js";
import { createCareSpace } from "../../../packages/care-domain/src/services/care-space-bootstrap.js";

function seed() {
  const store = new MemoryCareStore();
  store.upsertPerson({ id: "p-c", displayName: "Coord", kind: "family_caregiver" });
  store.upsertPerson({ id: "p-1", displayName: "Dsp1", kind: "professional" });
  store.upsertPerson({ id: "p-2", displayName: "Dsp2", kind: "professional" });
  const space = createCareSpace(store, {
    actorPersonId: "p-c",
    actorDisplayName: "Coord",
    displayName: "Iso Person",
  });
  if (!space.ok) throw new Error("space");
  for (const id of ["p-1", "p-2"]) {
    store.upsertRelationship({
      id: `rel-${id}`,
      careRecipientId: space.careRecipientId,
      personId: id,
      role: "direct_support_professional",
      roleLabel: "DSP",
      responsibilities: ["shift care"],
      access: {
        informationCategories: ["*"],
        allowedActions: ["*"],
        canEscalate: true,
        authorityLimits: [],
      },
      status: "active",
    });
  }
  return { store, rid: space.careRecipientId };
}

describe("reassign and escalate", () => {
  it("decline → reassign propose → accept", () => {
    const { store, rid } = seed();
    const created = createWorkItem(store, {
      careRecipientId: rid,
      actorPersonId: "p-c",
      actorDisplayName: "Coord",
      action: "Pharmacy pickup",
      reason: "Meds",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    declineWorkItem(store, {
      careRecipientId: rid,
      workItemId: created.item.id,
      actorPersonId: "p-1",
      actorDisplayName: "Dsp1",
      reason: "Cannot",
    });
    const re = reassignWorkItem(store, {
      careRecipientId: rid,
      workItemId: created.item.id,
      actorPersonId: "p-c",
      actorDisplayName: "Coord",
      newOwnerPersonId: "p-2",
      newOwnerDisplayName: "Dsp2",
    });
    expect(re.ok).toBe(true);
    if (!re.ok) return;
    expect(re.item.proposedOwnerPersonId).toBe("p-2");
    expect(re.item.ownerPersonId).toBeNull();
    const acc = claimWorkItem(store, {
      careRecipientId: rid,
      workItemId: created.item.id,
      actorPersonId: "p-2",
      actorDisplayName: "Dsp2",
    });
    expect(acc.ok).toBe(true);
    if (acc.ok) {
      expect(acc.item.status).toBe("accepted");
      expect(acc.item.ownerPersonId).toBe("p-2");
    }
  });

  it("escalate keeps open for alternate accept", () => {
    const { store, rid } = seed();
    const created = createWorkItem(store, {
      careRecipientId: rid,
      actorPersonId: "p-c",
      actorDisplayName: "Coord",
      action: "Transportation",
      reason: "PT",
    });
    if (!created.ok) return;
    const esc = escalateWorkItem(store, {
      careRecipientId: rid,
      workItemId: created.item.id,
      actorPersonId: "p-c",
      actorDisplayName: "Coord",
      reason: "No response",
      alternatePersonId: "p-1",
    });
    expect(esc.ok).toBe(true);
    if (!esc.ok) return;
    expect(esc.item.status).toBe("escalated");
    expect(esc.item.ownerPersonId).toBeNull();
    const acc = claimWorkItem(store, {
      careRecipientId: rid,
      workItemId: created.item.id,
      actorPersonId: "p-1",
      actorDisplayName: "Dsp1",
    });
    expect(acc.ok).toBe(true);
  });
});
