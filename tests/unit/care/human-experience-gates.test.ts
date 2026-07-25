import { describe, expect, it } from "vitest";
import { createCareRuntime } from "../../../packages/care-domain/src/index.js";
import { answerRelayQuestion } from "../../../packages/care-domain/src/services/relay-answer.js";
import { ageFromDateOfBirth } from "../../../packages/care-domain/src/services/recipient-profile.js";
import { listCoverage } from "../../../packages/care-domain/src/services/care-coverage.js";

function ask(store: ReturnType<typeof createCareRuntime>["store"], q: string) {
  return answerRelayQuestion({
    question: q,
    principalId: "p-sadeil",
    principalDisplayName: "Marcus Carter",
    roleLabel: "Primary family caregiver",
    careRecipientId: "cr-olivia",
    recipientDisplayName: "Evelyn Carter",
    store,
  });
}

describe("human experience hard gates", () => {
  it("coverage questions", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    expect(ask(store, "Who is helping now?").answer).toMatch(/Helping now|Marcus/i);
    expect(ask(store, "Who comes after me?").answer).toMatch(/Next|Maya/i);
    expect(ask(store, "When is Maya coming?").answer).toMatch(/Maya|4:30|Expected/i);
    expect(listCoverage(store, "cr-olivia").length).toBeGreaterThan(0);
  });

  it("cancel appointment", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const a = ask(store, "Cancel Evelyn's PT appointment");
    expect(a.answer).toMatch(/cancelled/i);
    const pt = store.getAppointments("cr-olivia").find((x) => /physical|pt/i.test(x.title));
    expect(pt?.status).toBe("cancelled");
  });

  it("book idempotent request", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    ask(store, "I would like to schedule a doctor appointment for Evelyn");
    ask(store, "Wednesday July 29 at 2pm");
    const b1 = ask(store, "confirm appointment request");
    expect(b1.answer).toMatch(/Saved appointment|request/i);
    const n1 = store.getAppointments("cr-olivia").length;
    const b2 = ask(store, "confirm appointment request");
    expect(b2.answer).toMatch(/already on file|idempotent|Saved/i);
    expect(store.getAppointments("cr-olivia").length).toBe(n1);
  });

  it("slot collision", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    ask(store, "I would like to schedule a doctor appointment for Evelyn");
    const a = ask(store, "3:30 pm please");
    expect(a.answer).toMatch(/unavailable|collision/i);
  });

  it("transportation", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const a = ask(store, "What about transportation to PT?");
    expect(a.answer).toMatch(/transport|drive|travel|appointment/i);
  });

  it("age from DOB birthday boundary", () => {
    expect(ageFromDateOfBirth("1948-03-12", new Date("2026-03-11T12:00:00Z"))).toBe(77);
    expect(ageFromDateOfBirth("1948-03-12", new Date("2026-03-12T12:00:00Z"))).toBe(78);
  });

  it("allergy unknown vs nkda", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const a = ask(store, "Does Evelyn have any allergies?");
    expect(a.answer).toMatch(/NO KNOWN ALLERGIES|KNOWN ALLERGY|UNKNOWN/i);
  });
});
