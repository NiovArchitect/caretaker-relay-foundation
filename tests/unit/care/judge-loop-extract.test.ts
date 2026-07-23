import { describe, expect, it } from "vitest";
import {
  createCareRuntime,
  JUDGE_LOOP_UTTERANCE,
  sadeilContext,
} from "../../../packages/care-domain/src/index.js";

describe("Track 1 judge-loop fixture extract", () => {
  it("extracts multi-event structure from messy caregiver update", async () => {
    const { service } = createCareRuntime({ mode: "fixture", seedOlivia: true });
    const result = await service.proposeFromInput(
      JUDGE_LOOP_UTTERANCE,
      sadeilContext(),
    );
    expect(result.kind).toBe("verify");
    if (result.kind !== "verify" || !result.bundle) return;
    expect(result.bundle.items.length).toBeGreaterThanOrEqual(4);
    const labels = result.bundle.items.map((i) => i.label.toLowerCase()).join(" | ");
    expect(labels).toMatch(/dizzy|dizziness/);
    expect(labels).toMatch(/meal|breakfast|9/);
    expect(labels).toMatch(/medication|pill|tablet/);
    expect(labels).toMatch(/maya/);
    // Medication consequential — discrepancy or high safety
    const med = result.bundle.items.find(
      (i) => i.discrepancy || /medication|pill|tablet/i.test(i.label),
    );
    expect(med).toBeTruthy();
    expect(med!.safetyClass === "high" || Boolean(med!.discrepancy)).toBe(true);
    // Never invent a clinical dose recommendation string
    const blob = JSON.stringify(result.bundle);
    expect(blob.toLowerCase()).not.toMatch(/you should give|i recommend|prescrib/);
  });
});
