/**
 * In-process care substrate store.
 *
 * This is the Caretaker Relay care persistence boundary used for:
 * - unit/integration tests without Postgres
 * - SYNTHETIC_FOUNDATION_BACKED demos
 * - app → foundation package wiring before DB-backed adapters land
 *
 * Maps conceptually to Foundation primitives (Entity, MemoryCapsule, AuditEvent,
 * ConsentGrant, Handoff) via FOUNDATION_PRIMITIVE_MAP. A future Prisma adapter
 * must preserve the same CareStore interface — not bypass it from the UI.
 */

import { PRODUCT_ID } from "@caretaker-relay/product-identity";
import type {
  Appointment,
  AuditEntry,
  CareEvent,
  CareHandoff,
  CareRecipient,
  CareTask,
  CareUpdate,
  ConsentRecord,
  Correction,
  CurrentCareState,
  MedicationAdministrationRecord,
  MedicationSchedule,
  Observation,
  Person,
  SafetyReview,
  CarePreferences,
  CareRelationship,
} from "../types.js";

function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

export interface CareStore {
  upsertPerson(p: Person): void;
  getPerson(id: string): Person | undefined;
  upsertRecipient(r: CareRecipient): void;
  getRecipient(id: string): CareRecipient | undefined;
  upsertRelationship(r: CareRelationship): void;
  getRelationships(careRecipientId: string): CareRelationship[];
  getRelationship(
    careRecipientId: string,
    personId: string,
  ): CareRelationship | undefined;
  /** All relationships for a person across recipients (membership scan). */
  getRelationshipsForPerson(personId: string): CareRelationship[];
  listRecipients(): CareRecipient[];
  revokeAccess(careRecipientId: string, personId: string, at: string): void;
  upsertConsent(c: ConsentRecord): void;
  getConsent(
    careRecipientId: string,
    granteePersonId: string,
  ): ConsentRecord | undefined;
  addEvent(e: CareEvent): CareEvent;
  getEvents(careRecipientId: string): CareEvent[];
  getEvent(id: string): CareEvent | undefined;
  supersedeEvent(eventId: string, supersededById: string): void;
  addObservation(o: Observation): Observation;
  getObservations(careRecipientId: string): Observation[];
  upsertAppointment(a: Appointment): Appointment;
  getAppointments(careRecipientId: string): Appointment[];
  upsertTask(t: CareTask): CareTask;
  getTasks(careRecipientId: string): CareTask[];
  upsertMedSchedule(s: MedicationSchedule): void;
  getMedSchedules(careRecipientId: string): MedicationSchedule[];
  addMedRecord(r: MedicationAdministrationRecord): MedicationAdministrationRecord;
  getMedRecords(careRecipientId: string): MedicationAdministrationRecord[];
  addHandoff(h: CareHandoff): CareHandoff;
  getHandoffs(careRecipientId: string): CareHandoff[];
  addUpdate(u: CareUpdate): CareUpdate;
  getUpdates(careRecipientId: string): CareUpdate[];
  addCorrection(c: Correction): Correction;
  getCorrections(careRecipientId: string): Correction[];
  addSafetyReview(s: SafetyReview): SafetyReview;
  getSafetyReviews(careRecipientId: string): SafetyReview[];
  updateSafetyReview(
    id: string,
    status: SafetyReview["status"],
  ): SafetyReview | undefined;
  writeAudit(entry: Omit<AuditEntry, "id" | "productId"> & { id?: string }): AuditEntry;
  listAudit(filter?: {
    careRecipientId?: string;
    householdId?: string;
  }): AuditEntry[];
  setPreferences(p: CarePreferences): void;
  getPreferences(personId: string): CarePreferences | undefined;
  getCurrentState(careRecipientId: string): CurrentCareState | undefined;
  newId(prefix: string): string;
  clear(): void;
}

export class MemoryCareStore implements CareStore {
  private people = new Map<string, Person>();
  private recipients = new Map<string, CareRecipient>();
  private relationships = new Map<string, CareRelationship>();
  private consents = new Map<string, ConsentRecord>();
  private events = new Map<string, CareEvent>();
  private observations = new Map<string, Observation>();
  private appointments = new Map<string, Appointment>();
  private tasks = new Map<string, CareTask>();
  private medSchedules = new Map<string, MedicationSchedule>();
  private medRecords = new Map<string, MedicationAdministrationRecord>();
  private handoffs = new Map<string, CareHandoff>();
  private updates = new Map<string, CareUpdate>();
  private corrections = new Map<string, Correction>();
  private safety = new Map<string, SafetyReview>();
  private audit: AuditEntry[] = [];
  private prefs = new Map<string, CarePreferences>();

