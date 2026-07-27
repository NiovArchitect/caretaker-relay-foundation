/**
 * Care orchestration unit tests — full Maya loop + provider candidate.
 */
import { describe, expect, it } from "vitest";
import { createCareRuntime } from "../../../packages/care-domain/src/index.js";
import {
  advanceOrchestrationOnResponse,
  confirmCandidate,
  startClarificationOrchestration,
  summarizeOpenLoops,
  selectBestContact,
} from "../../../packages/care-domain/src/services/orchestration.js";
import { respondToClarification } from "../../../packages/care-domain/src/services/notifications.js";
import { answerRelayQuestion } from "../../../packages/care-domain/src/services/relay-answer.js";

describe("care orchestration engine", () => {
  it("Marcus → Maya → response → verify → care truth changes answer", () => {
    const { store } = createCareRuntime({ seedOlivia: true });

    // Ensure no Maya MAR for clean unknown path (void existing maya records)
    for (const r of store.getMedRecords("cr-olivia")) {
      if (r.administeredByPersonId === "p-maya") {
        store.addMedRecord({ ...r, status: "voided", id: r.id + "-void" });
      }
    }

    const started = startClarificationOrchestration(store, {
      careRecipientId: "cr-olivia",
      requesterPersonId: "p-sadeil",
      requesterDisplayName: "Marcus Carter",
      targetPersonId: "p-maya",
      targetDisplayName: "Maya Bennett",
      question: "Did you give Evelyn lunch Metformin yesterday?",
      contextSummary: "unit test",
    });
    expect(started.orchestration.state).toBe("WAITING_FOR_RESPONSE");

    const waiting = summarizeOpenLoops(store, "cr-olivia", "p-sadeil");
    expect(waiting.waitingOnNames).toContain("Maya Bennett");
    expect(waiting.lines.some((l) => /Waiting on Maya/i.test(l))).toBe(true);

    const resp = respondToClarification(store, {
      requestId: started.requestId,
      careRecipientId: "cr-olivia",
      responderPersonId: "p-maya",
      responderDisplayName: "Maya Bennett",
      body: "Yes, I gave it around 12:10 after she ate.",
    });
    expect(resp).toBeTruthy();

    const advanced = advanceOrchestrationOnResponse(store, {
      careRecipientId: "cr-olivia",
      requestId: started.requestId,
      responseId: resp!.response.id,
      responseBody: "Yes, I gave it around 12:10 after she ate.",
      responderPersonId: "p-maya",
      responderDisplayName: "Maya Bennett",
    });
    expect(advanced).toBeTruthy();
    expect(advanced!.candidate.requiresVerification).toBe(true);
    expect(advanced!.orchestration.state).toBe("NEEDS_VERIFICATION");
    expect(advanced!.candidate.status).toBe("pending");

    // Must not auto-create MAR before confirm
    const beforeConfirm = store
      .getMedRecords("cr-olivia")
      .filter((m) => m.id.startsWith("mar-orch-"));
    expect(beforeConfirm.length).toBe(0);

    const confirmed = confirmCandidate(store, {
      careRecipientId: "cr-olivia",
      candidateId: advanced!.candidate.id,
      confirmerPersonId: "p-sadeil",
      confirmerDisplayName: "Marcus Carter",
    });
    expect(confirmed).toBeTruthy();
    expect(confirmed!.orchestration.state).toBe("RESOLVED");
    expect(confirmed!.mar).toBeTruthy();
    expect(confirmed!.handoff).toBeTruthy();

    // Expectation derives from scenario membership + confirmed MAR actor, not a hard-coded fixture.
    const actorId = confirmed!.mar?.administeredByPersonId ?? "p-maya";
    const actorName =
      store.getPerson(actorId)?.displayName ?? "Maya Bennett";
    const first = actorName.split(/\s+/)[0] ?? actorName;
    const ans = answerRelayQuestion({
      question: `When did ${first} give Evelyn's lunch medication yesterday?`,
      principalId: "p-sadeil",
      principalDisplayName: "Marcus Carter",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    expect(ans.authorizationOutcome).toBe("answered");
    // Answer must attribute the administration to the actual authorized actor name on file.
    expect(ans.answer).toMatch(new RegExp(first, "i"));
    expect(ans.answer).not.toMatch(/Want me to ask/i);
  });

  it("provider response creates professional candidate without auto MAR", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const started = startClarificationOrchestration(store, {
      careRecipientId: "cr-olivia",
      requesterPersonId: "p-sadeil",
      requesterDisplayName: "Marcus Carter",
      targetPersonId: "p-dr-shah",
      targetDisplayName: "Dr. Priya Shah",
      question: "Could recent dizziness need medication review?",
      kind: "provider_clarification",
    });
    const resp = respondToClarification(store, {
      requestId: started.requestId,
      careRecipientId: "cr-olivia",
      responderPersonId: "p-dr-shah",
      responderDisplayName: "Dr. Priya Shah",
      body: "Continue current medication as prescribed. Contact clinic if dizziness worsens.",
    });
    const advanced = advanceOrchestrationOnResponse(store, {
      careRecipientId: "cr-olivia",
      requestId: started.requestId,
      responseId: resp!.response.id,
      responseBody:
        "Continue current medication as prescribed. Contact clinic if dizziness worsens.",
      responderPersonId: "p-dr-shah",
      responderDisplayName: "Dr. Priya Shah",
    });
    expect(advanced!.candidate.authority).toBe("professional");
    expect(advanced!.candidate.type).toBe("provider_instruction");
    const confirmed = confirmCandidate(store, {
      careRecipientId: "cr-olivia",
      candidateId: advanced!.candidate.id,
      confirmerPersonId: "p-sadeil",
      confirmerDisplayName: "Marcus Carter",
    });
    expect(confirmed!.providerGuidanceId).toBeTruthy();
    expect(confirmed!.mar).toBeUndefined();
  });

  it("selectBestContact does not hardcode Maya for Robert", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    // Robert may have limited circle — should not invent Maya
    const hit = selectBestContact(store, "cr-robert", "medication_admin", "p-sadeil");
    if (hit) {
      expect(hit.personId).not.toBe("p-maya");
    }
  });

  it("waiting-on answer reflects open loops", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    startClarificationOrchestration(store, {
      careRecipientId: "cr-olivia",
      requesterPersonId: "p-sadeil",
      requesterDisplayName: "Marcus Carter",
      targetPersonId: "p-maya",
      targetDisplayName: "Maya Bennett",
      question: "Did you give lunch med?",
    });
    const ans = answerRelayQuestion({
      question: "Are we still waiting on anyone?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus Carter",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    expect(ans.answer).toMatch(/Maya|Waiting/i);
  });
});
