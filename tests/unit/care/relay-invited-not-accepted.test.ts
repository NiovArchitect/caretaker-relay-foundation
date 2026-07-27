import { describe, it, expect } from "vitest";
import {
  createCareRuntime,
  answerRelayQuestion,
  encodeInvitationUpdate,
  people,
} from "@caretaker-relay/care-domain";

describe("invited-not-accepted Relay denial", () => {
  it("pending invitation yields INVITED_NOT_ACCEPTED with zero care content", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const inviteeId = "p-invitee-pending";
    store.upsertPerson({
      id: inviteeId,
      displayName: "Pending Invitee",
      kind: "family_caregiver",
    });
    const now = new Date().toISOString();
    const inv = {
      id: "inv-pending-1",
      careRecipientId: "cr-olivia",
      token: "tok-test-pending",
      inviterPersonId: people.sadeil.id,
      inviteePersonId: inviteeId,
      inviteeDisplayName: "Pending Invitee",
      role: "family_caregiver" as const,
      roleLabel: "Family caregiver",
      status: "pending" as const,
      createdAt: now,
      expiresAt: new Date(Date.now() + 7 * 864e5).toISOString(),
    };
    store.addUpdate(
      encodeInvitationUpdate(inv, {
        id: "src-inv-1",
        kind: "system_derived",
        label: "Invitation",
        actorPersonId: people.sadeil.id,
        actorName: people.sadeil.displayName,
        recordedAt: now,
        whyVisible: "Invite flow",
      }),
    );

    for (const q of [
      "What medicines does she take today?",
      "What appointments does she have?",
      "How is her mood?",
      "Show emergency information",
      "Who is on the care team?",
      "What happened yesterday?",
    ]) {
      const r = answerRelayQuestion({
        store,
        principalId: inviteeId,
        principalDisplayName: "Pending Invitee",
        roleLabel: "Family caregiver",
        careRecipientId: "cr-olivia",
        recipientDisplayName: "Evelyn Carter",
        question: q,
      });
      expect(r.authorizationOutcome).toBe("denied");
      expect(r.authorizationCode).toBe("INVITED_NOT_ACCEPTED");
      expect(r.answer).not.toMatch(/Metformin|Fatigue|Priya|emergency|allergy/i);
    }
  });

  it("no invitation and no relationship → NO_RELATIONSHIP without naming secrets", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const r = answerRelayQuestion({
      store,
      principalId: "p-zero-access-x",
      principalDisplayName: "Nobody",
      roleLabel: "Visitor",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      question: "How is Evelyn?",
    });
    expect(r.authorizationOutcome).toBe("denied");
    expect(r.answer).not.toMatch(/Metformin|Fatigue after/);
  });
});
