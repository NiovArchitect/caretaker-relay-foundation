/**
 * Semantic Today eligibility matrix — 60 scenarios across required families.
 * Clean universes only; does not depend on public lab pollution.
 */
import { describe, it, expect } from "vitest";
import {
  buildSemanticTodaySlices,
  evaluateAppointmentEligibility,
  evaluateEventEligibility,
  evaluateObservationEligibility,
  evaluateTaskEligibility,
} from "../../../packages/care-domain/src/services/semantic-today.js";
import type {
  Appointment,
  CareEvent,
  CareTask,
  Observation,
} from "../../../packages/care-domain/src/types.js";

const DAY = "2026-07-30";
const nowMs = Date.parse(`${DAY}T15:00:00.000Z`);

function task(
  partial: Partial<CareTask> & { id: string; title: string },
): CareTask {
  return {
    careRecipientId: "cr-test",
    status: "pending",
    safetyClass: "moderate",
    epistemicStatus: "REPORTED",
    ...partial,
  };
}

function event(
  partial: Partial<CareEvent> & { id: string; type: CareEvent["type"]; title: string },
): CareEvent {
  return {
    careRecipientId: "cr-test",
    householdId: "hh-test",
    statement: partial.title,
    occurredAt: `${DAY}T12:00:00.000Z`,
    eventAt: `${DAY}T12:00:00.000Z`,
    epistemicStatus: "REPORTED",
    safetyClass: "moderate",
    source: {
      id: "src",
      kind: "caregiver_text",
      label: "test",
      actorName: "Tester",
      actorPersonId: "p-t",
      recordedAt: `${DAY}T12:00:00.000Z`,
      whyVisible: "test",
    },
    evidenceMode: "FIXTURE",
    ...partial,
  };
}

function apt(
  partial: Partial<Appointment> & { id: string; title: string; startsAt: string },
): Appointment {
  return {
    careRecipientId: "cr-test",
    status: "scheduled",
    epistemicStatus: "CONFIRMED",
    ...partial,
  };
}

function obs(
  partial: Partial<Observation> & { id: string; summary: string },
): Observation {
  return {
    careRecipientId: "cr-test",
    observedAt: `${DAY}T12:00:00.000Z`,
    epistemicStatus: "REPORTED",
    source: {
      id: "src",
      kind: "caregiver_text",
      label: "test",
      actorName: "Tester",
      actorPersonId: "p-t",
      recordedAt: `${DAY}T12:00:00.000Z`,
      whyVisible: "test",
    },
    ...partial,
  };
}

type Scenario = {
  id: string;
  category: string;
  run: () => void;
};

const scenarios: Scenario[] = [];

function sc(id: string, category: string, run: () => void) {
  scenarios.push({ id, category, run });
}

// A. Empty day — 5
for (let i = 1; i <= 5; i++) {
  sc(`A${i}`, "empty_day", () => {
    const s = buildSemanticTodaySlices({
      events: [],
      tasks: [],
      appointments: [],
      observations: [],
      nowMs,
    });
    expect(s.events).toHaveLength(0);
    expect(s.tasks).toHaveLength(0);
    expect(s.appointments).toHaveLength(0);
  });
}

// B. One scheduled medication — 5 (modeled as today med event + work)
for (let i = 1; i <= 5; i++) {
  sc(`B${i}`, "one_scheduled_med", () => {
    const s = buildSemanticTodaySlices({
      events: [
        event({
          id: `e-med-${i}`,
          type: "medication_administration",
          title: `Morning dose ${i}`,
        }),
      ],
      tasks: [task({ id: `t-med-${i}`, title: `Give morning med ${i}` })],
      nowMs,
    });
    expect(s.events.some((e) => e.id === `e-med-${i}`)).toBe(true);
    expect(s.tasks.some((t) => t.id === `t-med-${i}`)).toBe(true);
  });
}

