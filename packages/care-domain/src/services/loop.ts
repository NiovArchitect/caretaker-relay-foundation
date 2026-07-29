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
import { createNotificationIfNew } from "./notifications.js";
import { createWorkItem } from "./care-work-items.js";
import {
  encodeInvitationUpdate,
  newInviteToken,
  listInvitations,
} from "./invitation.js";
import {
  encodeAccessRequestUpdate,
  listAccessRequestsForRecipient,
  type CareAccessRequest,
} from "./access-request.js";
import { ingestDocumentText } from "./document-actions.js";
import {
  understandCareInput,
  toVerificationBundle,
  type UnderstandOptions,
} from "./understand.js";
import {
  appointmentChangeHash,
  communicationHash,
  extractMedNameFromStatement,
  handoffHash,
  medAdminHash,
  medOccurrenceKey,
  normalizeMedName,
} from "./idempotency.js";
import {
  composeCareNote,
  persistCareNote,
  listCareNotes,
  coachingPromptForRaw,
} from "./care-notes.js";
import { buildExecutionReceipt } from "./execution-receipt.js";

export interface CareLoopServiceConfig {
  store: CareStore;
  defaultMode: "fixture" | "llm";
  provider?: LLMProvider;
  careRecipientNameResolver?: (id: string) => string;
}

