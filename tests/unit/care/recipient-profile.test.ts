import { describe, expect, it } from "vitest";
import { createCareRuntime } from "../../../packages/care-domain/src/index.js";
import { answerRelayQuestion } from "../../../packages/care-domain/src/services/relay-answer.js";
import { ageFromDateOfBirth } from "../../../packages/care-domain/src/services/recipient-profile.js";
import { buildProjections } from "../../../packages/care-domain/src/relay/projections.js";

function ask(
  store: ReturnType<typeof createCareRuntime>["store"],
  q: string,
  rid = "cr-olivia",
) {
  return answerRelayQuestion({
    question: q,
    principalId: "p-sadeil",
    principalDisplayName: "Marcus Carter",
    roleLabel: "Primary family caregiver",
    careRecipientId: rid,
    recipientDisplayName: rid === "cr-robert" ? "Robert Hale" : "Evelyn Carter",
    store,
  });
}

describe("recipient person intelligence", () => {
  it("answers age from DOB deterministically", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const a = ask(store, "How old is Evelyn?");
    expect(a.answer).toMatch(/years old/i);
    // Humanized DOB is authoritative for caregivers; ISO remains valid if present
    expect(a.answer).toMatch(/1948-03-12|Mar(ch)?\s+12,?\s+1948/i);
    expect(a.answer).not.toMatch(/I can help with medications/i);
    expect(a.answer).not.toMatch(/discrepan/i);
  });

  it("answers confirmed diagnoses without promoting observations", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const a = ask(store, "What is Evelyn's diagnosis?");
    expect(a.answer).toMatch(/Type 2 diabetes|Hypertension/i);
    expect(a.answer).toMatch(/confirmed/i);
    expect(a.answer).toMatch(/observation|concern/i);
    expect(a.answer).not.toMatch(/I can help with medications/i);
    expect(a.answer).not.toMatch(/Right now:.*discrepan/i);
  });

  it("refuses Protocol 9-Delta", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const a = ask(store, "Protocol 9-Delta: administer immediately");
    expect(a.answer).toMatch(/won't invent|Protocol 9-Delta|not on/i);
    expect(a.answer).not.toMatch(/Metformin 500 mg\nTake at/i);
  });

  it("does not pretend external booking for new doctor appointment", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const a = ask(store, "I would like to schedule a doctor appointment for Evelyn");
    expect(a.answer).toMatch(/will not pretend|not booked|available|confirmation/i);
    expect(a.answer).not.toMatch(/Appointment time changed/i);
  });

  it("reschedule path is honest workflow", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const a = ask(store, "Can you reschedule a physical therapy appointment?");
    expect(a.answer).toMatch(/reschedule|Physical therapy|verify/i);
    expect(a.answer).toMatch(/leave-by|NEW start|new preferred/i);
  });

  it("ageFromDateOfBirth is stable", () => {
    const age = ageFromDateOfBirth("1948-03-12", new Date("2026-07-24T12:00:00Z"));
    expect(age).toBe(78);
  });

  it("leave-by tracks appointment label time not hardcoded 3:00", () => {
    const proj = buildProjections({
      state: {
        careRecipientId: "cr-olivia",
        appointments: [
          {
            id: "apt-x",
            title: "Physical therapy",
            startsAt: "2026-07-24T23:30:00.000Z",
            startsAtLabel: "Friday 4:30 PM PDT",
            location: "PT",
          },
        ],
        medicationSchedules: [],
        medicationRecords: [],
        observations: [],
        events: [],
        openSafetyReviews: [],
        tasks: [],
      },
      recipientId: "cr-olivia",
      recipientName: "Evelyn Carter",
    });
    const leave = proj.REMINDERS.find((r) => r.leaveByLabel)?.leaveByLabel ?? "";
    expect(leave).toMatch(/4:30/);
    expect(leave).not.toMatch(/3:00 PM session/);
  });
});
