import { describe, expect, it } from "vitest";
import { MemoryCareStore } from "../../../packages/care-domain/src/store/memory-store.js";
import { seedMultiTenantFixture } from "../../../packages/care-domain/src/scenario/multi-tenant.js";
import { evaluateAccess } from "../../../packages/care-domain/src/services/access.js";
import {
  listCareTeam,
  resolveCurrentProvider,
} from "../../../packages/care-domain/src/services/care-team.js";
import { answerRelayQuestion } from "../../../packages/care-domain/src/services/relay-answer.js";
import { createCareRuntime } from "../../../packages/care-domain/src/index.js";
import {
  startClarificationOrchestration,
  advanceOrchestrationOnResponse,
  confirmCandidate,
} from "../../../packages/care-domain/src/index.js";
import { respondToClarification } from "../../../packages/care-domain/src/services/notifications.js";

describe("three-company isolation", () => {
  it("Company A user cannot access Company B/C recipients", () => {
    const store = new MemoryCareStore();
    seedMultiTenantFixture(store);
    expect(evaluateAccess(store, "p-a-marcus", "cr-a-evelyn").allowed).toBe(true);
    expect(evaluateAccess(store, "p-a-marcus", "cr-b-evelyn").allowed).toBe(false);
    expect(evaluateAccess(store, "p-a-marcus", "cr-c-robert").allowed).toBe(false);
    expect(evaluateAccess(store, "p-b-marcus", "cr-a-evelyn").allowed).toBe(false);
    expect(evaluateAccess(store, "p-b-marcus", "cr-b-evelyn").allowed).toBe(true);
  });

  it("same display names do not pool data across companies", () => {
    const store = new MemoryCareStore();
    seedMultiTenantFixture(store);
    const aMeds = store.getMedSchedules("cr-a-evelyn");
    const bMeds = store.getMedSchedules("cr-b-evelyn");
    expect(aMeds[0]?.name).toMatch(/Metformin/i);
    expect(bMeds[0]?.name).toMatch(/Lisinopril/i);
    const aShah = resolveCurrentProvider(store, "cr-a-evelyn");
    const bShah = resolveCurrentProvider(store, "cr-b-evelyn");
    expect(aShah?.displayName).toMatch(/Shah/);
    expect(bShah?.displayName).toMatch(/Shah/);
    expect(aShah?.personId).not.toBe(bShah?.personId);
    expect(aShah?.organizationId).toBe("org-provider-clinic");
    expect(bShah?.organizationId).toBe("org-company-b");
  });

  it("external provider is care-team member with clinic org, not agency employee", () => {
    const store = new MemoryCareStore();
    seedMultiTenantFixture(store);
    const team = listCareTeam(store, "cr-a-evelyn");
    const shah = team.find((m) => m.personId === "p-prov-shah");
    expect(shah).toBeTruthy();
    expect(shah!.organizationName).toMatch(/Coastal Family Medicine/i);
    expect(shah!.roleKind).toMatch(/physician|primary/);
  });

  it("same DSP person can hold separate memberships without conflating scopes", () => {
    const store = new MemoryCareStore();
    seedMultiTenantFixture(store);
    // Daniel in A for Evelyn A
    expect(evaluateAccess(store, "p-a-daniel", "cr-a-evelyn").allowed).toBe(true);
    // Same person also on Robert in C
    expect(evaluateAccess(store, "p-a-daniel", "cr-c-robert").allowed).toBe(true);
    // But not Company B Evelyn
    expect(evaluateAccess(store, "p-a-daniel", "cr-b-evelyn").allowed).toBe(false);
  });
});

describe("pipeline loops", () => {
  it("output→human action→input closes medication loop without auto-truth", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const started = startClarificationOrchestration(store, {
      careRecipientId: "cr-olivia",
      requesterPersonId: "p-sadeil",
      requesterDisplayName: "Marcus Carter",
      targetPersonId: "p-maya",
      targetDisplayName: "Maya Bennett",
      question: "Did you give lunch Metformin?",
    });
    expect(started.orchestration.state).toBe("WAITING_FOR_RESPONSE");
    const resp = respondToClarification(store, {
      requestId: started.requestId,
      careRecipientId: "cr-olivia",
      responderPersonId: "p-maya",
      responderDisplayName: "Maya Bennett",
      body: "Yes around noon after she ate",
    });
    const advanced = advanceOrchestrationOnResponse(store, {
      careRecipientId: "cr-olivia",
      requestId: started.requestId,
      responseId: resp!.response.id,
      responseBody: "Yes around noon after she ate",
      responderPersonId: "p-maya",
      responderDisplayName: "Maya Bennett",
    });
    expect(advanced!.candidate.requiresVerification).toBe(true);
    expect(
      store.getMedRecords("cr-olivia").filter((m) => m.id.startsWith("mar-orch-"))
        .length,
    ).toBe(0);
    const conf = confirmCandidate(store, {
      careRecipientId: "cr-olivia",
      candidateId: advanced!.candidate.id,
      confirmerPersonId: "p-sadeil",
      confirmerDisplayName: "Marcus Carter",
    });
    expect(conf!.mar).toBeTruthy();
    const ans = answerRelayQuestion({
      question: "When did Maya give the medication?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus Carter",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    expect(ans.answer).toMatch(/Maya/i);
  });

  it("raw evidence is preserved on confirmation provenance", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const started = startClarificationOrchestration(store, {
      careRecipientId: "cr-olivia",
      requesterPersonId: "p-sadeil",
      requesterDisplayName: "Marcus Carter",
      targetPersonId: "p-maya",
      targetDisplayName: "Maya Bennett",
      question: "Lunch med?",
    });
    const raw = "Yes I gave Metformin 500mg around 12:10 after she ate.";
    const resp = respondToClarification(store, {
      requestId: started.requestId,
      careRecipientId: "cr-olivia",
      responderPersonId: "p-maya",
      responderDisplayName: "Maya Bennett",
      body: raw,
    });
    const advanced = advanceOrchestrationOnResponse(store, {
      careRecipientId: "cr-olivia",
      requestId: started.requestId,
      responseId: resp!.response.id,
      responseBody: raw,
      responderPersonId: "p-maya",
      responderDisplayName: "Maya Bennett",
    });
    expect(advanced!.candidate.originalEvidence).toBe(raw);
    const conf = confirmCandidate(store, {
      careRecipientId: "cr-olivia",
      candidateId: advanced!.candidate.id,
      confirmerPersonId: "p-sadeil",
      confirmerDisplayName: "Marcus Carter",
    });
    expect(conf!.mar?.source.rawExcerpt).toMatch(/12:10|Metformin/i);
  });
});