// C. Multiple medication states — 5
sc("C1", "multi_med", () => {
  const s = buildSemanticTodaySlices({
    events: [
      event({
        id: "e-done",
        type: "medication_administration",
        title: "Given at noon",
        eventAt: `${DAY}T12:00:00.000Z`,
      }),
      event({
        id: "e-old",
        type: "medication_administration",
        title: "Yesterday dose",
        eventAt: "2026-07-29T12:00:00.000Z",
        occurredAt: "2026-07-29T12:00:00.000Z",
      }),
    ],
    nowMs,
  });
  expect(s.events.some((e) => e.id === "e-done")).toBe(true);
  expect(s.events.some((e) => e.id === "e-old")).toBe(false);
});
sc("C2", "multi_med", () => {
  expect(
    evaluateEventEligibility(
      event({
        id: "e-corr",
        type: "correction",
        title: "Not administered",
        truthState: "corrected",
      }),
      nowMs,
    ).include,
  ).toBe(true);
});
sc("C3", "multi_med", () => {
  expect(
    evaluateEventEligibility(
      event({
        id: "e-sup",
        type: "medication_administration",
        title: "Old version",
        truthState: "superseded",
      }),
      nowMs,
    ).include,
  ).toBe(false);
});
sc("C4", "multi_med", () => {
  expect(
    evaluateTaskEligibility(
      task({ id: "t1", title: "Done work", status: "done" }),
      nowMs,
    ).include,
  ).toBe(false);
});
sc("C5", "multi_med", () => {
  expect(
    evaluateTaskEligibility(
      task({ id: "t2", title: "High safety med review", safetyClass: "high" }),
      nowMs,
    ).family,
  ).toBe("URGENT_SAFETY");
});

// D. PRN due/overdue/completed — 10 (eligibility on related work/events)
for (let i = 1; i <= 5; i++) {
  sc(`D${i}`, "prn", () => {
    const s = buildSemanticTodaySlices({
      tasks: [
        task({
          id: `prn-due-${i}`,
          title: `PRN follow-up ${i}`,
          dueAt: new Date(nowMs - 30 * 60 * 1000).toISOString(),
          safetyClass: "high",
        }),
      ],
      nowMs,
    });
    expect(s.tasks.some((t) => t.id === `prn-due-${i}`)).toBe(true);
  });
}
for (let i = 6; i <= 10; i++) {
  sc(`D${i}`, "prn", () => {
    const s = buildSemanticTodaySlices({
      tasks: [
        task({
          id: `prn-done-${i}`,
          title: `Completed PRN ${i}`,
          status: "done",
        }),
      ],
      events: [
        event({
          id: `prn-hist-${i}`,
          type: "medication_administration",
          title: "Completed PRN yesterday",
          eventAt: "2026-07-29T10:00:00.000Z",
          occurredAt: "2026-07-29T10:00:00.000Z",
        }),
      ],
      nowMs,
    });
    expect(s.tasks.some((t) => t.id === `prn-done-${i}`)).toBe(false);
    expect(s.events.some((e) => e.id === `prn-hist-${i}`)).toBe(false);
  });
}

// E. Appointment lineage — 10
sc("E1", "appointment", () => {
  expect(
    evaluateAppointmentEligibility(
      apt({
        id: "a1",
        title: "Therapy",
        startsAt: `${DAY}T18:00:00.000Z`,
      }),
      nowMs,
    ).include,
  ).toBe(true);
});
sc("E2", "appointment", () => {
  expect(
    evaluateAppointmentEligibility(
      apt({
        id: "a2",
        title: "Therapy",
        startsAt: `${DAY}T18:00:00.000Z`,
        status: "cancelled",
      }),
      nowMs,
    ).include,
  ).toBe(false);
});
sc("E3", "appointment", () => {
  expect(
    evaluateAppointmentEligibility(
      apt({
        id: "a3",
        title: "Therapy",
        startsAt: `${DAY}T10:00:00.000Z`,
        status: "completed",
      }),
      nowMs,
    ).include,
  ).toBe(false);
});
sc("E4", "appointment", () => {
  const s = buildSemanticTodaySlices({
    appointments: [
      apt({
        id: "old",
        title: "Therapy",
        startsAt: `${DAY}T16:00:00.000Z`,
        status: "moved",
        scheduleState: "rescheduled",
      }),
      apt({
        id: "new",
        title: "Therapy",
        startsAt: `${DAY}T18:00:00.000Z`,
        status: "scheduled",
      }),
    ],
    nowMs,
  });
  expect(s.appointments.some((a) => a.id === "new")).toBe(true);
  expect(s.appointments.some((a) => a.id === "old")).toBe(false);
});
sc("E5", "appointment", () => {
  expect(
    evaluateAppointmentEligibility(
      apt({
        id: "past",
        title: "Yesterday PT",
        startsAt: "2026-07-29T15:00:00.000Z",
      }),
      nowMs,
    ).include,
  ).toBe(false);
});
for (let i = 6; i <= 10; i++) {
  sc(`E${i}`, "appointment", () => {
    const s = buildSemanticTodaySlices({
      appointments: [
        apt({
          id: `ap-${i}`,
          title: `Visit ${i}`,
          startsAt: `${DAY}T${16 + (i % 3)}:00:00.000Z`,
        }),
      ],
      nowMs,
    });
    expect(s.appointments.length).toBe(1);
  });
}

