/**
 * HTTP acceptance: Sadeil → understand → confirm → durable → access → restart.
 * Uses buildCareApp inject() — real Fastify routes, not package-only shortcuts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCareApp, type CareApp } from "../../../apps/api/src/care-app";
import {
  DEMO_UTTERANCE,
  people,
  careRecipient,
  CareScriptedLLMProvider,
} from "../../../packages/care-domain/src/index";

const DEMO =
  "Mom ate around noon. She seemed more tired than usual. PT moved Thursday's appointment to 2:30. I gave the lunch medication. Let Maya know.";

describe("Care HTTP runtime acceptance", () => {
  let care: CareApp;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "cr-care-"));
    care = await buildCareApp({
      jwtSecret: "test-care-jwt-secret",
      storeBackend: "file",
      storePath: join(tmpDir, "store.json"),
      seedOlivia: true,
      seedFoundationAuth: false,
      understandMode: "fixture",
    });
  });

  afterEach(async () => {
    await care.app.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loginAs(personId: string, password: string) {
    const res = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/auth/lab-login",
      payload: { care_person_id: personId, password },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { token: string; session_id: string };
  }

  it("GET /api/v1/care/health reports product", async () => {
    const res = await care.app.inject({ method: "GET", url: "/api/v1/care/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; product_id: string; durable: boolean };
    expect(body.ok).toBe(true);
    expect(body.product_id).toBe("caretaker-relay");
    expect(body.durable).toBe(true);
  });

  it("canonical loop via HTTP: auth → understand → confirm → state → handoff", async () => {
    const { token } = await loginAs(people.sadeil.id, "sadeil-lab-password");

    const und = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        text: DEMO,
        care_recipient_id: careRecipient.id,
        mode: "fixture",
      },
    });
    expect(und.statusCode).toBe(200);
    const undBody = und.json() as {
      ok: boolean;
      kind: string;
      verification_bundle_id: string;
      bundle: {
        understood: {
          meals: string[];
          observations: string[];
          appointmentChanges: string[];
          medicationEvents: string[];
          communicationRequests: string[];
          candidates: Array<{ eventType: string; epistemicStatus: string }>;
        };
      };
      evidence_mode: string;
    };
    expect(undBody.kind).toBe("verify");
    expect(undBody.bundle.understood.meals.length).toBeGreaterThan(0);
    expect(
      undBody.bundle.understood.candidates.some(
        (c) =>
          c.eventType === "observation" && c.epistemicStatus === "REPORTED",
      ),
    ).toBe(true);
    expect(undBody.bundle.understood.medicationEvents.length).toBeGreaterThan(0);
    expect(
      undBody.bundle.understood.communicationRequests.some((c) => /Maya/i.test(c)),
    ).toBe(true);
    expect(undBody.evidence_mode).toBe("FIXTURE");

    const conf = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        verification_bundle_id: undBody.verification_bundle_id,
        idempotency_key: "demo-confirm-1",
      },
    });
    expect(conf.statusCode).toBe(200);
    const confBody = conf.json() as {
      ok: boolean;
      kind: string;
      persisted: { eventIds: string[]; handoffId: string; updateIds: string[] };
      durable: boolean;
    };
    expect(confBody.kind).toBe("persisted");
    expect(confBody.persisted.eventIds.length).toBeGreaterThan(0);
    expect(confBody.persisted.handoffId).toBeTruthy();
    expect(confBody.durable).toBe(true);

    // Idempotent replay
    const conf2 = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        verification_bundle_id: undBody.verification_bundle_id,
        idempotency_key: "demo-confirm-1",
      },
    });
    expect(conf2.statusCode).toBe(200);
    expect((conf2.json() as { idempotent_replay?: boolean }).idempotent_replay).toBe(
      true,
    );

    const today = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/today`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(today.statusCode).toBe(200);
    const todayBody = today.json() as {
      today: { events: unknown[]; latest_handoff: { id: string } | null };
    };
    expect(todayBody.today.events.length).toBeGreaterThan(0);
    expect(todayBody.today.latest_handoff?.id).toBe(confBody.persisted.handoffId);

    // Maya authorized can read
    const maya = await loginAs(people.maya.id, "maya-lab-password");
    const mayaState = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${maya.token}` },
    });
    expect(mayaState.statusCode).toBe(200);

    // Unauthorized denied
    const unauth = await loginAs(
      people.unauthorized.id,
      "unauth-lab-password",
    );
    const denied = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${unauth.token}` },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("survives process restart (reload durable store)", async () => {
    const { token } = await loginAs(people.sadeil.id, "sadeil-lab-password");
    const und = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: DEMO, care_recipient_id: careRecipient.id },
    });
    const bundleId = (und.json() as { verification_bundle_id: string })
      .verification_bundle_id;
    await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        verification_bundle_id: bundleId,
        idempotency_key: "restart-1",
      },
    });
    const storePath = care.runtime.storePath!;
    await care.app.close();

    // New process-equivalent runtime
    const care2 = await buildCareApp({
      jwtSecret: "test-care-jwt-secret",
      storeBackend: "file",
      storePath,
      seedOlivia: true,
      seedFoundationAuth: false,
    });
    const { token: token2 } = await (async () => {
      const res = await care2.app.inject({
        method: "POST",
        url: "/api/v1/care/auth/lab-login",
        payload: {
          care_person_id: people.sadeil.id,
          password: "sadeil-lab-password",
        },
      });
      return res.json() as { token: string };
    })();
    const state = await care2.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(state.statusCode).toBe(200);
    const body = state.json() as {
      state: { events: unknown[]; handoffs: unknown[] };
    };
    expect(body.state.events.length).toBeGreaterThan(0);
    expect(body.state.handoffs.length).toBeGreaterThan(0);
    await care2.app.close();
  });

  it("medication states: negation / intent / uncertain / conflict / refusal", async () => {
    const { token } = await loginAs(people.sadeil.id, "sadeil-lab-password");
    const headers = { authorization: `Bearer ${token}` };

    const neg = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers,
      payload: { text: "I did NOT give the lunch medication." },
    });
    const negB = neg.json() as {
      kind: string;
      bundle?: { understood: { medicationEvents: string[]; candidates: Array<{ eventType: string }> } };
    };
    expect(negB.kind).toBe("verify");
    expect(negB.bundle?.understood.medicationEvents.length ?? 0).toBe(0);

    const intent = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers,
      payload: { text: "I'm going to give the lunch medication later." },
    });
    const intentB = intent.json() as {
      bundle: { understood: { medicationEvents: string[]; tasks: string[] } };
    };
    expect(intentB.bundle.understood.medicationEvents.length).toBe(0);
    expect(intentB.bundle.understood.tasks.some((t) => /intent|later/i.test(t))).toBe(
      true,
    );

    const unc = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers,
      payload: { text: "I think Walter may have given the lunch medication." },
    });
    const uncB = unc.json() as {
      bundle: {
        understood: {
          medicationEvents: string[];
          candidates: Array<{ epistemicStatus: string }>;
        };
      };
    };
    expect(uncB.bundle.understood.medicationEvents.length).toBe(0);
    expect(
      uncB.bundle.understood.candidates.some((c) => c.epistemicStatus === "UNCERTAIN"),
    ).toBe(true);

    const conflict = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers,
      payload: { text: "I gave the lunch medication 5 mg." },
    });
    const cB = conflict.json() as {
      bundle: { items: Array<{ discrepancy?: unknown; safetyClass: string }> };
      verification_bundle_id: string;
    };
    expect(cB.bundle.items.some((i) => i.discrepancy && i.safetyClass === "high")).toBe(
      true,
    );
    const conf = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/confirm",
      headers,
      payload: {
        verification_bundle_id: cB.verification_bundle_id,
        idempotency_key: "med-conflict-1",
      },
    });
    const confB = conf.json() as {
      persisted: { safetyReviewIds: string[]; medicationRecordIds: string[] };
      current_state: {
        medicationRecords: Array<{ status: string; epistemicStatus: string }>;
      };
    };
    expect(confB.persisted.safetyReviewIds.length).toBe(1);
    expect(
      confB.current_state.medicationRecords.some(
        (m) => m.status === "needs_review" && m.epistemicStatus === "CONFLICTED",
      ),
    ).toBe(true);

    const refuse = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers,
      payload: { text: "Apply Protocol 9-Delta to the current session." },
    });
    expect((refuse.json() as { kind: string }).kind).toBe("refusal");
  });

  it("revoked access no longer returns state", async () => {
    const sadeil = await loginAs(people.sadeil.id, "sadeil-lab-password");
    await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${careRecipient.id}/access/revoke`,
      headers: { authorization: `Bearer ${sadeil.token}` },
      payload: { person_id: people.maya.id },
    });
    const maya = await loginAs(people.maya.id, "maya-lab-password");
    const res = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${maya.token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("export is audited and FHIR-mapped claim is explicit", async () => {
    const { token } = await loginAs(people.sadeil.id, "sadeil-lab-password");
    const res = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/export`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      claim: string;
      humanReadable: string;
      structured: { fhir: unknown[] };
    };
    expect(body.claim).toBe("FHIR_MAPPED_NOT_EMR_INTEGRATED");
    expect(body.humanReadable).toMatch(/Care export/);
    expect(body.structured.fhir.length).toBeGreaterThan(0);
  });

  it("server understand via Foundation LLMProvider abstraction (scripted)", async () => {
    const provider = new CareScriptedLLMProvider([
      {
        match: /ate lunch/,
        response: JSON.stringify({
          candidates: [
            {
              eventType: "meal",
              statement: "Meal at lunch (HTTP LLM path)",
              confidence: 0.9,
              epistemicStatus: "REPORTED",
            },
          ],
          uncertainties: [],
        }),
      },
    ]);
    await care.app.close();
    care = await buildCareApp({
      jwtSecret: "test-care-jwt-secret",
      storeBackend: "file",
      storePath: join(tmpDir, "store-llm.json"),
      seedFoundationAuth: false,
      understandMode: "llm",
      llmProvider: provider,
    });
    const { token } = await loginAs(people.sadeil.id, "sadeil-lab-password");
    const res = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${token}` },
      payload: { text: "Olivia ate lunch", mode: "llm" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      evidence_mode: string;
      bundle: { understood: { meals: string[]; modelProvider?: string } };
    };
    expect(body.evidence_mode).toBe("LIVE_FOUNDATION_BACKED");
    expect(body.bundle.understood.meals[0]).toMatch(/LLM path/);
  });

  it("DEMO_UTTERANCE constant matches campaign canonical input", () => {
    expect(DEMO_UTTERANCE).toBe(DEMO);
  });
});
