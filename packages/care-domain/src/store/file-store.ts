/**
 * Durable file-backed CareStore.
 *
 * Survives process restart / API restart without requiring Postgres.
 * Maps to the same CareStore interface as MemoryCareStore so routes
 * and CareLoopService are storage-agnostic.
 *
 * Persistence path: CARE_STORE_PATH env or provided path.
 * Format: single JSON snapshot (product_id tagged).
 *
 * This is SYNTHETIC_FOUNDATION_BACKED durable storage for Caretaker Relay.
 * A future Prisma adapter should implement the same CareStore interface.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PRODUCT_ID } from "@caretaker-relay/product-identity";
import type {
  Appointment,
  AuditEntry,
  CareEvent,
  CareHandoff,
  CarePreferences,
  CareRecipient,
  CareRelationship,
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
} from "../types.js";
import { MemoryCareStore, type CareStore } from "./memory-store.js";

interface Snapshot {
  productId: typeof PRODUCT_ID;
  version: 1;
  savedAt: string;
  people: Person[];
  recipients: CareRecipient[];
  relationships: CareRelationship[];
  consents: ConsentRecord[];
  events: CareEvent[];
  observations: Observation[];
  appointments: Appointment[];
  tasks: CareTask[];
  medSchedules: MedicationSchedule[];
  medRecords: MedicationAdministrationRecord[];
  handoffs: CareHandoff[];
  updates: CareUpdate[];
  corrections: Correction[];
  safety: SafetyReview[];
  audit: AuditEntry[];
  prefs: CarePreferences[];
  /** Idempotency ledger: key → response payload JSON */
  idempotency: Array<{ key: string; body: unknown; at: string }>;
}

