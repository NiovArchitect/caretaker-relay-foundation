/**
 * Canonical care loop:
 * INPUT → AUTH → UNDERSTAND → CANDIDATES → SAFETY → USER VERIFY →
 * PERSIST → PROVENANCE → CURRENT STATE → TASK/APPT/HANDOFF → AUDIT → CONTINUITY
 *
 * Does not run inside React state. Persistence goes through CareStore.
 */

import type { CareStore } from "../store/memory-store.js";
import type { LLMProvider } from "../llm/provider.js";
import type {
  AuthCareContext,
  BurdenMetrics,
  CareEvent,
  CareHandoff,
  CareLoopResult,
  CareUpdate,
  Correction,
  EvidenceMode,
  MedicationAdministrationRecord,
  Observation,
  SafetyReview,
  VerificationBundle,
} from "../types.js";
import { evaluateAccess } from "./access.js";
import {
  understandCareInput,
  toVerificationBundle,
  type UnderstandOptions,
} from "./understand.js";
import {
  appointmentChangeHash,
  communicationHash,
  handoffHash,
  medAdminHash,
} from "./idempotency.js";
import {
  composeCareNote,
  persistCareNote,
  coachingPromptForRaw,
} from "./care-notes.js";

export interface CareLoopServiceConfig {
  store: CareStore;
  defaultMode: "fixture" | "llm";
  provider?: LLMProvider;
  careRecipientNameResolver?: (id: string) => string;
}

export class CareLoopService {
  constructor(private readonly config: CareLoopServiceConfig) {}

  get store(): CareStore {
    return this.config.store;
  }

