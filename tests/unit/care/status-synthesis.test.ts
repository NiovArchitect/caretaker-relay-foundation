import { describe, expect, it } from "vitest";
import { classifyIntent } from "../../../packages/care-domain/src/relay/intents.js";
import { createCareRuntime } from "../../../packages/care-domain/src/index.js";
import { answerRelayQuestion } from "../../../packages/care-domain/src/services/relay-answer.js";
import { resolveEffectiveAt } from "../../../packages/care-domain/src/services/care-time.js";

describe("status synthesis + care time", () => {
  it("classifies how is evelyn doing", () => {
    const c = classifyIntent("How is Evelyn doing?");
    expect(c.intents).toContain("STATUS_SYNTHESIS");
  });

  it("answers status for family", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const r = answerRelayQuestion({
      question: "How is Evelyn doing?",
      principalId: "p-sadeil",
      principalDisplayName: "Marcus Carter",
      roleLabel: "Primary family caregiver",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    expect(r.answer).toMatch(/Evelyn|picture|observation|Medication|care/i);
    expect(r.answer).not.toMatch(/I don't have a specific answer for that yet/i);
  });

  it("physician framing differs", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const r = answerRelayQuestion({
      question: "How is Evelyn doing?",
      principalId: "p-dr-shah",
      principalDisplayName: "Dr. Priya Shah",
      roleLabel: "Primary care physician",
      careRecipientId: "cr-olivia",
      recipientDisplayName: "Evelyn Carter",
      store,
    });
    expect(r.answer).toMatch(/Clinical-facing|Provenance|authorized/i);
  });

  it("effective_at defaults for today language", () => {
    const t = resolveEffectiveAt("Evelyn feels very good today.");
    expect(t.recordedAt).toBeTruthy();
    expect(t.effectiveAt).toBeTruthy();
    expect(t.displayTimezone).toBe("America/Los_Angeles");
  });
});
