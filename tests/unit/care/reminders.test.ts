import { describe, expect, it } from "vitest";
import { createCareRuntime } from "../../../packages/care-domain/src/index.js";
import {
  listReminders,
  recalculateAppointmentReminders,
  recalculateMedicationReminders,
  rescheduleAppointment,
  resolveMedicationRemindersAfterAdmin,
} from "../../../packages/care-domain/src/services/reminders.js";

describe("reminder recalculation", () => {
  it("appointment 3pm → reminders; reschedule 4:30 supersedes old", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    store.upsertAppointment({
      id: "apt-pt-test",
      careRecipientId: "cr-olivia",
      title: "Physical therapy",
      startsAt: "2026-07-24T22:00:00.000Z", // 3:00 PM PDT
      startsAtLabel: "Friday 3:00 PM PDT",
      location: "Coastal PT",
      status: "scheduled",
      epistemicStatus: "CONFIRMED",
    });
    const first = recalculateAppointmentReminders(store, {
      careRecipientId: "cr-olivia",
      appointment: store.getAppointments("cr-olivia").find((a) => a.id === "apt-pt-test")!,
      timezone: "America/Los_Angeles",
      reminderMinutesBefore: 120,
      leaveByMinutesBefore: 45,
      principalIds: ["p-sadeil"],
    });
    expect(first.length).toBe(2);
    expect(first.some((r) => r.type === "APPOINTMENT_UPCOMING")).toBe(true);
    expect(first.some((r) => r.type === "LEAVE_SOON")).toBe(true);
    const active1 = listReminders(store, "cr-olivia");
    expect(active1.length).toBe(2);

    const res = rescheduleAppointment(store, {
      careRecipientId: "cr-olivia",
      appointmentId: "apt-pt-test",
      newStartsAt: "2026-07-24T23:30:00.000Z", // 4:30 PM PDT
      newStartsAtLabel: "Friday 4:30 PM PDT",
      previousStartsAtLabel: "Friday 3:00 PM PDT",
      timezone: "America/Los_Angeles",
      principalIds: ["p-sadeil"],
    });
    expect(res).toBeTruthy();
    const active2 = listReminders(store, "cr-olivia");
    expect(active2.length).toBe(2);
    expect(active2.every((r) => r.sourceVersion.includes("23:30"))).toBe(true);
    const all = listReminders(store, "cr-olivia", { includeTerminal: true });
    const superseded = all.filter((r) => r.status === "superseded");
    expect(superseded.length).toBeGreaterThanOrEqual(2);
    // No active reminder still pointing at old 3:00 version only
    expect(
      active2.some((r) => /3:00 PM/.test(r.body) && !/4:30/.test(r.body)),
    ).toBe(false);
  });

  it("medication admin confirmation resolves due reminders", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    recalculateMedicationReminders(store, {
      careRecipientId: "cr-olivia",
      scheduleId: "med-lunch",
      name: "Metformin",
      dose: "500 mg",
      nextDueAt: "2026-07-24T19:00:00.000Z",
      windowStart: "11:30 AM",
      windowEnd: "12:30 PM",
      timezone: "America/Los_Angeles",
    });
    expect(listReminders(store, "cr-olivia").some((r) => r.type === "MEDICATION_DUE")).toBe(
      true,
    );
    const n = resolveMedicationRemindersAfterAdmin(store, {
      careRecipientId: "cr-olivia",
      scheduleId: "med-lunch",
      principalId: "p-sadeil",
    });
    expect(n).toBeGreaterThan(0);
    expect(
      listReminders(store, "cr-olivia").filter((r) => r.type === "MEDICATION_DUE")
        .length,
    ).toBe(0);
    const all = listReminders(store, "cr-olivia", { includeTerminal: true });
    expect(all.some((r) => r.status === "resolved")).toBe(true);
  });

  it("timezone is stored on reminders", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    store.upsertAppointment({
      id: "apt-tz",
      careRecipientId: "cr-olivia",
      title: "Clinic",
      startsAt: "2026-07-25T17:00:00.000Z",
      startsAtLabel: "10:00 AM PDT",
      status: "scheduled",
      epistemicStatus: "CONFIRMED",
    });
    const rows = recalculateAppointmentReminders(store, {
      careRecipientId: "cr-olivia",
      appointment: store.getAppointments("cr-olivia").find((a) => a.id === "apt-tz")!,
      timezone: "America/Los_Angeles",
    });
    expect(rows.every((r) => r.timezone === "America/Los_Angeles")).toBe(true);
  });
});
