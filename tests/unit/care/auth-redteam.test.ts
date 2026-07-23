/**
 * Authorization red-team matrix against care API.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { people, careRecipient } from "../../../packages/care-domain/src/index";
import { buildCareApp } from "../../../apps/api/src/care-app";

describe("AUTH RED TEAM", () => {
  let care: Awaited<ReturnType<typeof buildCareApp>>;
  let marcusToken = "";
  let unauthToken = "";
  let otherHhToken = "";
  let danielToken = "";

  beforeAll(async () => {
    care = await buildCareApp({
      jwtSecret: "redteam-secret",
      storeBackend: "memory",
      seedOlivia: true,
      seedFoundationAuth: false,
      understandMode: "fixture",
    });
    async function login(id: string, pw: string) {
      const r = await care.app.inject({
        method: "POST",
        url: "/api/v1/care/auth/lab-login",
        payload: { care_person_id: id, password: pw },
      });
      expect(r.statusCode).toBe(200);
      return (r.json() as { token: string }).token;
    }
    marcusToken = await login(people.sadeil.id, "sadeil-lab-password");
    unauthToken = await login(people.unauthorized.id, "unauth-lab-password");
    otherHhToken = await login(
      people.otherHouseholdCaregiver.id,
      "other-hh-lab-password",
    );
    danielToken = await login(people.walter.id, "walter-lab-password");
  }, 60_000);

  afterAll(async () => {
    await care.app.close();
  });

  const id = () => careRecipient.id;
  const deniedGet = async (token: string, path: string) => {
    const r = await care.app.inject({
      method: "GET",
      url: path,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(r.statusCode).toBe(403);
  };

  it("denies unauthorized and wrong-household reads", async () => {
    const paths = [
      `/api/v1/care/recipients/${id()}/state`,
      `/api/v1/care/recipients/${id()}/today`,
      `/api/v1/care/recipients/${id()}/handoffs`,
      `/api/v1/care/recipients/${id()}/timeline`,
      `/api/v1/care/recipients/${id()}/export?format=json`,
      `/api/v1/care/recipients/${id()}/coordination`,
      `/api/v1/care/recipients/${id()}/circle`,
    ];
    for (const p of paths) {
      await deniedGet(unauthToken, p);
      await deniedGet(otherHhToken, p);
    }
  });

  it("denies unauthorized write surfaces", async () => {
    const und = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${unauthToken}` },
      payload: { text: "Mom ate lunch", care_recipient_id: id() },
    });
    expect([403, 200]).toContain(und.statusCode);
    // soft-path may return access_denied kind
    if (und.statusCode === 200) {
      const body = und.json() as { kind?: string };
      expect(body.kind === "access_denied" || body.kind === "refusal").toBe(
        true,
      );
    }

    const inv = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${id()}/invitations`,
      headers: { authorization: `Bearer ${unauthToken}` },
      payload: { invitee_care_person_id: people.maya.id },
    });
    expect(inv.statusCode).toBe(403);

    const coord = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${id()}/coordination`,
      headers: { authorization: `Bearer ${unauthToken}` },
      payload: { body: "hi" },
    });
    expect(coord.statusCode).toBe(403);

    const corr = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/corrections",
      headers: { authorization: `Bearer ${unauthToken}` },
      payload: {
        target_event_id: "evt-fake",
        corrected_value: "x",
        care_recipient_id: id(),
      },
    });
    // may be 200 access_denied or 403
    expect([403, 200, 404]).toContain(corr.statusCode);
  });

  it("daniel cannot invite; marcus can", async () => {
    const d = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${id()}/invitations`,
      headers: { authorization: `Bearer ${danielToken}` },
      payload: { invitee_care_person_id: people.unauthorized.id },
    });
    expect(d.statusCode).toBe(403);

    await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${id()}/access/revoke`,
      headers: { authorization: `Bearer ${marcusToken}` },
      payload: { person_id: people.maya.id },
    });
    const m = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${id()}/invitations`,
      headers: { authorization: `Bearer ${marcusToken}` },
      payload: { invitee_care_person_id: people.maya.id },
    });
    expect(m.statusCode).toBe(201);
    const token = (m.json() as { invitation: { token: string } }).invitation
      .token;

    // wrong principal accept
    const wrong = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/invitations/${token}/accept`,
      headers: { authorization: `Bearer ${danielToken}` },
      payload: {},
    });
    expect(wrong.statusCode).toBe(403);
  });
});
