/**
 * PRN reliability: overdue time progression, repeated escalation, multi-tenant isolation.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryCareStore } from "../../../packages/care-domain/src/store/memory-store.js";
import { seedOliviaScenario } from "../../../packages/care-domain/src/scenario/olivia.js";
import { seedMultiTenantFixture } from "../../../packages/care-domain/src/scenario/multi-tenant.js";
import {
  seedEvelynPrnOrders,
  createOrAdvancePrnEpisode,
  reassessPrnEpisode,
  buildPrnProjection,
  ensurePrnOverdueEscalation,
  setPrnOrderStatus,
  listPrnOrders,
} from "../../../packages/care-domain/src/services/prn-medication.js";
import { evaluateAccess } from "../../../packages/care-domain/src/services/access.js";

describe("PRN overdue timed progression (clock-injected)", () => {
  let store: MemoryCareStore;
  const t0 = Date.parse("2026-07-30T10:00:00.000Z");

  beforeEach(() => {
    store = new MemoryCareStore();
    seedOliviaScenario(store);
    seedEvelynPrnOrders(store, "cr-olivia");
  });

  it("scheduled → due → overdue once → clear after complete; repeat worker no dup", () => {
    const adminAt = new Date(t0).toISOString();
    const created = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
      administeredAt: adminAt,
      idempotencyKey: "soak-ond-1",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Ondansetron reassess 45m → due at t0+45m
    const beforeDue = t0 + 20 * 60 * 1000;
    const atDue = t0 + 45 * 60 * 1000;
    const overdue = t0 + 90 * 60 * 1000;

    const p1 = buildPrnProjection(store, "cr-olivia", beforeDue);
    expect(p1.reassessmentDue.length).toBeGreaterThanOrEqual(1);
    expect(p1.overdue.length).toBe(0);

    const p2 = buildPrnProjection(store, "cr-olivia", atDue);
    // due at exact boundary: overdue uses < now so atDue is not yet overdue
    expect(p2.reassessmentDue.length).toBeGreaterThanOrEqual(1);

    const e1 = ensurePrnOverdueEscalation(store, "cr-olivia", overdue);
    expect(e1.overdueCount).toBeGreaterThanOrEqual(1);
    const e2 = ensurePrnOverdueEscalation(store, "cr-olivia", overdue);
    expect(e2.overdueCount).toBeGreaterThanOrEqual(1);
    const audits = store
      .listAudit({ careRecipientId: "cr-olivia" })
      .filter((a) => a.action === "PRN_REASSESS_OVERDUE");
    expect(audits.length).toBe(1);

    const handoffs = store.getHandoffs("cr-olivia");
    const latest = handoffs[handoffs.length - 1];
    const overdueLines =
      latest?.stillNeedsAttention?.filter((x) =>
        /overdue as-needed follow-up/i.test(x),
      ) ?? [];
    // one line per medication (may inject at admin + overdue; filter unique)
    const unique = [...new Set(overdueLines)];
    expect(unique.length).toBeLessThanOrEqual(2);

    const re = reassessPrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-maya",
      actorDisplayName: "Maya Bennett",
      effect: "improved",
    });
    expect(re.ok).toBe(true);
    const after = buildPrnProjection(store, "cr-olivia", overdue + 60_000);
    expect(after.reassessmentDue.filter((e) => /ondansetron/i.test(e.medication))).toHaveLength(
      0,
    );
    expect(after.overdue.filter((e) => /ondansetron/i.test(e.medication))).toHaveLength(0);
    // third worker run after complete does not create new overdue audits for closed ep
    ensurePrnOverdueEscalation(store, "cr-olivia", overdue + 120_000);
    const audits2 = store
      .listAudit({ careRecipientId: "cr-olivia" })
      .filter((a) => a.action === "PRN_REASSESS_OVERDUE");
    expect(audits2.length).toBe(1);
  });
});

describe("PRN multi-tenant isolation (similar display names)", () => {
  it("blocks cross-tenant PRN read/write by similar names", () => {
    const store = new MemoryCareStore();
    seedMultiTenantFixture(store);
    // Tenant A Evelyn vs Tenant B if exists — use cr-a-evelyn only for A actors
    seedEvelynPrnOrders(store, "cr-a-evelyn");

    const aOk = evaluateAccess(store, "p-a-marcus", "cr-a-evelyn");
    expect(aOk.allowed).toBe(true);

    // Tenant B marcus must not write to A recipient even with same display names
    const bPerson = store.getPerson("p-b-marcus") || store.getPerson("p-a-marcus");
    // Cross: use Company B actor if present
    const bMarcusId =
      store.listPeople?.().find((p) => p.id.startsWith("p-b-") && /Marcus/i.test(p.displayName))
        ?.id || "p-b-marcus";
    if (!store.getPerson(bMarcusId)) {
      store.upsertPerson({
        id: bMarcusId,
        displayName: "Marcus Carter",
        kind: "family_caregiver",
      });
    }
    const cross = evaluateAccess(store, bMarcusId, "cr-a-evelyn");
    expect(cross.allowed).toBe(false);

    const denied = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-a-evelyn",
      actorPersonId: bMarcusId,
      actorDisplayName: "Marcus Carter",
      medicationHint: "Acetaminophen",
      symptom: "pain",
      confirm: true,
    });
    expect(denied.ok).toBe(false);

    // Stale episode id from A must not be reassessed by B
    const chart = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-a-evelyn",
      actorPersonId: "p-a-marcus",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Acetaminophen",
      symptom: "pain",
      confirm: true,
    });
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;
    const badRe = reassessPrnEpisode(store, {
      careRecipientId: "cr-a-evelyn",
      actorPersonId: bMarcusId,
      actorDisplayName: "Marcus Carter",
      episodeId: chart.episode.id,
      effect: "improved",
    });
    expect(badRe.ok).toBe(false);
  });
});

describe("PRN stale order status API path", () => {
  it("setPrnOrderStatus ends active order", () => {
    const store = new MemoryCareStore();
    seedOliviaScenario(store);
    seedEvelynPrnOrders(store, "cr-olivia");
    const orders = listPrnOrders(store, "cr-olivia");
    const ond = orders.find((o) => /ondansetron/i.test(o.medication));
    expect(ond).toBeTruthy();
    setPrnOrderStatus(
      store,
      "cr-olivia",
      ond!.id,
      "ended",
      "p-dr-shah",
      "Dr. Shah",
    );
    expect(
      listPrnOrders(store, "cr-olivia").some((o) => o.id === ond!.id),
    ).toBe(false);
  });
});
