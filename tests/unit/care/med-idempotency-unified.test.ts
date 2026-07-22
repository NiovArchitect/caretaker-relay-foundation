/**
 * Unified medication idempotency policy:
 * care-domain medAdminHash === PrismaCareStore.medContentHash
 * Survives process restart and different client idempotency keys.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCareApp, type CareApp } from "../../../apps/api/src/care-app";
import { medContentHash } from "../../../apps/api/src/services/care/prisma-care-store";
import {
  medAdminHash,
  people,
  careRecipient,
  DEMO_UTTERANCE,
} from "../../../packages/care-domain/src/index";
import { prisma } from "@niov/database";

const hasDb = Boolean(process.env.DATABASE_URL);

describe("Unified medAdminHash / medContentHash", () => {
  it("domain and prisma store use identical hash bytes", () => {
    const args = {
      careRecipientId: "cr-olivia",
      name: "Lunch medication",
      doseRecorded: "2.5 mg",
      administeredByPersonId: "p-sadeil",
      administeredAt: "2026-07-22T12:05:00.000Z",
    };
    expect(medAdminHash(args)).toBe(medContentHash(args));
    // Volatile wall-clock within same day does not change hash
    expect(
      medAdminHash({ ...args, administeredAt: "2026-07-22T23:59:00.000Z" }),
    ).toBe(medContentHash(args));
  });

  it("different day / dose / recipient produce different hashes", () => {
    const base = {
      careRecipientId: "cr-olivia",
      name: "Lunch medication",
      doseRecorded: "2.5 mg",
      administeredByPersonId: "p-sadeil",
      administeredAt: "2026-07-22T12:00:00.000Z",
    };
    expect(
      medAdminHash({ ...base, administeredAt: "2026-07-23T12:00:00.000Z" }),
    ).not.toBe(medAdminHash(base));
    expect(medAdminHash({ ...base, doseRecorded: "5 mg" })).not.toBe(
      medAdminHash(base),
    );
    expect(
      medAdminHash({ ...base, careRecipientId: "cr-other" }),
    ).not.toBe(medAdminHash(base));
  });
});

describe.skipIf(!hasDb)("Med idempotency across API restart (Prisma)", () => {
  let care: CareApp;

  beforeAll(async () => {
    care = await buildCareApp({
      jwtSecret: "med-idem-unified-secret",
      storeBackend: "prisma",
      seedOlivia: true,
      seedFoundationAuth: true,
      understandMode: "fixture",
    });
  }, 120_000);

  afterAll(async () => {
    await care?.app.close();
    await prisma.$disconnect();
  });

  async function login() {
    const res = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/auth/login",
      payload: {
        care_person_id: people.sadeil.id,
        password: "sadeil-lab-password",
      },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { token: string }).token;
  }

  it("same logical med + different retry keys → one administration; survives restart", async () => {
    const token = await login();
    const text = "I gave the lunch medication 2.5 mg.";

    const und1 = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${token}` },
      payload: { text, care_recipient_id: careRecipient.id },
    });
    expect(und1.statusCode).toBe(200);
    const bid1 = (und1.json() as { verification_bundle_id: string })
      .verification_bundle_id;

    const conf1 = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        verification_bundle_id: bid1,
        idempotency_key: "retry-key-A",
      },
    });
    expect(conf1.statusCode).toBe(200);

    // Different client key, same logical event
    const und2 = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${token}` },
      payload: { text, care_recipient_id: careRecipient.id },
    });
    const bid2 = (und2.json() as { verification_bundle_id: string })
      .verification_bundle_id;
    const conf2 = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        verification_bundle_id: bid2,
        idempotency_key: "retry-key-B",
      },
    });
    expect(conf2.statusCode).toBe(200);

    const state1 = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${token}` },
    });
    const meds1 = (
      state1.json() as {
        state: { medicationRecords: Array<{ doseRecorded: string; status: string }> };
      }
    ).state.medicationRecords.filter(
      (m) => m.status === "recorded" && /2\.5/.test(m.doseRecorded),
    );
    expect(meds1.length).toBe(1);

    // Restart API process
    await care.app.close();
    care = await buildCareApp({
      jwtSecret: "med-idem-unified-secret",
      storeBackend: "prisma",
      seedOlivia: true,
      seedFoundationAuth: true,
    });
    const token2 = await login();

    // Third attempt after restart
    const und3 = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${token2}` },
      payload: { text, care_recipient_id: careRecipient.id },
    });
    const bid3 = (und3.json() as { verification_bundle_id: string })
      .verification_bundle_id;
    await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token2}` },
      payload: {
        verification_bundle_id: bid3,
        idempotency_key: "retry-key-C-after-restart",
      },
    });

    const state2 = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${token2}` },
    });
    const meds2 = (
      state2.json() as {
        state: { medicationRecords: Array<{ doseRecorded: string; status: string }> };
      }
    ).state.medicationRecords.filter(
      (m) => m.status === "recorded" && /2\.5/.test(m.doseRecorded),
    );
    expect(meds2.length).toBe(1);
  }, 180_000);

  it("DEMO_UTTERANCE double confirm does not multiply meds", async () => {
    const token = await login();
    const und = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: DEMO_UTTERANCE,
        care_recipient_id: careRecipient.id,
      },
    });
    const bid = (und.json() as { verification_bundle_id: string })
      .verification_bundle_id;
    await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: { verification_bundle_id: bid, idempotency_key: "demo-once" },
    });
    // Same key replay
    const replay = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: { verification_bundle_id: bid, idempotency_key: "demo-once" },
    });
    expect((replay.json() as { idempotent_replay?: boolean }).idempotent_replay).toBe(
      true,
    );
  });
});
