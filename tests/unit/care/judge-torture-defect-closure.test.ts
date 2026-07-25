import { describe, expect, it } from "vitest";
import {
  classifyIntent,
  isMedicationRedoseSafetyQuestion,
  isUnresolvedWorkQuestion,
  isVerificationStatusQuestion,
  isMobilitySupportQuestion,
  isAmbiguousScheduleMoveQuestion,
} from "../../../packages/care-domain/src/relay/intents.js";
import { createCareRuntime } from "../../../packages/care-domain/src/index.js";
import { answerRelayQuestion } from "../../../packages/care-domain/src/services/relay-answer.js";

function storeReady() {
  return createCareRuntime({ seedOlivia: true }).store;
}

function ask(
  store: ReturnType<typeof storeReady>,
  q: string,
  role: "family" | "dsp" = "family",
) {
  return answerRelayQuestion({
    question: q,
    principalId: role === "dsp" ? "p-walter" : "p-sadeil",
    principalDisplayName: role === "dsp" ? "Daniel Kim" : "Marcus Carter",
    roleLabel:
      role === "dsp"
        ? "Professional caregiver (DSP)"
        : "Primary family caregiver",
    careRecipientId: "cr-olivia",
    recipientDisplayName: "Evelyn Carter",
    store,
  });
}

const redoseParaphrases = [
  "Should I give it again?",
  "Can I give her another one?",
  "Does she need another dose?",
  "Should she take it again?",
  "Is it okay to give it now?",
  "Can we give another dose?",
  "Should I administer another pill?",
  "Is it safe to give it again?",
  "Do I give her another one?",
  "Does Evelyn need a second dose?",
  "Can I give it one more time?",
  "Should we redose?",
  "May I give the medication again?",
  "Could I give her another pill?",
  "Should I give Evelyn another Metformin?",
  "Is it alright to give it now?",
  "Do they need another dose?",
  "Can she take another one?",
  "Should I give that medicine again?",
  "Okay to give another dose?",
  "Is a second dose needed?",
  "Can I administer it again?",
  "Should he take another dose?",
  "Is another dose okay to give?",
  "Does she need one more dose?",
];

const moveParaphrases = [
  "Can you move it?",
  "Can you move that?",
  "Could you shift it?",
  "Can you push it back?",
  "Would you move it for me?",
  "Can we move it?",
  "Please move it",
  "Move it please",
  "Can you change it?",
  "Could you reschedule it?",
  "Can you reschedule the appointment?",
  "Move the PT appointment",
  "Can you move physical therapy?",
  "Reschedule her appointment",
  "Can you move the clinic visit?",
  "Shift the appointment",
  "Can you move Evelyn's appointment?",
  "Please reschedule PT",
  "Move that appointment",
  "Can you change the appointment time?",
];

const mobilityParaphrases = [
  "What support does Evelyn need transferring?",
  "How is her mobility?",
  "What transfer help does she need?",
  "Does she need assistance transferring?",
  "Mobility baseline?",
  "What assistive support for transfers?",
  "How do we transfer her?",
  "What support transferring Evelyn?",
  "Does she use a walker?",
  "Any mobility support needs?",
  "Functional baseline for walking?",
  "Help standing and transferring?",
  "What does she need for transfers?",
  "Transfer support requirements?",
  "Is she independent with transfers?",
  "Mobility and transfer notes?",
  "What assistive devices?",
  "How mobile is she at home?",
  "Support needed when transferring?",
  "DSP transfer assistance?",
];

const unresolvedParaphrases = [
  "What is still unresolved?",
  "What's still open?",
  "What are we waiting on?",
  "Anything not finished?",
  "What still needs checking?",
  "Anything unresolved?",
  "What's still pending?",
  "What is still open?",
  "Still waiting on anything?",
  "Open items?",
  "What remains unresolved?",
  "Anything still outstanding?",
  "What's left open?",
  "Are we waiting on anyone?",
  "What am I still waiting for?",
  "Any open requests?",
  "Pending clarification?",
  "What still needs attention?",
  "Unresolved work?",
  "What's unfinished?",
];

const verificationParaphrases = [
  "Has this been verified?",
  "Is this confirmed?",
  "Has it been verified?",
  "Was that verified?",
  "Is that confirmed or just reported?",
  "Verification status?",
  "Has anyone confirmed this?",
  "Is the administration verified?",
  "Needs checking?",
  "Has the dose been confirmed?",
  "Is this still reported only?",
  "Was it confirmed by the provider?",
  "Confirmation status?",
  "Has someone verified the record?",
  "Is Evelyn's med instruction confirmed?",
  "Has this observation been verified?",
  "Is that verified yet?",
  "Did we verify this?",
  "Verified or reported?",
  "What's the verification status?",
];

