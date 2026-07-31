import { describe, it, expect } from "vitest";
import {
  answerRelayQuestion,
  createCareRuntime,
} from "@caretaker-relay/care-domain";

function ask(question: string) {
  const { store } = createCareRuntime({ seedOlivia: true });
  return answerRelayQuestion({
    store,
    principalId: "p-sadeil",
    principalDisplayName: "Marcus Carter",
    roleLabel: "Primary family caregiver",
    careRecipientId: "cr-olivia",
    recipientDisplayName: "Evelyn Carter",
    question,
  });
}

describe("R-CONTEXT priority and person referent", () => {
  it("R-CONTEXT-001 what should I do first grounds in open priority", () => {
    const r = ask("What should I do first?");
    expect(r.answer).toMatch(/start with/i);
    expect(r.answer).not.toMatch(/I don't have a record that answers/i);
  });

  it("R-CONTEXT-001 paraphrases where should I start", () => {
    const r = ask("Where should I start?");
    expect(r.answer).toMatch(/start with/i);
    expect(r.answer).not.toMatch(/I don't have a record that answers/i);
  });

  it("R-CONTEXT-001 what comes first", () => {
    const r = ask("What comes first?");
    expect(r.answer).toMatch(/start with/i);
    expect(r.answer).not.toMatch(/I don't have a record that answers/i);
  });

  it("R-CONTEXT-002 what is Maya handling grounds person", () => {
    const r = ask("What is Maya handling?");
    expect(r.answer).toMatch(/Maya/i);
    expect(r.answer).not.toMatch(/I don't have a record that answers/i);
  });

  it("R-CONTEXT-002 what is Maya taking care of", () => {
    const r = ask("What is Maya taking care of?");
    expect(r.answer).toMatch(/Maya/i);
    expect(r.answer).not.toMatch(/I don't have a record that answers/i);
  });
});
