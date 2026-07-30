/**
 * Clean-universe ETL: isolated MemoryCareStore, no public pollution.
 * Proves open → due → overdue → reassess → clear → history.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryCareStore } from "../../../packages/care-domain/src/store/memory-store.js";
import { seedOliviaScenario } from "../../../packages/care-domain/src/scenario/olivia.js";
import {
  seedEvelynPrnOrders,
  createOrAdvancePrnEpisode,
  reassessPrnEpisode,
  buildPrnProjection,
  ensurePrnOverdueEscalation,
  ensurePrnClarificationLifecycle,
  PRN_CLARIFICATION_ACTIVE_MS,
} from "../../../packages/care-domain/src/services/prn-medication.js";

describe("PRN clean-universe ETL lineage", () => {
  let store: MemoryCareStore;
  beforeEach(() => {
    store = new MemoryCareStore();
    seedOliviaScenario(store);
    seedEvelynPrnOrders(store, "cr-olivia");
  });

  it("full destination lineage: chart → due → overdue once → maya reassess → clear → history", () => {
    const t0 = Date.parse("2026-07-30T10:00:00.000Z");
    const chart = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      severityBefore: "moderate",
      confirm: true,
      administeredAt: new Date(t0).toISOString(),
      idempotencyKey: "clean-etl-1",
    });
    expect(chart.ok).toBe(true);
    if (!chart.ok) return;
    expect(chart.episode.symptom).toMatch(/nausea/i);
    expect(chart.episode.dose).toBeTruthy();
    expect(chart.episode.lifecycle).toBe("reassessment_due");
    expect(chart.episode.effect).toBeFalsy();

    const due = buildPrnProjection(store, "cr-olivia", t0 + 1000);
    expect(due.reassessmentDue.some((e) => e.id === chart.episode.id)).toBe(
      true,
    );
    expect(due.overdue.some((e) => e.id === chart.episode.id)).toBe(false);

    // Ondansetron reassess 45m
    const afterDue = t0 + 50 * 60 * 1000;
    const overdueProj = buildPrnProjection(store, "cr-olivia", afterDue);
    expect(overdueProj.overdue.some((e) => e.id === chart.episode.id)).toBe(
      true,
    );
    const esc1 = ensurePrnOverdueEscalation(store, "cr-olivia", afterDue);
    expect(esc1.overdueCount).toBeGreaterThanOrEqual(1);
    const esc2 = ensurePrnOverdueEscalation(store, "cr-olivia", afterDue);
    expect(esc2.overdueCount).toBeGreaterThanOrEqual(1);
    const audits = store
      .listAudit({ careRecipientId: "cr-olivia" })
      .filter((a) => a.action === "PRN_REASSESS_OVERDUE");
    expect(audits.length).toBe(1);

    const re = reassessPrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-maya",
      actorDisplayName: "Maya Bennett",
      episodeId: chart.episode.id,
      effect: "improved",
      severityAfter: "mild",
      idempotencyKey: "clean-etl-re-1",
    });
    expect(re.ok).toBe(true);
    if (!re.ok) return;
    expect(re.episode.effect).toBe("improved");
    expect(re.episode.reassessmentCompletedAt).toBeTruthy();

    const done = buildPrnProjection(store, "cr-olivia", afterDue + 60_000);
    expect(done.reassessmentDue.some((e) => e.id === chart.episode.id)).toBe(
      false,
    );
    expect(done.overdue.some((e) => e.id === chart.episode.id)).toBe(false);
    expect(
      done.completedRecent.some(
        (e) => e.id === chart.episode.id && e.effect === "improved",
      ),
    ).toBe(true);

    // Idempotent reassess
    const re2 = reassessPrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-maya",
      actorDisplayName: "Maya Bennett",
      episodeId: chart.episode.id,
      effect: "improved",
      idempotencyKey: "clean-etl-re-1",
    });
    expect(re2.ok).toBe(true);
  });

  it("archives stale unauthorized clarifications out of operational open", () => {
    const t0 = Date.now();
    createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus",
      medicationHint: "Benadryl",
      symptom: "itching",
      confirm: false,
      forceUnauthorized: true,
    });
    // Force age by rewriting episode updatedAt via second unauthorized
    const fresh = buildPrnProjection(store, "cr-olivia", t0);
    expect(
      fresh.openEpisodes.some((e) => e.unauthorizedReport === true),
    ).toBe(true);

    // Age past window
    const aged = t0 + PRN_CLARIFICATION_ACTIVE_MS + 60_000;
    // Manually age: re-encode with old timestamp
    const open = fresh.openEpisodes.find((e) => e.unauthorizedReport);
    expect(open).toBeTruthy();
    if (!open) return;
    store.addUpdate({
      id: open.id,
      careRecipientId: "cr-olivia",
      toPersonId: "p-sadeil",
      summary:
        "PRN_EPISODE_V1:" +
        JSON.stringify({
          ...open,
          updatedAt: new Date(t0 - PRN_CLARIFICATION_ACTIVE_MS - 1000).toISOString(),
          createdAt: new Date(t0 - PRN_CLARIFICATION_ACTIVE_MS - 1000).toISOString(),
        }),
      status: "ready",
      safetyClass: "high",
      source: {
        id: "src-age",
        kind: "caregiver_text",
        label: "age",
        actorName: "Marcus",
        actorPersonId: "p-sadeil",
        recordedAt: new Date().toISOString(),
        whyVisible: "test",
      },
    });

    const { archived } = ensurePrnClarificationLifecycle(
      store,
      "cr-olivia",
      aged,
    );
    expect(archived).toBeGreaterThanOrEqual(1);
    const after = buildPrnProjection(store, "cr-olivia", aged);
    expect(
      after.openEpisodes.filter((e) => e.unauthorizedReport).length,
    ).toBe(0);
    expect(
      after.completedRecent.some(
        (e) => e.unauthorizedReport || e.lifecycle === "cancelled",
      ),
    ).toBe(true);
  });
});
