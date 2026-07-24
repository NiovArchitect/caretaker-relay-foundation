/**
 * Medication unit safety matrix — pure comparison + fixture understand wiring.
 */
import { describe, expect, it } from "vitest";
import {
  compareMedicationDoses,
  extractDoseFromText,
  parseDose,
  detectMedicationDiscrepancy,
  understandCareInput,
  sadeilContext,
  medicationSchedule,
} from "../../../packages/care-domain/src/index";

const AUTH = "2.5 mg";

describe("dose-units parse/compare", () => {
  it("matches equivalent mass representations", () => {
    for (const r of ["2.5 mg", "2.5 milligrams", "2500 mcg", "0.0025 g"]) {
      const c = compareMedicationDoses(r, AUTH);
      expect(c?.status, r).toBe("match");
    }
  });

  it("flags 2.5 g as HIGH discrepancy vs 2.5 mg (1000×)", () => {
    const c = compareMedicationDoses("2.5 g", AUTH);
    expect(c?.status).toBe("discrepancy");
    if (c?.status === "discrepancy") {
      expect(c.severity).toBe("high");
      expect(c.recorded.kind).toBe("quantity");
      if (c.recorded.kind === "quantity" && c.authorized.kind === "quantity") {
        expect(c.recorded.baseValue).toBe(2500);
        expect(c.authorized.baseValue).toBe(2.5);
      }
    }
  });

  it("flags 2500 mg and 0.25/25 mg as discrepancy", () => {
    expect(compareMedicationDoses("2500 mg", AUTH)?.status).toBe("discrepancy");
    expect(compareMedicationDoses("0.25 mg", AUTH)?.status).toBe("discrepancy");
    expect(compareMedicationDoses("25 mg", AUTH)?.status).toBe("discrepancy");
  });

  it("does not invent mass↔volume conversion", () => {
    const ml = compareMedicationDoses("2.5 mL", AUTH);
    expect(ml?.status).toBe("discrepancy");
    if (ml?.status === "discrepancy") {
      // Plain caregiver language OR technical dimension wording both acceptable
      expect(ml.message.toLowerCase()).toMatch(
        /dimension|comparable|conversion|doesn't clearly match|care team|unit/,
      );
    }
    const L = compareMedicationDoses("2.5 L", AUTH);
    expect(L?.status).toBe("discrepancy");
  });

  it("requires review when unit missing", () => {
    const c = compareMedicationDoses("2.5", AUTH);
    expect(c?.status).toBe("unresolved");
    if (c?.status === "unresolved") {
      expect(c.message.toLowerCase()).toMatch(/missing unit/);
    }
  });

  it("handles textual milligrams/grams", () => {
    expect(
      compareMedicationDoses("two point five milligrams", AUTH)?.status,
    ).toBe("match");
    const g = compareMedicationDoses("two point five grams", AUTH);
    expect(g?.status).toBe("discrepancy");
  });

  it("does not convert pill/tablet without strength", () => {
    const c = compareMedicationDoses("one pill", AUTH);
    expect(c?.status).toBe("unresolved");
  });

  it("extracts grams from utterance", () => {
    expect(extractDoseFromText("I gave the lunch medication 2.5 grams.")).toMatch(
      /2\.5\s*grams?/i,
    );
  });
});

describe("detectMedicationDiscrepancy wiring", () => {
  // Canonical Olivia schedule is Metformin 500 mg (not 2.5 mg lab toy dose).
  const schedules = [medicationSchedule];

  it("HIGH discrepancy for 2.5 grams vs authorized 500 mg", () => {
    const d = detectMedicationDiscrepancy("2.5 grams", schedules);
    expect(d).toBeTruthy();
    expect(d!.authorizedDose).toMatch(/500\s*mg/i);
    expect(d!.message.toLowerCase()).toMatch(/not match|material|unit/);
  });

  it("no discrepancy for authorized 500 mg", () => {
    expect(detectMedicationDiscrepancy("500 mg", schedules)).toBeUndefined();
  });

  it("HIGH discrepancy for 2.5 mg vs authorized 500 mg", () => {
    const d = detectMedicationDiscrepancy("2.5 mg", schedules);
    expect(d).toBeTruthy();
    expect(d!.authorizedDose).toMatch(/500\s*mg/i);
  });
});

describe("fixture understand → verification discrepancy", () => {
  it("CR-STRESS-030 contract: 2.5 grams yields high discrepancy item", async () => {
    const r = await understandCareInput(
      "I gave the lunch medication 2.5 grams.",
      sadeilContext(),
      "Evelyn Carter",
      { mode: "fixture" },
    );
    expect(r.kind).toBe("understood");
    if (r.kind !== "understood") return;
    const med = r.slice.candidates.find(
      (c) => c.eventType === "medication_administration",
    );
    expect(med?.recordedDose).toMatch(/2\.5/i);
    expect(med?.recordedDose).toMatch(/g/i);

    const { toVerificationBundle } = await import(
      "../../../packages/care-domain/src/services/understand.js"
    );
    const bundle = toVerificationBundle(r.slice, [medicationSchedule]);
    const discItem = bundle.items.find((i) => i.discrepancy);
    expect(discItem).toBeTruthy();
    expect(discItem!.safetyClass).toBe("high");
    expect(discItem!.discrepancy!.recordedDose.toLowerCase()).toMatch(/g/);
    // Authorized schedule is Metformin 500 mg — 2.5 g is a material discrepancy
    expect(discItem!.discrepancy!.authorizedDose).toMatch(/500\s*mg/i);
  });

  it("2500 mcg vs authorized 500 mg raises discrepancy (not equivalent)", async () => {
    // 2500 mcg = 2.5 mg — not equal to authorized 500 mg Metformin.
    const r = await understandCareInput(
      "I gave the lunch medication 2500 mcg.",
      sadeilContext(),
      "Evelyn Carter",
      { mode: "fixture" },
    );
    expect(r.kind).toBe("understood");
    if (r.kind !== "understood") return;
    const { toVerificationBundle } = await import(
      "../../../packages/care-domain/src/services/understand.js"
    );
    const bundle = toVerificationBundle(r.slice, [medicationSchedule]);
    const discItem = bundle.items.find((i) => i.discrepancy);
    expect(discItem).toBeTruthy();
    expect(discItem!.safetyClass).toBe("high");
  });
});
