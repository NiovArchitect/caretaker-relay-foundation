/**
 * Prisma-backed CareStore for Caretaker Relay.
 * Write-through memory cache + durable Postgres (cr_* tables).
 * Survives process restart via load() + flush().
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@niov/database";
import { PRODUCT_ID } from "@caretaker-relay/product-identity";
import {
  MemoryCareStore,
  medAdminHash,
  handoffHash,
  communicationHash,
  type CareStore,
  type Appointment,
  type AuditEntry,
  type CareEvent,
  type CareHandoff,
  type CarePreferences,
  type CareRecipient,
  type CareRelationship,
  type CareTask,
  type CareUpdate,
  type ConsentRecord,
  type Correction,
  type CurrentCareState,
  type MedicationAdministrationRecord,
  type MedicationSchedule,
  type Observation,
  type Person,
  type SafetyReview,
  type SourceRef,
} from "@caretaker-relay/care-domain";

/**
 * CANONICAL medication content hash — single policy shared with care-domain loop.
 * Do not invent a second hash algorithm here.
 */
export function medContentHash(m: {
  careRecipientId: string;
  name: string;
  doseRecorded: string;
  administeredByPersonId: string;
  administeredAt: string;
}): string {
  return medAdminHash({
    careRecipientId: m.careRecipientId,
    name: m.name,
    doseRecorded: m.doseRecorded,
    administeredByPersonId: m.administeredByPersonId,
    administeredAt: m.administeredAt,
  });
}

export class PrismaCareStore implements CareStore {
  private memory = new MemoryCareStore();
  private idempotency = new Map<string, { body: unknown; at: string }>();
  private dirty = false;
  readonly backend = "prisma" as const;

  static async create(opts?: { load?: boolean }): Promise<PrismaCareStore> {
    const store = new PrismaCareStore();
    if (opts?.load !== false) {
      await store.load();
    }
    return store;
  }

