/**
 * Shift-to-shift answer evolution across ≥3 sequential shifts and ≥3 recipients.
 */
import { describe, it, expect } from "vitest";
import {
  seedCareUniverse,
  UNIVERSES,
  answerRelayQuestion,
  createShiftAssignment,
  respondShiftAssignment,
  completeShiftHandoff,
  expireShiftAssignment,
} from "@caretaker-relay/care-domain";

function runShiftCycle(
  store: ReturnType<typeof seedCareUniverse>,
  u: (typeof UNIVERSES)[number],
  dspId: string,
  dspName: string,
  observation: string,
  handoff: string,
  nowBase: number,
) {
  const assigner = u.actors[0]!;
  const startMs = nowBase;
  const endMs = nowBase + 4 * 3600e3;
  const created = createShiftAssignment(store, {
    careRecipientId: u.recipient.id,
    assignerPersonId: assigner.id,
    assignerDisplayName: assigner.displayName,
    assigneePersonId: dspId,
    assigneeDisplayName: dspName,
    shiftStart: new Date(startMs).toISOString(),
    shiftEnd: new Date(endMs).toISOString(),
  });
  const assignmentId = (created as { assignment: { id: string } }).assignment.id;
  respondShiftAssignment(store, {
    careRecipientId: u.recipient.id,
    assignmentId,
    actorPersonId: dspId,
    actorDisplayName: dspName,
    decision: "accept",
  });
  store.addObservation({
    id: `obs-${assignmentId}`,
    careRecipientId: u.recipient.id,
    summary: observation,
    observedAt: new Date(startMs + 3600e3).toISOString(),
    epistemicStatus: "REPORTED",
    source: {
      id: `src-${assignmentId}`,
      kind: "caregiver_text",
      label: "Shift report",
      actorName: dspName,
      actorPersonId: dspId,
      recordedAt: new Date(startMs + 3600e3).toISOString(),
      whyVisible: "Shift",
    },
  });
  completeShiftHandoff(store, {
    careRecipientId: u.recipient.id,
    assignmentId,
    actorPersonId: dspId,
    actorDisplayName: dspName,
    whatChanged: [observation],
    stillNeedsAttention: [handoff],
  });
  expireShiftAssignment(store, {
    careRecipientId: u.recipient.id,
    assignmentId,
    actorPersonId: assigner.id,
  });
  return { assignmentId, observation };
}

describe("shift-to-shift answer evolution", () => {
  it("answers change across three sequential shifts for three recipients", () => {
    const targets = UNIVERSES.filter((u) =>
      ["A_rich_family", "C_dsp_idd", "E_mobility"].includes(u.id),
    ).slice(0, 3);
    expect(targets.length).toBe(3);

    let staticAfterChange = 0;
    let evolutions = 0;

    for (const u of targets) {
      const store = seedCareUniverse(u);
      const family = u.actors[0]!;
      const answers: string[] = [];

      const stages = [
        { obs: "Calm after breakfast; mobility assistance provided", handoff: "Incomplete transportation task" },
        { obs: "More tired than usual; refused lunch", handoff: "Transportation completed" },
        { obs: "Mood improved; new mobility concern noted", handoff: "Therapy rescheduled" },
      ];

      let t = Date.now() - 20 * 3600e3;
      for (let i = 0; i < stages.length; i++) {
        const dspId = `p-dsp-evo-${u.id}-${i}`;
        store.upsertPerson({
          id: dspId,
          displayName: `DSP ${i + 1}`,
          kind: "professional",
        });
        // During active window of next family ask, use family principal for continuity
        runShiftCycle(
          store,
          u,
          dspId,
          `DSP ${i + 1}`,
          stages[i]!.obs,
          stages[i]!.handoff,
          t,
        );
        t += 5 * 3600e3;

        const r = answerRelayQuestion({
          store,
          principalId: family.id,
          principalDisplayName: family.displayName,
          roleLabel: family.roleLabel,
          careRecipientId: u.recipient.id,
          recipientDisplayName: u.recipient.displayName,
          question: `How is ${u.recipient.preferredName} today? What changed?`,
        });
        expect(r.authorizationOutcome).toBe("answered");
        answers.push(r.answer);
        evolutions++;
        // Must not invent Evelyn fixture when not Evelyn universe
        if (u.recipient.displayName !== "Evelyn Carter") {
          expect(r.answer).not.toMatch(/Evelyn Carter/);
        }
      }

      // At least one answer pair must differ after data change
      if (answers[0] === answers[1] && answers[1] === answers[2]) {
        staticAfterChange++;
      } else {
        // verify stage markers appear somewhere in later answers
        expect(answers.join("\n")).toMatch(/tired|refused|improved|calm|mobility|lunch|breakfast/i);
      }
    }

    expect(evolutions).toBeGreaterThanOrEqual(9);
    expect(staticAfterChange).toBe(0);
  });
});