  newId(prefix: string): string {
    return id(prefix);
  }

  clear(): void {
    this.people.clear();
    this.recipients.clear();
    this.relationships.clear();
    this.consents.clear();
    this.events.clear();
    this.observations.clear();
    this.appointments.clear();
    this.tasks.clear();
    this.medSchedules.clear();
    this.medRecords.clear();
    this.handoffs.clear();
    this.updates.clear();
    this.corrections.clear();
    this.safety.clear();
    this.audit = [];
    this.prefs.clear();
  }

  upsertPerson(p: Person): void {
    this.people.set(p.id, p);
  }
  getPerson(pid: string): Person | undefined {
    return this.people.get(pid);
  }
  upsertRecipient(r: CareRecipient): void {
    this.recipients.set(r.id, r);
  }
  getRecipient(rid: string): CareRecipient | undefined {
    return this.recipients.get(rid);
  }

  private relKey(careRecipientId: string, personId: string): string {
    return `${careRecipientId}::${personId}`;
  }

  upsertRelationship(r: CareRelationship): void {
    this.relationships.set(this.relKey(r.careRecipientId, r.personId), r);
  }
  getRelationships(careRecipientId: string): CareRelationship[] {
    return [...this.relationships.values()].filter(
      (r) => r.careRecipientId === careRecipientId,
    );
  }
  getRelationship(
    careRecipientId: string,
    personId: string,
  ): CareRelationship | undefined {
    return this.relationships.get(this.relKey(careRecipientId, personId));
  }
  getRelationshipsForPerson(personId: string): CareRelationship[] {
    return [...this.relationships.values()].filter((r) => r.personId === personId);
  }
  listRecipients(): CareRecipient[] {
    return [...this.recipients.values()];
  }
  revokeAccess(careRecipientId: string, personId: string, at: string): void {
    const rel = this.getRelationship(careRecipientId, personId);
    if (rel) {
      this.upsertRelationship({ ...rel, status: "revoked", endDate: at });
    }
    const consent = this.getConsent(careRecipientId, personId);
    if (consent) {
      this.upsertConsent({
        ...consent,
        status: "revoked",
        revokedAt: at,
      });
    }
  }

  upsertConsent(c: ConsentRecord): void {
    this.consents.set(`${c.careRecipientId}::${c.granteePersonId}`, c);
  }
  getConsent(
    careRecipientId: string,
    granteePersonId: string,
  ): ConsentRecord | undefined {
    return this.consents.get(`${careRecipientId}::${granteePersonId}`);
  }

  addEvent(e: CareEvent): CareEvent {
    this.events.set(e.id, e);
    return e;
  }
  getEvents(careRecipientId: string): CareEvent[] {
    return [...this.events.values()]
      .filter((e) => e.careRecipientId === careRecipientId)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }
  getEvent(eid: string): CareEvent | undefined {
    return this.events.get(eid);
  }
  supersedeEvent(eventId: string, supersededById: string): void {
    const e = this.events.get(eventId);
    if (e) {
      this.events.set(eventId, {
        ...e,
        epistemicStatus: "SUPERSEDED",
        supersededById,
      });
    }
  }

  addObservation(o: Observation): Observation {
    this.observations.set(o.id, o);
    return o;
  }
  getObservations(careRecipientId: string): Observation[] {
    return [...this.observations.values()].filter(
      (o) => o.careRecipientId === careRecipientId,
    );
  }

  upsertAppointment(a: Appointment): Appointment {
    this.appointments.set(a.id, a);
    return a;
  }
  getAppointments(careRecipientId: string): Appointment[] {
    return [...this.appointments.values()].filter(
      (a) => a.careRecipientId === careRecipientId,
    );
  }

  upsertTask(t: CareTask): CareTask {
    this.tasks.set(t.id, t);
    return t;
  }
  getTasks(careRecipientId: string): CareTask[] {
    return [...this.tasks.values()].filter(
      (t) => t.careRecipientId === careRecipientId,
    );
  }