  async load(): Promise<void> {
    this.memory.clear();
    this.idempotency.clear();

    const [
      people,
      recipients,
      relationships,
      consents,
      events,
      observations,
      appointments,
      tasks,
      medSchedules,
      medRecords,
      handoffs,
      updates,
      corrections,
      safety,
      prefs,
      audits,
      idems,
    ] = await Promise.all([
      prisma.carePersonRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careRecipientRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careRelationshipRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careConsentRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careEventRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careObservationRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careAppointmentRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careTaskRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careMedScheduleRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careMedAdminRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careHandoffRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careUpdateRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careCorrectionRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careSafetyReviewRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.carePreferenceRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careAuditRow.findMany({ where: { product_id: PRODUCT_ID } }),
      prisma.careIdempotencyRow.findMany({ where: { product_id: PRODUCT_ID } }),
    ]);

    for (const p of people) {
      this.memory.upsertPerson({
        id: p.id,
        displayName: p.display_name,
        kind: p.kind as Person["kind"],
      });
    }
    for (const r of recipients) {
      this.memory.upsertRecipient({
        id: r.id,
        displayName: r.display_name,
        preferredName: r.preferred_name ?? undefined,
        householdId: r.household_id,
      });
    }
    for (const r of relationships) {
      this.memory.upsertRelationship({
        id: r.id,
        careRecipientId: r.care_recipient_id,
        personId: r.person_id,
        role: r.role as CareRelationship["role"],
        roleLabel: r.role_label,
        responsibilities: r.responsibilities as unknown as string[],
        access: r.access as unknown as CareRelationship["access"],
        status: r.status as CareRelationship["status"],
        startDate: r.start_date ?? undefined,
        endDate: r.end_date ?? undefined,
        contactPreference: r.contact_preference ?? undefined,
        scheduleNotes: r.schedule_notes ?? undefined,
      });
    }
    for (const c of consents) {
      this.memory.upsertConsent({
        id: c.id,
        careRecipientId: c.care_recipient_id,
        granteePersonId: c.grantee_person_id,
        scope: c.scope as unknown as ConsentRecord["scope"],
        status: c.status as ConsentRecord["status"],
        grantedAt: c.granted_at,
        revokedAt: c.revoked_at ?? undefined,
      });
    }
    for (const e of events) {
      this.memory.addEvent({
        id: e.id,
        careRecipientId: e.care_recipient_id,
        householdId: e.household_id,
        type: e.type as CareEvent["type"],
        title: e.title,
        statement: e.statement,
        occurredAt: e.occurred_at,
        notes: e.notes ?? undefined,
        epistemicStatus: e.epistemic_status as CareEvent["epistemicStatus"],
        safetyClass: e.safety_class as CareEvent["safetyClass"],
        source: e.source as unknown as SourceRef,
        confidence: e.confidence ?? undefined,
        intendedRecipientPersonId: e.intended_recipient_person_id ?? undefined,
        supersededById: e.superseded_by_id ?? undefined,
        evidenceMode: e.evidence_mode as CareEvent["evidenceMode"],
      });
    }
    for (const o of observations) {
      this.memory.addObservation({
        id: o.id,
        careRecipientId: o.care_recipient_id,
        summary: o.summary,
        observedAt: o.observed_at,
        tags: o.tags,
        epistemicStatus: o.epistemic_status as Observation["epistemicStatus"],
        source: o.source as unknown as SourceRef,
      });
    }
    for (const a of appointments) {
      this.memory.upsertAppointment({
        id: a.id,
        careRecipientId: a.care_recipient_id,
        title: a.title,
        startsAt: a.starts_at,
        startsAtLabel: a.starts_at_label ?? undefined,
        endsAt: a.ends_at ?? undefined,
        location: a.location ?? undefined,
        status: a.status as Appointment["status"],
        epistemicStatus: a.epistemic_status as Appointment["epistemicStatus"],
        source: (a.source as unknown as SourceRef | null) ?? undefined,
      });
    }
    for (const t of tasks) {
      this.memory.upsertTask({
        id: t.id,
        careRecipientId: t.care_recipient_id,
        title: t.title,
        dueAt: t.due_at ?? undefined,
        status: t.status as CareTask["status"],
        assigneePersonId: t.assignee_person_id ?? undefined,
        safetyClass: t.safety_class as CareTask["safetyClass"],
        epistemicStatus: t.epistemic_status as CareTask["epistemicStatus"],
        source: (t.source as unknown as SourceRef | null) ?? undefined,
      });
    }
    for (const s of medSchedules) {
      this.memory.upsertMedSchedule({
        id: s.id,
        careRecipientId: s.care_recipient_id,
        name: s.name,
        dose: s.dose,
        scheduleLabel: s.schedule_label,
        authorizedBy: s.authorized_by,
        authorizedAt: s.authorized_at,
        source: s.source as unknown as SourceRef,
      });
    }
    for (const m of medRecords) {
      this.memory.addMedRecord({
        id: m.id,
        careRecipientId: m.care_recipient_id,
        scheduleId: m.schedule_id ?? undefined,
        name: m.name,
        doseRecorded: m.dose_recorded,
        administeredAt: m.administered_at,
        administeredByPersonId: m.administered_by_person_id,
        status: m.status as MedicationAdministrationRecord["status"],
        discrepancy:
          (m.discrepancy as unknown as MedicationAdministrationRecord["discrepancy"]) ??
          undefined,
        epistemicStatus:
          m.epistemic_status as MedicationAdministrationRecord["epistemicStatus"],
        source: m.source as unknown as SourceRef,
      });
    }
    for (const h of handoffs) {
      this.memory.addHandoff({
        id: h.id,
        careRecipientId: h.care_recipient_id,
        fromPersonId: h.from_person_id ?? undefined,
        toPersonId: h.to_person_id ?? undefined,
        whatChanged: h.what_changed as unknown as string[],
        stillNeedsAttention: h.still_needs as unknown as string[],
        watch: h.watch as unknown as string[],
        sources: h.sources as unknown as SourceRef[],
        createdAt: h.created_at,
        evidenceMode: h.evidence_mode as CareHandoff["evidenceMode"],
      });
    }
    for (const u of updates) {
      this.memory.addUpdate({
        id: u.id,
        careRecipientId: u.care_recipient_id,
        toPersonId: u.to_person_id,
        summary: u.summary,
        status: u.status as CareUpdate["status"],
        safetyClass: u.safety_class as CareUpdate["safetyClass"],
        source: u.source as unknown as SourceRef,
      });
    }
    for (const c of corrections) {
      this.memory.addCorrection({
        id: c.id,
        careRecipientId: c.care_recipient_id,
        targetEventId: c.target_event_id,
        previousValue: c.previous_value,
        correctedValue: c.corrected_value,
        correctedByPersonId: c.corrected_by_person_id,
        correctedAt: c.corrected_at,
        preservedEvidenceIds: c.preserved_evidence_ids as unknown as string[],
        source: c.source as unknown as SourceRef,
      });
    }
    for (const s of safety) {
      this.memory.addSafetyReview({
        id: s.id,
        careRecipientId: s.care_recipient_id,
        safetyClass: s.safety_class as SafetyReview["safetyClass"],
        reason: s.reason,
        status: s.status as SafetyReview["status"],
        createdAt: s.created_at,
        targetIds: s.target_ids as unknown as string[],
      });
    }
    for (const p of prefs) {
      this.memory.setPreferences({
        personId: p.person_id,
        summaryLength: p.summary_length as CarePreferences["summaryLength"],
        reminderTimingMinutes: p.reminder_timing_minutes,
        language: p.language,
        accessibility: p.accessibility as unknown as string[],
        handoffFormat: p.handoff_format as CarePreferences["handoffFormat"],
        communicationPreference:
          p.communication_preference as CarePreferences["communicationPreference"],
        reviewable: true,
        editable: true,
        removable: true,
        provenance: p.provenance as unknown as SourceRef,
      });
    }
    for (const a of audits) {
      this.memory.writeAudit({
        id: a.id,
        at: a.at,
        actorPersonId: a.actor_person_id,
        action: a.action,
        careRecipientId: a.care_recipient_id ?? undefined,
        householdId: a.household_id ?? undefined,
        details: a.details as unknown as Record<string, unknown>,
      });
    }
    for (const i of idems) {
      this.idempotency.set(i.key, { body: i.body, at: i.at });
    }
    this.dirty = false;
  }

