import { describe, it, expect } from "vitest";
import {
  createCareRuntime,
  answerRelayQuestion,
  people,
} from "@caretaker-relay/care-domain";

describe("active session revocation", () => {
  it("follow-up and replay after revoke are denied; audits attempts", () => {
    const { store } = createCareRuntime({ seedOlivia: true });

    const before = answerRelayQuestion({
      store,
      principalId: people.maya.id,
      principalDisplayName: people.maya.displayName,
      roleLabel: "Family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      question: "How is Evelyn?",
    });
    expect(before.authorizationOutcome).toBe("answered");

    store.revokeAccess("cr-olivia", people.maya.id, new Date().toISOString());

    const follow = answerRelayQuestion({
      store,
      principalId: people.maya.id,
      principalDisplayName: people.maya.displayName,
      roleLabel: "Family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      question: "What about her medication?",
    });
    expect(follow.authorizationOutcome).toBe("denied");
    expect(follow.answer).not.toMatch(/Metformin 500/);

    const replay = answerRelayQuestion({
      store,
      principalId: people.maya.id,
      principalDisplayName: people.maya.displayName,
      roleLabel: "Family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      question: "How is Evelyn?",
    });
    expect(replay.authorizationOutcome).toBe("denied");
    expect(replay.answer).not.toMatch(/Fatigue/);

    const deniedAudits = store
      .listAudit()
      .filter((a) => a.action === "RELAY_ANSWER_DENIED");
    expect(deniedAudits.length).toBeGreaterThanOrEqual(2);
  });
});