  upsertMedSchedule(s: MedicationSchedule): void {
    this.medSchedules.set(s.id, s);
  }
  getMedSchedules(careRecipientId: string): MedicationSchedule[] {
    return [...this.medSchedules.values()].filter(
      (s) => s.careRecipientId === careRecipientId,
    );
  }

  addMedRecord(
    r: MedicationAdministrationRecord,
  ): MedicationAdministrationRecord {
    this.medRecords.set(r.id, r);
    return r;
  }
  getMedRecords(careRecipientId: string): MedicationAdministrationRecord[] {
    return [...this.medRecords.values()].filter(
      (r) => r.careRecipientId === careRecipientId,
    );
  }

  addHandoff(h: CareHandoff): CareHandoff {
    this.handoffs.set(h.id, h);
    return h;
  }
  getHandoffs(careRecipientId: string): CareHandoff[] {
    return [...this.handoffs.values()].filter(
      (h) => h.careRecipientId === careRecipientId,
    );
  }

  addUpdate(u: CareUpdate): CareUpdate {
    this.updates.set(u.id, u);
    return u;
  }
  getUpdates(careRecipientId: string): CareUpdate[] {
    return [...this.updates.values()].filter(
      (u) => u.careRecipientId === careRecipientId,
    );
  }

  addCorrection(c: Correction): Correction {
    this.corrections.set(c.id, c);
    return c;
  }
  getCorrections(careRecipientId: string): Correction[] {
    return [...this.corrections.values()].filter(
      (c) => c.careRecipientId === careRecipientId,
    );
  }

  addSafetyReview(s: SafetyReview): SafetyReview {
    this.safety.set(s.id, s);
    return s;
  }
  getSafetyReviews(careRecipientId: string): SafetyReview[] {
    return [...this.safety.values()].filter(
      (s) => s.careRecipientId === careRecipientId,
    );
  }
  updateSafetyReview(
    sid: string,
    status: SafetyReview["status"],
  ): SafetyReview | undefined {
    const s = this.safety.get(sid);
    if (!s) return undefined;
    const next = { ...s, status };
    this.safety.set(sid, next);
    return next;
  }

  writeAudit(
    entry: Omit<AuditEntry, "id" | "productId"> & { id?: string },
  ): AuditEntry {
    const full: AuditEntry = {
      id: entry.id ?? id("audit"),
      at: entry.at,
      actorPersonId: entry.actorPersonId,
      action: entry.action,
      careRecipientId: entry.careRecipientId,
      householdId: entry.householdId,
      details: entry.details,
      productId: PRODUCT_ID,
    };
    this.audit.push(full);
    return full;
  }
  listAudit(filter?: {
    careRecipientId?: string;
    householdId?: string;
  }): AuditEntry[] {
    return this.audit.filter((a) => {
      if (
        filter?.careRecipientId &&
        a.careRecipientId !== filter.careRecipientId
      ) {
        return false;
      }
      if (filter?.householdId && a.householdId !== filter.householdId) {
        return false;
      }
      return true;
    });
  }

  setPreferences(p: CarePreferences): void {
    this.prefs.set(p.personId, p);
  }
  getPreferences(personId: string): CarePreferences | undefined {
    return this.prefs.get(personId);
  }

  getCurrentState(careRecipientId: string): CurrentCareState | undefined {
    const recipient = this.getRecipient(careRecipientId);
    if (!recipient) return undefined;
    const events = this.getEvents(careRecipientId).filter(
      (e) => e.epistemicStatus !== "SUPERSEDED",
    );
    return {
      careRecipientId,
      householdId: recipient.householdId,
      events,
      observations: this.getObservations(careRecipientId),
      appointments: this.getAppointments(careRecipientId),
      tasks: this.getTasks(careRecipientId),
      medicationRecords: this.getMedRecords(careRecipientId),
      medicationSchedules: this.getMedSchedules(careRecipientId),
      handoffs: this.getHandoffs(careRecipientId),
      openSafetyReviews: this.getSafetyReviews(careRecipientId).filter(
        (s) => s.status === "open",
      ),
      lastUpdatedAt: new Date().toISOString(),
    };
  }
}