  /** Flush entire care domain snapshot to Postgres. */
  async flush(): Promise<void> {
    const snap = dumpMemory(this.memory);

    // Ensure households exist for recipients
    const householdIds = new Set(snap.recipients.map((r) => r.householdId));
    for (const hid of householdIds) {
      await prisma.careHousehold.upsert({
        where: { id: hid },
        create: {
          id: hid,
          name: hid,
          product_id: PRODUCT_ID,
        },
        update: {},
      });
    }

    for (const p of snap.people) {
      await prisma.carePersonRow.upsert({
        where: { id: p.id },
        create: {
          id: p.id,
          display_name: p.displayName,
          kind: p.kind,
          product_id: PRODUCT_ID,
        },
        update: { display_name: p.displayName, kind: p.kind },
      });
    }
    for (const r of snap.recipients) {
      await prisma.careRecipientRow.upsert({
        where: { id: r.id },
        create: {
          id: r.id,
          household_id: r.householdId,
          display_name: r.displayName,
          preferred_name: r.preferredName ?? null,
          product_id: PRODUCT_ID,
        },
        update: {
          household_id: r.householdId,
          display_name: r.displayName,
          preferred_name: r.preferredName ?? null,
        },
      });
    }
    for (const r of snap.relationships) {
      await prisma.careRelationshipRow.upsert({
        where: { id: r.id },
        create: {
          id: r.id,
          care_recipient_id: r.careRecipientId,
          person_id: r.personId,
          role: r.role,
          role_label: r.roleLabel,
          responsibilities: r.responsibilities,
          access: r.access as object,
          status: r.status,
          start_date: r.startDate ?? null,
          end_date: r.endDate ?? null,
          contact_preference: r.contactPreference ?? null,
          schedule_notes: r.scheduleNotes ?? null,
          product_id: PRODUCT_ID,
        },
        update: {
          role: r.role,
          role_label: r.roleLabel,
          responsibilities: r.responsibilities,
          access: r.access as object,
          status: r.status,
          end_date: r.endDate ?? null,
        },
      });
    }
    for (const c of snap.consents) {
      await prisma.careConsentRow.upsert({
        where: { id: c.id },
        create: {
          id: c.id,
          care_recipient_id: c.careRecipientId,
          grantee_person_id: c.granteePersonId,
          scope: c.scope as object,
          status: c.status,
          granted_at: c.grantedAt,
          revoked_at: c.revokedAt ?? null,
          product_id: PRODUCT_ID,
        },
        update: {
          scope: c.scope as object,
          status: c.status,
          revoked_at: c.revokedAt ?? null,
        },
      });
    }

    // Events: upsert each
    for (const e of snap.events) {
      await prisma.careEventRow.upsert({
        where: { id: e.id },
        create: {
          id: e.id,
          care_recipient_id: e.careRecipientId,
          household_id: e.householdId,
          type: e.type,
          title: e.title,
          statement: e.statement,
          occurred_at: e.occurredAt,
          notes: e.notes ?? null,
          epistemic_status: e.epistemicStatus,
          safety_class: e.safetyClass,
          source: e.source as object,
          confidence: e.confidence ?? null,
          intended_recipient_person_id: e.intendedRecipientPersonId ?? null,
          superseded_by_id: e.supersededById ?? null,
          evidence_mode: e.evidenceMode,
          product_id: PRODUCT_ID,
        },
        update: {
          statement: e.statement,
          epistemic_status: e.epistemicStatus,
          superseded_by_id: e.supersededById ?? null,
          title: e.title,
        },
      });
    }
    // Also supersede events that are only in DB via memory getEvents doesn't include SUPERSEDED filtered - we dump all events from private map
    for (const e of allEventsIncludingSuperseded(this.memory)) {
      if (snap.events.find((x) => x.id === e.id)) continue;
      await prisma.careEventRow.upsert({
        where: { id: e.id },
        create: {
          id: e.id,
          care_recipient_id: e.careRecipientId,
          household_id: e.householdId,
          type: e.type,
          title: e.title,
          statement: e.statement,
          occurred_at: e.occurredAt,
          notes: e.notes ?? null,
          epistemic_status: e.epistemicStatus,
          safety_class: e.safetyClass,
          source: e.source as object,
          confidence: e.confidence ?? null,
          intended_recipient_person_id: e.intendedRecipientPersonId ?? null,
          superseded_by_id: e.supersededById ?? null,
          evidence_mode: e.evidenceMode,
          product_id: PRODUCT_ID,
        },
        update: {
          epistemic_status: e.epistemicStatus,
          superseded_by_id: e.supersededById ?? null,
        },
      });
    }

    for (const o of snap.observations) {
      await prisma.careObservationRow.upsert({
        where: { id: o.id },
        create: {
          id: o.id,
          care_recipient_id: o.careRecipientId,
          summary: o.summary,
          observed_at: o.observedAt,
          tags: o.tags ?? [],
          epistemic_status: o.epistemicStatus,
          source: o.source as object,
          product_id: PRODUCT_ID,
        },
        update: { summary: o.summary, epistemic_status: o.epistemicStatus },
      });
    }
    for (const a of snap.appointments) {
      await prisma.careAppointmentRow.upsert({
        where: { id: a.id },
        create: {
          id: a.id,
          care_recipient_id: a.careRecipientId,
          title: a.title,
          starts_at: a.startsAt,
          starts_at_label: a.startsAtLabel ?? null,
          ends_at: a.endsAt ?? null,
          location: a.location ?? null,
          status: a.status,
          epistemic_status: a.epistemicStatus,
          source: (a.source as object) ?? undefined,
          product_id: PRODUCT_ID,
        },
        update: {
          starts_at: a.startsAt,
          starts_at_label: a.startsAtLabel ?? null,
          status: a.status,
          epistemic_status: a.epistemicStatus,
        },
      });
    }
    for (const t of snap.tasks) {
      await prisma.careTaskRow.upsert({
        where: { id: t.id },
        create: {
          id: t.id,
          care_recipient_id: t.careRecipientId,
          title: t.title,
          due_at: t.dueAt ?? null,
          status: t.status,
          assignee_person_id: t.assigneePersonId ?? null,
          safety_class: t.safetyClass,
          epistemic_status: t.epistemicStatus,
          source: (t.source as object) ?? undefined,
          product_id: PRODUCT_ID,
        },
        update: { status: t.status, title: t.title },
      });
    }
    for (const s of snap.medSchedules) {
      await prisma.careMedScheduleRow.upsert({
        where: { id: s.id },
        create: {
          id: s.id,
          care_recipient_id: s.careRecipientId,
          name: s.name,
          dose: s.dose,
          schedule_label: s.scheduleLabel,
          authorized_by: s.authorizedBy,
          authorized_at: s.authorizedAt,
          source: s.source as object,
          product_id: PRODUCT_ID,
        },
        update: { dose: s.dose, schedule_label: s.scheduleLabel },
      });
    }
    for (const m of snap.medRecords) {
      const content_hash = medContentHash(m);
      await prisma.careMedAdminRow.upsert({
        where: { id: m.id },
        create: {
          id: m.id,
          care_recipient_id: m.careRecipientId,
          schedule_id: m.scheduleId ?? null,
          name: m.name,
          dose_recorded: m.doseRecorded,
          administered_at: m.administeredAt,
          administered_by_person_id: m.administeredByPersonId,
          status: m.status,
          discrepancy: (m.discrepancy as object) ?? undefined,
          epistemic_status: m.epistemicStatus,
          source: m.source as object,
          content_hash,
          product_id: PRODUCT_ID,
        },
        update: { status: m.status, epistemic_status: m.epistemicStatus },
      });
    }
    for (const h of snap.handoffs) {
      const content_hash = handoffHash({
        careRecipientId: h.careRecipientId,
        fromPersonId: h.fromPersonId,
        toPersonId: h.toPersonId,
        whatChanged: h.whatChanged,
      });
      await prisma.careHandoffRow.upsert({
        where: { id: h.id },
        create: {
          id: h.id,
          care_recipient_id: h.careRecipientId,
          from_person_id: h.fromPersonId ?? null,
          to_person_id: h.toPersonId ?? null,
          what_changed: h.whatChanged,
          still_needs: h.stillNeedsAttention,
          watch: h.watch,
          sources: h.sources as object,
          created_at: h.createdAt,
          evidence_mode: h.evidenceMode,
          content_hash,
          product_id: PRODUCT_ID,
        },
        update: {
          what_changed: h.whatChanged,
          still_needs: h.stillNeedsAttention,
        },
      });
    }
    for (const u of snap.updates) {
      const content_hash = communicationHash({
        careRecipientId: u.careRecipientId,
        toPersonId: u.toPersonId,
        summary: u.summary,
      });
      await prisma.careUpdateRow.upsert({
        where: { id: u.id },
        create: {
          id: u.id,
          care_recipient_id: u.careRecipientId,
          to_person_id: u.toPersonId,
          summary: u.summary,
          status: u.status,
          safety_class: u.safetyClass,
          source: u.source as object,
          content_hash,
          product_id: PRODUCT_ID,
        },
        update: { status: u.status, summary: u.summary, content_hash },
      });
    }
    for (const c of snap.corrections) {
      await prisma.careCorrectionRow.upsert({
        where: { id: c.id },
        create: {
          id: c.id,
          care_recipient_id: c.careRecipientId,
          target_event_id: c.targetEventId,
          previous_value: c.previousValue,
          corrected_value: c.correctedValue,
          corrected_by_person_id: c.correctedByPersonId,
          corrected_at: c.correctedAt,
          preserved_evidence_ids: c.preservedEvidenceIds,
          source: c.source as object,
          product_id: PRODUCT_ID,
        },
        update: { corrected_value: c.correctedValue },
      });
    }
    for (const s of snap.safety) {
      await prisma.careSafetyReviewRow.upsert({
        where: { id: s.id },
        create: {
          id: s.id,
          care_recipient_id: s.careRecipientId,
          safety_class: s.safetyClass,
          reason: s.reason,
          status: s.status,
          created_at: s.createdAt,
          target_ids: s.targetIds,
          product_id: PRODUCT_ID,
        },
        update: { status: s.status },
      });
    }
    for (const p of snap.prefs) {
      await prisma.carePreferenceRow.upsert({
        where: { person_id: p.personId },
        create: {
          person_id: p.personId,
          summary_length: p.summaryLength,
          reminder_timing_minutes: p.reminderTimingMinutes,
          language: p.language,
          accessibility: p.accessibility,
          handoff_format: p.handoffFormat,
          communication_preference: p.communicationPreference,
          provenance: p.provenance as object,
          product_id: PRODUCT_ID,
        },
        update: {
          summary_length: p.summaryLength,
          language: p.language,
        },
      });
    }
    for (const a of snap.audit) {
      await prisma.careAuditRow.upsert({
        where: { id: a.id },
        create: {
          id: a.id,
          at: a.at,
          actor_person_id: a.actorPersonId,
          action: a.action,
          care_recipient_id: a.careRecipientId ?? null,
          household_id: a.householdId ?? null,
          details: a.details as object,
          product_id: PRODUCT_ID,
        },
        update: {},
      });
    }
    for (const [key, v] of this.idempotency) {
      await prisma.careIdempotencyRow.upsert({
        where: { key },
        create: {
          key,
          body: v.body as object,
          at: v.at,
          product_id: PRODUCT_ID,
        },
        update: { body: v.body as object, at: v.at },
      });
    }
    this.dirty = false;
  }