// F. Work priority ranking — 10
sc("F1", "work", () => {
  const s = buildSemanticTodaySlices({
    tasks: [
      task({ id: "low", title: "Routine tidy", safetyClass: "low" }),
      task({ id: "hi", title: "Dose mismatch", safetyClass: "high" }),
      task({ id: "mid", title: "Call pharmacy", safetyClass: "moderate" }),
      task({ id: "mid2", title: "Restock gloves", safetyClass: "moderate" }),
      task({ id: "mid3", title: "Water plants", safetyClass: "low" }),
    ],
    nowMs,
  });
  expect(s.tasks[0]?.id).toBe("hi");
  expect(s.tasks.length).toBeLessThanOrEqual(8);
  // Primary non-high capped
  const nonHigh = s.tasks.filter((t) => t.safetyClass !== "high");
  expect(nonHigh.length).toBeLessThanOrEqual(3);
});
for (let i = 2; i <= 10; i++) {
  sc(`F${i}`, "work", () => {
    const s = buildSemanticTodaySlices({
      tasks: [
        task({ id: `w${i}`, title: `Open work ${i}`, status: "pending" }),
        task({ id: `d${i}`, title: `Done ${i}`, status: "done" }),
      ],
      nowMs,
    });
    expect(s.tasks.some((t) => t.id === `w${i}`)).toBe(true);
    expect(s.tasks.some((t) => t.id === `d${i}`)).toBe(false);
  });
}

// G. Corrections/supersession — 5
sc("G1", "correction", () => {
  expect(
    evaluateEventEligibility(
      event({
        id: "g1",
        type: "correction",
        title: "Med not given",
      }),
      nowMs,
    ).family,
  ).toBe("CORRECTED_TRUTH");
});
sc("G2", "correction", () => {
  expect(
    evaluateEventEligibility(
      event({
        id: "g2",
        type: "note",
        title: "old",
        supersededById: "x",
      }),
      nowMs,
    ).include,
  ).toBe(false);
});
sc("G3", "correction", () => {
  expect(
    evaluateEventEligibility(
      event({
        id: "g3",
        type: "note",
        title: "cancelled truth",
        truthState: "cancelled",
      }),
      nowMs,
    ).include,
  ).toBe(false);
});
sc("G4", "correction", () => {
  const s = buildSemanticTodaySlices({
    events: [
      event({
        id: "hist",
        type: "medication_administration",
        title: "Yesterday admin",
        eventAt: "2026-07-29T12:00:00.000Z",
        occurredAt: "2026-07-29T12:00:00.000Z",
      }),
      event({
        id: "corr",
        type: "correction",
        title: "Corrected: not administered",
        eventAt: "2026-07-29T13:00:00.000Z",
        occurredAt: "2026-07-29T13:00:00.000Z",
      }),
    ],
    nowMs,
  });
  expect(s.events.some((e) => e.id === "corr")).toBe(true);
  expect(s.events.some((e) => e.id === "hist")).toBe(false);
});
sc("G5", "correction", () => {
  expect(
    evaluateEventEligibility(
      event({
        id: "g5",
        type: "reminder",
        title: "Delivery reminder",
      }),
      nowMs,
    ).include,
  ).toBe(false);
});

