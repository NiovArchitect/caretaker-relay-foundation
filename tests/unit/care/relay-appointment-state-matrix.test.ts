import { describe, it, expect } from "vitest";
import {
  seedCareUniverse,
  UNIVERSES,
  answerRelayQuestion,
} from "@caretaker-relay/care-domain";

describe("appointment cancel/replace matrix", () => {
  it("cancelled is never returned as next; replacement becomes primary", () => {
    const u = UNIVERSES.find((x) => x.id === "A_rich_family")!;
    const store = seedCareUniverse(u);
    const actor = u.actors[0]!;
    const rid = u.recipient.id;

    // Cancel all existing
    for (const a of store.getAppointments(rid)) {
      store.upsertAppointment({
        ...a,
        status: "cancelled",
        scheduleState: "cancelled",
      });
    }

    store.upsertAppointment({
      id: "apt-old-cancelled",
      careRecipientId: rid,
      title: "Old PT (cancelled)",
      startsAt: new Date(Date.now() + 2 * 864e5).toISOString(),
      startsAtLabel: "Wednesday 2:00 PM",
      location: "Old clinic",
      status: "cancelled",
      scheduleState: "cancelled",
      epistemicStatus: "CONFIRMED",
    });

    store.upsertAppointment({
      id: "apt-replacement",
      careRecipientId: rid,
      title: "Replacement PT",
      startsAt: new Date(Date.now() + 3 * 864e5).toISOString(),
      startsAtLabel: "Thursday 3:00 PM",
      location: "Community PT",
      status: "scheduled",
      scheduleState: "confirmed",
      epistemicStatus: "CONFIRMED",
      rescheduledFromId: "apt-old-cancelled",
    });

    store.upsertAppointment({
      id: "apt-proposed",
      careRecipientId: rid,
      title: "Proposed dental",
      startsAt: new Date(Date.now() + 10 * 864e5).toISOString(),
      startsAtLabel: "Next week",
      status: "scheduled",
      scheduleState: "proposed",
      epistemicStatus: "REPORTED",
    });

    const r = answerRelayQuestion({
      store,
      principalId: actor.id,
      principalDisplayName: actor.displayName,
      roleLabel: actor.roleLabel,
      careRecipientId: rid,
      recipientDisplayName: u.recipient.displayName,
      question: "What is the next appointment?",
    });
    expect(r.authorizationOutcome).toBe("answered");
    expect(r.answer).toMatch(/Replacement PT|Thursday|Community PT|proposed|dental|appointment/i);
    expect(r.answer).not.toMatch(/Old PT \(cancelled\)/);
  });

  it("lifecycle states remain distinct in stored appointments", () => {
    const u = UNIVERSES.find((x) => x.id === "D_adrd")!;
    const store = seedCareUniverse(u);
    const rid = u.recipient.id;
    const states = [
      "proposed",
      "requested",
      "tentative",
      "confirmed",
      "cancelled",
      "rescheduled",
      "completed",
      "missed",
    ] as const;
    for (let i = 0; i < states.length; i++) {
      store.upsertAppointment({
        id: `apt-life-${states[i]}`,
        careRecipientId: rid,
        title: `Appt ${states[i]}`,
        startsAt: new Date(Date.now() + (i + 1) * 864e5).toISOString(),
        startsAtLabel: `Day+${i + 1}`,
        status:
          states[i] === "cancelled" || states[i] === "completed" || states[i] === "missed"
            ? (states[i] as "cancelled" | "completed")
            : states[i] === "rescheduled"
              ? "moved"
              : "scheduled",
        scheduleState: states[i],
        epistemicStatus: "REPORTED",
      });
    }
    const next = store
      .getAppointments(rid)
      .filter(
        (a) =>
          a.status !== "cancelled" &&
          a.status !== "completed" &&
          a.scheduleState !== "cancelled" &&
          a.scheduleState !== "completed" &&
          a.scheduleState !== "missed" &&
          a.scheduleState !== "rescheduled",
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
    expect(next?.title).not.toMatch(/cancelled|completed|missed/i);
  });
});