  markDirty(): void {
    this.dirty = true;
  }

  getIdempotent(key: string): unknown | undefined {
    return this.idempotency.get(key)?.body;
  }

  putIdempotent(key: string, body: unknown): void {
    this.idempotency.set(key, { body, at: new Date().toISOString() });
    this.dirty = true;
  }

  /** Content-hash med duplicate check against memory + will flush to DB. */
  findMedByContentHash(
    careRecipientId: string,
    hash: string,
  ): MedicationAdministrationRecord | undefined {
    return this.memory
      .getMedRecords(careRecipientId)
      .find((m) => medContentHash(m) === hash);
  }

  // ── CareStore interface (sync memory + dirty flag) ─────────────
  newId(prefix: string): string {
    return this.memory.newId(prefix);
  }
  clear(): void {
    this.memory.clear();
    this.idempotency.clear();
    this.dirty = true;
  }
  upsertPerson(p: Person): void {
    this.memory.upsertPerson(p);
    this.dirty = true;
  }
  getPerson(id: string) {
    return this.memory.getPerson(id);
  }
  upsertRecipient(r: CareRecipient): void {
    this.memory.upsertRecipient(r);
    this.dirty = true;
  }
  getRecipient(id: string) {
    return this.memory.getRecipient(id);
  }
  upsertRelationship(r: CareRelationship): void {
    this.memory.upsertRelationship(r);
    this.dirty = true;
  }
  getRelationships(careRecipientId: string) {
    return this.memory.getRelationships(careRecipientId);
  }
  getRelationship(careRecipientId: string, personId: string) {
    return this.memory.getRelationship(careRecipientId, personId);
  }
  revokeAccess(careRecipientId: string, personId: string, at: string): void {
    this.memory.revokeAccess(careRecipientId, personId, at);
    this.dirty = true;
  }
  upsertConsent(c: ConsentRecord): void {
    this.memory.upsertConsent(c);
    this.dirty = true;
  }
  getConsent(careRecipientId: string, granteePersonId: string) {
    return this.memory.getConsent(careRecipientId, granteePersonId);
  }
  addEvent(e: CareEvent): CareEvent {
    const r = this.memory.addEvent(e);
    this.dirty = true;
    return r;
  }
  getEvents(careRecipientId: string) {
    return this.memory.getEvents(careRecipientId);
  }
  getEvent(id: string) {
    return this.memory.getEvent(id);
  }
  supersedeEvent(eventId: string, supersededById: string): void {
    this.memory.supersedeEvent(eventId, supersededById);
    this.dirty = true;
  }
  addObservation(o: Observation): Observation {
    const r = this.memory.addObservation(o);
    this.dirty = true;
    return r;
  }
  getObservations(careRecipientId: string) {
    return this.memory.getObservations(careRecipientId);
  }
  upsertAppointment(a: Appointment): Appointment {
    const r = this.memory.upsertAppointment(a);
    this.dirty = true;
    return r;
  }
  getAppointments(careRecipientId: string) {
    return this.memory.getAppointments(careRecipientId);
  }
  upsertTask(t: CareTask): CareTask {
    const r = this.memory.upsertTask(t);
    this.dirty = true;
    return r;
  }
  getTasks(careRecipientId: string) {
    return this.memory.getTasks(careRecipientId);
  }
  upsertMedSchedule(s: MedicationSchedule): void {
    this.memory.upsertMedSchedule(s);
    this.dirty = true;
  }
  getMedSchedules(careRecipientId: string) {
    return this.memory.getMedSchedules(careRecipientId);
  }
  addMedRecord(r: MedicationAdministrationRecord): MedicationAdministrationRecord {
    const hash = medContentHash(r);
    // Dedupe completed OR needs_review for the same semantic administration
    const dup = this.findMedByContentHash(r.careRecipientId, hash);
    if (
      dup &&
      (dup.status === "recorded" || dup.status === "needs_review") &&
      (r.status === "recorded" || r.status === "needs_review")
    ) {
      this.storeAuditIdempotentHit(r.careRecipientId, hash, dup.id);
      return dup;
    }
    const out = this.memory.addMedRecord(r);
    this.dirty = true;
    return out;
  }

