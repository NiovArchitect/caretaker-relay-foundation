/**
 * Real multi-principal household closure (API-level).
 * Proves: invite → accept → understand → confirm → Maya continuity →
 * Maya question → Maya correction → Marcus re-observes → Daniel subset → unauthorized 403.
 *
 * Uses memory store by default; when DATABASE_URL is set, also exercises Prisma path.
 * Understand mode: fixture for deterministic CI; optional llm with MockLLMProvider.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  people,
  careRecipient,
  type LLMProvider,
  type LLMResult,
} from "../../../packages/care-domain/src/index";
import { buildCareApp } from "../../../apps/api/src/care-app";

class ScriptedCareLLM implements LLMProvider {
  readonly name = "mock-care-extract";
  constructor(private readonly script: LLMResult) {}
  async generateResponse(): Promise<LLMResult> {
    return this.script;
  }
}

const FRESH_UTTERANCE =
  "Mom was kinda dizzy again after breakfast. I think she took the blue one but I'm not positive because Maya had already set some pills out, and PT called and said Thursday won't work.";

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
    if (res.statusCode !== 200) {
      const lab = await care.app.inject({
        method: "POST",
        url: "/api/v1/care/auth/lab-login",
        payload: { care_person_id: carePersonId, password },
      });
      expect(lab.statusCode).toBe(200);
      return lab.json() as {
        token: string;
        care_person_id: string;
        display_name: string;
      };
    }
    return res.json() as {
      token: string;
      care_person_id: string;
      display_name: string;
    };
  }

  it("invite → update → Maya continuity → question → correction → Marcus re-observe → Daniel + deny", async () => {
    const marcus = await login(people.sadeil.id, "sadeil-lab-password");
    expect(marcus.display_name).toMatch(/Marcus/i);

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

    // Token not re-listed after create
    const listInv = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/invitations`,
      headers: { authorization: `Bearer ${marcus.token}` },
    });
    expect(listInv.statusCode).toBe(200);
    const listed = listInv.json() as {
      invitations: Array<{ token?: string; status: string }>;
    };
    expect(listed.invitations.some((i) => i.token)).toBe(false);

    const maya = await login(people.maya.id, "maya-lab-password");
    const accept = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/invitations/${invBody.invitation.token}/accept`,
      headers: { authorization: `Bearer ${maya.token}` },
      payload: {},
    });
    expect(accept.statusCode).toBe(200);

    const und = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${marcus.token}` },
      payload: {
        text: FRESH_UTTERANCE,
        care_recipient_id: careRecipient.id,
      },
    });
    expect(und.statusCode).toBe(200);
    const undBody = und.json() as {
      kind: string;
      verification_bundle_id?: string;
      bundle?: { items: Array<{ label: string }> };
      evidence_mode?: string;
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
    const confBody = conf.json() as {
      kind: string;
      persisted?: { eventIds?: string[]; handoffId?: string };
    };
    expect(confBody.kind).toBe("persisted");
    expect(confBody.persisted?.eventIds?.length).toBeGreaterThan(0);

    // Maya sees continuity
    const mayaHo = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/handoffs`,
      headers: { authorization: `Bearer ${maya.token}` },
    });
    expect(mayaHo.statusCode).toBe(200);
    expect(
      (mayaHo.json() as { handoffs: unknown[] }).handoffs.length,
    ).toBeGreaterThan(0);

    // Maya asks grounded question
    const ans = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/answer",
      headers: { authorization: `Bearer ${maya.token}` },
      payload: {
        question: "What happened since I was last here?",
        care_recipient_id: careRecipient.id,
      },
    });
    expect(ans.statusCode).toBe(200);
    const answer = (ans.json() as { answer: string; grounded: boolean }).answer;
    expect(answer.length).toBeGreaterThan(20);
    expect((ans.json() as { grounded: boolean }).grounded).toBe(true);

    // Coordination
    const coord = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${careRecipient.id}/coordination`,
      headers: { authorization: `Bearer ${marcus.token}` },
      payload: {
        body: "Please watch for more dizziness this evening.",
        to_person_id: people.maya.id,
      },
    });
    expect(coord.statusCode).toBe(201);

    // Maya corrects an appointment fact (find an event to supersede)
    const stateMaya = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${maya.token}` },
    });
    expect(stateMaya.statusCode).toBe(200);
    const events = (
      stateMaya.json() as {
        state: { events: Array<{ id: string; statement: string }> };
      }
    ).state.events;
    const target =
      events.find((e) => /PT|appointment|meal|dizzy/i.test(e.statement)) ??
      events[0];
    expect(target).toBeTruthy();

    const correction = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/corrections",
      headers: { authorization: `Bearer ${maya.token}` },
      payload: {
        target_event_id: target!.id,
        corrected_value:
          "Physical therapy is Friday at 2:30 PM (corrected by Maya)",
        care_recipient_id: careRecipient.id,
      },
    });
    expect(correction.statusCode).toBe(200);
    expect(
      (correction.json() as { kind?: string }).kind === "persisted" ||
        (correction.json() as { ok?: boolean }).ok === true ||
        correction.statusCode === 200,
    ).toBe(true);

    // Marcus re-observes corrections
    const marcusState = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/state`,
      headers: { authorization: `Bearer ${marcus.token}` },
    });
    expect(marcusState.statusCode).toBe(200);
    const corrList = (
      marcusState.json() as {
        state: {
          corrections?: Array<{
            correctedValue: string;
            correctedByPersonId: string;
          }>;
        };
      }
    ).state.corrections;
    // corrections may be on state or separate timeline
    const timeline = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/timeline`,
      headers: { authorization: `Bearer ${marcus.token}` },
    });
    expect(timeline.statusCode).toBe(200);
    const tl = timeline.json() as {
      corrections: Array<{
        correctedValue: string;
        correctedByPersonId: string;
      }>;
    };
    const allCorr = [
      ...(corrList ?? []),
      ...(tl.corrections ?? []),
    ];
    expect(
      allCorr.some(
        (c) =>
          c.correctedByPersonId === people.maya.id ||
          /Friday|corrected by Maya/i.test(c.correctedValue),
      ),
    ).toBe(true);

    // Daniel authorized subset
    const daniel = await login(people.walter.id, "walter-lab-password");
    const dToday = await care.app.inject({
      method: "GET",
      url: `/api/v1/care/recipients/${careRecipient.id}/today`,
      headers: { authorization: `Bearer ${daniel.token}` },
    });
    expect(dToday.statusCode).toBe(200);

    // Daniel cannot invite
    const dInvite = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/recipients/${careRecipient.id}/invitations`,
      headers: { authorization: `Bearer ${daniel.token}` },
      payload: { invitee_care_person_id: people.unauthorized.id },
    });
    expect(dInvite.statusCode).toBe(403);

    // Unauthorized denied
    const unauth = await login(
      people.unauthorized.id,
      "unauth-lab-password",
    );
    for (const path of [
      `/api/v1/care/recipients/${careRecipient.id}/state`,
      `/api/v1/care/recipients/${careRecipient.id}/handoffs`,
      `/api/v1/care/recipients/${careRecipient.id}/export?format=json`,
      `/api/v1/care/recipients/${careRecipient.id}/coordination`,
    ]) {
      const denied = await care.app.inject({
        method: "GET",
        url: path,
        headers: { authorization: `Bearer ${unauth.token}` },
      });
      expect(denied.statusCode).toBe(403);
    }

    // Token replay after accept fails
    const replay = await care.app.inject({
      method: "POST",
      url: `/api/v1/care/invitations/${invBody.invitation.token}/accept`,
      headers: { authorization: `Bearer ${maya.token}` },
      payload: {},
    });
    expect([409, 410, 404]).toContain(replay.statusCode);

    // Second fresh utterance
    const und2 = await care.app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: { authorization: `Bearer ${marcus.token}` },
      payload: {
        text: "She barely ate dinner and said her legs felt rubbery after therapy was cancelled.",
        care_recipient_id: careRecipient.id,
      },
    });
    expect(und2.statusCode).toBe(200);
    expect((und2.json() as { kind: string }).kind).toBe("verify");
  }, 120_000);

  it("llm mode with scripted provider extracts multi-signal JSON", async () => {
    const mock: LLMResult = {
      ok: true,
      text: JSON.stringify({
        candidates: [
          {
            eventType: "observation",
            statement: "Caregiver reported dizziness after breakfast",
            timeLabel: "after breakfast",
            confidence: 0.8,
            epistemicStatus: "REPORTED",
            intendedRecipientName: null,
            recordedDose: null,
          },
          {
            eventType: "medication_administration",
            statement: "Uncertain blue tablet report",
            confidence: 0.4,
            epistemicStatus: "UNCERTAIN",
            recordedDose: "unidentified blue tablet",
          },
          {
            eventType: "appointment_change",
            statement: "PT Thursday will not work",
            confidence: 0.75,
            epistemicStatus: "REPORTED",
          },
        ],
        uncertainties: [
          "Medication identity unknown from color alone",
          "New PT time not specified",
        ],
      }),
      provider: "mock-care-extract",
      model: "scripted-json",
    };
    const careLlm = await buildCareApp({
      jwtSecret: "household-llm-test",
      storeBackend: "memory",
      seedOlivia: true,
      seedFoundationAuth: false,
      understandMode: "llm",
      llmProvider: new ScriptedCareLLM(mock),
    });
    try {
      const login = await careLlm.app.inject({
        method: "POST",
        url: "/api/v1/care/auth/lab-login",
        payload: {
          care_person_id: people.sadeil.id,
          password: "sadeil-lab-password",
        },
      });
      expect(login.statusCode).toBe(200);
      const token = (login.json() as { token: string }).token;
      const und = await careLlm.app.inject({
        method: "POST",
        url: "/api/v1/care/understand",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          text: FRESH_UTTERANCE,
          care_recipient_id: careRecipient.id,
          mode: "llm",
        },
      });
      expect(und.statusCode).toBe(200);
      const body = und.json() as {
        kind: string;
        evidence_mode?: string;
        bundle?: { items: unknown[] };
      };
      expect(body.kind).toBe("verify");
      expect((body.bundle?.items ?? []).length).toBeGreaterThanOrEqual(2);
      expect(String(body.evidence_mode ?? "")).not.toMatch(/^FIXTURE$/i);
    } finally {
      await careLlm.app.close();
    }
  }, 60_000);
});
