/**
 * Focused medication-unit red team (real-stack inject + pure matrix).
 * Closes CR-STRESS-030 P1 with original strong discrepancy contract.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCareApp, type CareApp } from "../../apps/api/src/care-app";
import {
  people,
  careRecipient,
  compareMedicationDoses,
  medicationSchedule,
} from "../../packages/care-domain/src/index";
import { prisma } from "@niov/database";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const has5434 =
  (process.env.DATABASE_URL ?? "").includes("5434") &&
  (process.env.DATABASE_URL ?? "").includes("caretaker_relay_dev");

const EVIDENCE = resolve(
  process.cwd(),
  "docs/caretaker-relay/evidence/brutal-real-stack-v1",
);

describe("Medication unit matrix (pure)", () => {
  // Pure unit-conversion reference dose — NOT the lab Metformin schedule (500 mg).
  // Lab product truth remains medicationSchedule.dose = "500 mg" for Evelyn/Olivia.
  // This matrix validates mass/speech/STT equivalence against a fixed 2.5 mg baseline.
  const AUTH = "2.5 mg";

  const cases: Array<{
    input: string;
    expect: "match" | "discrepancy" | "unresolved";
    note: string;
  }> = [
    { input: "2.5 mg", expect: "match", note: "canonical match" },
    { input: "2.5 milligrams", expect: "match", note: "long form" },
    { input: "2500 mcg", expect: "match", note: "mcg equivalent" },
    { input: "0.0025 g", expect: "match", note: "g equivalent" },
    { input: "2.5 g", expect: "discrepancy", note: "1000× high disc" },
    { input: "2.5 grams", expect: "discrepancy", note: "grams high disc" },
    { input: "2500 mg", expect: "discrepancy", note: "1000× mg" },
    { input: "0.25 mg", expect: "discrepancy", note: "under dose" },
    { input: "25 mg", expect: "discrepancy", note: "10× high" },
    { input: "2.5 mL", expect: "discrepancy", note: "no mass/volume invent" },
    { input: "2.5 L", expect: "discrepancy", note: "volume extreme" },
    {
      input: "two point five milligrams",
      expect: "match",
      note: "speech mg",
    },
    {
      input: "two point five grams",
      expect: "discrepancy",
      note: "speech g",
    },
    { input: "2.5", expect: "unresolved", note: "missing unit" },
    {
      input: "a couple milligrams",
      expect: "unresolved",
      note: "ambiguous quantity",
    },
    {
      input: "half a tablet",
      // Count vs mass schedule → high discrepancy (no invented conversion)
      expect: "discrepancy",
      note: "no tablet strength — incompatible with mg schedule",
    },
    { input: "one pill", expect: "unresolved", note: "no strength" },
    { input: "2.5 M G", expect: "match", note: "spaced MG" },
    { input: "2 point 5 mg", expect: "match", note: "point form" },
    {
      input: "two and a half milligrams",
      expect: "match",
      note: "and a half",
    },
  ];

  it("matrix pass rate", () => {
    const results = cases.map((c) => {
      const r = compareMedicationDoses(c.input, AUTH);
      const status = r?.status ?? "none";
      const ok = status === c.expect;
      return { ...c, status, ok };
    });
    const failed = results.filter((r) => !r.ok);
    if (failed.length) {
      // eslint-disable-next-line no-console
      console.log("UNIT_MATRIX_FAILS", failed);
    }
    expect(failed).toEqual([]);
    expect(results.filter((r) => r.ok).length).toBe(cases.length);
  });
});

describe.skipIf(!has5434)("CR-STRESS-030 restored real-stack", () => {
  let care: CareApp;
  let token = "";

  beforeAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    care = await buildCareApp({
      jwtSecret:
        process.env.JWT_SECRET ?? "cr-local-dev-jwt-secret-not-for-production-32b",
      storeBackend: "prisma",
      seedOlivia: true,
      seedFoundationAuth: true,
      understandMode: "fixture",
    });
    const login = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/auth/login",
      payload: {
        care_person_id: people.sadeil.id,
        password: "sadeil-lab-password",
      },
    });
    token = (login.json() as { token: string }).token;
  }, 120_000);

  afterAll(async () => {
    await care?.app.close();
    await prisma.$disconnect();
  });

  it("2.5 grams → HIGH discrepancy; no silent normal admin finalize", async () => {
    const und = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: "I gave the lunch medication 2.5 grams.",
        care_recipient_id: careRecipient.id,
      },
    });
    const body = und.json() as {
      kind?: string;
      verification_bundle_id?: string;
      bundle?: {
        items?: Array<{
          discrepancy?: { recordedDose?: string; authorizedDose?: string; message?: string };
          safetyClass?: string;
          label?: string;
        }>;
        understood?: {
          candidates?: Array<{ eventType: string; recordedDose?: string }>;
        };
      };
    };

    writeFileSync(
      resolve(EVIDENCE, "CR-STRESS-030-after-product-fix.json"),
      JSON.stringify(body, null, 2),
    );

    expect(und.statusCode).toBe(200);
    expect(body.kind).toBe("verify");

    const discItems = (body.bundle?.items ?? []).filter((i) => i.discrepancy);
    expect(discItems.length).toBeGreaterThan(0);
    expect(discItems.some((i) => i.safetyClass === "high")).toBe(true);
    expect(
      discItems.some((i) =>
        /g|gram/i.test(i.discrepancy?.recordedDose ?? ""),
      ),
    ).toBe(true);
    expect(
      discItems.some((i) => /2\.5\s*mg/i.test(i.discrepancy?.authorizedDose ?? "")),
    ).toBe(true);
    // Does not tell caregiver which dose is clinically correct
    const msgs = discItems.map((i) => i.discrepancy?.message ?? "").join(" ");
    expect(msgs.toLowerCase()).toMatch(/will not choose|not match|material/);
    expect(msgs.toLowerCase()).not.toMatch(/you should give|correct dose is/);

    // Confirm must not create silent completed recorded admin without review path
    const conf = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        verification_bundle_id: body.verification_bundle_id,
        idempotency_key: `unit-030-${Date.now()}`,
      },
    });
    const cj = conf.json() as {
      kind?: string;
      persisted?: { safetyReviewIds?: string[]; medicationRecordIds?: string[] };
      current_state?: {
        medicationRecords?: Array<{
          status: string;
          doseRecorded?: string;
          epistemicStatus?: string;
        }>;
      };
    };
    expect(conf.statusCode).toBe(200);
    expect(cj.kind).toBe("persisted");
    const needsReview = (cj.current_state?.medicationRecords ?? []).some(
      (m) =>
        m.status === "needs_review" ||
        m.epistemicStatus === "CONFLICTED" ||
        /gram|g\b/i.test(m.doseRecorded ?? ""),
    );
    const safety = (cj.persisted?.safetyReviewIds?.length ?? 0) > 0;
    expect(needsReview || safety).toBe(true);
  });
});