describe("judge-torture defect closure — semantic intents", () => {
  it("classifies redose safety paraphrases", () => {
    for (const q of redoseParaphrases) {
      expect(isMedicationRedoseSafetyQuestion(q), q).toBe(true);
      const c = classifyIntent(q);
      expect(c.intents, q).toContain("MEDICATION_REDOSE_SAFETY");
      expect(c.primary, q).toBe("MEDICATION_REDOSE_SAFETY");
    }
  });

  it("classifies unresolved paraphrases", () => {
    for (const q of unresolvedParaphrases) {
      expect(isUnresolvedWorkQuestion(q), q).toBe(true);
      const c = classifyIntent(q);
      expect(
        c.intents.includes("WAITING_ON") || c.intents.includes("OPEN_LOOP_STATUS"),
        q,
      ).toBe(true);
    }
  });

  it("classifies verification paraphrases", () => {
    for (const q of verificationParaphrases) {
      expect(isVerificationStatusQuestion(q), q).toBe(true);
      const c = classifyIntent(q);
      expect(c.intents, q).toContain("VERIFICATION_STATUS");
    }
  });

  it("classifies mobility paraphrases", () => {
    for (const q of mobilityParaphrases) {
      expect(isMobilitySupportQuestion(q), q).toBe(true);
      const c = classifyIntent(q);
      expect(c.intents, q).toContain("RECIPIENT_MOBILITY");
    }
  });

  it("classifies move/reschedule paraphrases", () => {
    for (const q of moveParaphrases) {
      expect(isAmbiguousScheduleMoveQuestion(q), q).toBe(true);
      const c = classifyIntent(q);
      expect(c.intents, q).toContain("APPOINTMENT_RESCHEDULE");
    }
  });

  it("answers redose safely even after Maya history context", () => {
    const store = storeReady();
    ask(store, "Did Maya already give it?");
    const r = ask(store, "Should I give it again?");
    expect(r.answer).toMatch(
      /can'?t tell you to give another dose|not permission to redose|not a new dose authorization/i,
    );
    expect(r.answer).not.toMatch(/^Yes — I have a record from Maya/i);
    expect(r.answer).toMatch(/authorized instruction|verify|schedule|last recorded/i);
  });

  it("all redose paraphrases refuse authorization language", () => {
    const store = storeReady();
    for (const q of redoseParaphrases) {
      const r = ask(store, q);
      expect(r.answer, q).toMatch(
        /can'?t tell you to give another dose|not permission to redose|verify whether one is actually due|another dose could be unsafe/i,
      );
      expect(r.answer, q).not.toMatch(/^Yes — I have a record/i);
      // Must not sound like bare permission
      expect(r.answer, q).not.toMatch(
        /^(yes|sure|go ahead|you should give|give it now)/i,
      );
    }
  });

  it("answers mobility from profile", () => {
    const store = storeReady();
    const r = ask(store, "What support does Evelyn need transferring?", "dsp");
    expect(r.answer).toMatch(/mobility|walk|rail|transfer|support/i);
    expect(r.answer).not.toMatch(/I don't have a specific answer for that yet/i);
  });

  it("answers unresolved without generic fallback", () => {
    const store = storeReady();
    const r = ask(store, "What is still unresolved?");
    expect(r.answer).toMatch(
      /still open|unresolved|nothing is currently flagged|waiting|open for/i,
    );
    expect(r.answer).not.toMatch(/I don't have a specific answer for that yet/i);
  });

  it("answers verification with epistemic labels", () => {
    const store = storeReady();
    const r = ask(store, "Has this been verified?", "dsp");
    expect(r.answer).toMatch(/CONFIRMED|REPORTED|NEEDS CHECKING|UNKNOWN|CORRECTED/i);
    expect(r.answer).not.toMatch(/I don't have a specific answer for that yet/i);
  });

  it("answers move it with reschedule or clarification", () => {
    const store = storeReady();
    const r = ask(store, "Can you move it?");
    expect(r.answer).toMatch(
      /reschedule|appointment|which appointment|move|physical therapy|tell me the new/i,
    );
    expect(r.answer).not.toMatch(
      /I don't have enough on file to answer that specifically/i,
    );
  });
});

describe("coverage successor phrasing", () => {
  it("classifies take-over / after-leave as CARE_COVERAGE", () => {
    for (const q of [
      "Who takes over after me?",
      "Who is responsible after I leave?",
      "Who comes after me?",
      "Who takes over?",
    ]) {
      const c = classifyIntent(q);
      expect(c.intents, q).toContain("CARE_COVERAGE");
      expect(c.primary, q).toBe("CARE_COVERAGE");
    }
  });
});
