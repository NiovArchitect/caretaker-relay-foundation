/**
 * Caretaker Relay care domain model.
 *
 * Design rule: do not blindly rename Otzar nouns (Project → Patient).
 * Caregiver vocabulary is layered above Foundation substrate primitives.
 *
 * Evidence modes (must be explicit — never present fixture as production):
 * - LIVE_FOUNDATION_BACKED
 * - SYNTHETIC_FOUNDATION_BACKED
 * - FIXTURE
 * - DEMO_ONLY
 */

import {
  AUDIT_PRODUCT_TAG,
  FOUNDATION_ORIGIN_SHA,
  PRODUCT_ID,
} from "@caretaker-relay/product-identity";

export { PRODUCT_ID, FOUNDATION_ORIGIN_SHA, AUDIT_PRODUCT_TAG };

/** How a displayed or persisted state was produced. */
export type EvidenceMode =
  | "LIVE_FOUNDATION_BACKED"
  | "SYNTHETIC_FOUNDATION_BACKED"
  | "FIXTURE"
  | "DEMO_ONLY";

/** Epistemic status — uncertainty must not be flattened into care truth. */
export type EpistemicStatus =
  | "CONFIRMED"
  | "REPORTED"
  | "INFERRED"
  | "UNCERTAIN"
  | "CONFLICTED"
  | "SUPERSEDED";

export type SafetyClass = "low" | "moderate" | "high";

export type SourceKind =
  | "caregiver_speech"
  | "caregiver_text"
  | "professional_note"
  | "provider_instruction"
  | "system_derived"
  | "document"
  | "device"
  | "correction";

export interface SourceRef {
  id: string;
  kind: SourceKind;
  label: string;
  actorName?: string;
  actorPersonId?: string;
  recordedAt: string;
  /** Human-readable “Why am I seeing this?” */
  whyVisible: string;
  rawExcerpt?: string;
}

/** Confirmed condition — not the same as a transient observation. */
export interface CareCondition {
  id: string;
  label: string;
  status: "active" | "resolved" | "unknown";
  verification: "CONFIRMED" | "REPORTED" | "UNCERTAIN";
  sourceLabel?: string;
  recordedAt?: string;
  notes?: string;
}

/** Person-first care recipient profile (human model; not an EHR dump). */
export interface CareRecipientProfile {
  dateOfBirth?: string; // ISO date YYYY-MM-DD when known
  pronouns?: string;
  primaryLanguage?: string;
  communicationNeeds?: string[];
  confirmedConditions?: CareCondition[];
  healthConcerns?: string[]; // not diagnoses
  allergies?: Array<{ label: string; severity?: string; sourceLabel?: string }>;
  primaryProviderName?: string;
  otherProviders?: string[];
  mobilityBaseline?: string;
  assistiveDevices?: string[];
  cognitiveSupportNeeds?: string[];
  dietMealConsiderations?: string[];
  dailyRoutineSummary?: string;
  carePreferences?: string[];
  likesDislikes?: string[];
  safetyConsiderations?: string[];
  emergencyContacts?: Array<{
    name: string;
    relationship?: string;
    phone?: string;
  }>;
  careGoals?: string[];
  supportNeeds?: string[];
  transportationNotes?: string;
  careLocationSummary?: string;
  profileVerifiedAt?: string;
  profileSourceSummary?: string;
}

/**
 * Server-authoritative data classification for AI policy.
 * Never trust a client flag — only seed, ops, or secure admin may set this.
 */
export type CareDataClassification =
  | "synthetic"
  | "live_phi"
  | "unknown";

export interface CareRecipient {
  id: string;
  displayName: string;
  preferredName?: string;
  householdId: string;
  /**
   * Server-owned classification for AI mode selection.
   * synthetic → Grok-assisted interpretation permitted without PHI BAA.
   * live_phi → fixture only until Mode C (BAA+PHI) is proven.
   */
  dataClassification?: CareDataClassification;
  /** Person intelligence — optional; never invent when absent. */
  profile?: CareRecipientProfile;
}

