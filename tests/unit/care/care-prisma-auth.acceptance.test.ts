/**
 * Foundation AuthService + Prisma CareStore acceptance.
 * Requires local Postgres (.env.test DATABASE_URL).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCareApp, type CareApp } from "../../../apps/api/src/care-app";
import {
  careRecipient,
  people,
  DEMO_UTTERANCE,
} from "../../../packages/care-domain/src/index";
import { prisma } from "@niov/database";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("Prisma + Foundation Auth care acceptance", () => {
  let care: CareApp;

  beforeAll(async () => {
    care = await buildCareApp({
      jwtSecret: "prisma-auth-care-test-secret",
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

  async function login(personId: string, password: string) {
    const res = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/auth/login",
      payload: { care_person_id: personId, password },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      token: string;
      auth_mode: string;
      entity_id: string;
      care_person_id: string;
    };
    expect(body.auth_mode).toBe("foundation_auth_service");
    expect(body.entity_id).toMatch(
      /^[0-9a-f-]{36}$/i,
    );
    expect(body.care_person_id).toBe(personId);
    return body;
  }

  it("health reports prisma backend", async () => {
    const res = await care.app.inject({
      method: "GET",
      url: "/api/v1/care/health",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      store_backend: string;
      durable: boolean;
      foundation_auth: boolean;
    };
    expect(body.store_backend).toBe("prisma");
    expect(body.durable).toBe(true);
    expect(body.foundation_auth).toBe(true);
  });

  it("canonical loop via Foundation auth + prisma durability across reload", async () => {
    const { token } = await login(people.sadeil.id, "sadeil-lab-password");

    const und = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: DEMO_UTTERANCE,
        care_recipient_id: careRecipient.id,
      },
    });
    expect(und.statusCode).toBe(200);
    const undBody = und.json() as {
      kind: string;
      verification_bundle_id: string;
      auth_mode: string;
      bundle: {
        understood: {
          candidates: Array<{ eventType: string; epistemicStatus: string }>;
        };
      };
    };
    expect(undBody.kind).toBe("verify");
    expect(undBody.auth_mode).toBe("foundation_auth_service");
    expect(
      undBody.bundle.understood.candidates.some(
        (c) =>
          c.eventType === "observation" && c.epistemicStatus === "REPORTED",
      ),
    ).toBe(true);

    const conf = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        verification_bundle_id: undBody.verification_bundle_id,
        idempotency_key: "prisma-demo-1",
      },
    });
    expect(conf.statusCode).toBe(200);
    const confBody = conf.json() as {
      kind: string;
      store_backend: string;
      persisted: { eventIds: string[]; handoffId: string };
    };
    expect(confBody.kind).toBe("persisted");
    expect(confBody.store_backend).toBe("prisma");
    expect(confBody.persisted.handoffId).toBeTruthy();

    // Idempotent confirm
    const conf2 = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        verification_bundle_id: undBody.verification_bundle_id,
        idempotency_key: "prisma-demo-1",
      },
    });
    expect((conf2.json() as { idempotent_replay?: boolean }).idempotent_replay).toBe(
      true,
    );

    // Simulate process restart: new app, same DB
    await care.app.close();
    care = await buildCareApp({
      jwtSecret: "prisma-auth-care-test-secret",
      storeBackend: "prisma",
      seedOlivia: true,
      seedFoundationAuth: true,
    });

    const { token: token2 } = await login(
      people.sadeil.id,
      "sadeil-lab-password",
    );
    const state = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(state.statusCode).toBe(200);
    const st = state.json() as {
      state: { events: unknown[]; handoffs: unknown[] };
      store_backend: string;
    };
    expect(st.store_backend).toBe("prisma");
    expect(st.state.events.length).toBeGreaterThan(0);
    expect(st.state.handoffs.length).toBeGreaterThan(0);

    // Unauthorized denied
    const unauth = await login(
      people.unauthorized.id,
      "unauth-lab-password",
    );
    const denied = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${unauth.token}` },
    });
    expect(denied.statusCode).toBe(403);

    // Maya authorized
    const maya = await login(people.maya.id, "maya-lab-password");
    const mayaOk = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/today`,
      headers: { authorization: `Bearer ${maya.token}` },
    });
    expect(mayaOk.statusCode).toBe(200);
  }, 180_000);

  it("voice understand converges on same pipeline", async () => {
    const { token } = await login(people.sadeil.id, "sadeil-lab-password");
    const res = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/voice/understand",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        transcript: "Mom ate around noon and seemed more tired.",
        confidence: 0.55,
        language: "en",
        user_edited: true,
        care_recipient_id: careRecipient.id,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      kind: string;
      transcript_meta: { source: string; confidence: number };
    };
    expect(body.kind).toBe("verify");
    expect(body.transcript_meta.source).toBe("voice_stt");
  });

  it("revocation blocks subsequent reads", async () => {
    const sadeil = await login(people.sadeil.id, "sadeil-lab-password");
    await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${careRecipient.id}/access/revoke`,
      headers: { authorization: `Bearer ${sadeil.token}` },
      payload: { person_id: people.maya.id },
    });
    const maya = await login(people.maya.id, "maya-lab-password");
    const denied = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${maya.token}` },
    });
    expect(denied.statusCode).toBe(403);
  });
});
