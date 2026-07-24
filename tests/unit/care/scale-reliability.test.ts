import { describe, expect, it } from "vitest";
import { MemoryCareStore } from "../../../packages/care-domain/src/store/memory-store.js";
import { seedAgencyScaleFixture } from "../../../packages/care-domain/src/scenario/agency-scale.js";
import { evaluateAccess } from "../../../packages/care-domain/src/services/access.js";
import {
  listCareTeam,
  resolveCurrentProvider,
} from "../../../packages/care-domain/src/services/care-team.js";
import { createCareRuntime } from "../../../packages/care-domain/src/index.js";

describe("20-person care team authorization matrix", () => {
  it("has 20 relationship records; revoked/expired excluded from current team", () => {
    const store = new MemoryCareStore();
    seedAgencyScaleFixture(store);
    const allRels = store.getRelationships("cr-team20");
    expect(allRels.length).toBe(20);
    const active = listCareTeam(store, "cr-team20");
    expect(active.length).toBe(18);
    expect(active.every((m) => m.isCurrent)).toBe(true);
    expect(active.some((m) => m.personId === "p-team20-19")).toBe(false); // revoked
    expect(active.some((m) => m.personId === "p-team20-20")).toBe(false); // expired
  });

  it("access: active members allowed; revoked/expired denied", () => {
    const store = new MemoryCareStore();
    seedAgencyScaleFixture(store);
    expect(evaluateAccess(store, "p-team20-1", "cr-team20").allowed).toBe(true);
    expect(evaluateAccess(store, "p-team20-10", "cr-team20").allowed).toBe(true);
    expect(evaluateAccess(store, "p-team20-19", "cr-team20").allowed).toBe(false);
    expect(evaluateAccess(store, "p-team20-20", "cr-team20").allowed).toBe(false);
    // Cross-org / wrong recipient
    expect(evaluateAccess(store, "p-team20-1", "cr-bay-1").allowed).toBe(false);
  });

  it("name collision: two Priya Shah personIds remain distinct", () => {
    const store = new MemoryCareStore();
    seedAgencyScaleFixture(store);
    const north = resolveCurrentProvider(store, "cr-scale-1");
    const bay = resolveCurrentProvider(store, "cr-bay-1");
    expect(north?.displayName).toMatch(/Shah/);
    expect(bay?.displayName).toMatch(/Shah/);
    expect(north?.personId).not.toBe(bay?.personId);
    expect(north?.organizationId).not.toBe(bay?.organizationId);
  });
});

describe("1000+ durable care events longitudinal truth", () => {
  it("retains current med truth after 1000 synthetic care events", () => {
    const { store } = createCareRuntime({ seedOlivia: true });
    for (let i = 0; i < 1000; i++) {
      store.addEvent({
        id: `ev-long-${i}`,
        careRecipientId: "cr-olivia",
        householdId: "hh-olivia",
        type: i % 3 === 0 ? "observation" : i % 3 === 1 ? "note" : "task",
        title: `Historical event ${i}`,
        statement: `Synthetic longitudinal event ${i} for scale soak`,
        occurredAt: new Date(Date.now() - i * 60_000).toISOString(),
        epistemicStatus: "REPORTED",
        safetyClass: "low",
        source: {
          id: `src-long-${i}`,
          kind: "caregiver_text",
          label: "Historical soak",
          actorName: "Marcus Carter",
          actorPersonId: "p-sadeil",
          recordedAt: new Date().toISOString(),
          whyVisible: "Longitudinal scale test",
        },
        evidenceMode: "FIXTURE",
      });
    }
    const events = store.getEvents("cr-olivia");
    expect(events.length).toBeGreaterThanOrEqual(1000);
    const state = store.getCurrentState("cr-olivia");
    expect(state?.medicationSchedules[0]?.name).toMatch(/Metformin/i);
    expect(state?.medicationSchedules[0]?.dose).toMatch(/500/);
    // No insulin invented
    expect(
      state?.medicationSchedules.some((m) => /insulin/i.test(m.name)),
    ).toBe(false);
  });
});
