import { describe, it, expect, beforeEach } from "vitest";
import {
  createCareRuntime,
  people,
  answerRelayQuestion,
  classifyIntent,
  normalizeCareQuestionText,
} from "@caretaker-relay/care-domain";

describe("relay intelligence restoration", () => {
  let store: ReturnType<typeof createCareRuntime>["store"];
  beforeEach(() => {
    ({ store } = createCareRuntime({ seedOlivia: true }));
  });

  function ask(q: string) {
    return answerRelayQuestion({
      store,
      principalId: people.sadeil.id,
      principalDisplayName: people.sadeil.displayName,
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      question: q,
    });
  }

  it("normalizes evenlyn typo against active recipient name only", () => {
    expect(
      normalizeCareQuestionText("How is evenlyn", ["Evelyn"]),
    ).toMatch(/Evelyn/i);
    // Without recipient context, do not hard-code Evelyn
    expect(normalizeCareQuestionText("How is evenlyn")).toBe("How is evenlyn");
  });

  it("answers how is evenlyn / how is evelyn / feeling", () => {
    for (const q of [
      "How is evenlyn",
      "How is Evelyn",
      "How is she feeling?",
    ]) {
      const r = ask(q);
      expect(r.answer).not.toMatch(/I don't have enough on file to answer that specifically/);
      expect(r.answer.toLowerCase()).toMatch(/evelyn|fatigue|medication|plain-language|picture|report/);
    }
  });

  it("answers mood previous shift and yesterday", () => {
    const mood = ask("What is her mood previous shift?");
    expect(mood.answer).not.toMatch(/I don't have enough on file to answer that specifically/);
    const y = ask("Did anything happen yesterday regarding Evelyn");
    expect(y.answer.toLowerCase()).toMatch(/changed|evelyn|report|file|nothing new|event/);
  });

  it("answers who is caregiver", () => {
    const r = ask("Who is your caregiver?");
    expect(r.answer.toLowerCase()).toMatch(/marcus|maya|helping|care/);
  });

  it("classifies yoga schedule and slot confirm", () => {
    expect(
      classifyIntent("Can you schedule an appointment for yoga tomorrow at 4pm?")
        .intents,
    ).toContain("APPOINTMENT_REQUEST_NEW");
    expect(
      classifyIntent("Wednesday, July 29 · 2:00 PM PDT").intents,
    ).toContain("APPOINTMENT_CONFIRM_BOOK");
  });

  it("multi-turn: request then confirm slot creates appointment request", () => {
    const a = ask("Can you schedule an appointment for yoga tomorrow at 4pm?");
    expect(a.answer.toLowerCase()).toMatch(/slot|available|request/);
    const b = ask("Wednesday, July 29 · 2:00 PM PDT");
    expect(b.answer.toLowerCase()).toMatch(/saved|request|scheduled|appointment/);
    expect(b.answer).not.toMatch(/not sure what to file/);
  });
});
