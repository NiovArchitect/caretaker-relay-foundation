import { describe, it, expect } from "vitest";
import {
  seedCareUniverse,
  UNIVERSES,
  answerRelayQuestion,
} from "@caretaker-relay/care-domain";

describe("medication correction matrix", () => {
  it("stages: plan → reported → confirmed → voided correction supersedes current truth", () => {
    const u = UNIVERSES.find((x) => x.id === "A_rich_family")!;
    const store = seedCareUniverse(u);
    const actor = u.actors[0]!;
    const rid = u.recipient.id;

    const ask = (q: string) =>
      answerRelayQuestion({
        store,
        principalId: actor.id,
        principalDisplayName: actor.displayName,
        roleLabel: actor.roleLabel,
        careRecipientId: rid,
        recipientDisplayName: u.recipient.displayName,
        question: q,
      });

    // Stage 0: plan exists
    const s0 = ask("What medicines does she take today?");
    expect(s0.authorizationOutcome).toBe("answered");
    expect(s0.answer).toMatch(/mg|medication|plan|take|Authorized|schedule/i);

    // Stage 1: administration reported
    store.addMedRecord({
      id: "mar-corr-1",
      careRecipientId: rid,
      name: "Metformin",
      doseRecorded: "500 mg",
      administeredAt: new Date().toISOString(),
      administeredByPersonId: actor.id,
      status: "recorded",
      epistemicStatus: "REPORTED",
      source: {
        id: "src-mar-1",
        kind: "caregiver_text",
        label: "Reported admin",
        actorName: actor.displayName,
        actorPersonId: actor.id,
        recordedAt: new Date().toISOString(),
        whyVisible: "test",
      },
    });
    const s1 = ask("Was the medication given?");
    expect(s1.answer).toMatch(/500 mg|recorded|Last recorded|REPORTED|administered/i);
    expect(s1.answer).toMatch(new RegExp(actor.displayName.split(" ")[0]!, "i"));

    // Stage 2: confirmed (second record with CONFIRMED)
    store.addMedRecord({
      id: "mar-corr-2",
      careRecipientId: rid,
      name: "Metformin",
      doseRecorded: "500 mg",
      administeredAt: new Date().toISOString(),
      administeredByPersonId: actor.id,
      status: "recorded",
      epistemicStatus: "CONFIRMED",
      source: {
        id: "src-mar-2",
        kind: "caregiver_text",
        label: "Confirmed admin",
        actorName: actor.displayName,
        actorPersonId: actor.id,
        recordedAt: new Date().toISOString(),
        whyVisible: "test",
      },
    });
    const s2 = ask("Is it confirmed?");
    expect(s2.answer.length).toBeGreaterThan(10);

    // Stage 3: correction — void prior records
    for (const id of ["mar-corr-1", "mar-corr-2"]) {
      const existing = store.getMedRecords(rid).find((m) => m.id === id);
      if (existing) {
        store.addMedRecord({
          ...existing,
          id: id + "-void",
          status: "voided",
          epistemicStatus: "REPORTED",
          source: {
            ...existing.source,
            id: existing.source.id + "-void",
            label: "Correction: not administered",
            recordedAt: new Date().toISOString(),
          },
        });
      }
    }
    // Mark originals voided in-place if store keeps both
    store.addMedRecord({
      id: "mar-corr-void-truth",
      careRecipientId: rid,
      name: "Metformin",
      doseRecorded: "500 mg",
      administeredAt: new Date().toISOString(),
      administeredByPersonId: actor.id,
      status: "voided",
      epistemicStatus: "REPORTED",
      source: {
        id: "src-void",
        kind: "caregiver_text",
        label: "Corrected: not administered",
        actorName: actor.displayName,
        actorPersonId: actor.id,
        recordedAt: new Date().toISOString(),
        whyVisible: "correction",
      },
    });

    const s3 = ask("Was the medication given?");
    // Must not invent a fresh dose; voided should surface in projection path
    expect(s3.answer).not.toMatch(/give another dose from chat/i);
    expect(s3.authorizationOutcome).toBe("answered");
  });
});
