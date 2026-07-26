/**
 * Final coherence security: multi-instance revoke, suspension, view audit, config.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  people,
  careRecipient,
  MemorySharedRevocationAdapter,
  SharedSessionRevocation,
  setSharedSessionRevocation,
  getSharedSessionRevocation,
  clearCareViewAuditSuppression,
  validateCareProductionConfig,
  recordCareDataView,
  MemoryCareStore,
  seedOliviaScenario,
} from "../../../packages/care-domain/src/index";
import { buildCareApp } from "../../../apps/api/src/care-app";

describe("COHERENCE SECURITY", () => {
  let care: Awaited<ReturnType<typeof buildCareApp>>;
  const rid = careRecipient.id;

  beforeAll(async () => {
    MemorySharedRevocationAdapter.clearGlobal();
    setSharedSessionRevocation(
      new SharedSessionRevocation(new MemorySharedRevocationAdapter(true)),
    );
    care = await buildCareApp({
      jwtSecret: "coherence-secret",
      storeBackend: "memory",
      seedOlivia: true,
      seedFoundationAuth: false,
      understandMode: "fixture",
    });
  }, 60_000);

  afterAll(async () => {
    await care.app.close();
  });

  beforeEach(() => {
    clearCareViewAuditSuppression();
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

  it("multi-instance shared denylist: revoke on A denies on B", async () => {
    // Two independent CareAuthService paths sharing the same global Map
    const storeA = getSharedSessionRevocation();
    const storeB = new SharedSessionRevocation(
      new MemorySharedRevocationAdapter(true),
    );
    setSharedSessionRevocation(storeA);

    const token = await login(people.maya.id, "maya-lab-password");
    // Simulate instance A validates then revokes
    const me = await care.app.inject({
      method: "GET",
      url: "/api/v1/care/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    const sid = (me.json() as { session_id?: string }).session_id;
    expect(sid).toBeTruthy();

    await storeA.revokeSession(sid!, { reason: "test_multi" });
    // Instance B sees shared revoke
    expect(await storeB.isSessionRevoked(sid!)).toBe(true);

    const me2 = await care.app.inject({
      method: "GET",
      url: "/api/v1/care/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me2.statusCode).toBe(401);
  });

  it("account suspension invalidates subsequent API use", async () => {
    const victim = await login(people.unauthorized.id, "unauth-lab-password");
    const marcus = await login(people.sadeil.id, "sadeil-lab-password");

    const sus = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/accounts/suspend",
      headers: { authorization: `Bearer ${marcus}` },
      payload: {
        person_id: people.unauthorized.id,
        reason: "policy test suspension",
      },
    });
    expect(sus.statusCode).toBe(200);

    const denied = await care.app.inject({
      method: "GET",
      url: "/api/v1/care/me",
      headers: { authorization: `Bearer ${victim}` },
    });
    // May be 401 (session wiped) or 403 suspended
    expect([401, 403]).toContain(denied.statusCode);

    // Reactivate
    const re = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/accounts/reactivate",
      headers: { authorization: `Bearer ${marcus}` },
      payload: { person_id: people.unauthorized.id },
    });
    expect(re.statusCode).toBe(200);
  });

  it("view audit emits once under polling suppression", () => {
    const store = new MemoryCareStore();
    seedOliviaScenario(store);
    const a = recordCareDataView(store, {
      actorPersonId: people.sadeil.id,
      careRecipientId: rid,
      surface: "state",
    });
    const b = recordCareDataView(store, {
      actorPersonId: people.sadeil.id,
      careRecipientId: rid,
      surface: "state",
    });
    expect(a).toBe(true);
    expect(b).toBe(false);
    const views = store
      .listAudit({ careRecipientId: rid })
      .filter((x) => x.action === "CARE_DATA_VIEW");
    expect(views.length).toBeGreaterThanOrEqual(1);
  });

  it("access summary includes last access for controller", async () => {
    const marcus = await login(people.sadeil.id, "sadeil-lab-password");
    await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${rid}/state`,
      headers: { authorization: `Bearer ${marcus}` },
    });
    const acc = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${rid}/access`,
      headers: { authorization: `Bearer ${marcus}` },
    });
    expect(acc.statusCode).toBe(200);
    const body = acc.json() as {
      access_summary?: Array<{ person_id: string }>;
    };
    expect(Array.isArray(body.access_summary)).toBe(true);
    expect((body.access_summary ?? []).length).toBeGreaterThan(0);
  });

  it("production config fails on insecure JWT in production", () => {
    const bad = validateCareProductionConfig({
      NODE_ENV: "production",
      CARE_DEPLOYMENT_MODE: "regulated_restricted",
      JWT_SECRET: "short",
      CARE_MULTI_INSTANCE: "1",
      // no REDIS
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => /JWT|Redis|REDIS/i.test(e))).toBe(true);
  });

  it("test mode allows lab login", () => {
    const ok = validateCareProductionConfig({
      NODE_ENV: "test",
      CARE_DEPLOYMENT_MODE: "test",
    });
    expect(ok.flags.labLoginEnabled).toBe(true);
  });
});