export class FileCareStore implements CareStore {
  private readonly memory = new MemoryCareStore();
  private readonly path: string;
  private idempotency = new Map<string, { body: unknown; at: string }>();

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  get filePath(): string {
    return this.path;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, "utf8");
      const snap = JSON.parse(raw) as Snapshot;
      if (snap.productId !== PRODUCT_ID) {
        throw new Error(
          `Care store product mismatch: ${snap.productId} !== ${PRODUCT_ID}`,
        );
      }
      this.memory.clear();
      for (const p of snap.people ?? []) this.memory.upsertPerson(p);
      for (const r of snap.recipients ?? []) this.memory.upsertRecipient(r);
      for (const r of snap.relationships ?? []) this.memory.upsertRelationship(r);
      for (const c of snap.consents ?? []) this.memory.upsertConsent(c);
      for (const e of snap.events ?? []) this.memory.addEvent(e);
      for (const o of snap.observations ?? []) this.memory.addObservation(o);
      for (const a of snap.appointments ?? []) this.memory.upsertAppointment(a);
      for (const t of snap.tasks ?? []) this.memory.upsertTask(t);
      for (const s of snap.medSchedules ?? []) this.memory.upsertMedSchedule(s);
      for (const m of snap.medRecords ?? []) this.memory.addMedRecord(m);
      for (const h of snap.handoffs ?? []) this.memory.addHandoff(h);
      for (const u of snap.updates ?? []) this.memory.addUpdate(u);
      for (const c of snap.corrections ?? []) this.memory.addCorrection(c);
      for (const s of snap.safety ?? []) this.memory.addSafetyReview(s);
      for (const a of snap.audit ?? []) {
        this.memory.writeAudit({
          id: a.id,
          at: a.at,
          actorPersonId: a.actorPersonId,
          action: a.action,
          careRecipientId: a.careRecipientId,
          householdId: a.householdId,
          details: a.details,
        });
      }
      for (const p of snap.prefs ?? []) this.memory.setPreferences(p);
      this.idempotency = new Map(
        (snap.idempotency ?? []).map((i) => [i.key, { body: i.body, at: i.at }]),
      );
    } catch (err) {
      throw new Error(
        `Failed to load durable care store at ${this.path}: ${String(err)}`,
      );
    }
  }

  persist(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const snap: Snapshot = {
      productId: PRODUCT_ID,
      version: 1,
      savedAt: new Date().toISOString(),
      people: [...(this.memory as unknown as { people: Map<string, Person> }).people?.values?.() ?? []],
      recipients: [],
      relationships: [],
      consents: [],
      events: [],
      observations: [],
      appointments: [],
      tasks: [],
      medSchedules: [],
      medRecords: [],
      handoffs: [],
      updates: [],
      corrections: [],
      safety: [],
      audit: this.memory.listAudit(),
      prefs: [],
      idempotency: [...this.idempotency.entries()].map(([key, v]) => ({
        key,
        body: v.body,
        at: v.at,
      })),
    };

    // Dump via known APIs (don't rely on private maps)
    // Rebuild from public getters by scanning known scenario + dynamic ids is hard;
    // use internal export helper on memory instead.
    const dumped = dumpMemory(this.memory);
    Object.assign(snap, dumped);
    snap.idempotency = [...this.idempotency.entries()].map(([key, v]) => ({
      key,
      body: v.body,
      at: v.at,
    }));

    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap, null, 2), "utf8");
    renameSync(tmp, this.path);
  }

  getIdempotent(key: string): unknown | undefined {
    return this.idempotency.get(key)?.body;
  }

  putIdempotent(key: string, body: unknown): void {
    this.idempotency.set(key, { body, at: new Date().toISOString() });
    this.persist();
  }

  // Delegate + persist on writes
  newId(prefix: string): string {
    return this.memory.newId(prefix);
  }
  clear(): void {
    this.memory.clear();
    this.idempotency.clear();
    this.persist();
  }
  upsertPerson(p: Person): void {
    this.memory.upsertPerson(p);
    this.persist();
  }
  getPerson(id: string): Person | undefined {
    return this.memory.getPerson(id);
  }
  upsertRecipient(r: CareRecipient): void {
    this.memory.upsertRecipient(r);
    this.persist();
  }
  getRecipient(id: string): CareRecipient | undefined {
    return this.memory.getRecipient(id);
  }
  upsertRelationship(r: CareRelationship): void {
    this.memory.upsertRelationship(r);
    this.persist();
  }
  getRelationships(careRecipientId: string): CareRelationship[] {
    return this.memory.getRelationships(careRecipientId);
  }
  getRelationship(careRecipientId: string, personId: string) {
    return this.memory.getRelationship(careRecipientId, personId);
  }
  getRelationshipsForPerson(personId: string) {
    return this.memory.getRelationshipsForPerson(personId);
  }
  listRecipients() {
    return this.memory.listRecipients();
  }
  revokeAccess(careRecipientId: string, personId: string, at: string): void {
    this.memory.revokeAccess(careRecipientId, personId, at);
    this.persist();
  }
  upsertConsent(c: ConsentRecord): void {
    this.memory.upsertConsent(c);
    this.persist();
  }
  getConsent(careRecipientId: string, granteePersonId: string) {
    return this.memory.getConsent(careRecipientId, granteePersonId);
  }
  addEvent(e: CareEvent): CareEvent {
    const r = this.memory.addEvent(e);
    this.persist();
    return r;
  }
  getEvents(careRecipientId: string): CareEvent[] {
    return this.memory.getEvents(careRecipientId);
  }
  getEvent(id: string): CareEvent | undefined {
    return this.memory.getEvent(id);
  }
  supersedeEvent(eventId: string, supersededById: string): void {
    this.memory.supersedeEvent(eventId, supersededById);
    this.persist();
  }
  addObservation(o: Observation): Observation {
    const r = this.memory.addObservation(o);
    this.persist();
    return r;
  }
  getObservations(careRecipientId: string): Observation[] {
    return this.memory.getObservations(careRecipientId);
  }
  upsertAppointment(a: Appointment): Appointment {
    const r = this.memory.upsertAppointment(a);
    this.persist();
    return r;
  }
  getAppointments(careRecipientId: string): Appointment[] {
    return this.memory.getAppointments(careRecipientId);
  }
  upsertTask(t: CareTask): CareTask {
    const r = this.memory.upsertTask(t);
    this.persist();
    return r;
  }
  getTasks(careRecipientId: string): CareTask[] {
    return this.memory.getTasks(careRecipientId);
  }
  upsertMedSchedule(s: MedicationSchedule): void {
    this.memory.upsertMedSchedule(s);
    this.persist();
  }
  getMedSchedules(careRecipientId: string): MedicationSchedule[] {
    return this.memory.getMedSchedules(careRecipientId);
  }
  addMedRecord(r: MedicationAdministrationRecord): MedicationAdministrationRecord {
    const out = this.memory.addMedRecord(r);
    this.persist();
    return out;
  }
  getMedRecords(careRecipientId: string): MedicationAdministrationRecord[] {
    return this.memory.getMedRecords(careRecipientId);
  }
  addHandoff(h: CareHandoff): CareHandoff {
    const r = this.memory.addHandoff(h);
    this.persist();
    return r;
  }
  getHandoffs(careRecipientId: string): CareHandoff[] {
    return this.memory.getHandoffs(careRecipientId);
  }
  addUpdate(u: CareUpdate): CareUpdate {
    const r = this.memory.addUpdate(u);
    this.persist();
    return r;
  }
  getUpdates(careRecipientId: string): CareUpdate[] {
    return this.memory.getUpdates(careRecipientId);
  }
  addCorrection(c: Correction): Correction {
    const r = this.memory.addCorrection(c);
    this.persist();
    return r;
  }
  getCorrections(careRecipientId: string): Correction[] {
    return this.memory.getCorrections(careRecipientId);
  }
  addSafetyReview(s: SafetyReview): SafetyReview {
    const r = this.memory.addSafetyReview(s);
    this.persist();
    return r;
  }
  getSafetyReviews(careRecipientId: string): SafetyReview[] {
    return this.memory.getSafetyReviews(careRecipientId);
  }
  updateSafetyReview(id: string, status: SafetyReview["status"]) {
    const r = this.memory.updateSafetyReview(id, status);
    this.persist();
    return r;
  }
  writeAudit(entry: Omit<AuditEntry, "id" | "productId"> & { id?: string }): AuditEntry {
    const r = this.memory.writeAudit(entry);
    this.persist();
    return r;
  }
  listAudit(filter?: { careRecipientId?: string; householdId?: string }): AuditEntry[] {
    return this.memory.listAudit(filter);
  }
  setPreferences(p: CarePreferences): void {
    this.memory.setPreferences(p);
    this.persist();
  }
  getPreferences(personId: string): CarePreferences | undefined {
    return this.memory.getPreferences(personId);
  }
  getCurrentState(careRecipientId: string): CurrentCareState | undefined {
    return this.memory.getCurrentState(careRecipientId);
  }
}

/** Export memory store contents via public APIs + internal walk. */
function dumpMemory(store: MemoryCareStore): Omit<Snapshot, "productId" | "version" | "savedAt" | "idempotency"> {
  // Collect by scanning known recipients from audit + events is incomplete.
  // Use a private-access shim: MemoryCareStore is in the same package.
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
    events: [...anyStore.events.values()],
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