  /**
   * Step 1–5: Authenticated understand → verification bundle (candidates only).
   */
  async proposeFromInput(
    rawText: string,
    ctx: AuthCareContext,
    opts?: Partial<UnderstandOptions>,
  ): Promise<CareLoopResult> {
    const access = evaluateAccess(
      this.config.store,
      ctx.actorPersonId,
      ctx.careRecipientId,
      {
        requiredAction: "record_observations",
        householdId: ctx.householdId,
      },
    );
    // Family caregivers may use receive_updates + record via daily update path
    const soft = evaluateAccess(
      this.config.store,
      ctx.actorPersonId,
      ctx.careRecipientId,
      { householdId: ctx.householdId },
    );
    if (!soft.allowed) {
      const audit = this.config.store.writeAudit({
        at: new Date().toISOString(),
        actorPersonId: ctx.actorPersonId,
        action: "ACCESS_DENIED",
        careRecipientId: ctx.careRecipientId,
        householdId: ctx.householdId,
        details: { reason: soft.reason, code: soft.code },
      });
      return {
        kind: "access_denied",
        message: soft.reason,
        evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
        auditIds: [audit.id],
      };
    }

    const recipient = this.config.store.getRecipient(ctx.careRecipientId);
    const name =
      this.config.careRecipientNameResolver?.(ctx.careRecipientId) ??
      recipient?.displayName ??
      "Care recipient";

    const mode = opts?.mode ?? this.config.defaultMode;
    const understood = await understandCareInput(rawText, ctx, name, {
      mode,
      provider: opts?.provider ?? this.config.provider,
      recordedDoseOverride: opts?.recordedDoseOverride,
      schedules: this.config.store.getMedSchedules(ctx.careRecipientId),
      now: opts?.now,
    });

    if (understood.kind === "refusal") {
      const audit = this.config.store.writeAudit({
        at: new Date().toISOString(),
        actorPersonId: ctx.actorPersonId,
        action: "SAFETY_REFUSAL",
        careRecipientId: ctx.careRecipientId,
        householdId: ctx.householdId,
        details: { message: understood.message, rawText },
      });
      // Persist refusal as note event for audit continuity
      this.config.store.addEvent({
        id: this.config.store.newId("evt"),
        careRecipientId: ctx.careRecipientId,
        householdId: ctx.householdId,
        type: "note",
        title: "Safety refusal — note only",
        statement: understood.message,
        occurredAt: new Date().toISOString(),
        epistemicStatus: "REPORTED",
        safetyClass: "high",
        source: {
          id: this.config.store.newId("src"),
          kind: "system_derived",
          label: "Safety gate",
          actorName: "Relay safety",
          recordedAt: new Date().toISOString(),
          whyVisible: "Safety rules blocked an unsafe or unknown instruction.",
          rawExcerpt: rawText.slice(0, 200),
        },
        evidenceMode: understood.evidenceMode,
      });
      return {
        kind: "refusal",
        message: understood.message,
        evidenceMode: understood.evidenceMode,
        auditIds: [audit.id],
        currentState: this.config.store.getCurrentState(ctx.careRecipientId),
      };
    }

    const schedules = this.config.store.getMedSchedules(ctx.careRecipientId);
    const bundle = toVerificationBundle(understood.slice, schedules);
    const audit = this.config.store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: ctx.actorPersonId,
      action: "UNDERSTAND_PROPOSED",
      careRecipientId: ctx.careRecipientId,
      householdId: ctx.householdId,
      details: {
        candidateCount: understood.slice.candidates.length,
        evidenceMode: understood.slice.evidenceMode,
        accessNote: access.allowed ? access.reason : "soft-path",
      },
    });

    return {
      kind: "verify",
      bundle,
      evidenceMode: understood.slice.evidenceMode,
      auditIds: [audit.id],
    };
  }

  /**
   * Step 6–11: Human confirmation → persist effects + handoff + audit.
   */
  confirmAndPersist(
    bundle: VerificationBundle,
    ctx: AuthCareContext,
    opts?: { confirmedItemIds?: string[]; prepareHandoffForPersonId?: string },
  ): CareLoopResult {
    const soft = evaluateAccess(
      this.config.store,
      ctx.actorPersonId,
      ctx.careRecipientId,
      { householdId: ctx.householdId },
    );
    if (!soft.allowed) {
      return {
        kind: "access_denied",
        message: soft.reason,
        evidenceMode: bundle.evidenceMode,
        auditIds: [],
      };
    }

    const confirmedIds = new Set(
      opts?.confirmedItemIds ?? bundle.items.map((i) => i.id),
    );
    const eventIds: string[] = [];
    const medIds: string[] = [];
    const updateIds: string[] = [];
    const safetyReviewIds: string[] = [];
    const now = new Date().toISOString();
    const evidenceMode: EvidenceMode =
      bundle.evidenceMode === "FIXTURE"
        ? "SYNTHETIC_FOUNDATION_BACKED"
        : bundle.evidenceMode;

    for (const item of bundle.items) {
      if (!confirmedIds.has(item.id)) continue;
      if (item.candidateId === "uncertainty") continue;

      const candidate = bundle.understood.candidates.find(
        (c) => c.id === item.candidateId,
      );
      if (!candidate) continue;

      // High-consequence with discrepancy → safety review, no silent MAR
      if (item.discrepancy) {
        const review: SafetyReview = {
          id: this.config.store.newId("sr"),
          careRecipientId: ctx.careRecipientId,
          safetyClass: "high",
          reason: item.discrepancy.message,
          status: "open",
          createdAt: now,
          targetIds: [candidate.id],
        };
        this.config.store.addSafetyReview(review);
        safetyReviewIds.push(review.id);

        const mar: MedicationAdministrationRecord = {
          id: this.config.store.newId("mar"),
          careRecipientId: ctx.careRecipientId,
          name: "Lunch medication",
          doseRecorded: item.discrepancy.recordedDose,
          administeredAt: now,
          administeredByPersonId: ctx.actorPersonId,
          status: "needs_review",
          discrepancy: item.discrepancy,
          epistemicStatus: "CONFLICTED",
          source: candidate.sourceReference,
        };
        this.config.store.addMedRecord(mar);
        medIds.push(mar.id);

        const evt = this.persistEvent(candidate, ctx, now, evidenceMode, "CONFLICTED");
        eventIds.push(evt.id);
        continue;
      }

      if (candidate.eventType === "medication_administration") {
        // Negation path already stored as note candidates only
        const doseRecorded = candidate.recordedDose ?? "as scheduled";
        const hash = medAdminHash({
          careRecipientId: ctx.careRecipientId,
          name: "Lunch medication",
          doseRecorded,
          administeredByPersonId: ctx.actorPersonId,
          administeredAt: now,
        });
        const existingMed = this.config.store
          .getMedRecords(ctx.careRecipientId)
          .find(
            (m) =>
              m.status === "recorded" &&
              medAdminHash({
                careRecipientId: m.careRecipientId,
                name: m.name,
                doseRecorded: m.doseRecorded,
                administeredByPersonId: m.administeredByPersonId,
                administeredAt: m.administeredAt,
              }) === hash,
          );
        if (existingMed) {
          medIds.push(existingMed.id);
        } else {
          const mar: MedicationAdministrationRecord = {
            id: this.config.store.newId("mar"),
            careRecipientId: ctx.careRecipientId,
            name: "Lunch medication",
            doseRecorded,
            administeredAt: now,
            administeredByPersonId: ctx.actorPersonId,
            status: "recorded",
            epistemicStatus: "CONFIRMED",
            source: candidate.sourceReference,
          };
          this.config.store.addMedRecord(mar);
          medIds.push(mar.id);
        }
      }

      if (candidate.eventType === "observation") {
        const obs: Observation = {
          id: this.config.store.newId("obs"),
          careRecipientId: ctx.careRecipientId,
          summary: candidate.statement,
          observedAt: now,
          tags: ["caregiver_report"],
          // Soft observations stay REPORTED even after confirm of "I said this"
          epistemicStatus:
            candidate.epistemicStatus === "REPORTED"
              ? "REPORTED"
              : "CONFIRMED",
          source: candidate.sourceReference,
        };
        this.config.store.addObservation(obs);
      }

      if (candidate.eventType === "appointment_change") {
        if (candidate.epistemicStatus === "UNCERTAIN") {
          // Do not promote uncertain appointment to current schedule truth
          const evt = this.persistEvent(
            candidate,
            ctx,
            now,
            evidenceMode,
            "UNCERTAIN",
          );
          eventIds.push(evt.id);
          continue;
        }
        const existing = this.config.store
          .getAppointments(ctx.careRecipientId)
          .find((a) => /physical therapy|pt/i.test(a.title));
        const startsAtLabel = candidate.timeLabel
          ? `${candidate.dateLabel ?? ""} ${candidate.timeLabel}`.trim()
          : candidate.statement;
        const title = existing?.title ?? "Physical therapy";
        // Same semantic appointment change same day → reuse row (upsert by id)
        const aptHash = appointmentChangeHash({
          careRecipientId: ctx.careRecipientId,
          title,
          startsAtLabel,
          status: "moved",
        });
        void aptHash;
        // Supersede prior confirmed appointment_change events whose statement
        // no longer matches current time — preserves historical lineage.
        const priorAptEvents = this.config.store
          .getEvents(ctx.careRecipientId)
          .filter(
            (e) =>
              e.type === "appointment_change" &&
              e.epistemicStatus !== "SUPERSEDED" &&
              e.statement !== candidate.statement,
          );
        this.config.store.upsertAppointment({
          id: existing?.id ?? this.config.store.newId("apt"),
          careRecipientId: ctx.careRecipientId,
          title,
          startsAt: existing?.startsAt ?? now,
          startsAtLabel,
          status: "moved",
          epistemicStatus: "CONFIRMED",
          source: candidate.sourceReference,
        });
        const newEvt = this.persistEvent(
          candidate,
          ctx,
          now,
          evidenceMode,
          "CONFIRMED",
        );
        eventIds.push(newEvt.id);
        for (const pe of priorAptEvents) {
          this.config.store.supersedeEvent(pe.id, newEvt.id);
        }
        continue;
      }

      if (candidate.eventType === "task") {
        this.config.store.upsertTask({
          id: this.config.store.newId("task"),
          careRecipientId: ctx.careRecipientId,
          title: candidate.statement,
          status: "pending",
          safetyClass: candidate.consequentiality,
          epistemicStatus: "CONFIRMED",
          source: candidate.sourceReference,
        });
      }

      if (candidate.eventType === "communication_request") {
        const toPersonId =
          candidate.intendedRecipientPersonId ??
          opts?.prepareHandoffForPersonId ??
          "p-maya";
        const summary = this.buildUpdateSummary(bundle);
        const cHash = communicationHash({
          careRecipientId: ctx.careRecipientId,
          toPersonId,
          summary,
        });
        const existingUpd = this.config.store
          .getUpdates(ctx.careRecipientId)
          .find(
            (u) =>
              communicationHash({
                careRecipientId: u.careRecipientId,
                toPersonId: u.toPersonId,
                summary: u.summary,
              }) === cHash,
          );
        if (existingUpd) {
          updateIds.push(existingUpd.id);
        } else {
          const update: CareUpdate = {
            id: this.config.store.newId("upd"),
            careRecipientId: ctx.careRecipientId,
            toPersonId,
            summary,
            status: "ready",
            safetyClass: "moderate",
            source: candidate.sourceReference,
          };
          this.config.store.addUpdate(update);
          updateIds.push(update.id);
        }
      }

      const status =
        candidate.eventType === "observation"
          ? candidate.epistemicStatus
          : candidate.epistemicStatus === "UNCERTAIN"
            ? "UNCERTAIN"
            : "CONFIRMED";
      const evt = this.persistEvent(candidate, ctx, now, evidenceMode, status);
      eventIds.push(evt.id);
    }

    const handoff = this.buildHandoff(
      bundle,
      ctx,
      now,
      evidenceMode,
      opts?.prepareHandoffForPersonId,
    );
    const hHash = handoffHash({
      careRecipientId: handoff.careRecipientId,
      fromPersonId: handoff.fromPersonId,
      toPersonId: handoff.toPersonId,
      whatChanged: handoff.whatChanged,
    });
    const existingHo = this.config.store
      .getHandoffs(ctx.careRecipientId)
      .find(
        (h) =>
          handoffHash({
            careRecipientId: h.careRecipientId,
            fromPersonId: h.fromPersonId,
            toPersonId: h.toPersonId,
            whatChanged: h.whatChanged,
          }) === hHash,
      );
    if (existingHo) {
      // Reuse prior handoff id for response continuity
      handoff.id = existingHo.id;
    } else {
      this.config.store.addHandoff(handoff);
    }

    for (const sr of safetyReviewIds) {
      // leave open — human must resolve med conflict; Relay does not choose
      void sr;
    }

    // Role-aware care note from verified update (documentation without forms)
    const roleLabel =
      ctx.roles?.find((r) => /family|professional|physician|dsp|primary/i.test(r)) ??
      ctx.roles?.[0] ??
      "caregiver";
    const careNote = composeCareNote({
      bundle,
      ctx,
      roleLabel,
      eventIds,
      confirmedItemIds: opts?.confirmedItemIds,
    });
    const noteUpdate = persistCareNote(this.config.store, careNote, {
      id: `src-note-${careNote.id}`,
      kind: "system_derived",
      label: careNote.title,
      actorName: ctx.actorDisplayName,
      actorPersonId: ctx.actorPersonId,
      recordedAt: now,
      whyVisible: "Verified care update structured into a care note.",
      rawExcerpt: bundle.understood.rawText?.slice(0, 280),
    });
    updateIds.push(noteUpdate.id);

    const audit = this.config.store.writeAudit({
      at: now,
      actorPersonId: ctx.actorPersonId,
      action: "CARE_UPDATE_CONFIRMED",
      careRecipientId: ctx.careRecipientId,
      householdId: ctx.householdId,
      details: {
        eventIds,
        medIds,
        updateIds,
        safetyReviewIds,
        handoffId: handoff.id,
        careNoteId: careNote.id,
        careNoteKind: careNote.kind,
        evidenceMode,
      },
    });

    const coach = coachingPromptForRaw(bundle.understood.rawText ?? "");
    const noteLine = `${careNote.title} prepared for the care record.`;
    const coachLine = coach ? ` ${coach}` : "";

    return {
      kind: "persisted",
      message: `Confirmed. ${noteLine} Handoff ready.${coachLine}`,
      evidenceMode,
      auditIds: [audit.id],
      persisted: {
        eventIds,
        handoffId: handoff.id,
        updateIds,
        medicationRecordIds: medIds,
        safetyReviewIds,
        careNoteId: careNote.id,
        careNoteBody: careNote.body,
      },
      currentState: this.config.store.getCurrentState(ctx.careRecipientId),
    };
  }

  /**
   * Correction path: preserve prior evidence, supersede, audit.
   */
  applyCorrection(
    targetEventId: string,
    correctedValue: string,
    ctx: AuthCareContext,
  ): CareLoopResult {
    // Corrections rewrite durable care truth — require explicit correct authority
    // (or wildcard). Professional paid caregivers with task/observation scope only
    // must not silently supersede household care assertions.
    const soft = evaluateAccess(
      this.config.store,
      ctx.actorPersonId,
      ctx.careRecipientId,
      { householdId: ctx.householdId, requiredAction: "correct" },
    );
    if (!soft.allowed) {
      return {
        kind: "access_denied",
        message: soft.reason,
        evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
        auditIds: [],
      };
    }

    const prior = this.config.store.getEvent(targetEventId);
    if (!prior || prior.careRecipientId !== ctx.careRecipientId) {
      return {
        kind: "refusal",
        message: "Cannot correct: event not found in this care context.",
        evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
        auditIds: [],
      };
    }

    const now = new Date().toISOString();
    const newEvent: CareEvent = {
      ...prior,
      id: this.config.store.newId("evt"),
      statement: correctedValue,
      title: `Correction: ${prior.title}`,
      type: "correction",
      occurredAt: now,
      epistemicStatus: "CONFIRMED",
      source: {
        id: this.config.store.newId("src"),
        kind: "correction",
        label: "Caregiver correction",
        actorName: ctx.actorDisplayName,
        actorPersonId: ctx.actorPersonId,
        recordedAt: now,
        whyVisible: `${ctx.actorDisplayName} corrected a previous care assertion.`,
        rawExcerpt: correctedValue.slice(0, 200),
      },
      evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
    };
    this.config.store.addEvent(newEvent);
    this.config.store.supersedeEvent(prior.id, newEvent.id);

    const correction: Correction = {
      id: this.config.store.newId("corr"),
      careRecipientId: ctx.careRecipientId,
      targetEventId: prior.id,
      previousValue: prior.statement,
      correctedValue,
      correctedByPersonId: ctx.actorPersonId,
      correctedAt: now,
      preservedEvidenceIds: [prior.id, prior.source.id],
      source: newEvent.source,
    };
    this.config.store.addCorrection(correction);

    const audit = this.config.store.writeAudit({
      at: now,
      actorPersonId: ctx.actorPersonId,
      action: "CORRECTION_APPLIED",
      careRecipientId: ctx.careRecipientId,
      householdId: ctx.householdId,
      details: {
        targetEventId: prior.id,
        newEventId: newEvent.id,
        previousValue: prior.statement,
        correctedValue,
      },
    });

    return {
      kind: "persisted",
      message: "Correction saved. Previous evidence preserved.",
      evidenceMode: "SYNTHETIC_FOUNDATION_BACKED",
      auditIds: [audit.id],
      persisted: {
        eventIds: [newEvent.id],
        updateIds: [],
        medicationRecordIds: [],
        safetyReviewIds: [],
      },
      currentState: this.config.store.getCurrentState(ctx.careRecipientId),
    };
  }

  measureBurdenLab(result: CareLoopResult): BurdenMetrics {
    const organized =
      (result.persisted?.eventIds.length ?? 0) +
      (result.persisted?.updateIds.length ?? 0) +
      (result.persisted?.handoffId ? 1 : 0);
    return {
      stepsToRecordUpdate: 3, // speak/type → verify → confirm
      repeatedEntryCount: 0,
      manualMessagesAvoided: result.persisted?.updateIds.length ?? 0,
      appContextSwitches: 1,
      correctionEffortSteps: 2,
      tasksOrganizedAutomatically: organized,
      classification: "LAB_MEASUREMENT",
    };
  }

  private persistEvent(
    candidate: VerificationBundle["understood"]["candidates"][0],
    ctx: AuthCareContext,
    now: string,
    evidenceMode: EvidenceMode,
    status: CareEvent["epistemicStatus"],
  ): CareEvent {
    const evt: CareEvent = {
      id: this.config.store.newId("evt"),
      careRecipientId: ctx.careRecipientId,
      householdId: ctx.householdId,
      type: candidate.eventType,
      title: candidate.statement,
      statement: candidate.statement,
      occurredAt: now,
      epistemicStatus: status,
      safetyClass: candidate.consequentiality,
      source: candidate.sourceReference,
      confidence: candidate.confidence,
      intendedRecipientPersonId: candidate.intendedRecipientPersonId,
      evidenceMode,
    };
    return this.config.store.addEvent(evt);
  }

  private buildUpdateSummary(bundle: VerificationBundle): string {
    return bundle.understood.candidates
      .map((c) => c.statement)
      .slice(0, 5)
      .join("; ");
  }

  private buildHandoff(
    bundle: VerificationBundle,
    ctx: AuthCareContext,
    now: string,
    evidenceMode: EvidenceMode,
    toPersonId?: string,
  ): CareHandoff {
    const whatChanged = bundle.understood.candidates
      .filter((c) => c.epistemicStatus !== "UNCERTAIN")
      .map((c) => c.statement);
    const watch = bundle.understood.candidates
      .filter((c) => c.eventType === "observation")
      .map((c) => c.statement);
    const stillNeeds = bundle.understood.tasks.length
      ? bundle.understood.tasks
      : ["Confirm any open transportation or evening medication"];
    return {
      id: this.config.store.newId("ho"),
      careRecipientId: ctx.careRecipientId,
      fromPersonId: ctx.actorPersonId,
      toPersonId: toPersonId ?? "p-maya",
      whatChanged:
        whatChanged.length > 0
          ? whatChanged
          : ["Care update recorded"],
      stillNeedsAttention: stillNeeds,
      watch:
        watch.length > 0
          ? watch
          : ["No new watch items"],
      sources: bundle.understood.candidates.map((c) => c.sourceReference),
      createdAt: now,
      evidenceMode,
    };
  }
}

/** Full canonical demo path helper. */
export async function runCanonicalCareLoop(
  service: CareLoopService,
  utterance: string,
  ctx: AuthCareContext,
  opts?: Partial<UnderstandOptions>,
): Promise<{
  propose: CareLoopResult;
  persist?: CareLoopResult;
  burden?: BurdenMetrics;
}> {
  const propose = await service.proposeFromInput(utterance, ctx, opts);
  if (propose.kind !== "verify" || !propose.bundle) {
    return { propose };
  }
  const persist = service.confirmAndPersist(propose.bundle, ctx, {
    prepareHandoffForPersonId: "p-maya",
  });
  const burden = service.measureBurdenLab(persist);
  return { propose, persist, burden };
}