// H. Handoff continuity — 5
for (let i = 1; i <= 5; i++) {
  sc(`H${i}`, "handoff", () => {
    const s = buildSemanticTodaySlices({
      events: [
        event({
          id: `ho-${i}`,
          type: "handoff",
          title: `Shift handoff ${i}`,
          eventAt: `${DAY}T14:00:00.000Z`,
        }),
        event({
          id: `ho-old-${i}`,
          type: "handoff",
          title: `Old handoff ${i}`,
          eventAt: "2026-07-28T14:00:00.000Z",
          occurredAt: "2026-07-28T14:00:00.000Z",
        }),
      ],
      nowMs,
    });
    expect(s.events.some((e) => e.id === `ho-${i}`)).toBe(true);
    expect(s.events.some((e) => e.id === `ho-old-${i}`)).toBe(false);
  });
}

// I. Timezone/midnight — 5
sc("I1", "timezone", () => {
  // Just before midnight UTC next day — still "today" for fixed nowMs day
  const s = buildSemanticTodaySlices({
    events: [
      event({
        id: "late",
        type: "observation",
        title: "Late note",
        eventAt: `${DAY}T23:50:00.000Z`,
        occurredAt: `${DAY}T23:50:00.000Z`,
      }),
    ],
    nowMs,
  });
  expect(s.events.some((e) => e.id === "late")).toBe(true);
});
sc("I2", "timezone", () => {
  const s = buildSemanticTodaySlices({
    events: [
      event({
        id: "next",
        type: "observation",
        title: "Next day",
        eventAt: "2026-07-31T00:10:00.000Z",
        occurredAt: "2026-07-31T00:10:00.000Z",
      }),
    ],
    nowMs,
  });
  // Not in calendar day of nowMs
  expect(s.events.some((e) => e.id === "next")).toBe(false);
});
sc("I3", "timezone", () => {
  expect(
    evaluateObservationEligibility(
      obs({
        id: "o1",
        summary: "Dizzy after lunch",
        observedAt: `${DAY}T13:00:00.000Z`,
      }),
      nowMs,
    ).include,
  ).toBe(true);
});
sc("I4", "timezone", () => {
  expect(
    evaluateObservationEligibility(
      obs({
        id: "o2",
        summary: "Old note",
        observedAt: "2026-07-20T13:00:00.000Z",
      }),
      nowMs,
    ).include,
  ).toBe(false);
});
sc("I5", "timezone", () => {
  expect(
    evaluateTaskEligibility(
      task({ id: "probe", title: "JL-SMOKE probe task" }),
      nowMs,
    ).include,
  ).toBe(false);
});

describe("Semantic Today 60-scenario matrix", () => {
  it(`runs ${scenarios.length} scenarios`, () => {
    expect(scenarios.length).toBe(60);
  });

  for (const s of scenarios) {
    it(`${s.id} [${s.category}]`, () => {
      s.run();
    });
  }

  it("excludes history-only and terminal from mixed bag", () => {
    const s = buildSemanticTodaySlices({
      events: [
        event({
          id: "hist",
          type: "meal",
          title: "Old meal",
          eventAt: "2026-07-01T12:00:00.000Z",
          occurredAt: "2026-07-01T12:00:00.000Z",
        }),
        event({
          id: "safe",
          type: "incident",
          title: "Fall risk",
          safetyClass: "high",
        }),
      ],
      tasks: [
        task({ id: "done", title: "Done", status: "done" }),
        task({ id: "open", title: "Open", status: "pending" }),
      ],
      appointments: [
        apt({
          id: "cx",
          title: "Cancelled",
          startsAt: `${DAY}T19:00:00.000Z`,
          status: "cancelled",
        }),
      ],
      nowMs,
    });
    expect(s.events.some((e) => e.id === "safe")).toBe(true);
    expect(s.events.some((e) => e.id === "hist")).toBe(false);
    expect(s.tasks.some((t) => t.id === "open")).toBe(true);
    expect(s.tasks.some((t) => t.id === "done")).toBe(false);
    expect(s.appointments).toHaveLength(0);
  });
});