export type CareRelationshipRole =
  | "spouse"
  | "parent"
  | "adult_child"
  | "sibling"
  | "friend"
  | "neighbor"
  | "paid_caregiver"
  | "direct_support_professional"
  | "nurse"
  | "physician"
  | "therapist"
  | "care_coordinator"
  | "agency"
  | "home_health_organization"
  | "family_caregiver"
  | "other";

export interface AccessScope {
  informationCategories: string[];
  allowedActions: string[];
  canEscalate: boolean;
  authorityLimits: string[];
}

export interface CareRelationship {
  id: string;
  careRecipientId: string;
  personId: string;
  role: CareRelationshipRole;
  roleLabel: string;
  responsibilities: string[];
  access: AccessScope;
  startDate?: string;
  endDate?: string;
  contactPreference?: string;
  scheduleNotes?: string;
  status: "active" | "revoked" | "expired";
  /** Optional organization (agency/clinic) for multi-org isolation at scale. */
  organizationId?: string;
  organizationName?: string;
}

export interface Person {
  id: string;
  displayName: string;
  kind: "family_caregiver" | "professional" | "provider" | "service" | "care_recipient";
}

export interface CareCircleMember {
  id: string;
  displayName: string;
  personId: string;
  relationship: CareRelationship;
  nextInvolvement?: string;
  lastUpdate?: string;
}

export interface CareCircle {
  careRecipientId: string;
  members: CareCircleMember[];
}

export interface CarePlan {
  id: string;
  careRecipientId: string;
  title: string;
  summary: string;
  updatedAt: string;
  source?: SourceRef;
}

export interface CareTask {
  id: string;
  careRecipientId: string;
  title: string;
  dueAt?: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
  assigneePersonId?: string;
  safetyClass: SafetyClass;
  epistemicStatus: EpistemicStatus;
  source?: SourceRef;
}

export type CareEventType =
  | "meal"
  | "observation"
  | "appointment_change"
  | "medication_administration"
  | "communication_request"
  | "task"
  | "note"
  | "correction"
  | "handoff"
  | "access_change"
  | "consent_change"
  | "shift_observation"
  | "clinical_note"
  | "schedule_change"
  | "reminder"
  | "incident";

/** Schedule / action lifecycle (internal engine). */
export type ScheduleLifecycleState =
  | "proposed"
  | "requested"
  | "tentative"
  | "confirmed"
  | "cancelled"
  | "rescheduled"
  | "completed"
  | "missed";

export type CareTruthState =
  | "reported"
  | "confirmed"
  | "disputed"
  | "corrected"
  | "cancelled"
  | "superseded";

export type CareAuthorityBasis =
  | "membership"
  | "assignment"
  | "invitation"
  | "consent"
  | "provisional_draft"
  | "system"
  | "self";

export type CareConfidenceLabel =
  | "confirmed"
  | "reported"
  | "inferred"
  | "unknown";

/**
 * Canonical durable care event.
 * Optional ETL fields are backward-compatible; older rows omit them.
 * Server store + Prisma CareEventRow.source Json carries full provenance.
 */
export interface CareEvent {
  id: string;
  careRecipientId: string;
  householdId: string;
  type: CareEventType;
  title: string;
  statement: string;
  /** @deprecated prefer eventAt — retained for existing rows */
  occurredAt: string;
  notes?: string;
  epistemicStatus: EpistemicStatus;
  safetyClass: SafetyClass;
  source: SourceRef;
  confidence?: number;
  intendedRecipientPersonId?: string;
  supersededById?: string;
  evidenceMode: EvidenceMode;
  /** When the care fact happened (or is scheduled). Defaults to occurredAt. */
  eventAt?: string;
  /** When it was reported into Relay. Defaults to source.recordedAt. */
  reportAt?: string;
  /** Server ingest wall time. */
  ingestedAt?: string;
  timezone?: string;
  actorPrincipalId?: string;
  actorActiveRole?: string;
  authorityBasis?: CareAuthorityBasis;
  dataDomain?: string;
  purpose?: string;
  sensitivity?: SafetyClass;
  truthState?: CareTruthState;
  confidenceLabel?: CareConfidenceLabel;
  dedupeKey?: string;
  conflictGroupId?: string;
  conflictWithIds?: string[];
  correctionTargetId?: string;
  scheduleState?: ScheduleLifecycleState;
  approvalState?: "none" | "pending" | "approved" | "rejected";
  executionState?: "none" | "pending" | "executed" | "failed" | "skipped";
  correlationId?: string;
  structured?: Record<string, unknown>;
}

