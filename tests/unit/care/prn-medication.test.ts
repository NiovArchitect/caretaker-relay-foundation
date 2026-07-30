/**
 * PRN (as-needed) medication order + episode charting unit tests.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemoryCareStore } from "../../../packages/care-domain/src/store/memory-store.js";
import { seedOliviaScenario } from "../../../packages/care-domain/src/scenario/olivia.js";
import {
  seedEvelynPrnOrders,
  listPrnOrders,
  createOrAdvancePrnEpisode,
  reassessPrnEpisode,
  buildPrnProjection,
  intervalAllows,
  lastPrnAdministration,
  answerPrnQuestion,
} from "../../../packages/care-domain/src/services/prn-medication.js";

describe("PRN medication charting", () => {
  let store: MemoryCareStore;

  beforeEach(() => {
    store = new MemoryCareStore();
    seedOliviaScenario(store);
    seedEvelynPrnOrders(store, "cr-olivia");
  });

  it("seeds authorized acetaminophen PRN order without inventing doses", () => {
    const orders = listPrnOrders(store, "cr-olivia");
    expect(orders.length).toBeGreaterThanOrEqual(1);
    const ac = orders.find((o) => /acetaminophen/i.test(o.medication));
    expect(ac?.allowedDose).toMatch(/500/);
    expect(ac?.indication).toMatch(/pain/i);
    expect(ac?.minIntervalHours).toBe(6);
    expect(ac?.authorizedBy).toMatch(/Shah/i);
  });

  it("previews PRN administration requiring confirmation — does not invent dose", () => {
    const preview = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Tylenol",
      symptom: "knee pain",
      severityBefore: "7/10",
      confirm: false,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.needsConfirmation).toBe(true);
    expect(preview.plainLanguage).toMatch(/as-needed|Ready to verify|confirm PRN/i);
    expect(preview.plainLanguage).not.toMatch(/you should give|I recommend/i);
    expect(preview.order?.medication).toMatch(/Acetaminophen/i);
  });

  it("charts reason, dose, time and opens reassessment on confirm", () => {
    const admin = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Acetaminophen",
      symptom: "knee pain",
      severityBefore: "7/10",
      confirm: true,
    });
    expect(admin.ok).toBe(true);
    if (!admin.ok) return;
    expect(admin.episode.outcome).toBe("administered");
    expect(admin.episode.symptom).toMatch(/knee pain/i);
    expect(admin.episode.lifecycle).toBe("reassessment_due");
    expect(admin.episode.reassessmentDueAt).toBeTruthy();
    expect(admin.plainLanguage).toMatch(/Charted|follow-up|knee pain/i);

    const proj = buildPrnProjection(store, "cr-olivia");
    expect(proj.reassessmentDue.length).toBeGreaterThanOrEqual(1);
  });

  it("completes effectiveness result and preserves reason+result together", () => {
    createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Acetaminophen",
      symptom: "knee pain",
      severityBefore: "7/10",
      confirm: true,
    });
    const re = reassessPrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      effect: "improved",
      severityAfter: "3/10",
    });
    expect(re.ok).toBe(true);
    if (!re.ok) return;
    expect(re.episode.effect).toBe("improved");
    expect(re.episode.severityAfter).toBe("3/10");
    expect(re.episode.reassessmentCompletedAt).toBeTruthy();
    expect(re.plainLanguage).toMatch(/helped|3\/10|knee pain/i);
  });

  it("does not treat unauthorized Benadryl report as active PRN order", () => {
    const r = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Benadryl",
      symptom: "itching",
      confirm: false,
      forceUnauthorized: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.episode.unauthorizedReport).toBe(true);
    expect(r.plainLanguage).toMatch(/not.*authorized|flag it for review/i);
    expect(r.plainLanguage).not.toMatch(/added to the active plan/i);
  });

  it("enforces minimum interval after administration", () => {
    const first = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Acetaminophen",
      symptom: "pain",
      confirm: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const order = first.order!;
    const last = lastPrnAdministration(store, "cr-olivia", order.id);
    const check = intervalAllows(order, last, Date.now() + 60 * 60 * 1000); // 1h later
    expect(check.ok).toBe(false);
    expect(check.human).toMatch(/interval|hours remain/i);
  });

  it("answers PRN inventory questions without recommending a dose", () => {
    const a = answerPrnQuestion(
      store,
      "cr-olivia",
      "Evelyn Carter",
      "What PRN medication can Evelyn take for pain?",
    );
    expect(a).toBeTruthy();
    expect(a).toMatch(/Acetaminophen|as-needed|authorized/i);
    expect(a).not.toMatch(/you should give|take two now/i);
  });
});