  private storeAuditIdempotentHit(
    careRecipientId: string,
    hash: string,
    existingId: string,
  ): void {
    this.memory.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: "system",
      action: "IDEMPOTENT_MED_DEDUPED",
      careRecipientId,
      details: {
        content_hash: hash,
        existing_record_id: existingId,
        policy: "medAdminHash/semanticContentHash",
      },
    });
    this.dirty = true;
  }
  getMedRecords(careRecipientId: string) {
    return this.memory.getMedRecords(careRecipientId);
  }
  addHandoff(h: CareHandoff): CareHandoff {
    const hash = handoffHash({
      careRecipientId: h.careRecipientId,
      fromPersonId: h.fromPersonId,
      toPersonId: h.toPersonId,
      whatChanged: h.whatChanged,
    });
    const dup = this.memory
      .getHandoffs(h.careRecipientId)
      .find(
        (x) =>
          handoffHash({
            careRecipientId: x.careRecipientId,
            fromPersonId: x.fromPersonId,
            toPersonId: x.toPersonId,
            whatChanged: x.whatChanged,
          }) === hash,
      );
    if (dup) return dup;
    const r = this.memory.addHandoff(h);
    this.dirty = true;
    return r;
  }
  getHandoffs(careRecipientId: string) {
    return this.memory.getHandoffs(careRecipientId);
  }
  addUpdate(u: CareUpdate): CareUpdate {
    const hash = communicationHash({
      careRecipientId: u.careRecipientId,
      toPersonId: u.toPersonId,
      summary: u.summary,
    });
    const dup = this.memory
      .getUpdates(u.careRecipientId)
      .find(
        (x) =>
          communicationHash({
            careRecipientId: x.careRecipientId,
            toPersonId: x.toPersonId,
            summary: x.summary,
          }) === hash,
      );
    if (dup) return dup;
    const r = this.memory.addUpdate(u);
    this.dirty = true;
    return r;
  }
  getUpdates(careRecipientId: string) {
    return this.memory.getUpdates(careRecipientId);
  }
  addCorrection(c: Correction): Correction {
    const r = this.memory.addCorrection(c);
    this.dirty = true;
    return r;
  }
  getCorrections(careRecipientId: string) {
    return this.memory.getCorrections(careRecipientId);
  }
  addSafetyReview(s: SafetyReview): SafetyReview {
    const r = this.memory.addSafetyReview(s);
    this.dirty = true;
    return r;
  }
  getSafetyReviews(careRecipientId: string) {
    return this.memory.getSafetyReviews(careRecipientId);
  }
  updateSafetyReview(id: string, status: SafetyReview["status"]) {
    const r = this.memory.updateSafetyReview(id, status);
    this.dirty = true;
    return r;
  }
  writeAudit(
    entry: Omit<AuditEntry, "id" | "productId"> & { id?: string },
  ): AuditEntry {
    const r = this.memory.writeAudit(entry);
    this.dirty = true;
    return r;
  }
  listAudit(filter?: { careRecipientId?: string; householdId?: string }) {
    return this.memory.listAudit(filter);
  }
  setPreferences(p: CarePreferences): void {
    this.memory.setPreferences(p);
    this.dirty = true;
  }
  getPreferences(personId: string) {
    return this.memory.getPreferences(personId);
  }
  getCurrentState(careRecipientId: string): CurrentCareState | undefined {
    return this.memory.getCurrentState(careRecipientId);
  }
}

