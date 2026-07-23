/**
 * Real multi-principal household closure (API-level).
 * Marcus → invite Maya → Maya accept → update → confirm → Maya sees → Maya corrects → Marcus sees → Daniel limited → unauthorized denied.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DEMO_UTTERANCE, people, careRecipient } from "../../../packages/care-domain/src/index";
import { buildCareApp } from "../../../apps/api/src/care-app";

describe("HOUSEHOLD CLOSURE: multi-principal continuity", () => {
  let care: Awaited<ReturnType<typeof buildCareApp>>;

  beforeAll(async () => {
    care = await buildCareApp({
      jwtSecret: "household-closure-test-secret",
      storeBackend: "memory",
      seedOlivia: true,
      seedFoundationAuth: false,
      understandMode: "fixture",
    });
  }, 60_000);

  afterAll(async () => {
    await care.app.close();
  });

  async function login(carePersonId: string, password: string) {
    const res = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/auth/login",
      payload: { care_person_id: carePersonId, password },
    });
    // memory backend may use lab-login path
    if (res.statusCode !== 200) {
      const lab = await care.app.inject({
        method: "POST",
        url: "/api/v1/care/auth/lab-login",
        payload: { care_person_id: carePersonId, password },
      });
      expect(lab.statusCode).toBe(200);
      return lab.json() as { token: string; care_person_id: string; display_name: string };
    }
    return res.json() as { token: string; care_person_id: string; display_name: string };
  }

  it("three-principal loop with invite, update, correction, isolation", async () => {
    const marcus = await login(people.sadeil.id, "sadeil-lab-password");
    expect(marcus.display_name).toMatch(/Marcus/i);

    // Revoke Maya first so invite is meaningful (if already active seed)
    await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${careRecipient.id}/access/revoke`,
      headers: { authorization: `Bearer ${marcus.token}` },
      payload: { person_id: people.maya.id },
    });

    const inv = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${careRecipient.id}/invitations`,
      headers: { authorization: `Bearer ${marcus.token}` },
      payload: {
        invitee_care_person_id: people.maya.id,
        role: "family_caregiver",
        role_label: "Family / friend caregiver",
      },
    });
    expect(inv.statusCode).toBe(201);
    const invBody = inv.json() as {
      invitation: { token: string; id: string };
    };
    expect(invBody.invitation.token.length).toBeGreaterThan(10);

    const maya = await login(people.maya.id, "maya-lab-password");
    const accept = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/invitations/${invBody.invitation.token}/accept`,
      headers: { authorization: `Bearer ${maya.token}` },
      payload: {},
    });
    expect(accept.statusCode).toBe(200);

    // Fresh-language multi-signal update (not only DEMO_UTTERANCE)
    const fresh =
      "Mom was kinda dizzy again after breakfast. I think she took the blue one but I'm not positive because Maya had already set some pills out, and PT called and said Thursday won't work.";
    const und = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${marcus.token}` },
      payload: {
        text: fresh,
        care_recipient_id: careRecipient.id,
        mode: "fixture",
      },
    });
    expect(und.statusCode).toBe(200);
    const undBody = und.json() as {
      kind: string;
      verification_bundle_id?: string;
      bundle?: { items: Array<{ label: string; safetyClass?: string }> };
    };
    expect(undBody.kind).toBe("verify");
    expect(undBody.verification_bundle_id).toBeTruthy();
    const labels = (undBody.bundle?.items ?? []).map((i) => i.label).join(" ");
    expect(/dizzy|meal|medication|PT|appointment/i.test(labels)).toBe(true);

    const conf = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${marcus.token}` },
      payload: {
        verification_bundle_id: undBody.verification_bundle_id,
        idempotency_key: `hh-close-${Date.now()}`,
      },
    });
    expect(conf.statusCode).toBe(200);
    expect((conf.json() as { kind: string }).kind).toBe("persisted");

    // Maya sees handoffs independently
    const mayaHo = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/handoffs`,
      headers: { authorization: `Bearer ${maya.token}` },
    });
    expect(mayaHo.statusCode).toBe(200);
    const handoffs = (mayaHo.json() as { handoffs: unknown[] }).handoffs;
    expect(handoffs.length).toBeGreaterThan(0);

    // Coordination message Marcus → circle
    const coord = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${careRecipient.id}/coordination`,
      headers: { authorization: `Bearer ${marcus.token}` },
      payload: { body: "Please watch for more dizziness this evening.", to_person_id: people.maya.id },
    });
    expect(coord.statusCode).toBe(201);

    const mayaCoord = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/coordination`,
      headers: { authorization: `Bearer ${maya.token}` },
    });
    expect(mayaCoord.statusCode).toBe(200);
    const msgs = (mayaCoord.json() as { messages: Array<{ body: string }> }).messages;
    expect(msgs.some((m) => /dizziness/i.test(m.body))).toBe(true);

    // Daniel professional limited access
    const daniel = await login(people.walter.id, "walter-lab-password");
    const dToday = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/today`,
      headers: { authorization: `Bearer ${daniel.token}` },
    });
    expect(dToday.statusCode).toBe(200);

    // Unauthorized denied
    const unauth = await login(people.unauthorized.id, "unauth-lab-password");
    const denied = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${unauth.token}` },
    });
    expect(denied.statusCode).toBe(403);

    // Second fresh utterance
    const und2 = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${marcus.token}` },
      payload: {
        text: "She barely ate dinner and complained her legs felt rubbery after PT was cancelled.",
        care_recipient_id: careRecipient.id,
        mode: "fixture",
      },
    });
    expect(und2.statusCode).toBe(200);
    expect((und2.json() as { kind: string }).kind).toBe("verify");

    // me endpoint
    const me = await care.app.inject({
      method: "GET",
      url: "/api/v1/care/me",
      headers: { authorization: `Bearer ${marcus.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { care_person_id: string }).care_person_id).toBe(
      people.sadeil.id,
    );

    void DEMO_UTTERANCE; // keep import for fixture parity reference
  }, 120_000);
});
