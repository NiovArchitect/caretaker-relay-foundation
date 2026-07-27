import { describe, it, expect } from "vitest";
import {
  seedCareUniverse,
  UNIVERSES,
  answerRelayQuestion,
  createShiftAssignment,
  respondShiftAssignment,
  expireShiftAssignment,
} from "@caretaker-relay/care-domain";

describe("expired assignment Relay denial", () => {
  it("expired DSP cannot answer after expire even with known med names", () => {
    const u = UNIVERSES.find((x) => x.id === "A_rich_family")!;
    const store = seedCareUniverse(u);
    const assigner = u.actors[0]!;
    const dspId = "p-dsp-exp";
    store.upsertPerson({
      id: dspId,
      displayName: "Expired DSP",
      kind: "professional",
    });
    const startMs = Date.now() - 6 * 3600e3;
    const endMs = Date.now() - 2 * 3600e3;
    const created = createShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignerPersonId: assigner.id,
      assignerDisplayName: assigner.displayName,
      assigneePersonId: dspId,
      assigneeDisplayName: "Expired DSP",
      shiftStart: new Date(startMs).toISOString(),
      shiftEnd: new Date(endMs).toISOString(),
    });
    const id = (created as { assignment: { id: string } }).assignment.id;
    respondShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignmentId: id,
      actorPersonId: dspId,
      actorDisplayName: "Expired DSP",
      decision: "accept",
    });
    expireShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignmentId: id,
      actorPersonId: assigner.id,
    });

    for (const q of [
      "What medicines does she take today?",
      "Was Metformin administered?",
      "What is the next appointment?",
      "How is Alicia?",
    ]) {
      const r = answerRelayQuestion({
        store,
        principalId: dspId,
        principalDisplayName: "Expired DSP",
        roleLabel: "Direct support professional",
        careRecipientId: u.recipient.id,
        recipientDisplayName: u.recipient.displayName,
        question: q,
      });
      expect(r.authorizationOutcome).toBe("denied");
      expect(r.authorizationCode).toMatch(/EXPIRED|REVOKED|SHIFT/i);
      expect(r.answer).not.toMatch(/Metformin 500|Physical therapy/i);
    }
  });
});