export interface Observation {
  id: string;
  careRecipientId: string;
  summary: string;
  observedAt: string;
  tags?: string[];
  epistemicStatus: EpistemicStatus;
  source: SourceRef;
}

export interface Appointment {
  id: string;
  careRecipientId: string;
  title: string;
  startsAt: string;
  startsAtLabel?: string;
  endsAt?: string;
  location?: string;
  /** Legacy UI status; scheduleState is the authoritative lifecycle. */
  status: "scheduled" | "moved" | "completed" | "cancelled";
  scheduleState?: ScheduleLifecycleState;
  epistemicStatus: EpistemicStatus;
  source?: SourceRef;
  previousStartsAtLabel?: string;
  changeSource?: string;
  /** Prior appointment id when rescheduled. */
  rescheduledFromId?: string;
  timezone?: string;
  assigneePersonId?: string;
  coveragePersonId?: string;
  recurrenceRule?: string;
}

export interface MedicationSchedule {
  id: string;
  careRecipientId: string;
  name: string;
  dose: string;
  scheduleLabel: string;
  authorizedBy: string;
  authorizedAt: string;
  source: SourceRef;
  /** Optional structured professional fields when the source provides them. */
  strength?: string;
  route?: string;
  scheduleTime?: string;
  windowStart?: string;
  windowEnd?: string;
  mealRelation?: string;
  specialInstructions?: string;
  nextDueLabel?: string;
  lastAdministeredAt?: string;
  lastAdministeredBy?: string;
  lastAdministeredByName?: string;
}

export interface MedicationDiscrepancy {
  recordedDose: string;
  authorizedDose: string;
  authorizedSourceLabel: string;
  message: string;
}

export interface MedicationAdministrationRecord {
  id: string;
  careRecipientId: string;
  scheduleId?: string;
  name: string;
  doseRecorded: string;
  administeredAt: string;
  administeredByPersonId: string;
  status: "recorded" | "needs_review" | "voided" | "rejected_pending_verify";
  discrepancy?: MedicationDiscrepancy;
  epistemicStatus: EpistemicStatus;
  source: SourceRef;
}

export interface CareInstruction {
  id: string;
  careRecipientId: string;
  text: string;
  category: string;
  source: SourceRef;
  status: "current" | "superseded" | "stale";
}

export interface CareHandoff {
  id: string;
  careRecipientId: string;
  fromPersonId?: string;
  toPersonId?: string;
  whatChanged: string[];
  stillNeedsAttention: string[];
  watch: string[];
  sources: SourceRef[];
  createdAt: string;
  evidenceMode: EvidenceMode;
}

export interface CareUpdate {
  id: string;
  careRecipientId: string;
  toPersonId: string;
  summary: string;
  status: "draft" | "ready" | "sent" | "blocked_pending_verify";
  safetyClass: SafetyClass;
  source: SourceRef;
}

/**
 * Invitation lifecycle for care-space membership.
 * Durable via CareUpdate rows with structured summary (INVITE_V1:…).
 */
export type CareInvitationStatus =
  | "pending"
  | "accepted"
  | "revoked"
  | "expired"
  | "consumed";

