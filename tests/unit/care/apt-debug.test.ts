import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildCareApp, type CareApp } from "../../../apps/api/src/care-app";
import { people, careRecipient } from "../../../packages/care-domain/src/index";
import { prisma } from "@niov/database";

const has5434 = (process.env.DATABASE_URL ?? "").includes("5434");

describe.skipIf(!has5434)("apt debug", () => {
  let care: CareApp;
  let token = "";
  beforeAll(async () => {
    care = await buildCareApp({
      jwtSecret: "x",
      storeBackend: "prisma",
      seedOlivia: true,
      seedFoundationAuth: true,
    });
    const s = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/auth/login",
      payload: {
        care_person_id: people.sadeil.id,
        password: "sadeil-lab-password",
      },
    });
    token = (s.json() as { token: string }).token;
  }, 120000);
  afterAll(async () => {
    await care.app.close();
    await prisma.$disconnect();
  });

  it("persists 3:00 appointment", async () => {
    const und = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: "PT moved Thursday's appointment to 3:00.",
        care_recipient_id: careRecipient.id,
      },
    });
    const uj = und.json() as {
      kind: string;
      verification_bundle_id: string;
      bundle: { understood: { appointmentChanges: string[]; candidates: unknown[] } };
    };
    // eslint-disable-next-line no-console
    console.log("UND", und.statusCode, uj.kind, uj.bundle?.understood);
    expect(uj.kind).toBe("verify");
    expect(uj.bundle.understood.appointmentChanges.join(" ")).toMatch(/3:00/);

    const conf = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        verification_bundle_id: uj.verification_bundle_id,
        idempotency_key: `apt-debug-300-${Date.now()}`,
      },
    });
    const cj = conf.json() as {
      kind: string;
      current_state?: { appointments?: Array<{ startsAtLabel?: string }> };
    };
    // eslint-disable-next-line no-console
    console.log("CONF", conf.statusCode, cj.kind, cj.current_state?.appointments);

    const st = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${token}` },
    });
    const apts = (
      st.json() as {
        state: { appointments: Array<{ startsAtLabel?: string }> };
      }
    ).state.appointments;
    // eslint-disable-next-line no-console
    console.log("STATE", apts);
    expect(apts.some((a) => /3:00/.test(a.startsAtLabel ?? ""))).toBe(true);
  });
});
