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
  hasOpenPrnReassessment,
  ensurePrnOverdueEscalation,
  setPrnOrderStatus,
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

  it("charts a second authorized PRN class without pain-interval collision", () => {
    createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Acetaminophen",
      symptom: "knee pain",
      confirm: true,
    });
    const nausea = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      severityBefore: "moderate",
      confirm: true,
    });
    expect(nausea.ok).toBe(true);
    if (!nausea.ok) return;
    expect(nausea.episode.medication).toMatch(/Ondansetron/i);
    expect(nausea.episode.lifecycle).toBe("reassessment_due");
    const proj = buildPrnProjection(store, "cr-olivia");
    expect(proj.orders.length).toBeGreaterThanOrEqual(2);
    expect(proj.reassessmentDue.some((e) => /ondansetron/i.test(e.medication))).toBe(
      true,
    );
  });

  it("allows a different caregiver to complete reassessment on the same episode", () => {
    createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
    });
    const re = reassessPrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-maya",
      actorDisplayName: "Maya Chen",
      effect: "improved",
      severityAfter: "mild",
    });
    expect(re.ok).toBe(true);
    if (!re.ok) return;
    expect(re.episode.effect).toBe("improved");
    expect(re.episode.reassessmentCompletedAt).toBeTruthy();
    const proj = buildPrnProjection(store, "cr-olivia");
    expect(
      proj.reassessmentDue.filter((e) => /ondansetron/i.test(e.medication)),
    ).toHaveLength(0);
  });

  it("does not create a second administration on double confirm (idempotent)", () => {
    const first = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.episode.id).toBe(first.episode.id);
    expect(second.plainLanguage).toMatch(/already charted|No second dose|already recorded/i);
    const open = buildPrnProjection(store, "cr-olivia").reassessmentDue.filter(
      (e) => /ondansetron/i.test(e.medication),
    );
    expect(open.length).toBe(1);
  });

  it("rejects confirm after order is deactivated (stale preview) without charting", () => {
    const preview = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: false,
    });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const orderId = preview.order!.id;
    setPrnOrderStatus(
      store,
      "cr-olivia",
      orderId,
      "ended",
      "p-dr-shah",
      "Dr. Priya Shah",
    );
    expect(listPrnOrders(store, "cr-olivia").some((o) => o.id === orderId)).toBe(
      false,
    );
    const confirm = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
      orderId,
    });
    expect(confirm.ok).toBe(false);
    if (confirm.ok) return;
    expect(confirm.code).toBe("PRN_ORDER_INACTIVE");
    expect(confirm.message).toMatch(/no longer active|deactivated|changed/i);
    const due = buildPrnProjection(store, "cr-olivia").reassessmentDue.filter(
      (e) => /ondansetron/i.test(e.medication),
    );
    expect(due).toHaveLength(0);
  });

  it("retries with the same idempotency key return one episode (offline recovery)", () => {
    const key = "client-action-prn-ond-1";
    const a = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
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
      actorDisplayName: "Marcus Carter",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
      idempotencyKey: key,
    });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.episode.id).toBe(a.episode.id);
    expect(b.plainLanguage).toMatch(/Already recorded|No duplicate|already charted/i);
    const open = buildPrnProjection(store, "cr-olivia").reassessmentDue.filter(
      (e) => /ondansetron/i.test(e.medication),
    );
    expect(open.length).toBe(1);
  });

  it("marks overdue reassessment once and does not duplicate handoff lines", () => {
    const admin = createOrAdvancePrnEpisode(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: "p-sadeil",
      actorDisplayName: "Marcus Carter",
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
      administeredAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });
    expect(admin.ok).toBe(true);
    if (!admin.ok) return;
    // Force due in the past via second write if needed — episode uses reassess minutes from admin time
    const pastDue = Date.now() + 60_000; // projection clock after due
    // administered 3h ago with 45m reassess → overdue
    expect(hasOpenPrnReassessment(store, "cr-olivia")).toBe(true);
    const a = ensurePrnOverdueEscalation(store, "cr-olivia", pastDue);
    expect(a.overdueCount).toBeGreaterThanOrEqual(1);
    const b = ensurePrnOverdueEscalation(store, "cr-olivia", pastDue);
    expect(b.overdueCount).toBeGreaterThanOrEqual(1);
    // second call should not re-escalate same ids if audit already written
    const audits = store
      .listAudit({ careRecipientId: "cr-olivia" })
      .filter((x) => x.action === "PRN_REASSESS_OVERDUE");
    expect(audits.length).toBe(1);
    const proj = buildPrnProjection(store, "cr-olivia", pastDue);
    expect(proj.overdue.length).toBeGreaterThanOrEqual(1);
  });
});
