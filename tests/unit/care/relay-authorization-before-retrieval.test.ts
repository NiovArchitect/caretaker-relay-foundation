import { describe, it, expect, beforeEach } from "vitest";
import {
  createCareRuntime,
  people,
  answerRelayQuestion,
  seedCareUniverse,
  UNIVERSES,
  MemoryCareStore,
  authorizeRelayQuestion,
} from "@caretaker-relay/care-domain";

describe("permissioned Relay — authorization before retrieval", () => {
  let store: ReturnType<typeof createCareRuntime>["store"];
  beforeEach(() => {
    ({ store } = createCareRuntime({ seedOlivia: true }));
  });

  it("authorized family receives grounded care answer", () => {
    const r = answerRelayQuestion({
      store,
      principalId: people.sadeil.id,
      principalDisplayName: people.sadeil.displayName,
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      question: "How is Evelyn?",
    });
    expect(r.authorizationOutcome).toBe("answered");
    expect(r.answer).not.toMatch(/I can't access that information/);
    expect(r.answer.length).toBeGreaterThan(40);
  });

  it("zero-relationship principal is denied without confirming hidden data", () => {
    const r = answerRelayQuestion({
      store,
      principalId: "p-stranger-no-rel",
      principalDisplayName: "Stranger",
      roleLabel: "Visitor",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      question: "What medicines does she take today?",
    });
    expect(r.authorizationOutcome).toBe("denied");
    expect(r.authorizationCode).toMatch(/NO_RELATIONSHIP|UNKNOWN/);
    expect(r.answer).toMatch(/authorized access|invitation|assignment/i);
    // Must not dump medication plan
    expect(r.answer).not.toMatch(/Metformin 500/);
  });

  it("revoked membership cannot answer", () => {
    store.revokeAccess(
      "cr-olivia",
      people.maya.id,
      new Date().toISOString(),
    );
    const r = answerRelayQuestion({
      store,
      principalId: people.maya.id,
      principalDisplayName: people.maya.displayName,
      roleLabel: "Family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      question: "How is she feeling?",
    });
    expect(r.authorizationOutcome).toBe("denied");
    expect(r.authorizationCode).toBe("REVOKED");
    expect(r.answer).toMatch(/no longer active|revoked|expired/i);
    expect(r.answer).not.toMatch(/Fatigue after lunch/);
  });

  it("transport-only scope is denied medication domain", () => {
    const s = new MemoryCareStore();
    const u = UNIVERSES.find((x) => x.id === "B_sparse_new")!;
    seedCareUniverse(u, s);
    // Narrow Lena's access to appointments only
    const rel = s.getRelationship(u.recipient.id, u.primaryCaregiverId)!;
    s.upsertRelationship({
      ...rel,
      access: {
        informationCategories: ["appointments", "schedule"],
        allowedActions: ["view"],
        canEscalate: false,
        authorityLimits: ["no_medications"],
      },
    });
    // Add meds so unauthorized domain would be interesting
    s.upsertMedSchedule({
      id: "med-t-1",
      careRecipientId: u.recipient.id,
      name: "SecretMed",
      dose: "10 mg",
      scheduleLabel: "Morning",
      authorizedBy: "Dr X",
      authorizedAt: new Date().toISOString(),
      source: {
        id: "src-m",
        kind: "provider_instruction",
        label: "Plan",
        actorName: "Dr X",
        recordedAt: new Date().toISOString(),
        whyVisible: "plan",
      },
    });
    const r = answerRelayQuestion({
      store: s,
      principalId: u.primaryCaregiverId,
      principalDisplayName: "Lena Reed",
      roleLabel: "Transportation helper",
      careRecipientId: u.recipient.id,
      recipientDisplayName: u.recipient.displayName,
      question: "What medicines does she take today?",
    });
    expect(r.authorizationOutcome).toBe("denied");
    expect(r.answer).toMatch(/medication|permissions|access/i);
    expect(r.answer).not.toMatch(/SecretMed/);
  });

  it("cross-universe: Alicia caregiver cannot read Thomas", () => {
    const s = new MemoryCareStore();
    const alicia = UNIVERSES.find((x) => x.id === "A_rich_family")!;
    const thomas = UNIVERSES.find((x) => x.id === "B_sparse_new")!;
    seedCareUniverse(alicia, s);
    seedCareUniverse(thomas, s);
    const r = answerRelayQuestion({
      store: s,
      principalId: alicia.primaryCaregiverId,
      principalDisplayName: "Jordan Monroe",
      roleLabel: "Primary family caregiver",
      careRecipientId: thomas.recipient.id,
      recipientDisplayName: thomas.recipient.displayName,
      question: "How is Thomas today?",
    });
    expect(r.authorizationOutcome).toBe("denied");
    expect(r.answer).not.toMatch(/Metformin|Alicia|Evelyn/);
  });

  it("writes audit on deny and answer", () => {
    answerRelayQuestion({
      store,
      principalId: "p-stranger-audit",
      principalDisplayName: "X",
      roleLabel: "X",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      question: "How is she?",
    });
    const audits = store
      .listAudit()
      .filter((a) => a.action === "RELAY_ANSWER_DENIED");
    expect(audits.length).toBeGreaterThan(0);

    answerRelayQuestion({
      store,
      principalId: people.sadeil.id,
      principalDisplayName: people.sadeil.displayName,
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      question: "What is her medication?",
    });
    const ok = store
      .listAudit()
      .filter((a) => a.action === "RELAY_ANSWER_ACCESSED");
    expect(ok.length).toBeGreaterThan(0);
  });

  it("authorize helper distinguishes no-relationship", () => {
    const d = authorizeRelayQuestion(store, {
      principalId: "nobody",
      careRecipientId: "cr-olivia",
      roleLabel: "x",
      question: "How is she?",
    });
    expect(d.kind).toBe("denied");
  });
});
