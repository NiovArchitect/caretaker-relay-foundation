import { describe, expect, it } from "vitest";
import {
  fixtureExtract,
  toVerificationBundle,
} from "../../../packages/care-domain/src/services/understand.js";
import { people, careRecipient } from "../../../packages/care-domain/src/scenario/olivia.js";

const ctx = {
  sessionId: "s-test",
  actorPersonId: people.sadeil.id,
  actorDisplayName: people.sadeil.displayName,
  careRecipientId: careRecipient.id,
  householdId: "hh-lab",
  roles: ["Primary family caregiver"],
};

describe("wellbeing caregiver observations", () => {
  it("understands feels very good today as REPORTED observation", () => {
    const slice = fixtureExtract(
      "Evelyn feels very good today.",
      ctx,
      careRecipient.displayName,
    );
    expect(slice.candidates.length).toBeGreaterThan(0);
    const obs = slice.candidates.find((c) => c.eventType === "observation");
    expect(obs).toBeTruthy();
    expect(obs!.epistemicStatus).toBe("REPORTED");
    expect(obs!.statement.toLowerCase()).toMatch(/wellbeing|feels good|good/);
    expect(slice.uncertainties.some((u) => /not sure what to file/i.test(u))).toBe(
      false,
    );
  });

  it("understands seemed more tired", () => {
    const slice = fixtureExtract(
      "She seemed more tired than usual after lunch.",
      ctx,
      careRecipient.displayName,
    );
    const obs = slice.candidates.find((c) => c.eventType === "observation");
    expect(obs?.epistemicStatus).toBe("REPORTED");
  });

  it("does not surface OpenAI/system fallback noise as verify items", () => {
    const slice = fixtureExtract(
      "Evelyn feels very good today.",
      ctx,
      careRecipient.displayName,
    );
    slice.uncertainties = [
      "OpenAI provider failed: 429 You exceeded your current quota",
      "Structured fallback extraction used while the language model was unavailable",
    ];
    const bundle = toVerificationBundle(slice);
    expect(
      bundle.items.every(
        (i) => !/OpenAI|Structured fallback|quota/i.test(i.label),
      ),
    ).toBe(true);
    expect(
      bundle.items.some((i) => /wellbeing|feels good|observation/i.test(i.label)),
    ).toBe(true);
  });

  it("covers ordinary caregiver wellbeing phrases", () => {
    const phrases = [
      "She seems tired.",
      "She ate all her lunch.",
      "She slept well.",
      "She seems more alert.",
      "She wasn't herself this morning.",
      "She was in a great mood.",
    ];
    for (const p of phrases) {
      const slice = fixtureExtract(p, ctx, careRecipient.displayName);
      expect(slice.candidates.length, p).toBeGreaterThan(0);
      const structured = slice.candidates.find(
        (c) =>
          c.eventType === "observation" ||
          c.eventType === "meal" ||
          c.eventType === "note",
      );
      expect(structured, p).toBeTruthy();
      if (structured?.eventType === "observation") {
        expect(structured.epistemicStatus, p).toBe("REPORTED");
      }
      expect(structured!.recordedAt, p).toBeTruthy();
      expect(structured!.effectiveAt, p).toBeTruthy();
    }
  });
});
