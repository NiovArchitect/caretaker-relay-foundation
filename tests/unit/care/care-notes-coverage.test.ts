import { describe, expect, it } from "vitest";
import { createCareRuntime } from "../../../packages/care-domain/src/index.js";
import {
  composeCareNote,
  coachingPromptForRaw,
  listCareNotes,
} from "../../../packages/care-domain/src/services/care-notes.js";
import {
  listCoverage,
  formatCoverageHuman,
  seedDefaultCoverage,
} from "../../../packages/care-domain/src/services/care-coverage.js";
import { buildCareHistory } from "../../../packages/care-domain/src/services/care-history.js";
import { sadeilContext } from "../../../packages/care-domain/src/scenario/olivia.js";
import type { VerificationBundle } from "../../../packages/care-domain/src/types.js";

describe("care notes + coverage + history", () => {
  it("composes family care update without diagnosing", () => {
    const bundle = {
      id: "vb-1",
      title: "t",
      items: [
        {
          id: "v1",
          candidateId: "c1",
          label: "Dizziness after standing",
          safetyClass: "moderate" as const,
          epistemicStatus: "REPORTED" as const,
          requiresConfirmation: true,
        },
      ],
      understood: {
        careRecipientId: "cr-olivia",
        careRecipientName: "Evelyn Carter",
        rawText:
          "Evelyn got dizzy when she stood up after breakfast and I helped her sit.",
        candidates: [
          {
            id: "c1",
            eventType: "observation" as const,
            statement:
              "Evelyn experienced dizziness after standing following breakfast; helped to sit.",
            epistemicStatus: "REPORTED" as const,
            confidence: 0.8,
            consequentiality: "moderate" as const,
            sourceReference: {
              id: "s1",
              kind: "caregiver_text" as const,
              label: "update",
              actorName: "Marcus Carter",
              recordedAt: new Date().toISOString(),
              whyVisible: "test",
            },
          },
        ],
        uncertainties: [],
      },
      evidenceMode: "FIXTURE" as const,
    } as unknown as VerificationBundle;

    const note = composeCareNote({
      bundle,
      ctx: sadeilContext(),
      roleLabel: "Primary family caregiver",
      eventIds: ["ev1"],
    });
    expect(note.title).toMatch(/Care update/i);
    expect(note.body).toMatch(/Observation/i);
    expect(note.body).toMatch(/not a clinical diagnosis/i);
    expect(note.body).not.toMatch(/orthostatic hypotension/i);
  });

  it("coaches vague language gently", () => {
    expect(coachingPromptForRaw("She was weird today")).toMatch(/different/i);
    expect(coachingPromptForRaw("She ate poorly")).toMatch(/how much/i);
  });

  it("seeds and formats coverage", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    seedDefaultCoverage(store, "cr-olivia");
    const slots = listCoverage(store, "cr-olivia");
    expect(slots.some((s) => s.phase === "helping_now")).toBe(true);
    expect(slots.some((s) => s.phase === "next")).toBe(true);
    const text = formatCoverageHuman(slots);
    expect(text).toMatch(/Helping now/i);
    expect(text).toMatch(/Next/i);
    expect(text).not.toMatch(/CLOCKED|OVERTIME|SHIFT PRODUCTIVITY/i);
  });

  it("builds human history without requiring event id in titles", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    const hist = buildCareHistory(store, "cr-olivia", "all");
    expect(hist.length).toBeGreaterThan(0);
    expect(hist.every((h) => h.title && !/^ev-/.test(h.title))).toBe(true);
  });

  it("confirm produces care note", async () => {
    const { service, store } = createCareRuntime({ seedOlivia: true });
    const propose = await service.proposeFromInput(
      "Mom seemed more tired after lunch and ate only half her sandwich.",
      sadeilContext(),
    );
    if (propose.kind !== "verify" || !propose.bundle) {
      expect(propose.kind).toBe("verify");
      return;
    }
    const conf = service.confirmAndPersist(propose.bundle, sadeilContext());
    expect(conf.kind).toBe("persisted");
    expect(conf.message).toMatch(/Care update|Support note|prepared/i);
    expect(conf.persisted?.careNoteId).toBeTruthy();
    const notes = listCareNotes(store, "cr-olivia");
    expect(notes.length).toBeGreaterThan(0);
  });
});
