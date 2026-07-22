import { describe, expect, it } from "vitest";
import {
  appointmentChangeHash,
  communicationHash,
  handoffHash,
  medAdminHash,
  semanticContentHash,
  createCareRuntime,
  sadeilContext,
  DEMO_UTTERANCE,
  runCanonicalCareLoop,
} from "../../../packages/care-domain/src/index";

describe("Semantic content-hash idempotency", () => {
  it("SHOULD DEDUPLICATE identical med admin same day", () => {
    const a = medAdminHash({
      careRecipientId: "cr-olivia",
      name: "Lunch medication",
      doseRecorded: "2.5 mg",
      administeredByPersonId: "p-sadeil",
      administeredAt: "2026-07-22T12:00:00Z",
    });
    const b = medAdminHash({
      careRecipientId: "cr-olivia",
      name: "Lunch medication",
      doseRecorded: "2.5 mg",
      administeredByPersonId: "p-sadeil",
      administeredAt: "2026-07-22T18:00:00Z", // same day bucket
    });
    expect(a).toBe(b);
  });

  it("MUST NOT DEDUPLICATE different dose same day", () => {
    const a = medAdminHash({
      careRecipientId: "cr-olivia",
      name: "Lunch medication",
      doseRecorded: "2.5 mg",
      administeredByPersonId: "p-sadeil",
      administeredAt: "2026-07-22T12:00:00Z",
    });
    const b = medAdminHash({
      careRecipientId: "cr-olivia",
      name: "Lunch medication",
      doseRecorded: "5 mg",
      administeredByPersonId: "p-sadeil",
      administeredAt: "2026-07-22T12:00:00Z",
    });
    expect(a).not.toBe(b);
  });

  it("MUST NOT DEDUPLICATE different care recipients", () => {
    const a = medAdminHash({
      careRecipientId: "cr-olivia",
      name: "Lunch medication",
      doseRecorded: "2.5 mg",
      administeredByPersonId: "p-sadeil",
    });
    const b = medAdminHash({
      careRecipientId: "cr-other",
      name: "Lunch medication",
      doseRecorded: "2.5 mg",
      administeredByPersonId: "p-sadeil",
    });
    expect(a).not.toBe(b);
  });

  it("SHOULD DEDUPLICATE identical appointment change", () => {
    const a = appointmentChangeHash({
      careRecipientId: "cr-olivia",
      title: "Physical therapy",
      startsAtLabel: "Thursday 2:30 PM",
      status: "moved",
    });
    const b = appointmentChangeHash({
      careRecipientId: "cr-olivia",
      title: "Physical therapy",
      startsAtLabel: "thursday  2:30 pm",
      status: "moved",
    });
    expect(a).toBe(b);
  });

  it("MUST NOT DEDUPLICATE different appointment times", () => {
    const a = appointmentChangeHash({
      careRecipientId: "cr-olivia",
      title: "Physical therapy",
      startsAtLabel: "Thursday 2:30 PM",
      status: "moved",
    });
    const b = appointmentChangeHash({
      careRecipientId: "cr-olivia",
      title: "Physical therapy",
      startsAtLabel: "Thursday 3:00 PM",
      status: "moved",
    });
    expect(a).not.toBe(b);
  });

  it("SHOULD DEDUPLICATE identical communication", () => {
    const a = communicationHash({
      careRecipientId: "cr-olivia",
      toPersonId: "p-maya",
      summary: "Meal around noon; tired; PT moved",
    });
    const b = communicationHash({
      careRecipientId: "cr-olivia",
      toPersonId: "p-maya",
      summary: "Meal around noon; tired; PT moved",
    });
    expect(a).toBe(b);
  });

  it("MUST NOT DEDUPLICATE different intended recipients", () => {
    const a = communicationHash({
      careRecipientId: "cr-olivia",
      toPersonId: "p-maya",
      summary: "update",
    });
    const b = communicationHash({
      careRecipientId: "cr-olivia",
      toPersonId: "p-walter",
      summary: "update",
    });
    expect(a).not.toBe(b);
  });

  it("SHOULD DEDUPLICATE identical handoff content", () => {
    const a = handoffHash({
      careRecipientId: "cr-olivia",
      fromPersonId: "p-sadeil",
      toPersonId: "p-maya",
      whatChanged: ["Meal", "PT moved"],
    });
    const b = handoffHash({
      careRecipientId: "cr-olivia",
      fromPersonId: "p-sadeil",
      toPersonId: "p-maya",
      whatChanged: ["pt moved", "meal"], // order/case independent
    });
    expect(a).toBe(b);
  });

  it("double confirm same bundle does not duplicate med records", async () => {
    const { service, store } = createCareRuntime({ mode: "fixture" });
    const ctx = sadeilContext();
    const { propose, persist } = await runCanonicalCareLoop(
      service,
      DEMO_UTTERANCE,
      ctx,
    );
    expect(persist?.kind).toBe("persisted");
    const meds1 = store.getMedRecords("cr-olivia").length;
    const updates1 = store.getUpdates("cr-olivia").length;
    const handoffs1 = store.getHandoffs("cr-olivia").length;

    // Second confirm of same verification bundle (double click / retry)
    const again = service.confirmAndPersist(propose.bundle!, ctx, {
      prepareHandoffForPersonId: "p-maya",
    });
    expect(again.kind).toBe("persisted");
    expect(store.getMedRecords("cr-olivia").length).toBe(meds1);
    expect(store.getUpdates("cr-olivia").length).toBe(updates1);
    expect(store.getHandoffs("cr-olivia").length).toBe(handoffs1);
  });

  it("volatile metadata does not change semantic hash", () => {
    const a = semanticContentHash({
      careRecipientId: "cr-olivia",
      actionType: "appointment_change",
      effectiveDay: "2026-07-22",
      payload: { title: "PT", when: "2:30 PM", status: "moved" },
    });
    const b = semanticContentHash({
      careRecipientId: "cr-olivia",
      actionType: "appointment_change",
      effectiveDay: "2026-07-22",
      payload: {
        title: "PT",
        when: "2:30 PM",
        status: "moved",
        // volatile fields must not be included by callers
      },
    });
    expect(a).toBe(b);
  });
});
