/**
 * Server intelligence authority tests — run with vitest from foundation or care-domain.
 */
import { describe, expect, it } from "vitest";
import { createCareRuntime } from "../index.js";
import { answerRelayQuestion } from "../services/relay-answer.js";
import {
  assertPrincipalIsolation,
  listTurns,
} from "./conversation-memory.js";

describe("server answer authority", () => {
  it("answers medication from store projections", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const r = answerRelayQuestion({
      question: "What medication does Evelyn need next?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus Carter",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    expect(r.answer).toMatch(/Metformin|500|12:00/i);
    expect(r.canDeterministic).toBe(true);
    expect(r.durable).toBe(true);
    expect(r.turnId).toBeTruthy();
  });

  it("persists turns and resolves it across calls (durable memory)", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    answerRelayQuestion({
      question: "What medication does Evelyn take with lunch?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus Carter",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    const follow = answerRelayQuestion({
      question: "When did Maya give it yesterday?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus Carter",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    expect(follow.answer).toMatch(/Maya|500|recorded|Last recorded/i);
    const turns = listTurns(store, "p-sadeil", "cr-olivia");
    expect(turns.length).toBeGreaterThanOrEqual(2);
  });

  it("isolates memory by recipient", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    answerRelayQuestion({
      question: "What medication is due next?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    const robert = answerRelayQuestion({
      question: "Did Maya give it yesterday?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-robert",
      recipientDisplayName: "Robert Hale",
      store,
    });
    expect(robert.answer).not.toMatch(/Metformin/i);
    expect(robert.answer).not.toMatch(/Evelyn/i);
  });

  it("isolates private turns across principals", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    answerRelayQuestion({
      question: "What medication is due next?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    answerRelayQuestion({
      question: "What changed since my last visit?",
      principalId: "p-walter",
      principalDisplayName: "Daniel",
      roleLabel: "Professional caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    const iso = assertPrincipalIsolation(
      store,
      "cr-olivia",
      "p-sadeil",
      "p-walter",
    );
    expect(iso.leak).toBe(false);
    expect(iso.aCount).toBeGreaterThan(0);
    expect(iso.bCount).toBeGreaterThan(0);
    const mayaSeesMarcus = listTurns(store, "p-maya", "cr-olivia");
    expect(mayaSeesMarcus.every((t) => t.principalId === "p-maya")).toBe(true);
  });

  it("same question changes when durable MAR truth changes", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    // Clear med records if any
    const state = store.getCurrentState("cr-olivia");
    const empty = {
      careRecipientId: "cr-olivia",
      medicationSchedules: (state?.medicationSchedules ?? []) as unknown as Array<
        Record<string, unknown>
      >,
      medicationRecords: [],
      appointments: (state?.appointments ?? []) as unknown as Array<
        Record<string, unknown>
      >,
      observations: [],
      events: [],
      openSafetyReviews: [],
      tasks: [],
    };
    const a = answerRelayQuestion({
      question: "Did anyone already give her lunch medicine?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
      stateOverride: empty,
    });
    const withMar = {
      ...empty,
      medicationRecords: [
        {
          id: "mar-x",
          doseRecorded: "500 mg",
          administeredAt: "2026-07-22T19:58:00Z",
          administeredByPersonId: "p-maya",
          name: "Metformin",
        },
      ],
    };
    const b = answerRelayQuestion({
      question: "Did anyone already give her lunch medicine?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
      stateOverride: withMar,
    });
    expect(a.answer).not.toEqual(b.answer);
    expect(b.answer).toMatch(/Maya|500|recorded/i);
  });

  it("role-conditions answers on server", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const q = "What's going on with Evelyn's medication?";
    const family = answerRelayQuestion({
      question: q,
      principalId: "p-sadeil",
      principalDisplayName: "Marcus",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    const dsp = answerRelayQuestion({
      question: q,
      principalId: "p-walter",
      principalDisplayName: "Daniel",
      roleLabel: "Professional caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    const md = answerRelayQuestion({
      question: q,
      principalId: "p-dr-shah",
      principalDisplayName: "Dr. Shah",
      roleLabel: "Primary care physician",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    expect(family.persona).toBe("family");
    expect(dsp.persona).toBe("professional_dsp");
    expect(md.persona).toBe("physician");
    expect(family.answer).not.toEqual(md.answer);
  });

  it("topic switch: it binds to medication not appointment", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    answerRelayQuestion({
      question: "When is PT?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    answerRelayQuestion({
      question: "What medication is due?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    const it = answerRelayQuestion({
      question: "Did Maya give it?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    expect(it.answer).toMatch(/Maya|Metformin|500|recorded|medication/i);
    expect(it.answer.toLowerCase()).not.toMatch(/physical therapy is tomorrow/);
  });
});
