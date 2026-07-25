import { describe, expect, it } from "vitest";
import { fixtureExtract } from "../../../packages/care-domain/src/services/understand.js";
import { people, careRecipient } from "../../../packages/care-domain/src/scenario/olivia.js";

const dspCtx = {
  sessionId: "s-dsp",
  actorPersonId: people.walter.id,
  actorDisplayName: people.walter.displayName,
  careRecipientId: careRecipient.id,
  householdId: "hh-lab",
  roles: ["Professional caregiver", "Direct support professional"],
};

const PHRASES = [
  "Evelyn needed help getting out of bed this morning.",
  "Evelyn walked from the bedroom to the kitchen with assistance.",
  "She needed support transferring from the chair.",
  "Evelyn used her walker today.",
  "She seemed unsteady when standing.",
  "I helped Evelyn with bathing and dressing.",
  "She ate most of breakfast with some assistance.",
  "Evelyn refused her shower this morning.",
  "She needed two reminders to get ready.",
  "Evelyn was more independent with dressing today.",
  "She needed help using the bathroom.",
  "Evelyn completed her exercises with assistance.",
  "She seemed more tired during her walk.",
  "I helped reposition her because she was uncomfortable.",
  "Evelyn participated well in her normal morning routine.",
  "Standby assistance for chair to walker transfer this afternoon.",
  "Helped with toileting and hand hygiene.",
  "She walked with the walker to the dining room.",
  "Needed assistance putting on shoes.",
  "Refused bathing but accepted a partial wash.",
  "More independent transferring bed to chair.",
  "Gait was slow but steady with the walker.",
  "Required physical assist to stand from the couch.",
  "Completed range of motion exercises with support.",
  "Needed prompts to start getting ready for the day.",
  "Sat for breakfast; needed help cutting food.",
  "Used wheelchair for longer hallway trip.",
  "Felt unsteady after standing too quickly.",
  "Assisted with evening hygiene routine.",
  "Support provided for safe bed mobility.",
];

describe("DSP support / mobility / ADL extraction", () => {
  it("structures 30 natural DSP utterances without 'not sure what to file'", () => {
    expect(PHRASES.length).toBeGreaterThanOrEqual(30);
    let ok = 0;
    for (const p of PHRASES) {
      const slice = fixtureExtract(p, dspCtx, careRecipient.displayName);
      const structured = slice.candidates.filter(
        (c) =>
          c.eventType === "observation" ||
          c.eventType === "meal" ||
          c.eventType === "note" ||
          c.eventType === "task",
      );
      const uncertainOnly =
        structured.length === 0 &&
        slice.uncertainties.some((u) => /not sure what to file/i.test(u));
      expect(uncertainOnly, p).toBe(false);
      expect(structured.length, p).toBeGreaterThan(0);
      expect(
        structured.every((c) => c.epistemicStatus === "REPORTED" || c.epistemicStatus === "UNCERTAIN"),
        p,
      ).toBe(true);
      ok++;
    }
    expect(ok).toBe(PHRASES.length);
  });

  it("does not invent a clinical diagnosis from mobility support wording", () => {
    const slice = fixtureExtract(
      "She needed support transferring from the chair.",
      dspCtx,
      careRecipient.displayName,
    );
    const obs = slice.candidates.find((c) => c.eventType === "observation");
    expect(obs).toBeTruthy();
    expect(obs!.statement.toLowerCase()).not.toMatch(
      /diagnos|fracture|prescri|order to|must take/i,
    );
    expect(obs!.epistemicStatus).toBe("REPORTED");
  });
});
