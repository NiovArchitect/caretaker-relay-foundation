/**
 * End-to-end server security closure:
 * register → zero recipients → deny API → access request → approve → access
 * Direct API attack tests (not UI).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  people,
  careRecipient,
} from "../../../packages/care-domain/src/index";
import { buildCareApp } from "../../../apps/api/src/care-app";

describe("SERVER SECURITY CLOSURE", () => {
  let care: Awaited<ReturnType<typeof buildCareApp>>;
  const rid = careRecipient.id;

  beforeAll(async () => {
    care = await buildCareApp({
      jwtSecret: "security-closure-secret",
      storeBackend: "memory",
      seedOlivia: true,
      seedFoundationAuth: false,
      understandMode: "fixture",
    });
  }, 60_000);

  afterAll(async () => {
    await care.app.close();
  });

  async function labLogin(id: string, pw: string) {
    const r = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/auth/lab-login",
      payload: { care_person_id: id, password: pw },
    });
    expect(r.statusCode).toBe(200);
    return (r.json() as { token: string }).token;
  }

  it("register creates durable account with zero recipients", async () => {
    const email = `new.user.${Date.now()}@example.test`;
    const reg = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/auth/register",
      payload: {
        preferred_name: "Jordan Lee",
        email,
        password: "secure-password-12",
        claimed_relationship: "family_caregiver",
      },
    });
    expect(reg.statusCode).toBe(201);
    const body = reg.json() as {
      ok: boolean;
      token: string;
      care_person_id: string;
      authorized_recipients: number;
      account_status: string;
    };
    expect(body.ok).toBe(true);
    expect(body.authorized_recipients).toBe(0);
    expect(body.account_status).toBe("unverified");
    expect(body.care_person_id.startsWith("p-acct-")).toBe(true);

    // Role claim does not grant Evelyn access
    const state = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${rid}/state`,
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(state.statusCode).toBe(403);

    const answer = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/answer",
      headers: { authorization: `Bearer ${body.token}` },
      payload: { question: "How is Mom?", care_recipient_id: rid },
    });
    expect(answer.statusCode).toBe(403);

    const me = await care.app.inject({
      method: "GET",
      url: "/api/v1/care/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    const meBody = me.json() as {
      authorized_recipients: number;
      pending_recipient_access: boolean;
    };
    expect(meBody.authorized_recipients).toBe(0);
    expect(meBody.pending_recipient_access).toBe(true);

    // Access matrix leak closed
    const access = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${rid}/access`,
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(access.statusCode).toBe(403);

    // Access request does not grant access
    const ar = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/access-requests",
      headers: { authorization: `Bearer ${body.token}` },
      payload: {
        care_recipient_id: rid,
        claimed_relationship: "family_caregiver",
        reason: "I help with evening meds",
      },
    });
    expect(ar.statusCode).toBe(201);
    const arBody = ar.json() as {
      access_request: { id: string; status: string };
      authorized_recipients: number;
    };
    expect(arBody.access_request.status).toBe("pending");
    expect(arBody.authorized_recipients).toBe(0);

    // Still denied after request
    const state2 = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${rid}/state`,
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(state2.statusCode).toBe(403);

    // Primary can approve
    const marcus = await labLogin(people.sadeil.id, "sadeil-lab-password");
    const decide = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/access-requests/${arBody.access_request.id}/decide`,
      headers: { authorization: `Bearer ${marcus}` },
      payload: { decision: "approve", role_label: "Family caregiver" },
    });
    expect(decide.statusCode).toBe(200);

    // Now authorized
    const state3 = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${rid}/state`,
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(state3.statusCode).toBe(200);

    const me2 = await care.app.inject({
      method: "GET",
      url: "/api/v1/care/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    const me2Body = me2.json() as { authorized_recipients: number };
    expect(me2Body.authorized_recipients).toBe(1);

    // Revoke immediately
    const rev = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${rid}/access/revoke`,
      headers: { authorization: `Bearer ${marcus}` },
      payload: { person_id: body.care_person_id },
    });
    expect(rev.statusCode).toBe(200);

    const state4 = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${rid}/state`,
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(state4.statusCode).toBe(403);
  });

  it("direct API attack: unauthenticated denied", async () => {
    const paths = [
      `/api/v1/care/recipients/${rid}/state`,
      `/api/v1/care/recipients/${rid}/profile`,
      `/api/v1/care/me`,
    ];
    for (const p of paths) {
      const r = await care.app.inject({ method: "GET", url: p });
      expect(r.statusCode).toBe(401);
    }
    const ans = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/answer",
      payload: { question: "How is Mom?", care_recipient_id: rid },
    });
    expect(ans.statusCode).toBe(401);
  });

  it("central authorize denies wrong household", async () => {
    const other = await labLogin(
      people.otherHouseholdCaregiver.id,
      "other-hh-lab-password",
    );
    const r = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${rid}/export?format=json`,
      headers: { authorization: `Bearer ${other}` },
    });
    expect(r.statusCode).toBe(403);
  });

  it("contact verification lifecycle", async () => {
    process.env.CARE_EXPOSE_VERIFY_CODE = "1";
    const email = `verify.${Date.now()}@example.test`;
    const reg = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/auth/register",
      payload: {
        preferred_name: "Sam Verify",
        email,
        password: "secure-password-12",
        claimed_relationship: "friend",
      },
    });
    expect(reg.statusCode).toBe(201);
    const body = reg.json() as {
      token: string;
      verification_code_dev_only?: string;
    };
    expect(body.verification_code_dev_only).toBeTruthy();
    const v = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/auth/verify-contact",
      headers: { authorization: `Bearer ${body.token}` },
      payload: { code: body.verification_code_dev_only },
    });
    expect(v.statusCode).toBe(200);
    const me = await care.app.inject({
      method: "GET",
      url: "/api/v1/care/me",
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect((me.json() as { contact_verified: boolean }).contact_verified).toBe(
      true,
    );
  });
});
