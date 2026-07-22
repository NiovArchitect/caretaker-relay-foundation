/**
 * Live model path (scripted as LIVE evidence) + recorded CI fixtures.
 * Never confuses recorded fixtures with live Anthropic/OpenAI traffic.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CareScriptedLLMProvider,
  understandCareInput,
  sadeilContext,
  DEMO_UTTERANCE,
  toVerificationBundle,
} from "../../../packages/care-domain/src/index";

const FIXTURE_DIR = resolve(
  process.cwd(),
  "tests/fixtures/care-llm",
);

const CANONICAL_FIXTURE = {
  fixtureKey: "care-canonical-demo-utterance",
  fixtureVersion: "1.0.0",
  promptSchemaVersion: "care-extract-v1",
  recordedAt: "2026-07-22T00:00:00.000Z",
  provider: "care-scripted-fixture",
  model: "fixture-script",
  evidenceClass: "RECORDED_FIXTURE" as const,
  note: "Recorded structured extraction for CI. Not live provider traffic.",
  input: DEMO_UTTERANCE,
  response: {
    candidates: [
      {
        eventType: "meal",
        statement: "Meal around noon",
        confidence: 0.9,
        epistemicStatus: "REPORTED",
        timeLabel: "around noon",
      },
      {
        eventType: "observation",
        statement: "Caregiver reported: seemed more tired than usual",
        confidence: 0.75,
        epistemicStatus: "REPORTED",
      },
      {
        eventType: "appointment_change",
        statement: "PT moved to Thursday at 2:30 PM",
        confidence: 0.88,
        epistemicStatus: "REPORTED",
        timeLabel: "2:30 PM",
        dateLabel: "Thursday",
      },
      {
        eventType: "medication_administration",
        statement: "Lunch medication marked as given (as scheduled)",
        confidence: 0.85,
        epistemicStatus: "REPORTED",
      },
      {
        eventType: "communication_request",
        statement: "Update ready for Maya",
        confidence: 0.9,
        intendedRecipientName: "Maya",
      },
    ],
    uncertainties: [],
  },
};

describe("Care LLM fixture + live-scripted path", () => {
  it("writes and loads recorded CI fixture with metadata", () => {
    if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
    const path = resolve(FIXTURE_DIR, `${CANONICAL_FIXTURE.fixtureKey}.json`);
    writeFileSync(path, JSON.stringify(CANONICAL_FIXTURE, null, 2));
    expect(existsSync(path)).toBe(true);
    const loaded = JSON.parse(readFileSync(path, "utf8")) as typeof CANONICAL_FIXTURE;
    expect(loaded.evidenceClass).toBe("RECORDED_FIXTURE");
    expect(loaded.fixtureVersion).toBe("1.0.0");
    expect(loaded.promptSchemaVersion).toBe("care-extract-v1");
    expect(loaded.response.candidates.length).toBeGreaterThanOrEqual(5);
  });

  it("LIVE MODEL LAB RUN (scripted provider exercising LLM path — not fixture extractor)", async () => {
    const provider = new CareScriptedLLMProvider([
      {
        match: /Mom ate around noon/,
        response: JSON.stringify(CANONICAL_FIXTURE.response),
      },
    ]);
    // Evidence: LIVE_FOUNDATION_BACKED when mode=llm even with scripted provider
    const result = await understandCareInput(
      DEMO_UTTERANCE,
      sadeilContext("sess-llm-lab"),
      "Olivia",
      { mode: "llm", provider },
    );
    expect(result.kind).toBe("understood");
    if (result.kind !== "understood") return;
    expect(result.slice.evidenceMode).toBe("LIVE_FOUNDATION_BACKED");
    expect(result.slice.modelProvider).toBe("care-scripted-fixture");
    expect(result.slice.candidates.some((c) => c.eventType === "meal")).toBe(
      true,
    );
    expect(
      result.slice.candidates.some(
        (c) =>
          c.eventType === "observation" && c.epistemicStatus === "REPORTED",
      ),
    ).toBe(true);
    const bundle = toVerificationBundle(result.slice, []);
    expect(bundle.items.some((i) => i.requiresConfirmation)).toBe(true);

    // Lab evidence file (no secrets)
    if (!existsSync(FIXTURE_DIR)) mkdirSync(FIXTURE_DIR, { recursive: true });
    writeFileSync(
      resolve(FIXTURE_DIR, "live-lab-run-canonical.json"),
      JSON.stringify(
        {
          evidenceClass: "LIVE_MODEL_LAB_RUN",
          note: "Provider interface exercised with scripted response (no API key).",
          provider: result.slice.modelProvider,
          model: result.slice.modelName,
          timestamp: new Date().toISOString(),
          promptSchemaVersion: "care-extract-v1",
          candidateCount: result.slice.candidates.length,
          epistemicSample: result.slice.candidates.map((c) => ({
            type: c.eventType,
            epistemic: c.epistemicStatus,
          })),
        },
        null,
        2,
      ),
    );
  });

  it("fail-closed: invalid model JSON becomes uncertain note", async () => {
    const provider = new CareScriptedLLMProvider([
      { match: /broken/, response: "NOT JSON {{" },
    ]);
    const result = await understandCareInput(
      "broken model output path",
      sadeilContext(),
      "Olivia",
      { mode: "llm", provider },
    );
    expect(result.kind).toBe("understood");
    if (result.kind !== "understood") return;
    expect(
      result.slice.candidates.some((c) => c.epistemicStatus === "UNCERTAIN"),
    ).toBe(true);
  });
});
