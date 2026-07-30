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

  it("does not age-archive possible unauthorized administration reports", () => {
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
    const fresh = buildPrnProjection(store, "cr-olivia", t0);
    const open = fresh.openEpisodes.find((e) => e.unauthorizedReport);
    expect(open).toBeTruthy();
    if (!open) return;
    // Age past 24h — safety-relevant unauthorized reports must remain reviewable
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
    const aged = t0 + PRN_CLARIFICATION_ACTIVE_MS + 60_000;
    const { archived, retainedSafety } = ensurePrnClarificationLifecycle(
      store,
      "cr-olivia",
      aged,
    );
    expect(archived).toBe(0);
    expect(retainedSafety).toBeGreaterThanOrEqual(1);
    const after = buildPrnProjection(store, "cr-olivia", aged);
    expect(
      after.openEpisodes.filter((e) => e.unauthorizedReport).length,
    ).toBe(1);
  });

  it("collapses duplicate unauthorized clarifications to one operational row", () => {
    const t0 = Date.now();
    for (let i = 0; i < 4; i++) {
      createOrAdvancePrnEpisode(store, {
        careRecipientId: "cr-olivia",
        actorPersonId: "p-sadeil",
        actorDisplayName: "Marcus",
        medicationHint: "Benadryl",
        symptom: "itching",
        confirm: false,
        forceUnauthorized: true,
      });
    }
    const before = buildPrnProjection(store, "cr-olivia", t0);
    expect(
      before.openEpisodes.filter((e) => e.unauthorizedReport).length,
    ).toBeGreaterThanOrEqual(4);

    const { collapsed } = ensurePrnClarificationLifecycle(
      store,
      "cr-olivia",
      t0,
    );
    expect(collapsed).toBeGreaterThanOrEqual(3);
    const after = buildPrnProjection(store, "cr-olivia", t0);
    const unauthOpen = after.openEpisodes.filter((e) => e.unauthorizedReport);
    expect(unauthOpen.length).toBe(1);
    expect(
      after.completedRecent.some(
        (e) =>
          e.lifecycle === "cancelled" &&
          /superseded by duplicate/i.test(e.notes || ""),
      ),
    ).toBe(true);
  });

  it("age-archives only low-risk abandoned drafts, never adverse signals", () => {
    const t0 = Date.now();
    // Low-risk incomplete clarification (authorized path incomplete style)
    createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus",
      medicationHint: "MysteryMed",
      symptom: "?",
      confirm: false,
      forceUnauthorized: true,
      notes: "started typing only",
      dose: "dose not confirmed",
    });
    // Force low-risk: rewrite without administered claim
    let proj = buildPrnProjection(store, "cr-olivia", t0);
    let draft = proj.openEpisodes.find((e) => e.medication === "MysteryMed");
    expect(draft).toBeTruthy();
    if (!draft) return;
    store.addUpdate({
      id: draft.id,
      careRecipientId: "cr-olivia",
      toPersonId: "p-sadeil",
      summary:
        "PRN_EPISODE_V1:" +
        JSON.stringify({
          ...draft,
          dose: "dose not confirmed",
          route: "not confirmed",
          administeredAt: undefined,
          unauthorizedReport: false,
          lifecycle: "needs_clarification",
          outcome: undefined,
          notes: "abandoned draft only",
          updatedAt: new Date(t0 - PRN_CLARIFICATION_ACTIVE_MS - 5000).toISOString(),
          createdAt: new Date(t0 - PRN_CLARIFICATION_ACTIVE_MS - 5000).toISOString(),
        }),
      status: "ready",
      safetyClass: "high",
      source: {
        id: "src-draft",
        kind: "caregiver_text",
        label: "draft",
        actorName: "Marcus",
        actorPersonId: "p-sadeil",
        recordedAt: new Date().toISOString(),
        whyVisible: "test",
      },
    });

    // Adverse-signal unauthorized
    createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus",
      medicationHint: "Benadryl",
      symptom: "itching",
      confirm: false,
      forceUnauthorized: true,
      notes: "she became very sleepy after taking it",
    });
    proj = buildPrnProjection(store, "cr-olivia", t0);
    const adverse = proj.openEpisodes.find((e) => e.medication === "Benadryl");
    expect(adverse).toBeTruthy();
    if (adverse) {
      store.addUpdate({
        id: adverse.id,
        careRecipientId: "cr-olivia",
        toPersonId: "p-sadeil",
        summary:
          "PRN_EPISODE_V1:" +
          JSON.stringify({
            ...adverse,
            notes: "she became very sleepy after taking it",
            updatedAt: new Date(t0 - PRN_CLARIFICATION_ACTIVE_MS - 5000).toISOString(),
            createdAt: new Date(t0 - PRN_CLARIFICATION_ACTIVE_MS - 5000).toISOString(),
          }),
        status: "ready",
        safetyClass: "high",
        source: {
          id: "src-adv",
          kind: "caregiver_text",
          label: "adv",
          actorName: "Marcus",
          actorPersonId: "p-sadeil",
          recordedAt: new Date().toISOString(),
          whyVisible: "test",
        },
      });
    }

    const aged = t0 + PRN_CLARIFICATION_ACTIVE_MS + 60_000;
    const { archived } = ensurePrnClarificationLifecycle(store, "cr-olivia", aged);
    expect(archived).toBeGreaterThanOrEqual(1);
    const after = buildPrnProjection(store, "cr-olivia", aged);
    expect(
      after.openEpisodes.some((e) => e.medication === "MysteryMed"),
    ).toBe(false);
    expect(
      after.openEpisodes.some(
        (e) =>
          e.medication === "Benadryl" &&
          /sleepy|taking/i.test(e.notes || ""),
      ),
    ).toBe(true);
  });
});
