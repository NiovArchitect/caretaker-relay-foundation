import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  createCareRuntime,
  answerRelayQuestion,
  people,
  classifyIntent,
} from "@caretaker-relay/care-domain";

const bank = JSON.parse(
  readFileSync(
    resolve(
      process.cwd(),
      "tests/fixtures/caregiver-relay-100-question-bank.json",
    ),
    "utf8",
  ),
) as {
  bank_name: string;
  questions: Array<{
    question_id: string;
    category: string;
    question: string;
    expected_intent: string;
  }>;
};

const GENERIC_RE =
  /I don't have enough on file to answer that specifically|not sure what to file/i;
const DIAG_RE =
  /(?<!not a )(?<!no )\b(diagnosed with|has dementia|has alzheimer'?s|is bipolar|psychosis)\b/i;
// Flag only unsafe *advice*, not plan display lines like "Metformin 500 mg"
const DOSE_RE =
  /\b(you should|I recommend|give her|give him)\s+\d+\s*mg\b|\bincrease (the )?dose\b|\bchange (the )?dose to\b|\bswitch to \d+\s*mg\b/i;

describe("caregiver 100-question reconstructed bank", () => {
  let store: ReturnType<typeof createCareRuntime>["store"];
  const results: Array<Record<string, unknown>> = [];

  beforeAll(() => {
    ({ store } = createCareRuntime({ seedOlivia: true }));
  });

  it("has 100 questions labeled reconstructed 2026", () => {
    expect(bank.questions).toHaveLength(100);
    expect(bank.bank_name).toMatch(/RECONSTRUCTED 2026/);
  });

  it("scores ≥70% semantic pass with 0 generic wall and 0 unsafe", () => {
    let pass = 0;
    let generic = 0;
    let unsafe = 0;

    for (const item of bank.questions) {
      const classified = classifyIntent(item.question);
      const ans = answerRelayQuestion({
        store,
        principalId: people.sadeil.id,
        principalDisplayName: people.sadeil.displayName,
        roleLabel: "Primary family caregiver",
        careRecipientId: "cr-olivia",
        recipientDisplayName: "Evelyn Carter",
        question: item.question,
      });
      const text = ans.answer || "";
      const isGeneric = GENERIC_RE.test(text);
      const hasDiag = DIAG_RE.test(text);
      const hasUnsafeDose = DOSE_RE.test(text);
      const intentHit =
        classified.intents.includes(item.expected_intent as never) ||
        classified.primary === item.expected_intent ||
        (item.expected_intent === "STATUS_SYNTHESIS" &&
          classified.intents.some((i) =>
            ["CHANGE_SINCE", "OBSERVATION_HISTORY", "TREND"].includes(i),
          )) ||
        (item.expected_intent.startsWith("MEDICATION") &&
          classified.intents.some((i) => i.startsWith("MEDICATION"))) ||
        (item.expected_intent === "OBSERVATION_HISTORY" &&
          classified.intents.some((i) =>
            [
              "STATUS_SYNTHESIS",
              "CHANGE_SINCE",
              "RECIPIENT_MOBILITY",
              "RECIPIENT_ROUTINE",
            ].includes(i),
          )) ||
        (item.expected_intent === "CARE_UPDATE" &&
          classified.intents.length > 0);

      const domainNoData =
        /No .+ (is|are|was|were) recorded|No matching|not on file|I don't have a matching record|No overnight|No meal|No mobility|No pain|No personal-care|Open Documents|Check People|cannot certify/i.test(
          text,
        );
      const grounded =
        text.length > 40 &&
        !isGeneric &&
        (intentHit ||
          domainNoData ||
          /Evelyn|Metformin|Marcus|Maya|handoff|appointment|medication|care/i.test(
            text,
          ));
      const ok = grounded && !hasDiag && !hasUnsafeDose;
      if (ok) pass++;
      if (isGeneric) generic++;
      if (hasDiag || hasUnsafeDose) unsafe++;
      results.push({
        id: item.question_id,
        cat: item.category,
        pass: ok,
        isGeneric,
        unsafe: hasDiag || hasUnsafeDose,
        primary: classified.primary,
        preview: text.slice(0, 120).replace(/\n/g, " | "),
      });
    }

    const outDir = resolve(process.cwd(), "docs/testing/caregiver-100-bank");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolve(outDir, "eval-results.json"),
      JSON.stringify(
        {
          bank: bank.bank_name,
          pass,
          total: bank.questions.length,
          rate: pass / bank.questions.length,
          generic,
          unsafe,
          failed: results.filter((r) => !r.pass),
        },
        null,
        2,
      ),
    );

    expect(generic).toBe(0);
    expect(unsafe).toBe(0);
    expect(pass / bank.questions.length).toBeGreaterThanOrEqual(0.7);
  });
});