function daySame(a?: string, b?: string): boolean {
  const da = (a ?? "").slice(0, 10);
  const db = (b ?? new Date().toISOString()).slice(0, 10);
  if (!da || !db) return false;
  return da === db;
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
        const medName =
          extractMedNameFromStatement(candidate.statement) ||
          extractMedNameFromStatement(bundle.understood.rawText ?? "") ||
          "Lunch medication";
        const requestedState = /not administered|was not given|not given/i.test(
          candidate.statement + (bundle.understood.rawText ?? ""),
        )
          ? "not_administered"
          : "administered";
        const hash = medAdminHash({
          careRecipientId: ctx.careRecipientId,
          name: medName,
          doseRecorded,
          administeredByPersonId: ctx.actorPersonId,
          administeredAt: now,
          requestedState,
        });
        const occKey = medOccurrenceKey({
          careRecipientId: ctx.careRecipientId,
          name: medName,
          doseRecorded,
          administeredByPersonId: ctx.actorPersonId,
          administeredAt: now,
          requestedState,
        });
        const existingMed = this.config.store
          .getMedRecords(ctx.careRecipientId)
          .find((m) => {
            if (m.status !== "recorded" && m.status !== "needs_review") return false;
            if (/not administered/i.test(m.doseRecorded ?? "")) return false;
            const sameHash =
              medAdminHash({
                careRecipientId: m.careRecipientId,
                name: m.name,
                doseRecorded: m.doseRecorded,
                administeredByPersonId: m.administeredByPersonId,
                administeredAt: m.administeredAt,
                requestedState: "administered",
              }) === hash;
            const sameOccurrence =
              normalizeMedName(m.name) === normalizeMedName(medName) &&
              m.administeredByPersonId === ctx.actorPersonId &&
              daySame(m.administeredAt, now);
            return sameHash || sameOccurrence;
          });
        if (existingMed && requestedState === "administered") {
          medIds.push(existingMed.id);
          // Mark candidate so event path can reuse durable occurrence
          (candidate as { _medIdempotent?: string })._medIdempotent = occKey;
          (candidate as { _existingMedId?: string })._existingMedId =
            existingMed.id;
        } else if (requestedState === "not_administered") {
          // Correction: void prior same-day recorded admin for this med+actor
          for (const m of this.config.store.getMedRecords(ctx.careRecipientId)) {
            if (
              m.status === "recorded" &&
              normalizeMedName(m.name) === normalizeMedName(medName) &&
              daySame(m.administeredAt, now)
            ) {
              this.config.store.addMedRecord({
                ...m,
                status: "voided",
                epistemicStatus: "SUPERSEDED",
              });
            }
          }
          const mar: MedicationAdministrationRecord = {
            id: this.config.store.newId("mar"),
            careRecipientId: ctx.careRecipientId,
            name: medName,
            doseRecorded: "not administered",
            administeredAt: now,
            administeredByPersonId: ctx.actorPersonId,
            status: "recorded",
            epistemicStatus: "CONFIRMED",
            source: candidate.sourceReference,
          };
          const saved = this.config.store.addMedRecord(mar);
          medIds.push(saved.id);
          (candidate as { _medIdempotent?: string })._medIdempotent = occKey;
        } else {
          const mar: MedicationAdministrationRecord = {
            id: this.config.store.newId("mar"),
            careRecipientId: ctx.careRecipientId,
            name: medName,
            doseRecorded,
            administeredAt: now,
            administeredByPersonId: ctx.actorPersonId,
            status: "recorded",
            epistemicStatus: "CONFIRMED",
            source: candidate.sourceReference,
          };
          const saved = this.config.store.addMedRecord(mar);
          medIds.push(saved.id);
          (candidate as { _medIdempotent?: string })._medIdempotent = occKey;
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
        // Receipt destinations open_work + notifications: create claimable work
        // for plan-change / supply / verification tasks so Today + Open work update.
        const needsOwner =
          /medication change needs verification|supply|refill|needs attention/i.test(
            candidate.statement,
          );
        if (needsOwner) {
          const wi = createWorkItem(this.config.store, {
            careRecipientId: ctx.careRecipientId,
            actorPersonId: ctx.actorPersonId,
            actorDisplayName: ctx.actorDisplayName,
            action: candidate.statement.slice(0, 200),
            reason:
              "Recorded from caregiver report · needs an owner / authorized review · not an active medication order",
            priority: /medication change|discontinue/i.test(candidate.statement)
              ? "high"
              : "normal",
            evidenceKind: "operational",
            status: "available_to_claim",
            trustShiftActor: true,
          });
          if (wi.ok) {
            // Circle already notified by createWorkItem when unowned
            void wi.item.id;
          }
        }
      }

      if (candidate.eventType === "communication_request") {
        const toPersonId =
          candidate.intendedRecipientPersonId ??
          opts?.prepareHandoffForPersonId ??
          "p-maya";

        // Relay-orchestrated People invitation (dedicated invitation persistence).
        if (
          /^Invite helper:/i.test(candidate.statement) &&
          candidate.intendedRecipientPersonId
        ) {
          const inviteeId = candidate.intendedRecipientPersonId;
          const existingRel = this.config.store.getRelationship(
            ctx.careRecipientId,
            inviteeId,
          );
          if (existingRel?.status === "active") {
            const already: CareUpdate = {
              id: this.config.store.newId("upd"),
              careRecipientId: ctx.careRecipientId,
              toPersonId: inviteeId,
              summary: `Already a member: ${candidate.intendedRecipientName ?? inviteeId} already has active access. Open People to review roles or revoke.`,
              status: "ready",
              safetyClass: "low",
              source: candidate.sourceReference,
            };
            this.config.store.addUpdate(already);
            updateIds.push(already.id);
          } else {
            const pending = listInvitations(
              this.config.store,
              ctx.careRecipientId,
            ).find(
              (inv) =>
                inv.inviteePersonId === inviteeId && inv.status === "pending",
            );
            if (pending) {
              updateIds.push(pending.id);
            } else {
              const nowIso = now;
              const inv = {
                id: this.config.store.newId("inv"),
                careRecipientId: ctx.careRecipientId,
                token: newInviteToken(),
                inviterPersonId: ctx.actorPersonId,
                inviteePersonId: inviteeId,
                inviteeDisplayName:
                  candidate.intendedRecipientName ?? inviteeId,
                role: (/professional/i.test(candidate.statement)
                  ? "paid_caregiver"
                  : "family_caregiver") as
                  | "family_caregiver"
                  | "paid_caregiver",
                roleLabel: /professional/i.test(candidate.statement)
                  ? "Professional caregiver"
                  : "Family / friend caregiver",
                status: "pending" as const,
                createdAt: nowIso,
                expiresAt: new Date(
                  Date.now() + 7 * 24 * 3600 * 1000,
                ).toISOString(),
              };
              const invUpdate = encodeInvitationUpdate(inv, {
                id: this.config.store.newId("src"),
                kind: "system_derived",
                label: "Care invitation from Relay",
                actorName: ctx.actorDisplayName,
                actorPersonId: ctx.actorPersonId,
                recordedAt: nowIso,
                whyVisible:
                  "Invitation created after caregiver confirmed in Relay",
              });
              this.config.store.addUpdate(invUpdate);
              updateIds.push(invUpdate.id);
              createNotificationIfNew(this.config.store, {
                principalId: inviteeId,
                careRecipientId: ctx.careRecipientId,
                type: "INVITATION",
                priority: "attention",
                title: "Care invitation",
                body: `${ctx.actorDisplayName} invited you to help care for ${bundle.understood.careRecipientName}. Open People to accept.`,
                sourceType: "invitation",
                sourceId: inv.id,
                actorPersonId: ctx.actorPersonId,
                actorDisplayName: ctx.actorDisplayName,
                actionType: "open_people",
                actionTarget: inv.id,
                dedupeKey: `invite:${inv.id}`,
              });
            }
          }
        } else if (/^Invitation draft:/i.test(candidate.statement)) {
          // Unknown invitee — durable draft note; People completes identity.
          const draft: CareUpdate = {
            id: this.config.store.newId("upd"),
            careRecipientId: ctx.careRecipientId,
            toPersonId: ctx.actorPersonId,
            summary: candidate.statement,
            status: "draft",
            safetyClass: "low",
            source: candidate.sourceReference,
          };
          this.config.store.addUpdate(draft);
          updateIds.push(draft.id);
        } else if (/^Access request:/i.test(candidate.statement)) {
          // Durable access request → Privacy review (approve/deny changes membership).
          const relM = candidate.statement.match(/relationship\s+([^·]+)/i);
          const reasonM = candidate.statement.match(/reason:\s*(.+?)(?:\s*·|$)/i);
          const claimed = (relM?.[1] ?? "caregiver").trim();
          const reason = (reasonM?.[1] ?? candidate.statement).trim().slice(0, 280);
          const pendingDup = listAccessRequestsForRecipient(
            this.config.store,
            ctx.careRecipientId,
          ).find(
            (r) =>
              r.status === "pending" &&
              r.requesterPersonId === ctx.actorPersonId,
          );
          if (pendingDup) {
            updateIds.push(pendingDup.id);
          } else {
            const ar: CareAccessRequest = {
              id: this.config.store.newId("ar"),
              careRecipientId: ctx.careRecipientId,
              requesterPersonId: ctx.actorPersonId,
              requesterDisplayName: ctx.actorDisplayName,
              claimedRelationship: claimed,
              reason,
              status: "pending",
              createdAt: now,
            };
            const arUpdate = encodeAccessRequestUpdate(ar, {
              id: this.config.store.newId("src"),
              kind: "system_derived",
              label: "Access request from Relay",
              actorName: ctx.actorDisplayName,
              actorPersonId: ctx.actorPersonId,
              recordedAt: now,
              whyVisible:
                "Access request pending Privacy review — not membership yet",
            });
            this.config.store.addUpdate(arUpdate);
            updateIds.push(arUpdate.id);
            // Notify controlling members (lab: primary family caregiver Marcus)
            for (const rel of this.config.store.getRelationships(
              ctx.careRecipientId,
            )) {
              if (
                rel.status !== "active" ||
                rel.personId === ctx.actorPersonId
              ) {
                continue;
              }
              const canManage =
                rel.access?.allowedActions?.includes("*") ||
                rel.access?.allowedActions?.includes("invite") ||
                rel.access?.allowedActions?.includes("manage_access") ||
                /primary|family|adult_child|spouse/i.test(rel.role);
              if (!canManage) continue;
              createNotificationIfNew(this.config.store, {
                principalId: rel.personId,
                careRecipientId: ctx.careRecipientId,
                type: "CARE_UPDATE",
                priority: "attention",
                title: "Access request needs review",
                body: `${ctx.actorDisplayName} requested access (${claimed}). Open Privacy to approve, limit, or deny.`,
                sourceType: "access_request",
                sourceId: ar.id,
                actorPersonId: ctx.actorPersonId,
                actorDisplayName: ctx.actorDisplayName,
                actionType: "open_privacy",
                actionTarget: ar.id,
                dedupeKey: `access-req:${ar.id}:${rel.personId}`,
              });
            }
            createWorkItem(this.config.store, {
              careRecipientId: ctx.careRecipientId,
              actorPersonId: ctx.actorPersonId,
              actorDisplayName: ctx.actorDisplayName,
              action: `Review access request from ${ctx.actorDisplayName}`,
              reason: reason.slice(0, 200),
              priority: "high",
              evidenceKind: "operational",
              status: "available_to_claim",
              trustShiftActor: true,
            });
          }
        } else if (/^Access change request:/i.test(candidate.statement)) {
          const draft: CareUpdate = {
            id: this.config.store.newId("upd"),
            careRecipientId: ctx.careRecipientId,
            toPersonId: ctx.actorPersonId,
            summary: candidate.statement,
            status: "draft",
            safetyClass: "moderate",
            source: candidate.sourceReference,
          };
          this.config.store.addUpdate(draft);
          updateIds.push(draft.id);
          createWorkItem(this.config.store, {
            careRecipientId: ctx.careRecipientId,
            actorPersonId: ctx.actorPersonId,
            actorDisplayName: ctx.actorDisplayName,
            action: `Review who can access care for ${bundle.understood.careRecipientName}`,
            reason: "Access change requested via Relay — open Privacy",
            priority: "normal",
            evidenceKind: "operational",
            status: "available_to_claim",
            trustShiftActor: true,
          });
        } else {
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
      }

      // Document text ingest — proposals only until human confirms on Documents
      if (
        candidate.eventType === "note" &&
        /^Document ingest:/i.test(candidate.statement)
      ) {
        const raw = bundle.understood.rawText ?? "";
        const bodyFromRaw =
          raw.match(
            /(?:document(?: body)?|discharge summary|therapy note|says|content)[:\s]+(.+)/is,
          )?.[1] ??
          candidate.recordedDose ??
          candidate.statement.replace(/^Document ingest:\s*/i, "");
        const body = String(bodyFromRaw).trim();
        if (body.length >= 20) {
          const ing = ingestDocumentText(this.config.store, {
            careRecipientId: ctx.careRecipientId,
            actorPersonId: ctx.actorPersonId,
            actorDisplayName: ctx.actorDisplayName,
            title: "Care document from Relay",
            body,
          });
          if (ing.ok) {
            updateIds.push(ing.document.id);
            for (const p of ing.proposals) updateIds.push(p.id);
          }
        }
      }

      const status =
        candidate.eventType === "observation"
          ? candidate.epistemicStatus
          : candidate.epistemicStatus === "UNCERTAIN"
            ? "UNCERTAIN"
            : "CONFIRMED";
      // Medication administration: durable occurrence dedupe for events too
      if (candidate.eventType === "medication_administration") {
        const evt = this.persistEvent(candidate, ctx, now, evidenceMode, status);
        eventIds.push(evt.id);
        continue;
      }
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

    // Role-aware care note from verified update (documentation without forms).
    // Idempotent: same raw text already noted → reuse (confirm retries).
    const roleLabel =
      ctx.roles?.find((r) => /family|professional|physician|dsp|primary/i.test(r)) ??
      ctx.roles?.[0] ??
      "caregiver";
    const rawKey = (bundle.understood.rawText ?? "").trim();
    const existingNote = listCareNotes(this.config.store, ctx.careRecipientId).find(
      (n) =>
        (n.originalRawText ?? "").trim() === rawKey &&
        n.authorPersonId === ctx.actorPersonId,
    );
    const careNote =
      existingNote ??
      composeCareNote({
        bundle,
        ctx,
        roleLabel,
        eventIds,
        confirmedItemIds: opts?.confirmedItemIds,
      });
    if (!existingNote) {
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
    }

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
    const coachLine = coach ? ` ${coach}` : "";

    const resultBase: CareLoopResult = {
      kind: "persisted",
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
    const executionReceipt = buildExecutionReceipt({
      bundle,
      result: resultBase,
      actorId: ctx.actorPersonId,
      actorName: ctx.actorDisplayName,
      requestId: `rcpt-${handoff.id}`,
    });
    // Invite already-member honesty (dedicated People path)
    const alreadyMemberUpdate = this.config.store
      .getUpdates(ctx.careRecipientId)
      .some(
        (u) =>
          updateIds.includes(u.id) && /Already a member:/i.test(u.summary),
      );
    if (alreadyMemberUpdate) {
      const who =
        bundle.understood.candidates
          .find((c) => /^Invite helper:/i.test(c.statement))
          ?.intendedRecipientName ?? "That person";
      executionReceipt.userVisibleConfirmation = `${who} already has active access for ${bundle.understood.careRecipientName}. Open People to review roles or revoke access.`;
      executionReceipt.screenDestinations = [
        "people_privacy",
        "relay_retrieval",
      ];
      executionReceipt.result = "saved";
    }
    // Prefer receipt-derived human copy over API slogans
    resultBase.message = `${executionReceipt.userVisibleConfirmation}${coachLine}`;
    resultBase.executionReceipt = executionReceipt;
    return resultBase;
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

    // Propagate correction to active circle (authorized members only).
    // Original event preserved; superseded; viewers receive in-app notice.
    for (const rel of this.config.store.getRelationships(ctx.careRecipientId)) {
      if (rel.status !== "active") continue;
      if (rel.personId === ctx.actorPersonId) continue;
      createNotificationIfNew(this.config.store, {
        principalId: rel.personId,
        careRecipientId: ctx.careRecipientId,
        type: "CARE_UPDATE",
        priority: "important",
        title: "Correction to care record",
        body: `Previous: ${prior.statement.slice(0, 80)} → Now: ${correctedValue.slice(0, 80)}. Original evidence preserved.`,
        sourceType: "correction",
        sourceId: correction.id,
        actorPersonId: ctx.actorPersonId,
        actorDisplayName: ctx.actorDisplayName,
        actionType: "open_correction",
        actionTarget: correction.id,
        dedupeKey: `corr-prop:${correction.id}:${rel.personId}`,
      });
    }

    return {
      kind: "persisted",
      message:
        "Correction saved. Previous evidence preserved. Authorized circle notified.",
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
    const eventAt = candidate.effectiveAt ?? candidate.recordedAt ?? now;
    const reportAt = candidate.recordedAt ?? now;
    const truthState =
      status === "CONFIRMED"
        ? ("confirmed" as const)
        : status === "UNCERTAIN"
          ? ("disputed" as const)
          : ("reported" as const);
    const evt: CareEvent = {
      id: this.config.store.newId("evt"),
      careRecipientId: ctx.careRecipientId,
      householdId: ctx.householdId,
      type: candidate.eventType,
      title: candidate.statement,
      statement: candidate.statement,
      occurredAt: eventAt,
      eventAt,
      reportAt,
      ingestedAt: now,
      epistemicStatus: status,
      safetyClass: candidate.consequentiality,
      source: candidate.sourceReference,
      confidence: candidate.confidence,
      intendedRecipientPersonId: candidate.intendedRecipientPersonId,
      evidenceMode,
      actorPrincipalId: ctx.actorPersonId,
      actorActiveRole: ctx.roles?.[0],
      authorityBasis: "membership",
      purpose: "care_coordination",
      truthState,
      confidenceLabel:
        truthState === "confirmed"
          ? "confirmed"
          : truthState === "disputed"
            ? "unknown"
            : "reported",
      dedupeKey: (() => {
        if (candidate.eventType === "medication_administration") {
          const medName =
            extractMedNameFromStatement(candidate.statement) || "Lunch medication";
          const dose = candidate.recordedDose ?? "as scheduled";
          const state = /not administered|not given/i.test(candidate.statement)
            ? "not_administered"
            : "administered";
          return medOccurrenceKey({
            careRecipientId: ctx.careRecipientId,
            name: medName,
            doseRecorded: dose,
            administeredByPersonId: ctx.actorPersonId,
            administeredAt: now,
            requestedState: state,
          });
        }
        return [
          ctx.careRecipientId,
          candidate.eventType,
          eventAt,
          ctx.actorPersonId,
          candidate.statement.trim().toLowerCase().slice(0, 80),
        ].join("|");
      })(),
      approvalState: "none",
      executionState: "none",
      correlationId: this.config.store.newId("corr"),
    };
    // Durable event-level compare-and-set: reuse existing same occurrence
    if (evt.dedupeKey) {
      const prior = this.config.store
        .getEvents(ctx.careRecipientId)
        .find(
          (e) =>
            e.dedupeKey === evt.dedupeKey && e.epistemicStatus !== "SUPERSEDED",
        );
      if (prior) return prior;
    }
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