export interface CareInvitation {
  id: string;
  careRecipientId: string;
  token: string;
  inviterPersonId: string;
  inviteePersonId: string;
  inviteeDisplayName: string;
  inviteeEmail?: string;
  role: CareRelationshipRole;
  roleLabel: string;
  status: CareInvitationStatus;
  createdAt: string;
  expiresAt?: string;
  acceptedAt?: string;
}

/** Human coordination note (not AI Relay). */
export interface CareCoordinationMessage {
  id: string;
  careRecipientId: string;
  fromPersonId: string;
  fromDisplayName: string;
  toPersonId?: string;
  body: string;
  createdAt: string;
  kind: "coordination";
}

export interface ConsentRecord {
  id: string;
  careRecipientId: string;
  granteePersonId: string;
  scope: AccessScope;
  status: "active" | "revoked" | "expired";
  grantedAt: string;
  revokedAt?: string;
}

export interface CareOrganization {
  id: string;
  name: string;
  kind: "household" | "agency" | "home_health" | "clinic" | "other";
}

export interface CareSummary {
  id: string;
  careRecipientId: string;
  periodLabel: string;
  body: string;
  source: SourceRef;
}

export interface Correction {
  id: string;
  careRecipientId: string;
  targetEventId: string;
  previousValue: string;
  correctedValue: string;
  correctedByPersonId: string;
  correctedAt: string;
  preservedEvidenceIds: string[];
  source: SourceRef;
}

export interface SafetyReview {
  id: string;
  careRecipientId: string;
  safetyClass: SafetyClass;
  reason: string;
  status: "open" | "confirmed" | "rejected";
  createdAt: string;
  targetIds: string[];
}

/** Structured candidate from Understand — never authoritative until confirmed. */
export interface CareCandidate {
  id: string;
  eventType: CareEventType;
  statement: string;
  careRecipientId: string;
  careRecipientName: string;
  sourceSpeakerPersonId?: string;
  sourceSpeakerName?: string;
  timeLabel?: string;
  dateLabel?: string;
  /** Server-authoritative when the report was captured. */
  recordedAt?: string;
  /** When the care event is understood to have occurred (defaults to recordedAt). */
  effectiveAt?: string;
  timePrecision?: "exact" | "day" | "approximate" | "unknown";
  confidence: number;
  epistemicStatus: EpistemicStatus;
  consequentiality: SafetyClass;
  intendedRecipientPersonId?: string;
  intendedRecipientName?: string;
  recordedDose?: string;
  sourceReference: SourceRef;
  /** Model must not execute; this is a candidate only. */
  actionable: false;
}

export interface UnderstoodCareSlice {
  candidates: CareCandidate[];
  /** Legacy flat fields retained for UI compatibility; derived from candidates. */
  meals: string[];
  observations: string[];
  appointmentChanges: string[];
  medicationEvents: string[];
  communicationRequests: string[];
  tasks: string[];
  uncertainties: string[];
  rawText: string;
  careRecipientId: string;
  careRecipientName: string;
  evidenceMode: EvidenceMode;
  modelProvider?: string;
  modelName?: string;
}

export interface VerificationItem {
  id: string;
  candidateId: string;
  label: string;
  detail?: string;
  safetyClass: SafetyClass;
  epistemicStatus: EpistemicStatus;
  requiresConfirmation: boolean;
  discrepancy?: MedicationDiscrepancy;
}

export interface VerificationBundle {
  title: string;
  items: VerificationItem[];
  understood: UnderstoodCareSlice;
  evidenceMode: EvidenceMode;
}

export interface AuditEntry {
  id: string;
  at: string;
  actorPersonId: string;
  action: string;
  careRecipientId?: string;
  householdId?: string;
  details: Record<string, unknown>;
  productId: typeof PRODUCT_ID;
}

export interface CarePreferences {
  personId: string;
  summaryLength: "short" | "medium" | "long";
  reminderTimingMinutes: number;
  language: string;
  accessibility: string[];
  handoffFormat: "bullet" | "paragraph";
  communicationPreference: "text" | "voice" | "both";
  reviewable: true;
  editable: true;
  removable: true;
  provenance: SourceRef;
}