function dumpMemory(store: MemoryCareStore) {
  const anyStore = store as unknown as {
    people: Map<string, Person>;
    recipients: Map<string, CareRecipient>;
    relationships: Map<string, CareRelationship>;
    consents: Map<string, ConsentRecord>;
    events: Map<string, CareEvent>;
    observations: Map<string, Observation>;
    appointments: Map<string, Appointment>;
    tasks: Map<string, CareTask>;
    medSchedules: Map<string, MedicationSchedule>;
    medRecords: Map<string, MedicationAdministrationRecord>;
    handoffs: Map<string, CareHandoff>;
    updates: Map<string, CareUpdate>;
    corrections: Map<string, Correction>;
    safety: Map<string, SafetyReview>;
    prefs: Map<string, CarePreferences>;
  };
  return {
    people: [...anyStore.people.values()],
    recipients: [...anyStore.recipients.values()],
    relationships: [...anyStore.relationships.values()],
    consents: [...anyStore.consents.values()],
    events: [...anyStore.events.values()].filter(
      (e) => e.epistemicStatus !== "SUPERSEDED",
    ),
    observations: [...anyStore.observations.values()],
    appointments: [...anyStore.appointments.values()],
    tasks: [...anyStore.tasks.values()],
    medSchedules: [...anyStore.medSchedules.values()],
    medRecords: [...anyStore.medRecords.values()],
    handoffs: [...anyStore.handoffs.values()],
    updates: [...anyStore.updates.values()],
    corrections: [...anyStore.corrections.values()],
    safety: [...anyStore.safety.values()],
    audit: store.listAudit(),
    prefs: [...anyStore.prefs.values()],
  };
}

function allEventsIncludingSuperseded(store: MemoryCareStore): CareEvent[] {
  const anyStore = store as unknown as { events: Map<string, CareEvent> };
  return [...anyStore.events.values()];
}

export async function linkPrincipal(
  entityId: string,
  carePersonId: string,
  displayName: string,
  roles: string[],
): Promise<void> {
  await prisma.carePrincipalLink.upsert({
    where: { entity_id: entityId },
    create: {
      id: randomUUID(),
      entity_id: entityId,
      care_person_id: carePersonId,
      display_name: displayName,
      roles,
      product_id: PRODUCT_ID,
    },
    update: {
      care_person_id: carePersonId,
      display_name: displayName,
      roles,
    },
  });
}

export async function resolveCarePersonFromEntity(
  entityId: string,
): Promise<{ carePersonId: string; displayName: string; roles: string[] } | null> {
  const row = await prisma.carePrincipalLink.findUnique({
    where: { entity_id: entityId },
  });
  if (!row) return null;
  return {
    carePersonId: row.care_person_id,
    displayName: row.display_name,
    roles: row.roles,
  };
}
