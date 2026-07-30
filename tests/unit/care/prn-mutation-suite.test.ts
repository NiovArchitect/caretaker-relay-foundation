/**
 * Mutation suite: tests must FAIL if critical safeguards are removed.
 * Each test encodes the invariant that a "mutated" implementation would violate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryCareStore } from "../../../packages/care-domain/src/store/memory-store.js";
import { seedOliviaScenario } from "../../../packages/care-domain/src/scenario/olivia.js";
import { seedMultiTenantFixture } from "../../../packages/care-domain/src/scenario/multi-tenant.js";
import { evaluateAccess } from "../../../packages/care-domain/src/services/access.js";
import {
  seedEvelynPrnOrders,
  createOrAdvancePrnEpisode,
  reassessPrnEpisode,
  buildPrnProjection,
  setPrnOrderStatus,
  listPrnOrders,
} from "../../../packages/care-domain/src/services/prn-medication.js";

describe("PRN mutation suite (safeguards must be detectable)", () => {
  let store: MemoryCareStore;
  beforeEach(() => {
    store = new MemoryCareStore();
    seedOliviaScenario(store);
    seedEvelynPrnOrders(store, "cr-olivia");
  });

  it("M1 tenant/recipient filter: wrong actor cannot chart", () => {
    seedMultiTenantFixture(store);
    seedEvelynPrnOrders(store, "cr-a-evelyn");
    const r = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-a-evelyn",
      actorPersonId: "p-b-marcus",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Acetaminophen",
      symptom: "pain",
      confirm: true,
    });
    // If recipient/tenant filter removed, this would succeed
    expect(r.ok).toBe(false);
  });

  it("M2 idempotency: same key does not create two episodes", () => {
    const key = "mut-idem-1";
    const a = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
      idempotencyKey: key,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
      idempotencyKey: key,
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.episode.id).toBe(a.episode.id);
    // If idempotency disabled, ids would differ
  });

  it("M3 reassessment required: open episode lacks effect until reassess", () => {
    const a = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.episode.effect).toBeFalsy();
    expect(a.episode.reassessmentCompletedAt).toBeFalsy();
    const proj = buildPrnProjection(store, "cr-olivia");
    expect(proj.reassessmentDue.some((e) => e.id === a.episode.id)).toBe(true);
  });

  it("M4 inactive order version: confirm rejected", () => {
    const prev = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: false,
    });
    expect(prev.ok).toBe(true);
    if (!prev.ok) return;
    setPrnOrderStatus(
      store,
      "cr-olivia",
      prev.order!.id,
      "ended",
      "p-dr-shah",
      "Dr Shah",
    );
    const conf = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
      orderId: prev.order!.id,
    });
    expect(conf.ok).toBe(false);
    if (conf.ok) return;
    expect(conf.code).toBe("PRN_ORDER_INACTIVE");
  });

  it("M5 completed work not active: after reassess, leaves due list", () => {
    const a = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
    });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    reassessPrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-maya",
      actorDisplayName: "Maya",
      episodeId: a.episode.id,
      effect: "improved",
    });
    const proj = buildPrnProjection(store, "cr-olivia");
    expect(proj.reassessmentDue.some((e) => e.id === a.episode.id)).toBe(false);
    expect(
      proj.completedRecent.some((e) => e.id === a.episode.id) ||
        proj.completedRecent.some((e) => e.effect === "improved"),
    ).toBe(true);
  });

  it("M6 history is not current: completed not in reassessmentDue", () => {
    const a = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus",
      medicationHint: "Simethicone",
      symptom: "gas",
      confirm: true,
    });
    if (!a.ok) return;
    reassessPrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus",
      episodeId: a.episode.id,
      effect: "improved",
    });
    const proj = buildPrnProjection(store, "cr-olivia");
    expect(proj.reassessmentDue.every((e) => e.id !== a.episode.id)).toBe(true);
  });

  it("M7 role authorization: evaluateAccess gates writes", () => {
    expect(evaluateAccess(store, "p-nobody", "cr-olivia").allowed).toBe(false);
    expect(evaluateAccess(store, "p-sadeil", "cr-olivia").allowed).toBe(true);
  });

  it("M8 active orders only for matching", () => {
    const orders = listPrnOrders(store, "cr-olivia");
    expect(orders.every((o) => o.status === "active")).toBe(true);
  });
});