export interface CurrentCareState {
  careRecipientId: string;
  householdId: string;
  events: CareEvent[];
  observations: Observation[];
  appointments: Appointment[];
  tasks: CareTask[];
  medicationRecords: MedicationAdministrationRecord[];
  medicationSchedules: MedicationSchedule[];
  handoffs: CareHandoff[];
  openSafetyReviews: SafetyReview[];
  lastUpdatedAt: string;
}

export interface AuthCareContext {
  actorPersonId: string;
  actorDisplayName: string;
  careRecipientId: string;
  householdId: string;
  sessionId: string;
  roles: string[];
}

export interface CareLoopResult {
  kind: "refusal" | "verify" | "persisted" | "access_denied";
  message?: string;
  bundle?: VerificationBundle;
  persisted?: {
    eventIds: string[];
    handoffId?: string;
    updateIds: string[];
    medicationRecordIds: string[];
    safetyReviewIds: string[];
    careNoteId?: string;
    careNoteBody?: string;
  };
  /** Structured receipt — user-visible copy must derive from this when present. */
  executionReceipt?: import("./services/execution-receipt.js").ExecutionReceipt;
  currentState?: CurrentCareState;
  evidenceMode: EvidenceMode;
  auditIds: string[];
}

/** Burden instrumentation — lab measurement only unless marked validated. */
export interface BurdenMetrics {
  stepsToRecordUpdate: number;
  timeToRecordUpdateMs?: number;
  repeatedEntryCount: number;
  timeToProduceHandoffMs?: number;
  manualMessagesAvoided: number;
  appContextSwitches: number;
  timeToFindCurrentInstructionMs?: number;
  correctionEffortSteps: number;
  tasksOrganizedAutomatically: number;
  classification: "FOUNDER_HYPOTHESIS" | "LAB_MEASUREMENT" | "CAREGIVER_VALIDATED";
}

/** FHIR interoperability boundary mapping (not internal UI model). */
export const FHIR_CONCEPT_MAP = {
  CareRecipient: "Patient",
  Person: "RelatedPerson | Practitioner | Person",
  CareCircleMember: "RelatedPerson | Practitioner",
  CareCircle: "CareTeam",
  CarePlan: "CarePlan",
  CareTask: "Task",
  CareEvent: "Observation | Event",
  Observation: "Observation",
  Appointment: "Appointment",
  MedicationSchedule: "MedicationRequest",
  MedicationAdministrationRecord: "MedicationAdministration",
  CareUpdate: "Communication",
  ConsentRecord: "Consent",
  CareInstruction: "DocumentReference | CarePlan.activity",
  SourceRef: "Provenance",
  CareSummary: "DocumentReference",
  Correction: "Provenance (correction target)",
} as const;

/** Maps care domain concepts → Foundation substrate primitives (internal only). */
export const FOUNDATION_PRIMITIVE_MAP = {
  CareRecipient: "Entity (class: care_subject) + household scope",
  Person: "Entity",
  CareRelationship: "Permission + ConsentGrant + membership",
  CareEvent: "MemoryCapsule / evidence snapshot",
  Observation: "MemoryCapsule (observation kind)",
  CareTask: "Action / obligation primitive (care-mapped)",
  CareHandoff: "Handoff primitive (care-mapped)",
  MedicationSchedule: "Care instruction + provenance evidence",
  MedicationAdministrationRecord: "Governed action + audit",
  ConsentRecord: "ConsentGrant",
  AccessScope: "Permission / TAR / decision rights",
  SourceRef: "AuditEvent + provenance chain",
  Correction: "Correction memory + preserved evidence",
  SafetyReview: "High-sensitivity / governed action gate",
  AuditEntry: "AuditEvent (product_id=caretaker-relay)",
  UnderstandLLM: "LLMProvider circuit-breaker abstraction",
} as const;
