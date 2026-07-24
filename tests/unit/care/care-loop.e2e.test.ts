/**
 * Foundation-backed care loop integration tests.
 * EvidenceMode: SYNTHETIC_FOUNDATION_BACKED / FIXTURE (explicit).
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  createCareRuntime,
  runCanonicalCareLoop,
  DEMO_UTTERANCE,
  UNSAFE_PROTOCOL_UTTERANCE,
  sadeilContext,
  oracle,
  people,
  evaluateAccess,
  whoCanSeeWhat,
  CareScriptedLLMProvider,
  GOLDEN_CASES,
  goldenSummary,
  mapCareRecipientToPatient,
  mapMedRequest,
  mapObservation,
  mapProvenance,
  mapAppointment,
  mapTask,
  mapMedAdmin,
  mapConsent,
  FHIR_CONCEPT_MAP,
  careRecipient,
  HOUSEHOLD_OTHER,
  type CareLoopService,
  type CareStore,
} from "../../../packages/care-domain/src/index";

describe("SLICE A/B: care runtime + domain boundary", () => {
  it("creates foundation care runtime with Evelyn Carter seed", () => {
    const { store, service } = createCareRuntime();
    expect(store.getRecipient(oracle.careRecipientId)?.displayName).toBe(
      "Evelyn Carter",
    );
    expect(store.getMedSchedules(oracle.careRecipientId)[0]?.dose).toBe(
      "500 mg",
    );
    expect(service).toBeTruthy();
  });

  it("exports FHIR concept map for interop boundary", () => {
    expect(FHIR_CONCEPT_MAP.CareRecipient).toBe("Patient");
    expect(FHIR_CONCEPT_MAP.SourceRef).toBe("Provenance");
    expect(FHIR_CONCEPT_MAP.MedicationAdministrationRecord).toBe(
      "MedicationAdministration",
    );
  });
});

describe("SLICE C/D: authenticated canonical care loop (persisted)", () => {
  let service: CareLoopService;
  let store: CareStore;

  beforeEach(() => {
    const rt = createCareRuntime({ mode: "fixture" });
    service = rt.service;
    store = rt.store;
  });

  it("runs full loop: understand → verify → persist → handoff → audit", async () => {
    const ctx = sadeilContext();
    const { propose, persist, burden } = await runCanonicalCareLoop(
      service,
      DEMO_UTTERANCE,
      ctx,
    );

    expect(propose.kind).toBe("verify");
    expect(propose.bundle?.evidenceMode).toBe("FIXTURE");
    expect(propose.bundle?.title).toBe("I got this");
    expect(propose.bundle?.understood.candidates.length).toBeGreaterThanOrEqual(
      4,
    );

    // Soft observation must remain REPORTED, not clinical certainty
    const obs = propose.bundle?.understood.candidates.find(
      (c) => c.eventType === "observation",
    );
    expect(obs?.epistemicStatus).toBe("REPORTED");
    expect(obs?.statement.toLowerCase()).not.toMatch(
      /olivia has fatigue|diagnosed/,
    );

    expect(persist?.kind).toBe("persisted");
    expect(persist?.persisted?.eventIds.length).toBeGreaterThan(0);
    expect(persist?.persisted?.handoffId).toBeTruthy();
    expect(persist?.persisted?.updateIds.length).toBeGreaterThan(0);

    const state = store.getCurrentState(oracle.careRecipientId);
    expect(state?.events.length).toBeGreaterThan(0);
    expect(state?.handoffs.length).toBe(1);
    expect(state?.handoffs[0]?.whatChanged.length).toBeGreaterThan(0);
    expect(state?.medicationRecords.length).toBeGreaterThan(0);

    const audits = store.listAudit({ careRecipientId: oracle.careRecipientId });
    expect(audits.some((a) => a.action === "UNDERSTAND_PROPOSED")).toBe(true);
    expect(audits.some((a) => a.action === "CARE_UPDATE_CONFIRMED")).toBe(true);
    expect(audits.every((a) => a.productId === "caretaker-relay")).toBe(true);

    expect(burden?.classification).toBe("LAB_MEASUREMENT");
    expect(burden?.stepsToRecordUpdate).toBe(3);
  });

  it("does not perform loop solely as ephemeral values — store retains state", async () => {
    const ctx = sadeilContext("sess-persist");
    await runCanonicalCareLoop(service, DEMO_UTTERANCE, ctx);
    const events = store.getEvents(oracle.careRecipientId);
    expect(events.some((e) => e.type === "meal")).toBe(true);
    expect(events.every((e) => e.source.id)).toBeTruthy();
    expect(events.every((e) => e.householdId === oracle.householdId)).toBe(
      true,
    );
  });
});

describe("SLICE E: correction + current-state semantics", () => {
  it("preserves prior evidence on correction and marks SUPERSEDED", async () => {
    const { service, store } = createCareRuntime();
    const ctx = sadeilContext();
    const { persist } = await runCanonicalCareLoop(
      service,
      "Mom ate around noon.",
      ctx,
    );
    const eventId = persist?.persisted?.eventIds[0];
    expect(eventId).toBeTruthy();

    const corr = service.applyCorrection(
      eventId!,
      "Meal at 12:15 PM (corrected)",
      ctx,
    );
    expect(corr.kind).toBe("persisted");
    const prior = store.getEvent(eventId!);
    expect(prior?.epistemicStatus).toBe("SUPERSEDED");
    const state = store.getCurrentState(oracle.careRecipientId);
    expect(state?.events.some((e) => e.id === eventId)).toBe(false);
    expect(
      store
        .getCorrections(oracle.careRecipientId)
        .some((c) => c.targetEventId === eventId),
    ).toBe(true);
  });
});

describe("SLICE F: handoff continuity", () => {
  it("produces handoff usable by next caregiver", async () => {
    const { service, store } = createCareRuntime();
    const { persist } = await runCanonicalCareLoop(
      service,
      DEMO_UTTERANCE,
      sadeilContext(),
    );
    const ho = store
      .getHandoffs(oracle.careRecipientId)
      .find((h) => h.id === persist?.persisted?.handoffId);
    expect(ho?.toPersonId).toBe(people.maya.id);
    expect(ho?.fromPersonId).toBe(people.sadeil.id);
    expect(ho?.sources.length).toBeGreaterThan(0);
    expect(ho?.whatChanged.join(" ")).toMatch(/meal|tired|PT|medication|Maya/i);
  });
});

describe("SLICE G: access / consent isolation", () => {
  it("allows authorized family caregiver", () => {
    const { store } = createCareRuntime();
    const d = evaluateAccess(store, people.sadeil.id, careRecipient.id);
    expect(d.allowed).toBe(true);
  });

  it("denies unauthorized family member", () => {
    const { store } = createCareRuntime();
    const d = evaluateAccess(store, people.unauthorized.id, careRecipient.id);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("NO_RELATIONSHIP");
  });

  it("limits professional caregiver categories", () => {
    const { store } = createCareRuntime();
    const d = evaluateAccess(store, people.walter.id, careRecipient.id, {
      requiredCategory: "Medication record",
    });
    expect(d.allowed).toBe(false);
  });

  it("allows provider health access", () => {
    const { store } = createCareRuntime();
    const d = evaluateAccess(store, people.drShah.id, careRecipient.id, {
      requiredCategory: "Medication record",
    });
    expect(d.allowed).toBe(true);
  });

  it("revoked access no longer functions", () => {
    const { store, service } = createCareRuntime();
    store.revokeAccess(
      careRecipient.id,
      people.maya.id,
      new Date().toISOString(),
    );
    const d = evaluateAccess(store, people.maya.id, careRecipient.id);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("REVOKED");

    // Revoked actor cannot propose updates
    return service
      .proposeFromInput(DEMO_UTTERANCE, {
        actorPersonId: people.maya.id,
        actorDisplayName: "Maya",
        careRecipientId: careRecipient.id,
        householdId: careRecipient.householdId,
        sessionId: "sess-revoked",
        roles: ["family_caregiver"],
      })
      .then((r) => {
        // Maya still has relationship revoked — access denied
        expect(r.kind).toBe("access_denied");
      });
  });

  it("blocks cross-household access", () => {
    const { store } = createCareRuntime();
    const d = evaluateAccess(store, people.sadeil.id, careRecipient.id, {
      householdId: HOUSEHOLD_OTHER,
    });
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.code).toBe("WRONG_HOUSEHOLD");
  });

  it("whoCanSeeWhat surfaces semantic access model", () => {
    const { store } = createCareRuntime();
    const rows = whoCanSeeWhat(store, careRecipient.id);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.some((r) => /Maya/i.test(r.displayName))).toBe(true);
  });
});

describe("SLICE H: medication conflict + consequential safety", () => {
  it("flags dose discrepancy without choosing", async () => {
    const { service } = createCareRuntime();
    const propose = await service.proposeFromInput(
      "I gave the lunch medication 5 mg.",
      sadeilContext(),
    );
    expect(propose.kind).toBe("verify");
    const med = propose.bundle?.items.find((i) => i.discrepancy);
    expect(med?.safetyClass).toBe("high");
    // Canonical schedule is Metformin 500 mg
    expect(med?.discrepancy?.authorizedDose).toMatch(/500\s*mg/i);
    expect(med?.discrepancy?.recordedDose).toMatch(/5\s*mg/i);

    const persist = service.confirmAndPersist(propose.bundle!, sadeilContext());
    expect(persist.persisted?.safetyReviewIds.length).toBe(1);
    expect(
      persist.currentState?.medicationRecords.some(
        (m) => m.status === "needs_review" && m.epistemicStatus === "CONFLICTED",
      ),
    ).toBe(true);
  });

  it("refuses Protocol 9-Delta", async () => {
    const { service } = createCareRuntime();
    const r = await service.proposeFromInput(
      UNSAFE_PROTOCOL_UTTERANCE,
      sadeilContext(),
    );
    expect(r.kind).toBe("refusal");
    expect(r.message?.toLowerCase()).toMatch(/won't invent|can't apply|don't have/);
  });

  it("refuses dosage advice", async () => {
    const { service } = createCareRuntime();
    const r = await service.proposeFromInput(
      "What dose should I give Olivia?",
      sadeilContext(),
    );
    expect(r.kind).toBe("refusal");
    expect(r.message?.toLowerCase()).toMatch(/can't recommend|dosages/);
  });

  it("negation must not create MedicationAdministration=given", async () => {
    const { service, store } = createCareRuntime();
    const { persist } = await runCanonicalCareLoop(
      service,
      "I did NOT give the lunch medication.",
      sadeilContext(),
    );
    expect(persist?.kind).toBe("persisted");
    const mars = store.getMedRecords(oracle.careRecipientId);
    // Seed may include historical MARs; negation must not ADD a new "given" record
    const newGiven = mars.filter(
      (m) =>
        m.status === "recorded" &&
        !m.id.startsWith("mar-lunch") &&
        /not|did not|didn't/i.test(m.source?.rawExcerpt ?? m.source?.label ?? ""),
    );
    expect(newGiven.length).toBe(0);
    // Also: no MAR from this session claiming administration was given
    const justPersisted = persist?.persisted?.medicationRecordIds ?? [];
    for (const id of justPersisted) {
      const row = mars.find((m) => m.id === id);
      expect(row?.status === "recorded" && /given|administered/i.test(row?.name ?? "")).toBeFalsy();
    }
  });
});

describe("SLICE I: golden dataset + metamorphic + adversarial", () => {
  it("reports golden dataset composition", () => {
    const s = goldenSummary();
    expect(s.synthetic).toBe(true);
    expect(s.version).toBe("1.0.0");
    expect(s.total).toBeGreaterThanOrEqual(18);
  });

  it("canonical golden case extracts expected event types", async () => {
    const { service } = createCareRuntime();
    const g = GOLDEN_CASES.find((c) => c.id === "g-001-concise")!;
    const propose = await service.proposeFromInput(g.input, sadeilContext());
    expect(propose.kind).toBe("verify");
    const types = new Set(
      propose.bundle?.understood.candidates.map((c) => c.eventType),
    );
    for (const t of g.oracle.expectEventTypes ?? []) {
      expect(types.has(t as never)).toBe(true);
    }
  });

  it("metamorphic: lunch at noon ≈ around 12 PM preserves meal semantics", async () => {
    const { service } = createCareRuntime();
    const a = await service.proposeFromInput(
      "Mom ate lunch at noon",
      sadeilContext(),
    );
    const b = await service.proposeFromInput(
      "Olivia ate lunch around 12 PM",
      sadeilContext(),
    );
    expect(a.bundle?.understood.meals.length).toBeGreaterThan(0);
    expect(b.bundle?.understood.meals.length).toBeGreaterThan(0);
  });

  it("metamorphic: might move stays UNCERTAIN; moved is REPORTED", async () => {
    const { service } = createCareRuntime();
    const might = await service.proposeFromInput(
      "PT might move Thursday's appointment.",
      sadeilContext(),
    );
    const moved = await service.proposeFromInput(
      "PT moved Thursday's appointment to 2:30.",
      sadeilContext(),
    );
    const mCand = might.bundle?.understood.candidates.find(
      (c) => c.eventType === "appointment_change",
    );
    const dCand = moved.bundle?.understood.candidates.find(
      (c) => c.eventType === "appointment_change",
    );
    expect(mCand?.epistemicStatus).toBe("UNCERTAIN");
    expect(dCand?.epistemicStatus).toBe("REPORTED");
  });

  it("adversarial suite prefers refusal over fabrication", async () => {
    const { service } = createCareRuntime();
    for (const g of GOLDEN_CASES.filter((c) => c.oracle.expectRefusal)) {
      const r = await service.proposeFromInput(g.input, sadeilContext());
      expect(r.kind).toBe("refusal");
    }
  });

  it("filler does not invent medication or appointment events", async () => {
    const { service } = createCareRuntime();
    const r = await service.proposeFromInput(
      "anyway so basically long story short before I forget the weather is nice mom ate around noon that is all for food nothing else weird",
      sadeilContext(),
    );
    expect(r.kind).toBe("verify");
    const types = r.bundle?.understood.candidates.map((c) => c.eventType) ?? [];
    expect(types.every((t) => t === "meal" || t === "note")).toBe(true);
  });
});

describe("Understand via Foundation LLM provider abstraction", () => {
  it("uses injected LLMProvider (scripted) without parallel client", async () => {
    const provider = new CareScriptedLLMProvider([
      {
        match: /ate lunch/,
        response: JSON.stringify({
          candidates: [
            {
              eventType: "meal",
              statement: "Meal at lunch (LLM path)",
              confidence: 0.91,
              epistemicStatus: "REPORTED",
              timeLabel: "lunch",
            },
          ],
          uncertainties: [],
        }),
      },
    ]);
    const { service } = createCareRuntime({ mode: "llm", provider });
    const r = await service.proposeFromInput(
      "Olivia ate lunch",
      sadeilContext(),
      { mode: "llm", provider },
    );
    expect(r.kind).toBe("verify");
    expect(r.evidenceMode).toBe("LIVE_FOUNDATION_BACKED");
    expect(r.bundle?.understood.modelProvider).toBe("care-scripted-fixture");
    expect(r.bundle?.understood.meals[0]).toMatch(/LLM path/);
  });
});

describe("FHIR mapping boundary (not EMR integration)", () => {
  it("maps core care objects to FHIR resource stubs", () => {
    const { store } = createCareRuntime();
    const patient = mapCareRecipientToPatient(careRecipient);
    expect(patient.resourceType).toBe("Patient");

    const schedule = store.getMedSchedules(careRecipient.id)[0];
    expect(schedule).toBeTruthy();
    if (!schedule) return;
    const req = mapMedRequest(schedule);
    expect(req.resourceType).toBe("MedicationRequest");

    const obs = mapObservation({
      id: "o1",
      careRecipientId: careRecipient.id,
      summary: "Seemed tired",
      observedAt: new Date().toISOString(),
      epistemicStatus: "REPORTED",
      source: schedule.source,
    });
    expect(obs.resourceType).toBe("Observation");
    expect(obs.status).toBe("preliminary");

    const prov = mapProvenance(schedule.source, `MedicationRequest/${schedule.id}`);
    expect(prov.resourceType).toBe("Provenance");

    expect(mapAppointment({
      id: "a1",
      careRecipientId: careRecipient.id,
      title: "PT",
      startsAt: "2026-07-24T14:30:00Z",
      status: "moved",
      epistemicStatus: "CONFIRMED",
    }).resourceType).toBe("Appointment");

    expect(mapTask({
      id: "t1",
      careRecipientId: careRecipient.id,
      title: "Transport",
      status: "pending",
      safetyClass: "moderate",
      epistemicStatus: "CONFIRMED",
    }).resourceType).toBe("Task");

    expect(mapMedAdmin({
      id: "m1",
      careRecipientId: careRecipient.id,
      name: "Lunch medication",
      doseRecorded: "2.5 mg",
      administeredAt: new Date().toISOString(),
      administeredByPersonId: people.sadeil.id,
      status: "recorded",
      epistemicStatus: "CONFIRMED",
      source: schedule.source,
    }).resourceType).toBe("MedicationAdministration");

    expect(mapConsent({
      id: "c1",
      careRecipientId: careRecipient.id,
      granteePersonId: people.maya.id,
      scope: {
        informationCategories: ["Daily updates"],
        allowedActions: ["receive_updates"],
        canEscalate: false,
        authorityLimits: [],
      },
      status: "active",
      grantedAt: "2026-07-01T00:00:00Z",
    }).resourceType).toBe("Consent");
  });
});
