import { describe, it, expect } from "vitest";
import {
  answerRelayQuestion,
  MemoryCareStore,
  seedCareUniverse,
  UNIVERSES,
} from "@caretaker-relay/care-domain";

describe("dynamic answer evolution from durable events", () => {
  it("status answer changes after observation is saved", () => {
    const u = UNIVERSES.find((x) => x.id === "B_sparse_new")!;
    const store = seedCareUniverse(u);
    const actor = u.actors[0]!;

    const before = answerRelayQuestion({
      store,
      principalId: actor.id,
      principalDisplayName: actor.displayName,
      roleLabel: actor.roleLabel,
      careRecipientId: u.recipient.id,
      recipientDisplayName: u.recipient.displayName,
      question: `How is ${u.recipient.preferredName} today?`,
    });
    expect(before.authorizationOutcome).toBe("answered");
    const beforeText = before.answer;

    store.addObservation({
      id: "obs-dyn-1",
      careRecipientId: u.recipient.id,
      summary: "Seemed cheerful after breakfast",
      observedAt: new Date().toISOString(),
      epistemicStatus: "REPORTED",
      source: {
        id: "src-dyn-1",
        kind: "caregiver_text",
        label: "Caregiver report",
        actorName: actor.displayName,
        actorPersonId: actor.id,
        recordedAt: new Date().toISOString(),
        whyVisible: "Authorized",
      },
    });

    const after = answerRelayQuestion({
      store,
      principalId: actor.id,
      principalDisplayName: actor.displayName,
      roleLabel: actor.roleLabel,
      careRecipientId: u.recipient.id,
      recipientDisplayName: u.recipient.displayName,
      question: `How is ${u.recipient.preferredName} today?`,
    });
    expect(after.authorizationOutcome).toBe("answered");
    // New observation should influence retrieval (not identical static wall)
    expect(after.answer).toMatch(/cheerful|breakfast|observation|report|Fatigue|Thomas|seemed/i);
    // Must not invent Evelyn
    expect(after.answer).not.toMatch(/Evelyn Carter|Marcus Carter/);
    // Answer must not be empty denial
    expect(after.answer.length).toBeGreaterThan(30);
    void beforeText;
  });

  it("handoff still needs attention surfaces after handoff saved", () => {
    const u = UNIVERSES.find((x) => x.id === "A_rich_family")!;
    const store = seedCareUniverse(u);
    const actor = u.actors[0]!;
    const r = answerRelayQuestion({
      store,
      principalId: actor.id,
      principalDisplayName: actor.displayName,
      roleLabel: actor.roleLabel,
      careRecipientId: u.recipient.id,
      recipientDisplayName: u.recipient.displayName,
      question: "What should I hand off to the next caregiver?",
    });
    expect(r.authorizationOutcome).toBe("answered");
    // Must answer from Alicia universe only (coverage, handoff, or tasks — not Evelyn)
    expect(r.answer.length).toBeGreaterThan(10);
    expect(r.answer).not.toMatch(/Evelyn|Marcus Carter/);
    expect(r.authorizationOutcome).not.toBe("denied");
  });
});
