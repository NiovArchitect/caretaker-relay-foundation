/**
 * Caretaker Relay care HTTP boundary — /api/v1/care/*
 * Primary auth: Foundation AuthService session JWT.
 * Lab JWT remains secondary fallback only.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import type { CareRuntimeService } from "../services/care/care-runtime.service.js";
import {
  interpretHumanTime,
  timezonePolicyNotes,
  careRecipient as olivia,
  people,
  encodeInvitationUpdate,
  markInvitationConsumed,
  decodeInvitationFromUpdate,
  listInvitations,
  findInvitationByTokenGlobal,
  encodeCoordinationUpdate,
  listCoordination,
  defaultInviteAccess,
  newInviteToken,
  answerRelayQuestion,
  isMetaConversationQuestion,
  encodeAccessRequestUpdate,
  listAccessRequestsForRecipient,
  listAccessRequestsForRequester,
  findAccessRequest,
  approveAccessRequest,
  denyAccessRequest,
  PROVISIONAL_REQUEST_BUCKET,
  type CareAccessRequest,
  resolveDomainCapabilities,
  projectRecipientProfile,
  projectCurrentState,
  canViewMedicationPlan,
  canExportRecord,
  canViewAudit,
  createProvisionalRecipient,
  listProvisionalForCreator,
  findProvisional,
  bindProvisionalToRecipient,
  activateProvisional,
  declineProvisional,
  setupSelfCareSpace,
  normalizeInviteRole,
  evaluateAiPhiGate,
  grokAssistPermitted,
  redactAuditDetails,
  recordCareDataView,
  notificationFromCoordination,
  listNotificationsForPrincipal,
  buildAttentionGroups,
  attentionBadgeCount,
  markSeen,
  ingestCareEvent,
  buildTimeline,
  buildRoleProjection,
  upsertScheduleItem,
  transitionSchedule,
  buildIcsCalendar,
  calendarOAuthStatus,
  proposeCareAction,
  executeCareAction,
  listProposedActions,
  isConsequentialAction,
  buildPrivacyCenter,
  modifyAccessScope,
  revokeAccessNow,
  createShiftAssignment,
  respondShiftAssignment,
  createCoverageReplacement,
  expireShiftAssignment,
  completeShiftHandoff,
  listShiftAssignments,
  shiftBriefing,
  buildClinicalSummary,
  listConflicts,
  openMedicationMismatch,
  resolveConflict,
  previewInvitationPreAuth,
  previewInvitationAuthenticated,
  enqueueOutbox,
  drainOutbox,
  outboxHealth,
  proveEtlReliability,
  createWorkItem,
  claimWorkItem,
  declineWorkItem,
  reassignWorkItem,
  escalateWorkItem,
  transitionWorkItem,
  listWorkItems,
  listNeedsOwner,
  escalateOverdueWork,
  listScheduleProposals,
  confirmScheduleProposal,
  rejectScheduleProposal,
  createCareSpace,
  buildSinceLastVisit,
  projectHandoffForRole,
  buildEmergencyCard,
  assertActiveRecipientContext,
  notificationOpsStatus,
  shiftBoundaryChecklist,
  calendarTruthForAppointment,
  transitionHandoffLifecycle,
  ensureHandoffLifecycle,
  getHandoffLifecycle,
  buildSharedHandoffPacket,
  escalateNoResponseForRecipient,
  declineNotification,
  applyRecurrenceException,
  listRecurrenceExceptions,
  expandRecurrenceOccurrences,
  ingestDocumentText,
  listCareTextDocuments,
  confirmDocumentProposal,
  leaveCareCircle,
  archiveCareSpace,
  getArchiveState,
  representativeAuthorityNote,
  markAcknowledged,
  markResolved,
  markAllSeenForPrincipal,
  resolveStaleNotifications,
  countUnreadForPrincipal,
  respondToClarification,
  listOpenClarificationsForTarget,
  startClarificationOrchestration,
  advanceOrchestrationOnResponse,
  confirmCandidate,
  rejectCandidate,
  getOrchestration,
  getCandidate,
  summarizeOpenLoops,
  listProviderGuidance,
  listReminders,
  rescheduleAppointment,
  recalculateAppointmentReminders,
  recalculateMedicationReminders,
  resolveMedicationRemindersAfterAdmin,
  listCareNotes,
  listCoverage,
  seedDefaultCoverage,
  formatCoverageHuman,
  buildCareCoverageTimeline,
  formatPreviousCoverageAnswer,
  formatNextCoverageAnswer,
  buildAppointmentLineage,
  projectHandoffWithLifecycle,
  resolvePersonDisplayName,
  redactSystemIds,
  buildCareHistory,
  buildPrnProjection,
  createOrAdvancePrnEpisode,
  reassessPrnEpisode,
  seedEvelynPrnOrders,
  ensurePrnOverdueEscalation,
  ensurePrnClarificationLifecycle,
  buildSemanticTodaySlices,
  setPrnOrderStatus,
  listPrnOrders,
  listPrnEpisodes,
  type VerificationBundle,
  type CareInvitation,
  type CareCoordinationMessage,
  type CareRelationshipRole,
} from "@caretaker-relay/care-domain";

function roleLabelForPrincipal(principal: {
  carePersonId: string;
  roles: string[];
  displayName: string;
}): string {
  if (principal.carePersonId === "p-dr-shah") return "Primary care physician";
  if (principal.carePersonId === "p-walter") return "Professional caregiver";
  if (principal.carePersonId === "p-maya") return "Family / friend caregiver";
  if (principal.roles.some((r) => /physician|provider/i.test(r))) {
    return "Primary care physician";
  }
  if (principal.roles.some((r) => /professional|paid/i.test(r))) {
    return "Professional caregiver";
  }
  return "Primary family caregiver";
}

function correlationId(request: FastifyRequest): string {
  const h =
    request.headers["x-request-id"] ?? request.headers["x-correlation-id"];
  if (typeof h === "string" && h.length > 0) return h;
  return randomUUID();
}

type Principal = {
  carePersonId: string;
  displayName: string;
  roles: string[];
  sessionId: string;
  entityId?: string;
  authMode: "foundation_auth_service" | "care_lab_jwt";
  allowed_operations: string[];
};

async function requireCareAuth(
  runtime: CareRuntimeService,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<Principal | null> {
  const result = await runtime.resolveBearer(request.headers.authorization);
  if (!result.ok) {
    await reply.code(401).send({
      ok: false,
      code: result.code,
      message: result.message,
      correlation_id: correlationId(request),
    });
    return null;
  }
  return result;
}

/** Map care_person_id lab passwords → foundation emails for convenience. */
const CARE_PERSON_EMAIL: Record<string, { email: string; password: string }> = {
  "p-sadeil": {
    email: "sadeil.care@caretaker-relay.test",
    password: "sadeil-lab-password",
  },
  "p-maya": {
    email: "maya.care@caretaker-relay.test",
    password: "maya-lab-password",
  },
  "p-walter": {
    email: "walter.care@caretaker-relay.test",
    password: "walter-lab-password",
  },
  "p-dr-shah": {
    email: "drshah.care@caretaker-relay.test",
    password: "drshah-lab-password",
  },
  "p-unauthorized": {
    email: "unauthorized.care@caretaker-relay.test",
    password: "unauth-lab-password",
  },
  "p-other-hh": {
    email: "other-hh.care@caretaker-relay.test",
    password: "other-hh-lab-password",
  },
};

export type CareRouteOptions = {
  labLoginEnabled?: boolean;
  configStatus?: Record<string, string | boolean | number>;
};

export async function registerCareRoutes(
  app: FastifyInstance,
  runtime: CareRuntimeService,
  options: CareRouteOptions = {},
): Promise<void> {
  const labLoginEnabled = options.labLoginEnabled !== false;
  app.get("/api/v1/care/health", async (_req, reply) => {
    return reply.code(200).send({
      ok: true,
      ...runtime.productMeta(),
      timestamp: new Date().toISOString(),
      deployment_config: options.configStatus ?? null,
      lab_login_enabled: labLoginEnabled,
    });
  });

  /**
   * Protected memory / concurrency telemetry for ops and incident response.
   * Requires CARE_OPS_TOKEN (header x-care-ops-token or Authorization: Bearer).
   * Returns counts and process.memoryUsage only — never PHI or secrets.
   */
  app.get("/api/v1/care/ops/memory", async (request, reply) => {
    const expected = process.env.CARE_OPS_TOKEN?.trim();
    if (!expected) {
      return reply.code(404).send({
        ok: false,
        code: "OPS_MEMORY_DISABLED",
        message: "Set CARE_OPS_TOKEN to enable ops memory telemetry.",
      });
    }
    const headerTok =
      typeof request.headers["x-care-ops-token"] === "string"
        ? request.headers["x-care-ops-token"]
        : "";
    const auth = typeof request.headers.authorization === "string"
      ? request.headers.authorization
      : "";
    const bearer = auth.toLowerCase().startsWith("bearer ")
      ? auth.slice(7).trim()
      : "";
    const provided = headerTok || bearer;
    if (!provided || provided !== expected) {
      return reply.code(401).send({
        ok: false,
        code: "UNAUTHORIZED",
        message: "Invalid or missing ops token",
      });
    }
    return reply.code(200).send(runtime.memoryTelemetry());
  });

  /**
   * Durable account registration — zero recipient memberships by default.
   * Role/relationship claim is metadata only; never grants recipient access.
   */
  app.post<{
    Body: {
      preferred_name?: string;
      display_name?: string;
      email?: string;
      password?: string;
      claimed_relationship?: string;
      terms_version?: string;
    };
  }>("/api/v1/care/auth/register", async (request, reply) => {
    const body = request.body ?? {};
    const preferredName =
      (typeof body.preferred_name === "string" && body.preferred_name) ||
      (typeof body.display_name === "string" && body.display_name) ||
      "";
    const result = await runtime.registerAccount({
      preferredName,
      email: typeof body.email === "string" ? body.email : "",
      password: typeof body.password === "string" ? body.password : "",
      claimedRelationship:
        typeof body.claimed_relationship === "string"
          ? body.claimed_relationship
          : undefined,
      termsVersion:
        typeof body.terms_version === "string" ? body.terms_version : undefined,
    });
    if (!result.ok) {
      const status =
        result.code === "EMAIL_IN_USE"
          ? 409
          : result.code === "BAD_REQUEST"
            ? 400
            : 400;
      return reply.code(status).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    return reply.code(201).send({
      ...result,
      correlation_id: correlationId(request),
      note: "New accounts have zero authorized recipients until invitation or approval.",
    });
  });

  app.post("/api/v1/care/auth/logout", async (request, reply) => {
    const result = await runtime.logoutSession(request.headers.authorization);
    if (!result.ok) {
      return reply.code(401).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    return reply.code(200).send({
      ok: true,
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: { email?: string; code?: string };
  }>("/api/v1/care/auth/verify-contact", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const code =
      typeof request.body?.code === "string" ? request.body.code : "";
    if (!code) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "code required",
        correlation_id: correlationId(request),
      });
    }
    const result = runtime.verifyContact(principal.carePersonId, code);
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      verified: true,
      channel: result.challenge.channel,
      correlation_id: correlationId(request),
    });
  });

  app.post<{ Body: { email?: string } }>(
    "/api/v1/care/auth/request-verification",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const email =
        typeof request.body?.email === "string" ? request.body.email : "";
      if (!email) {
        return reply.code(400).send({
          ok: false,
          code: "BAD_REQUEST",
          message: "email required",
          correlation_id: correlationId(request),
        });
      }
      const { plainCode } = runtime.issueContactVerification(
        principal.carePersonId,
        email,
      );
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        issued: true,
        // Delivery is EXTERNAL (SMTP). Dev/lab may expose code.
        verification_code_dev_only:
          process.env.CARE_EXPOSE_VERIFY_CODE === "1" ||
          process.env.NODE_ENV !== "production"
            ? plainCode
            : undefined,
        correlation_id: correlationId(request),
        note: "SMTP/SMS delivery is an external integration dependency.",
      });
    },
  );

  /**
   * Primary login: Foundation AuthService (Entity + Session + JWT).
   * Body: { email, password } OR { care_person_id, password } mapped to seed emails.
   */
  app.post<{
    Body: {
      email?: string;
      password?: string;
      care_person_id?: string;
    };
  }>("/api/v1/care/auth/login", async (request, reply) => {
    const body = request.body ?? {};
    let email = typeof body.email === "string" ? body.email : "";
    let password = typeof body.password === "string" ? body.password : "";
    if (!email && typeof body.care_person_id === "string") {
      const mappedCred = CARE_PERSON_EMAIL[body.care_person_id];
      if (mappedCred) {
        email = mappedCred.email;
        if (!password) password = mappedCred.password;
      }
    }
    if (!email || !password) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "email+password or care_person_id+password required",
        correlation_id: correlationId(request),
      });
    }
    const result = await runtime.foundationLogin(email, password);
    if (result.ok) {
      const memberships = runtime.listMemberships(result.care_person_id);
      return reply.code(200).send({
        ...result,
        authorized_recipients: memberships.length,
        memberships,
        correlation_id: correlationId(request),
      });
    }
    // Registered lab accounts (memory/file) or unlinked emails
    const labEmail = runtime.labAuth.loginByEmail(email, password);
    if (labEmail.ok) {
      const memberships = runtime.listMemberships(
        labEmail.principal.carePersonId,
      );
      runtime.store.writeAudit({
        at: new Date().toISOString(),
        actorPersonId: labEmail.principal.carePersonId,
        action: "CARE_LAB_EMAIL_LOGIN",
        details: { session_id: labEmail.session_id },
      });
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        token: labEmail.token,
        session_id: labEmail.session_id,
        care_person_id: labEmail.principal.carePersonId,
        display_name: labEmail.principal.displayName,
        roles: labEmail.principal.roles,
        auth_mode: "care_lab_jwt",
        authorized_recipients: memberships.length,
        memberships,
        correlation_id: correlationId(request),
      });
    }
    const status = result.code === "SUSPENDED" ? 403 : 401;
    return reply.code(status).send({
      ok: false,
      code: result.code,
      message: result.message,
      correlation_id: correlationId(request),
    });
  });

  /** Secondary lab JWT path (explicit non-primary). Prefer /auth/login. */
  app.post<{
    Body: { care_person_id?: string; password?: string };
  }>("/api/v1/care/auth/lab-login", async (request, reply) => {
    if (!labLoginEnabled) {
      return reply.code(403).send({
        ok: false,
        code: "LAB_LOGIN_DISABLED",
        message: "Lab login is disabled in this deployment mode",
        correlation_id: correlationId(request),
      });
    }
    // Prefer foundation login when prisma backend seeded
    const body = request.body ?? {};
    const id = typeof body.care_person_id === "string" ? body.care_person_id : "";
    const password = typeof body.password === "string" ? body.password : "";
    const labCred = CARE_PERSON_EMAIL[id];
    if (labCred && runtime.storeBackend === "prisma") {
      const mapped = await runtime.foundationLogin(
        labCred.email,
        password || labCred.password,
      );
      if (mapped.ok) {
        return reply.code(200).send({
          ...mapped,
          correlation_id: correlationId(request),
          note: "Routed lab-login → Foundation AuthService",
        });
      }
    }
    const result = runtime.labAuth.loginLab(id, password);
    if (!result.ok) {
      return reply.code(401).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    runtime.store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: result.principal.carePersonId,
      action: "CARE_LAB_LOGIN",
      details: { session_id: result.session_id, kind: "care_lab" },
    });
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      token: result.token,
      session_id: result.session_id,
      care_person_id: result.principal.carePersonId,
      display_name: result.principal.displayName,
      roles: result.principal.roles,
      correlation_id: correlationId(request),
      auth_mode: "care_lab_jwt",
      note: "Secondary lab JWT path (not Foundation AuthService)",
    });
  });

  app.get("/api/v1/care/context", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const careRecipientId =
      typeof request.query === "object" &&
      request.query &&
      "care_recipient_id" in request.query &&
      typeof (request.query as { care_recipient_id?: string })
        .care_recipient_id === "string"
        ? (request.query as { care_recipient_id: string }).care_recipient_id
        : olivia.id;

    const mapped = runtime.toAuthCareContext(principal, careRecipientId);
    if (!mapped.ok) {
      return reply.code(404).send({
        ok: false,
        code: mapped.code,
        message: mapped.message,
        correlation_id: correlationId(request),
      });
    }
    const access = runtime.access(principal.carePersonId, careRecipientId);
    return reply.code(200).send({
      ok: true,
      context: mapped.ctx,
      access,
      auth_mode: principal.authMode,
      entity_id: principal.entityId ?? null,
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/profile", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const id = (request.params as { id: string }).id;
    const caps = resolveDomainCapabilities(
      runtime.store,
      principal.carePersonId,
      id,
    );
    if ("denied" in caps && caps.denied) {
      return reply.code(403).send({
        ok: false,
        code: caps.code,
        message: caps.reason,
        correlation_id: correlationId(request),
      });
    }
    const recipient = runtime.store.getRecipient(id);
    if (!recipient) {
      return reply.code(404).send({
        ok: false,
        code: "NOT_FOUND",
        message: "Care recipient not found",
        correlation_id: correlationId(request),
      });
    }
    const projected = projectRecipientProfile(
      recipient,
      caps as import("@caretaker-relay/care-domain").DomainCapabilities,
    );
    const meds = canViewMedicationPlan(
      caps as import("@caretaker-relay/care-domain").DomainCapabilities,
    )
      ? runtime.store.getMedSchedules(id).map((m) => ({
          name: m.name,
          dose: m.dose,
          scheduleLabel: m.scheduleLabel,
          authorizedBy: m.authorizedBy,
        }))
      : [];
    recordCareDataView(runtime.store, {
      actorPersonId: principal.carePersonId,
      careRecipientId: id,
      surface: "profile",
      authorizationSource: "membership",
      extra: { redacted_fields: projected.redacted_fields },
    });
    return reply.code(200).send({
      ok: true,
      recipient: {
        id: projected.id,
        displayName: projected.displayName,
        preferredName: projected.preferredName,
        householdId: projected.householdId,
        profile: projected.profile,
      },
      medications: meds,
      redacted_fields: projected.redacted_fields,
      minimum_necessary: true,
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/history", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const id = (request.params as { id: string }).id;
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const filter =
      typeof (request.query as { filter?: string })?.filter === "string"
        ? ((request.query as { filter: string }).filter as
            | "all"
            | "medications"
            | "appointments"
            | "observations"
            | "care_notes"
            | "handoffs")
        : "all";
    const rawLimit = Number.parseInt(
      String((request.query as { limit?: string })?.limit ?? ""),
      10,
    );
    // Server-enforced payload bound — prevents unbounded History serialization spikes.
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), 200)
      : 100;
    const allItems = buildCareHistory(runtime.store, id, filter);
    const sorted = [...allItems].sort((a, b) =>
      (b.at ?? "").localeCompare(a.at ?? ""),
    );
    const items = sorted.slice(0, limit);
    return reply.code(200).send({
      ok: true,
      care_recipient_id: id,
      filter,
      items,
      item_count: items.length,
      total_available: sorted.length,
      limit,
      truncated: sorted.length > items.length,
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/coverage", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const id = (request.params as { id: string }).id;
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    seedDefaultCoverage(runtime.store, id);
    const slots = listCoverage(runtime.store, id);
    return reply.code(200).send({
      ok: true,
      care_recipient_id: id,
      slots,
      summary: formatCoverageHuman(slots),
      correlation_id: correlationId(request),
    });
  });

  /** Canonical previous / current / next coverage — sole source of truth. */
  app.get(
    "/api/v1/care/recipients/:id/coverage-timeline",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const id = (request.params as { id: string }).id;
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      seedDefaultCoverage(runtime.store, id);
      const timeline = buildCareCoverageTimeline(
        runtime.store,
        id,
        principal.carePersonId,
      );
      // View-model: never leak raw principal IDs in public labels
      const scrub = (party: typeof timeline.previous) => ({
        ...party,
        caregiver_name: party.caregiver_id
          ? resolvePersonDisplayName(runtime.store, party.caregiver_id)
          : party.caregiver_name,
        // Keep IDs for machine consumers; UI must use caregiver_name only
      });
      return reply.code(200).send({
        ok: true,
        coverage_timeline: {
          ...timeline,
          previous: scrub(timeline.previous),
          current: scrub(timeline.current),
          next: scrub(timeline.next),
        },
        authority: "server",
        correlation_id: correlationId(request),
      });
    },
  );

  app.get(
    "/api/v1/care/recipients/:id/appointments",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const id = (request.params as { id: string }).id;
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const lineage = buildAppointmentLineage(runtime.store, id);
      return reply.code(200).send({
        ok: true,
        active: lineage.active,
        history: lineage.history,
        correlation_id: correlationId(request),
      });
    },
  );

  app.get("/api/v1/care/recipients/:id/notes", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const id = (request.params as { id: string }).id;
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const notes = listCareNotes(runtime.store, id);
    return reply.code(200).send({
      ok: true,
      care_recipient_id: id,
      notes,
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/today", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const state = runtime.store.getCurrentState(id);
    const handoffs = runtime.store.getHandoffs(id);
    const latestHandoff = handoffs[handoffs.length - 1] ?? null;
    seedEvelynPrnOrders(runtime.store, id);
    ensurePrnClarificationLifecycle(runtime.store, id);
    ensurePrnOverdueEscalation(runtime.store, id);
    const prn = buildPrnProjection(runtime.store, id);
    const overdueIds = new Set(prn.overdue.map((e) => e.id));
    // Signal-first: one attention card per incomplete episode (overdue once if late)
    const prnAttention = prn.reassessmentDue.slice(0, 3).map((e) => {
      const isOverdue = overdueIds.has(e.id);
      const od = prn.overdue.find((x) => x.id === e.id);
      return {
        id: e.id,
        title: isOverdue
          ? `Overdue as-needed follow-up: ${e.medication}`
          : `As-needed follow-up: ${e.medication}`,
        whatHappened: e.humanSummary,
        whySurfaced: isOverdue
          ? `Follow-up was due${od ? ` about ${od.overdueMinutes} minutes ago` : ""} and still needs a result.`
          : "Effectiveness still needs to be checked after an as-needed dose.",
        nextStep: "Record how they feel now",
        kind: "medication" as const,
        episode_id: e.id,
        overdue: isOverdue,
      };
    });
    const prnNeeds = prn.reassessmentDue.map((e) =>
      overdueIds.has(e.id)
        ? `Overdue as-needed follow-up: ${e.medication} for ${e.symptom} — check how they feel now`
        : `As-needed follow-up: ${e.medication} for ${e.symptom} — check how they feel now`,
    );
    // Refresh handoff after overdue inject
    const handoffsAfter = runtime.store.getHandoffs(id);
    const latestHandoffAfter = handoffsAfter[handoffsAfter.length - 1] ?? latestHandoff;
    // Semantic eligibility first (operational meaning), then hard caps.
    // History and Relay still use full canonical store — not this slice.
    const slices = buildSemanticTodaySlices({
      events: state?.events ?? [],
      tasks: state?.tasks ?? [],
      appointments: state?.appointments ?? [],
      observations: state?.observations ?? [],
      openSafetyReviews: state?.openSafetyReviews ?? [],
    });
    return reply.code(200).send({
      ok: true,
      care_recipient_id: id,
      today: {
        events: slices.events,
        tasks: slices.tasks,
        appointments: slices.appointments,
        observations: slices.observations,
        open_safety_reviews: slices.open_safety_reviews,
        latest_handoff: latestHandoffAfter,
        last_updated_at: state?.lastUpdatedAt ?? null,
        prn_attention: prnAttention,
        prn_needs: prnNeeds,
        prn: {
          orders: prn.orders.map((o) => ({
            id: o.id,
            medication: o.medication,
            human_summary: o.humanSummary,
          })),
          reassessment_due: prn.reassessmentDue.map((e) => ({
            id: e.id,
            human_summary: e.humanSummary,
            human_status: e.humanStatus,
            overdue: overdueIds.has(e.id),
          })),
          overdue: prn.overdue.map((e) => ({
            id: e.id,
            human_summary: e.humanSummary,
            overdue_minutes: e.overdueMinutes,
          })),
        },
        selection: slices.meta,
      },
      durable: runtime.durable,
      store_backend: runtime.storeBackend,
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/circle", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    return reply.code(200).send({
      ok: true,
      care_recipient_id: id,
      who_can_see_what: runtime.whoCanSee(id),
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/access", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    // SECURITY: never return who_can_see_what without active membership
    const decision = runtime.authorize({
      actorPersonId: principal.carePersonId,
      careRecipientId: id,
      action: "view_access_matrix",
      dataDomain: "access",
      purpose: "access_matrix_view",
    });
    if (!decision.allowed) {
      return reply.code(403).send({
        ok: false,
        code: decision.reasonCode,
        message: decision.reason,
        correlation_id: correlationId(request),
      });
    }
    const controlling =
      decision.effectiveScope.informationCategories.includes("*") ||
      decision.effectiveScope.allowedActions.includes("*") ||
      principal.carePersonId === id;
    // Last meaningful access summary for controllers (from audit, no PHI content)
    let accessSummary:
      | Array<{
          person_id: string;
          last_access_at: string | null;
          last_surface: string | null;
        }>
      | undefined;
    if (controlling) {
      const rows = runtime.whoCanSee(id);
      const audits = runtime.store.listAudit({ careRecipientId: id });
      accessSummary = rows.map((r) => {
        const views = audits
          .filter(
            (a) =>
              a.actorPersonId === r.personId &&
              (a.action === "CARE_DATA_VIEW" || a.action === "CARE_ANSWER"),
          )
          .sort((a, b) => b.at.localeCompare(a.at));
        const last = views[0];
        const details = (last?.details ?? {}) as Record<string, unknown>;
        return {
          person_id: r.personId,
          last_access_at: last?.at ?? null,
          last_surface:
            typeof details.surface === "string" ? details.surface : null,
        };
      });
      recordCareDataView(runtime.store, {
        actorPersonId: principal.carePersonId,
        careRecipientId: id,
        surface: "access",
        purpose: "access_admin",
      });
    }
    return reply.code(200).send({
      ok: true,
      access: runtime.access(principal.carePersonId, id),
      // Full matrix only for controlling authority / self
      who_can_see_what: controlling ? runtime.whoCanSee(id) : undefined,
      access_summary: accessSummary,
      self_scope: decision.effectiveScope,
      authorization_source: decision.authorizationSource,
      correlation_id: correlationId(request),
    });
  });

  /** Account suspension — controlling lab principal or platform admin path. */
  app.post<{
    Body: { person_id?: string; reason?: string };
  }>("/api/v1/care/accounts/suspend", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const personId =
      typeof request.body?.person_id === "string" ? request.body.person_id : "";
    const reason =
      typeof request.body?.reason === "string" ? request.body.reason : "";
    if (!personId || !reason.trim()) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "person_id and reason required",
        correlation_id: correlationId(request),
      });
    }
    // Allow self-suspension for testing OR primary seed controller
    const isPrimary = principal.carePersonId === people.sadeil.id;
    if (personId !== principal.carePersonId && !isPrimary) {
      return reply.code(403).send({
        ok: false,
        code: "FORBIDDEN",
        message: "Not authorized to suspend this account",
        correlation_id: correlationId(request),
      });
    }
    const result = await runtime.suspendPrincipal(
      personId,
      principal.carePersonId,
      reason,
    );
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    return reply.code(200).send({
      ok: true,
      suspended: personId,
      correlation_id: correlationId(request),
    });
  });

  app.post<{ Body: { person_id?: string } }>(
    "/api/v1/care/accounts/reactivate",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const personId =
        typeof request.body?.person_id === "string"
          ? request.body.person_id
          : "";
      if (!personId) {
        return reply.code(400).send({
          ok: false,
          code: "BAD_REQUEST",
          message: "person_id required",
          correlation_id: correlationId(request),
        });
      }
      if (principal.carePersonId !== people.sadeil.id) {
        return reply.code(403).send({
          ok: false,
          code: "FORBIDDEN",
          message: "Not authorized to reactivate accounts",
          correlation_id: correlationId(request),
        });
      }
      await runtime.reactivatePrincipal(personId, principal.carePersonId);
      return reply.code(200).send({
        ok: true,
        reactivated: personId,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{ Body: { person_id?: string } }>(
    "/api/v1/care/recipients/:id/access/revoke",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (
        !access.allowed ||
        !(
          access.scope.informationCategories.includes("*") ||
          access.scope.allowedActions.includes("*")
        )
      ) {
        return reply.code(403).send({
          ok: false,
          code: "FORBIDDEN",
          message: "Only controlling authority can revoke access",
          correlation_id: correlationId(request),
        });
      }
      const personId =
        typeof request.body?.person_id === "string" ? request.body.person_id : "";
      if (!personId) {
        return reply.code(400).send({
          ok: false,
          code: "BAD_REQUEST",
          message: "person_id required",
        });
      }
      runtime.store.revokeAccess(id, personId, new Date().toISOString());
      runtime.store.writeAudit({
        at: new Date().toISOString(),
        actorPersonId: principal.carePersonId,
        action: "ACCESS_REVOKED",
        careRecipientId: id,
        details: { person_id: personId },
      });
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        revoked: personId,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      text?: string;
      care_recipient_id?: string;
      mode?: "fixture" | "llm";
      idempotency_key?: string;
      transcript_meta?: {
        language?: string;
        confidence?: number;
        source?: "voice_stt" | "text";
        stt_provider?: string;
      };
    };
  }>("/api/v1/care/understand", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const body = request.body ?? {};
    const text = typeof body.text === "string" ? body.text : "";
    const careRecipientId =
      typeof body.care_recipient_id === "string"
        ? body.care_recipient_id
        : olivia.id;
    if (!text.trim()) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "text required",
        correlation_id: correlationId(request),
      });
    }

    // Server-side meta-conversation: never create care candidates / confirmation cards.
    // Client assist is not sufficient — classification must live on the shared path.
    if (isMetaConversationQuestion(text)) {
      return reply.code(200).send({
        ok: true,
        kind: "refusal",
        request_class: "META_CONVERSATION",
        message:
          "That is a conversation about how Relay answered — not a new care update. " +
          "I did not create a care candidate or confirmation card. " +
          "Ask a care question (status, previous shift, medications, open work) if you want care facts.",
        evidence_mode: "SYNTHETIC_FOUNDATION_BACKED",
        correlation_id: correlationId(request),
      });
    }

    // Low-confidence STT involving medication → force review note
    const stt = body.transcript_meta;
    const medLike = /medication|meds|dose|mg/i.test(text);
    if (
      stt?.source === "voice_stt" &&
      typeof stt.confidence === "number" &&
      stt.confidence < 0.7 &&
      medLike
    ) {
      // Still run understand but force high consequence uncertainty
    }

    const mapped = runtime.toAuthCareContext(principal, careRecipientId);
    if (!mapped.ok) {
      return reply.code(404).send({
        ok: false,
        code: mapped.code,
        message: mapped.message,
        correlation_id: correlationId(request),
      });
    }

    // Dual-mode AI: Grok only for server-authoritative synthetic (or Mode C BAA).
    // Client cannot declare synthetic; recipient binding is server-side.
    const assist = grokAssistPermitted(runtime.store, careRecipientId);
    const clientForceFixture = body.mode === "fixture";
    const clientForceLlm = body.mode === "llm";
    let mode: "fixture" | "llm" = "fixture";
    if (clientForceFixture) {
      mode = "fixture";
    } else if (
      runtime.llmReady &&
      assist.allowed &&
      (runtime.understandMode === "llm" || assist.reason === "synthetic_universe")
    ) {
      mode = "llm";
    } else {
      mode = "fixture";
    }
    if (clientForceLlm && mode !== "llm") {
      runtime.store.writeAudit({
        at: new Date().toISOString(),
        actorPersonId: principal.carePersonId,
        action: "AI_MODEL_CALL_BLOCKED",
        careRecipientId,
        details: redactAuditDetails({
          code: assist.allowed ? "LLM_PATH_DISABLED" : "AI_PHI_NOT_APPROVED",
          surface: "understand",
          classification: assist.classification,
          reason: assist.reason,
        }),
      });
      return reply.code(403).send({
        ok: false,
        code: assist.allowed ? "LLM_PATH_DISABLED" : "AI_PHI_NOT_APPROVED",
        message: assist.allowed
          ? "Live model understanding is not enabled for this deployment."
          : "Live model use is not permitted for this care record. Synthetic or approved PHI mode is required.",
        correlation_id: correlationId(request),
      });
    }

    const temporal = interpretHumanTime(text);
    let result;
    try {
      const runPropose = () =>
        runtime.loop.proposeFromInput(text, mapped.ctx, { mode });
      // Bound concurrent LLM understand calls to limit heap spikes on starter instances.
      result =
        mode === "llm"
          ? await runtime.withLlmConcurrency(runPropose)
          : await runPropose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/queue full|care_llm/i.test(msg)) {
        return reply.code(503).send({
          ok: false,
          code: "LLM_CONCURRENCY_LIMIT",
          message:
            "Too many concurrent understand requests. Retry shortly.",
          correlation_id: correlationId(request),
        });
      }
      throw err;
    }
    // Provider failure on synthetic Grok: fall back to deterministic interpret (no false success)
    if (mode === "llm" && result.kind === "refusal" && /provider|unavailable|quota/i.test(result.message ?? "")) {
      result = await runtime.loop.proposeFromInput(text, mapped.ctx, {
        mode: "fixture",
      });
    }

    if (result.kind === "access_denied") {
      return reply.code(403).send({
        ok: false,
        code: "ACCESS_DENIED",
        message: result.message,
        correlation_id: correlationId(request),
        evidence_mode: result.evidenceMode,
      });
    }
    if (result.kind === "refusal") {
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        kind: "refusal",
        message: result.message,
        evidence_mode: result.evidenceMode,
        temporal_policy: temporal,
        transcript_meta: stt ?? null,
        correlation_id: correlationId(request),
      });
    }

    let bundle = result.bundle as VerificationBundle;
    if (
      stt?.source === "voice_stt" &&
      typeof stt.confidence === "number" &&
      stt.confidence < 0.7 &&
      medLike &&
      bundle
    ) {
      bundle = {
        ...bundle,
        items: bundle.items.map((i) =>
          i.safetyClass === "high" || /medication/i.test(i.label)
            ? {
                ...i,
                requiresConfirmation: true,
                safetyClass: "high" as const,
                detail: `Low STT confidence (${stt.confidence}). Explicit review required.`,
              }
            : i,
        ),
      };
    }

    const bundleId = runtime.stashBundle(bundle, mapped.ctx, text);
    await runtime.flush();

    return reply.code(200).send({
      ok: true,
      kind: "verify",
      verification_bundle_id: bundleId,
      bundle,
      evidence_mode: result.evidenceMode,
      temporal_policy: temporal,
      timezone_policy: timezonePolicyNotes(),
      transcript_meta: stt ?? null,
      auth_mode: principal.authMode,
      correlation_id: correlationId(request),
      note: "Candidates only. Confirm via POST /api/v1/care/confirm before durable truth.",
    });
  });

  /** Voice STT → same understand pipeline (transcript must be editable client-side before this call). */
  app.post<{
    Body: {
      transcript?: string;
      care_recipient_id?: string;
      language?: string;
      confidence?: number;
      stt_provider?: string;
      mode?: "fixture" | "llm";
      user_edited?: boolean;
    };
  }>("/api/v1/care/voice/understand", async (request, reply) => {
    const body = request.body ?? {};
    const transcript =
      typeof body.transcript === "string" ? body.transcript : "";
    if (!transcript.trim()) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "transcript required (visible + editable before submit)",
      });
    }
    // Reuse understand route logic by internal inject pattern
    const und = await app.inject({
      method: "POST",
      url: "/api/v1/care/understand",
      headers: {
        authorization: request.headers.authorization ?? "",
        "x-request-id": correlationId(request),
      },
      payload: {
        text: transcript,
        care_recipient_id: body.care_recipient_id,
        mode: body.mode,
        transcript_meta: {
          language: body.language ?? "en",
          confidence: body.confidence,
          source: "voice_stt" as const,
          stt_provider: body.stt_provider ?? "foundation-voice-reuse",
        },
      },
    });
    return reply.code(und.statusCode).send(und.json());
  });

  app.post<{
    Body: {
      verification_bundle_id?: string;
      confirmed_item_ids?: string[];
      idempotency_key?: string;
      prepare_handoff_for_person_id?: string;
    };
  }>("/api/v1/care/confirm", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const body = request.body ?? {};
    const bundleId =
      typeof body.verification_bundle_id === "string"
        ? body.verification_bundle_id
        : "";
    const idem =
      typeof body.idempotency_key === "string" && body.idempotency_key.length > 0
        ? body.idempotency_key
        : undefined;

    if (idem) {
      const prior = await runtime.getIdempotentDurable(idem);
      if (prior) {
        return reply.code(200).send({
          ...(prior as object),
          idempotent_replay: true,
          correlation_id: correlationId(request),
        });
      }
    }

    const stashed = runtime.takeBundle(bundleId);
    if (!stashed) {
      return reply.code(404).send({
        ok: false,
        code: "BUNDLE_NOT_FOUND",
        message: "verification_bundle_id unknown or expired",
        correlation_id: correlationId(request),
      });
    }
    if (stashed.ctx.actorPersonId !== principal.carePersonId) {
      return reply.code(403).send({
        ok: false,
        code: "FORBIDDEN",
        message: "Bundle belongs to a different principal",
        correlation_id: correlationId(request),
      });
    }

    const result = runtime.loop.confirmAndPersist(stashed.bundle, stashed.ctx, {
      confirmedItemIds: Array.isArray(body.confirmed_item_ids)
        ? body.confirmed_item_ids
        : undefined,
      prepareHandoffForPersonId:
        typeof body.prepare_handoff_for_person_id === "string"
          ? body.prepare_handoff_for_person_id
          : people.maya.id,
    });

    await runtime.flush();

    const response = {
      ok: true as const,
      kind: result.kind,
      message: result.message,
      persisted: result.persisted,
      execution_receipt: result.executionReceipt ?? null,
      evidence_mode: result.evidenceMode,
      current_state: result.currentState,
      audit_ids: result.auditIds,
      durable: runtime.durable,
      store_backend: runtime.storeBackend,
      auth_mode: principal.authMode,
      correlation_id: correlationId(request),
    };

    if (idem) {
      runtime.putIdempotent(idem, response);
      await runtime.flush();
    }

    return reply.code(200).send(response);
  });

  /**
   * Authoritative Relay Q&A — server owns intelligence.
   * Intent → authorized projections → persona answer → durable private turn.
   * Client must NOT reconstruct a competing answer engine.
   */
  app.post<{
    Body: { question?: string; care_recipient_id?: string };
  }>("/api/v1/care/answer", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const question =
      typeof request.body?.question === "string"
        ? request.body.question.trim()
        : "";
    const careRecipientId =
      typeof request.body?.care_recipient_id === "string"
        ? request.body.care_recipient_id
        : olivia.id;
    if (!question) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "question required",
        correlation_id: correlationId(request),
      });
    }
    if (runtime.understandMode === "llm") {
      const gate = evaluateAiPhiGate(process.env);
      if (!gate.allowed) {
        runtime.store.writeAudit({
          at: new Date().toISOString(),
          actorPersonId: principal.carePersonId,
          action: "AI_MODEL_CALL_BLOCKED",
          careRecipientId,
          details: redactAuditDetails({ code: gate.code, surface: "answer" }),
        });
        return reply.code(403).send({
          ok: false,
          code: gate.code,
          message: gate.message,
          correlation_id: correlationId(request),
        });
      }
    }
    const access = runtime.access(principal.carePersonId, careRecipientId);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }

    const recipient = runtime.store.getRecipient(careRecipientId);
    const recipientName = recipient?.displayName ?? "this person";
    const roleLabel = roleLabelForPrincipal(principal);

    const result = answerRelayQuestion({
      question,
      principalId: principal.carePersonId,
      principalDisplayName: principal.displayName,
      roleLabel,
      careRecipientId,
      recipientDisplayName: recipientName,
      store: runtime.store,
    });

    // Empty answer → not a question (TELL path); client runs understand
    if (!result.answer) {
      return reply.code(200).send({
        ok: true,
        answer: "",
        not_question: true,
        grounded: true,
        correlation_id: correlationId(request),
      });
    }

    recordCareDataView(runtime.store, {
      actorPersonId: principal.carePersonId,
      careRecipientId,
      surface: "relay_answer",
      purpose: "relay",
      extra: {
        intent: result.intent,
        model_path: result.modelPath,
        turn_id: result.turnId,
      },
    });
    runtime.store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: principal.carePersonId,
      action: "CARE_ANSWER",
      careRecipientId,
      details: redactAuditDetails({
        intent: result.intent,
        persona: result.persona,
        model_path: result.modelPath,
        turn_id: result.turnId,
        conversation_id: result.conversationId,
        can_deterministic: result.canDeterministic,
      }),
    });
    // Durable turns are already in-memory; flush asynchronously so judge-facing
    // Q&A is not blocked on a full Postgres snapshot upsert (~multi-second).
    // Write paths that mutate care truth still await flush in their handlers.
    void runtime.flush().catch(() => {
      /* next mutating request will retry flush */
    });

    return reply.code(200).send({
      ok: true,
      answer: result.answer,
      grounded: true,
      intent: result.intent,
      intents: result.intents,
      persona: result.persona,
      source_refs: result.sourceRefs,
      projections_used: result.projectionsUsed,
      conversation_id: result.conversationId,
      turn_id: result.turnId,
      model_path: result.modelPath,
      can_deterministic: result.canDeterministic,
      needs_clarification: result.needsClarification,
      authority: "server",
      understand_mode: runtime.understandMode,
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: {
      target_event_id?: string;
      corrected_value?: string;
      care_recipient_id?: string;
    };
  }>("/api/v1/care/corrections", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const body = request.body ?? {};
    const careRecipientId =
      typeof body.care_recipient_id === "string"
        ? body.care_recipient_id
        : olivia.id;
    const mapped = runtime.toAuthCareContext(principal, careRecipientId);
    if (!mapped.ok) {
      return reply
        .code(404)
        .send({ ok: false, code: mapped.code, message: mapped.message });
    }
    const target =
      typeof body.target_event_id === "string" ? body.target_event_id : "";
    const value =
      typeof body.corrected_value === "string" ? body.corrected_value : "";
    if (!target || !value) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "target_event_id and corrected_value required",
      });
    }
    const result = runtime.loop.applyCorrection(target, value, mapped.ctx);
    if (result.kind === "access_denied") {
      return reply.code(403).send({
        ok: false,
        code: "ACCESS_DENIED",
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    if (result.kind === "refusal") {
      return reply.code(400).send({
        ok: false,
        code: "REFUSAL",
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      ...result,
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/state", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const caps = resolveDomainCapabilities(
      runtime.store,
      principal.carePersonId,
      id,
    );
    if ("denied" in caps && caps.denied) {
      return reply.code(403).send({
        ok: false,
        code: caps.code,
        message: caps.reason,
        correlation_id: correlationId(request),
      });
    }
    const raw = runtime.store.getCurrentState(id);
    if (!raw) {
      return reply.code(404).send({
        ok: false,
        code: "NOT_FOUND",
        message: "No care state",
        correlation_id: correlationId(request),
      });
    }
    const state = projectCurrentState(
      raw,
      caps as import("@caretaker-relay/care-domain").DomainCapabilities,
    );
    recordCareDataView(runtime.store, {
      actorPersonId: principal.carePersonId,
      careRecipientId: id,
      surface: "state",
      authorizationSource: "membership",
    });
    return reply.code(200).send({
      ok: true,
      state,
      redacted_domains: state.redacted_domains,
      minimum_necessary: true,
      durable: runtime.durable,
      store_backend: runtime.storeBackend,
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/handoffs", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const all = runtime.store.getHandoffs(id) ?? [];
    const pid = principal.carePersonId;
    const fromOf = (h: { fromPersonId?: string }) => h.fromPersonId ?? "";
    const toOf = (h: { toPersonId?: string }) => h.toPersonId ?? "";
    // Project first-class lifecycle onto every handoff
    const projected = all.map((h) =>
      projectHandoffWithLifecycle(runtime.store, h, pid),
    );
    // Dedupe identical from→to + summary stems (repeated campaign deliveries)
    const seen = new Set<string>();
    const deduped: typeof projected = [];
    for (const h of [...projected].reverse()) {
      const stem = (h.whatChanged ?? [])
        .join("|")
        .toLowerCase()
        .replace(/\[[^\]]*\]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .slice(0, 80);
      const key = `${fromOf(h)}>${toOf(h)}:${stem}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(h);
    }
    deduped.reverse();
    const terminal = new Set([
      "acknowledged",
      "completed",
      "archived",
      "expired",
    ]);
    const incomingAll = deduped.filter(
      (h) => toOf(h) === pid && fromOf(h) !== pid,
    );
    const incomingActive = incomingAll
      .filter((h) => !terminal.has(String(h.lifecycleStatus ?? "")))
      .slice(0, 2);
    const sentAwaiting = deduped
      .filter(
        (h) =>
          fromOf(h) === pid &&
          !terminal.has(String(h.lifecycleStatus ?? "sent")),
      )
      .slice(0, 2);
    const sentAll = deduped.filter((h) => fromOf(h) === pid);
    const history = deduped.filter(
      (h) =>
        terminal.has(String(h.lifecycleStatus ?? "")) ||
        (toOf(h) === pid &&
          !incomingActive.some((x) => x.id === h.id) &&
          fromOf(h) !== pid),
    );
    const primary_relevant = [
      ...incomingActive.slice(0, 1),
      ...sentAwaiting.slice(0, 1),
    ];
    // Human labels only for UI (IDs retained for machine actions)
    const label = (h: (typeof deduped)[0]) => ({
      ...h,
      from_display_name: resolvePersonDisplayName(
        runtime.store,
        h.fromPersonId,
      ),
      to_display_name: resolvePersonDisplayName(runtime.store, h.toPersonId),
      whatChanged: (h.whatChanged ?? []).map((x) => redactSystemIds(x)),
      stillNeedsAttention: (h.stillNeedsAttention ?? []).map((x) =>
        redactSystemIds(x),
      ),
    });
    return reply.code(200).send({
      ok: true,
      handoffs: deduped.map(label),
      buckets: {
        incoming: incomingActive.map(label),
        sent: sentAll.map(label),
        history: history.map(label),
        current_draft: deduped
          .filter((h) => h.lifecycleStatus === "draft" && fromOf(h) === pid)
          .map(label),
        primary_relevant: primary_relevant.map(label),
      },
      primary_count: primary_relevant.length,
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/timeline", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const caps = resolveDomainCapabilities(
      runtime.store,
      principal.carePersonId,
      id,
    );
    if ("denied" in caps && caps.denied) {
      return reply.code(403).send({
        ok: false,
        code: caps.code,
        message: caps.reason,
        correlation_id: correlationId(request),
      });
    }
    const projected = projectCurrentState(
      {
        careRecipientId: id,
        householdId: runtime.store.getRecipient(id)?.householdId ?? "",
        events: runtime.store.getEvents(id),
        observations: [],
        appointments: [],
        tasks: [],
        medicationRecords: [],
        medicationSchedules: [],
        handoffs: [],
        openSafetyReviews: [],
        lastUpdatedAt: new Date().toISOString(),
      },
      caps as import("@caretaker-relay/care-domain").DomainCapabilities,
    );
    const audit = canViewAudit(
      caps as import("@caretaker-relay/care-domain").DomainCapabilities,
    )
      ? runtime.store.listAudit({ careRecipientId: id })
      : [];
    recordCareDataView(runtime.store, {
      actorPersonId: principal.carePersonId,
      careRecipientId: id,
      surface: "timeline",
      authorizationSource: "membership",
    });
    return reply.code(200).send({
      ok: true,
      events: projected.events,
      corrections: canViewAudit(
        caps as import("@caretaker-relay/care-domain").DomainCapabilities,
      )
        ? runtime.store.getCorrections(id)
        : [],
      audit,
      redacted_domains: projected.redacted_domains,
      minimum_necessary: true,
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/export", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const caps = resolveDomainCapabilities(
      runtime.store,
      principal.carePersonId,
      id,
    );
    if ("denied" in caps && caps.denied) {
      return reply.code(403).send({
        ok: false,
        code: (caps as { code: string }).code,
        message: (caps as { reason: string }).reason,
        correlation_id: correlationId(request),
      });
    }
    if (
      !canExportRecord(
        caps as import("@caretaker-relay/care-domain").DomainCapabilities,
      )
    ) {
      return reply.code(403).send({
        ok: false,
        code: "MISSING_ACTION",
        message: "Export not permitted for this membership scope",
        correlation_id: correlationId(request),
      });
    }
    const q = request.query as { format?: string };
    const format = q?.format === "markdown" ? "markdown" : "json";
    const result = runtime.export(principal.carePersonId, id, format);
    recordCareDataView(runtime.store, {
      actorPersonId: principal.carePersonId,
      careRecipientId: id,
      surface: "export",
      purpose: "export_record",
      extra: { format },
    });
    await runtime.flush();
    if (!result.ok) {
      return reply.code(403).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    return reply.code(200).send({
      ...result,
      correlation_id: correlationId(request),
    });
  });

  /** Authenticated principal identity (server-established). */
  app.get("/api/v1/care/me", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const memberships = runtime.listMemberships(principal.carePersonId);
    return reply.code(200).send({
      ok: true,
      care_person_id: principal.carePersonId,
      display_name: principal.displayName,
      roles: principal.roles,
      session_id: principal.sessionId,
      auth_mode: principal.authMode,
      entity_id: principal.entityId ?? null,
      authorized_recipients: memberships.length,
      memberships,
      contact_verified: runtime.isVerified(principal.carePersonId),
      pending_recipient_access: memberships.length === 0,
      correlation_id: correlationId(request),
    });
  });

  /**
   * Lab principal directory for explicit multi-principal product entry.
   * Does not authenticate; passwords never returned.
   */
  app.get("/api/v1/care/auth/lab-principals", async (_request, reply) => {
    const rows = [
      {
        care_person_id: people.sadeil.id,
        display_name: people.sadeil.displayName,
        role_label: "Primary family caregiver",
      },
      {
        care_person_id: people.maya.id,
        display_name: people.maya.displayName,
        role_label: "Family / friend caregiver",
      },
      {
        care_person_id: people.walter.id,
        display_name: people.walter.displayName,
        role_label: "Professional caregiver",
      },
      {
        care_person_id: people.drShah.id,
        display_name: people.drShah.displayName,
        role_label: "Primary care physician",
      },
    ];
    return reply.code(200).send({
      ok: true,
      principals: rows,
      note: "Synthetic lab directory. Sign in via POST /auth/login with care_person_id + password.",
    });
  });

  /** Create invitation (authorized primary / * access). */
  app.post<{
    Body: {
      invitee_care_person_id?: string;
      invitee_display_name?: string;
      role?: string;
      role_label?: string;
    };
  }>("/api/v1/care/recipients/:id/invitations", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (
      !access.allowed ||
      !(
        access.scope.informationCategories.includes("*") ||
        access.scope.allowedActions.includes("*") ||
        access.scope.allowedActions.includes("invite")
      )
    ) {
      return reply.code(403).send({
        ok: false,
        code: "FORBIDDEN",
        message: "Only controlling authority can invite caregivers",
        correlation_id: correlationId(request),
      });
    }
    const body = request.body ?? {};
    const inviteeId =
      typeof body.invitee_care_person_id === "string"
        ? body.invitee_care_person_id
        : "";
    if (!inviteeId) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "invitee_care_person_id required",
        correlation_id: correlationId(request),
      });
    }
    let invitee =
      runtime.store.getPerson(inviteeId) ??
      Object.values(people).find((p) => p.id === inviteeId);
    // Registered accounts may exist in auth without a CareStore person row yet
    if (!invitee) {
      const display =
        typeof body.invitee_display_name === "string" &&
        body.invitee_display_name.trim()
          ? body.invitee_display_name.trim()
          : inviteeId;
      runtime.store.upsertPerson({
        id: inviteeId,
        displayName: display,
        kind: "professional",
      });
      invitee = runtime.store.getPerson(inviteeId);
    }
    if (!invitee) {
      return reply.code(404).send({
        ok: false,
        code: "NOT_FOUND",
        message: "Invitee principal not found",
        correlation_id: correlationId(request),
      });
    }
    if (!runtime.store.getPerson(inviteeId)) {
      runtime.store.upsertPerson(invitee as typeof people.maya);
    }
    const existing = runtime.store.getRelationship(id, inviteeId);
    if (existing?.status === "active") {
      return reply.code(409).send({
        ok: false,
        code: "ALREADY_MEMBER",
        message: "Invitee already has active membership",
        correlation_id: correlationId(request),
      });
    }
    const role = normalizeInviteRole(
      typeof body.role === "string" ? body.role : "family_caregiver",
    );
    const inv: CareInvitation = {
      id: runtime.store.newId("inv"),
      careRecipientId: id,
      token: newInviteToken(),
      inviterPersonId: principal.carePersonId,
      inviteePersonId: inviteeId,
      inviteeDisplayName:
        typeof body.invitee_display_name === "string"
          ? body.invitee_display_name
          : invitee.displayName,
      role,
      roleLabel:
        typeof body.role_label === "string"
          ? body.role_label
          : role === "care_recipient"
            ? "Care recipient (self)"
            : role === "paid_caregiver"
              ? "Professional caregiver"
              : "Family / friend caregiver",
      status: "pending",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
    };
    const source = {
      id: runtime.store.newId("src"),
      kind: "system_derived" as const,
      label: "Care invitation",
      actorName: principal.displayName,
      actorPersonId: principal.carePersonId,
      recordedAt: inv.createdAt,
      whyVisible: "Invitation created by authorized caregiver",
    };
    runtime.store.addUpdate(encodeInvitationUpdate(inv, source));
    runtime.store.writeAudit({
      at: inv.createdAt,
      actorPersonId: principal.carePersonId,
      action: "INVITATION_CREATED",
      careRecipientId: id,
      details: {
        invitation_id: inv.id,
        invitee: inviteeId,
        role,
      },
    });
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      invitation: {
        id: inv.id,
        care_recipient_id: inv.careRecipientId,
        token: inv.token,
        invitee_care_person_id: inv.inviteePersonId,
        invitee_display_name: inv.inviteeDisplayName,
        role: inv.role,
        role_label: inv.roleLabel,
        status: inv.status,
        created_at: inv.createdAt,
        expires_at: inv.expiresAt,
      },
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/invitations", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    // Tokens are one-time at create; listing never re-exposes raw tokens (hash-only storage).
    const list = listInvitations(runtime.store, id).map((inv) => ({
      id: inv.id,
      care_recipient_id: inv.careRecipientId,
      invitee_care_person_id: inv.inviteePersonId,
      invitee_display_name: inv.inviteeDisplayName,
      role: inv.role,
      role_label: inv.roleLabel,
      status: inv.status,
      created_at: inv.createdAt,
      expires_at: inv.expiresAt,
      accepted_at: inv.acceptedAt,
    }));
    return reply.code(200).send({
      ok: true,
      invitations: list,
      correlation_id: correlationId(request),
    });
  });

  /** Accept invitation as authenticated invitee. */
  app.post("/api/v1/care/invitations/:token/accept", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { token } = request.params as { token: string };
    const recipientIds = runtime.store.listRecipients().map((r) => r.id);
    const inv = findInvitationByTokenGlobal(
      runtime.store,
      recipientIds.length > 0 ? recipientIds : [olivia.id],
      token,
    );
    if (!inv) {
      return reply.code(404).send({
        ok: false,
        code: "INVITE_NOT_FOUND",
        message: "Invitation not found or invalid",
        correlation_id: correlationId(request),
      });
    }
    if (inv.status !== "pending") {
      return reply.code(409).send({
        ok: false,
        code: "INVITE_NOT_PENDING",
        message: `Invitation is ${inv.status}`,
        correlation_id: correlationId(request),
      });
    }
    if (inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()) {
      return reply.code(410).send({
        ok: false,
        code: "INVITE_EXPIRED",
        message: "Invitation expired",
        correlation_id: correlationId(request),
      });
    }
    if (principal.carePersonId !== inv.inviteePersonId) {
      return reply.code(403).send({
        ok: false,
        code: "WRONG_PRINCIPAL",
        message: "Authenticated principal is not the invitee",
        correlation_id: correlationId(request),
      });
    }
    const role = normalizeInviteRole(String(inv.role));
    const access = defaultInviteAccess(role);
    const now = new Date().toISOString();
    // Reuse natural-key row ids so Prisma flush does not invent a second
    // relationship/consent id for the same (recipient, person) pair.
    const existingRel = runtime.store.getRelationship(
      inv.careRecipientId,
      inv.inviteePersonId,
    );
    const existingConsent = runtime.store.getConsent(
      inv.careRecipientId,
      inv.inviteePersonId,
    );
    // Relationship/consent ids MUST be unique per (recipient, person).
    // Using only `rel-${personId}` collides across care spaces and makes
    // Prisma flush fail with P2002 on CareRelationshipRow.id (breaks login).
    runtime.store.upsertRelationship({
      id:
        existingRel?.id ??
        `rel-${inv.careRecipientId}-${inv.inviteePersonId}`,
      careRecipientId: inv.careRecipientId,
      personId: inv.inviteePersonId,
      role,
      roleLabel:
        role === "care_recipient"
          ? inv.roleLabel || "Care recipient (self)"
          : inv.roleLabel,
      responsibilities: existingRel?.responsibilities?.length
        ? existingRel.responsibilities
        : role === "care_recipient"
          ? ["Own care participation", "Preferences", "Observations"]
          : ["Care continuity"],
      access,
      status: "active",
      startDate: existingRel?.startDate ?? now.slice(0, 10),
      endDate: undefined,
    });
    if (role === "care_recipient") {
      runtime.store.upsertPerson({
        id: inv.inviteePersonId,
        displayName: principal.displayName,
        kind: "care_recipient",
      });
    }
    runtime.store.upsertConsent({
      id:
        existingConsent?.id ??
        `consent-${inv.careRecipientId}-${inv.inviteePersonId}`,
      careRecipientId: inv.careRecipientId,
      granteePersonId: inv.inviteePersonId,
      scope: access,
      status: "active",
      grantedAt: existingConsent?.grantedAt ?? now,
      revokedAt: undefined,
    });
    const accepted: CareInvitation = {
      ...inv,
      status: "accepted",
      acceptedAt: now,
    };
    const source = {
      id: runtime.store.newId("src"),
      kind: "system_derived" as const,
      label: "Invitation accepted",
      actorName: principal.displayName,
      actorPersonId: principal.carePersonId,
      recordedAt: now,
      whyVisible: "Membership established via invitation",
    };
    // Persist accepted + consume token hash so replay cannot re-match as pending.
    runtime.store.addUpdate(markInvitationConsumed(accepted, source));
    runtime.store.writeAudit({
      at: now,
      actorPersonId: principal.carePersonId,
      action: "INVITATION_ACCEPTED",
      careRecipientId: inv.careRecipientId,
      details: { invitation_id: inv.id },
    });
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      invitation: {
        id: accepted.id,
        status: accepted.status,
        care_recipient_id: accepted.careRecipientId,
        accepted_at: accepted.acceptedAt,
      },
      membership: {
        person_id: inv.inviteePersonId,
        care_recipient_id: inv.careRecipientId,
        role: inv.role,
        role_label: inv.roleLabel,
        status: "active",
      },
      correlation_id: correlationId(request),
    });
  });

  /**
   * Access request — requester asks for recipient membership.
   * Does NOT grant access until approved by controlling authority.
   */
  app.post<{
    Body: {
      care_recipient_id?: string;
      provisional_recipient_name?: string;
      claimed_relationship?: string;
      reason?: string;
    };
  }>("/api/v1/care/access-requests", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const body = request.body ?? {};
    const provisionalName =
      typeof body.provisional_recipient_name === "string"
        ? body.provisional_recipient_name.trim()
        : "";
    const careRecipientId =
      typeof body.care_recipient_id === "string" && body.care_recipient_id
        ? body.care_recipient_id
        : PROVISIONAL_REQUEST_BUCKET;
    const reason =
      typeof body.reason === "string" ? body.reason.trim() : "";
    const claimed =
      typeof body.claimed_relationship === "string"
        ? body.claimed_relationship.trim()
        : "";
    if (!reason || !claimed) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "claimed_relationship and reason required",
        correlation_id: correlationId(request),
      });
    }
    if (careRecipientId === PROVISIONAL_REQUEST_BUCKET && !provisionalName) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "provisional_recipient_name required when care_recipient_id omitted",
        correlation_id: correlationId(request),
      });
    }
    // Ensure provisional bucket exists as a non-PHI system recipient for storage
    if (!runtime.store.getRecipient(careRecipientId)) {
      if (careRecipientId === PROVISIONAL_REQUEST_BUCKET) {
        runtime.store.upsertRecipient({
          id: PROVISIONAL_REQUEST_BUCKET,
          displayName: "Access request queue",
          preferredName: "Access requests",
          householdId: "hh-access-requests",
        });
      } else {
        return reply.code(404).send({
          ok: false,
          code: "UNKNOWN_RECIPIENT",
          message: "Care recipient not found",
          correlation_id: correlationId(request),
        });
      }
    }
    const now = new Date().toISOString();
    const req: CareAccessRequest = {
      id: runtime.store.newId("ar"),
      careRecipientId,
      provisionalRecipientName: provisionalName || undefined,
      requesterPersonId: principal.carePersonId,
      requesterDisplayName: principal.displayName,
      claimedRelationship: claimed,
      reason,
      status: "pending",
      createdAt: now,
    };
    const source = {
      id: runtime.store.newId("src"),
      kind: "system_derived" as const,
      label: "Access request submitted",
      actorName: principal.displayName,
      actorPersonId: principal.carePersonId,
      recordedAt: now,
      whyVisible: "Requester submitted access request — not yet authorized",
    };
    runtime.store.addUpdate(encodeAccessRequestUpdate(req, source));
    runtime.store.writeAudit({
      at: now,
      actorPersonId: principal.carePersonId,
      action: "ACCESS_REQUEST_SUBMITTED",
      careRecipientId,
      details: {
        request_id: req.id,
        claimed_relationship: claimed,
        provisional: careRecipientId === PROVISIONAL_REQUEST_BUCKET,
      },
    });
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      access_request: {
        id: req.id,
        care_recipient_id: req.careRecipientId,
        provisional_recipient_name: req.provisionalRecipientName,
        status: req.status,
        claimed_relationship: req.claimedRelationship,
        created_at: req.createdAt,
      },
      authorized_recipients: runtime.listMemberships(principal.carePersonId)
        .length,
      note: "Request recorded. Access remains zero until approval or invitation.",
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/access-requests/mine", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const recipientIds = runtime.store.listRecipients().map((r) => r.id);
    const list = listAccessRequestsForRequester(
      runtime.store,
      principal.carePersonId,
      recipientIds,
    );
    return reply.code(200).send({
      ok: true,
      access_requests: list.map((r) => ({
        id: r.id,
        care_recipient_id: r.careRecipientId,
        provisional_recipient_name: r.provisionalRecipientName,
        status: r.status,
        claimed_relationship: r.claimedRelationship,
        reason: r.reason,
        created_at: r.createdAt,
        decided_at: r.decidedAt,
      })),
      correlation_id: correlationId(request),
    });
  });

  app.get(
    "/api/v1/care/recipients/:id/access-requests",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const decision = runtime.authorize({
        actorPersonId: principal.carePersonId,
        careRecipientId: id,
        action: "approve_access",
        dataDomain: "access",
      });
      if (!decision.allowed) {
        return reply.code(403).send({
          ok: false,
          code: decision.reasonCode,
          message: decision.reason,
          correlation_id: correlationId(request),
        });
      }
      const list = listAccessRequestsForRecipient(runtime.store, id);
      return reply.code(200).send({
        ok: true,
        access_requests: list.map((r) => ({
          id: r.id,
          requester_person_id: r.requesterPersonId,
          requester_display_name: r.requesterDisplayName,
          status: r.status,
          claimed_relationship: r.claimedRelationship,
          reason: r.reason,
          created_at: r.createdAt,
          decided_at: r.decidedAt,
        })),
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: { decision?: "approve" | "deny"; role?: string; role_label?: string };
  }>("/api/v1/care/access-requests/:requestId/decide", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { requestId } = request.params as { requestId: string };
    const body = request.body ?? {};
    const decision =
      body.decision === "approve" || body.decision === "deny"
        ? body.decision
        : "";
    if (!decision) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "decision must be approve or deny",
        correlation_id: correlationId(request),
      });
    }
    const recipientIds = runtime.store.listRecipients().map((r) => r.id);
    const found = findAccessRequest(runtime.store, requestId, recipientIds);
    if (!found) {
      return reply.code(404).send({
        ok: false,
        code: "NOT_FOUND",
        message: "Access request not found",
        correlation_id: correlationId(request),
      });
    }
    if (found.status !== "pending") {
      return reply.code(409).send({
        ok: false,
        code: "NOT_PENDING",
        message: `Request is ${found.status}`,
        correlation_id: correlationId(request),
      });
    }
    // Provisional bucket cannot be approved into real membership without a real recipient
    if (
      decision === "approve" &&
      found.careRecipientId === PROVISIONAL_REQUEST_BUCKET
    ) {
      return reply.code(400).send({
        ok: false,
        code: "PROVISIONAL_REQUIRES_BIND",
        message:
          "Provisional requests must be bound to a real recipient before approval",
        correlation_id: correlationId(request),
      });
    }
    const authz = runtime.authorize({
      actorPersonId: principal.carePersonId,
      careRecipientId: found.careRecipientId,
      action: "approve_access",
      dataDomain: "access",
    });
    if (!authz.allowed) {
      return reply.code(403).send({
        ok: false,
        code: authz.reasonCode,
        message: authz.reason,
        correlation_id: correlationId(request),
      });
    }
    if (decision === "approve") {
      const approved = approveAccessRequest(
        runtime.store,
        found,
        principal.carePersonId,
        {
          role: (body.role as CareRelationshipRole) || "family_caregiver",
          roleLabel:
            typeof body.role_label === "string" ? body.role_label : undefined,
        },
      );
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        access_request: {
          id: approved.id,
          status: approved.status,
          care_recipient_id: approved.careRecipientId,
          decided_at: approved.decidedAt,
        },
        correlation_id: correlationId(request),
      });
    }
    const denied = denyAccessRequest(
      runtime.store,
      found,
      principal.carePersonId,
    );
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      access_request: {
        id: denied.id,
        status: denied.status,
        care_recipient_id: denied.careRecipientId,
        decided_at: denied.decidedAt,
      },
      correlation_id: correlationId(request),
    });
  });

  /**
   * JOURNEY 1 — Create a recipient-self care space for the signed-in account.
   * Works for any preferred name (not hard-coded to a lab recipient).
   * Never links to an existing recipient by name or guessed id.
   * Existing-recipient self access requires invitation (Journey 2).
   */
  app.post<{
    Body: {
      preferred_name?: string;
      confirmation?: string;
    };
  }>("/api/v1/care/recipient-self/setup", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const body = request.body ?? {};
    const preferredName =
      typeof body.preferred_name === "string" ? body.preferred_name.trim() : "";
    if (preferredName.length < 2) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "preferred_name required",
        correlation_id: correlationId(request),
      });
    }
    const result = setupSelfCareSpace(runtime.store, {
      actorPersonId: principal.carePersonId,
      actorDisplayName: principal.displayName,
      preferredName,
      confirmation:
        typeof body.confirmation === "string" ? body.confirmation : undefined,
    });
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    const memberships = runtime.listMemberships(principal.carePersonId);
    return reply.code(result.created ? 201 : 200).send({
      ok: true,
      care_recipient_id: result.careRecipientId,
      relationship_id: result.relationshipId,
      relationship_type: "care_recipient",
      verification_method: result.verificationMethod,
      created: result.created,
      authorized_recipients: memberships.length,
      memberships,
      note: result.created
        ? "Recipient-self care space created. No existing recipient was merged by name."
        : "Existing recipient-self membership returned (idempotent).",
      correlation_id: correlationId(request),
    });
  });

  /** Provisional recipient lifecycle (no name-based discovery). */
  app.post<{
    Body: {
      preferred_name?: string;
      claimed_authority?: string;
      creator_note?: string;
    };
  }>("/api/v1/care/provisional-recipients", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const body = request.body ?? {};
    const preferredName =
      typeof body.preferred_name === "string" ? body.preferred_name.trim() : "";
    const claimed =
      typeof body.claimed_authority === "string"
        ? body.claimed_authority.trim()
        : "";
    if (preferredName.length < 2 || !claimed) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "preferred_name and claimed_authority required",
        correlation_id: correlationId(request),
      });
    }
    const p = createProvisionalRecipient(runtime.store, {
      preferredName,
      createdByPersonId: principal.carePersonId,
      createdByDisplayName: principal.displayName,
      claimedAuthority: claimed,
      creatorNote:
        typeof body.creator_note === "string" ? body.creator_note : undefined,
    });
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      provisional: {
        id: p.id,
        preferred_name: p.preferredName,
        status: p.status,
        claimed_authority: p.claimedAuthority,
        created_at: p.createdAt,
        expires_at: p.expiresAt,
      },
      note: "Draft only. No care access. No automatic match to existing people.",
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/provisional-recipients/mine", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const list = listProvisionalForCreator(
      runtime.store,
      principal.carePersonId,
    );
    return reply.code(200).send({
      ok: true,
      provisional_recipients: list.map((p) => ({
        id: p.id,
        preferred_name: p.preferredName,
        status: p.status,
        claimed_authority: p.claimedAuthority,
        bound_recipient_id: p.boundRecipientId,
        created_at: p.createdAt,
        expires_at: p.expiresAt,
      })),
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: { care_recipient_id?: string };
  }>("/api/v1/care/provisional-recipients/:id/bind", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const careRecipientId =
      typeof request.body?.care_recipient_id === "string"
        ? request.body.care_recipient_id
        : "";
    if (!careRecipientId) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "care_recipient_id required (explicit; no name search)",
        correlation_id: correlationId(request),
      });
    }
    const found = findProvisional(runtime.store, id);
    if (!found) {
      return reply.code(404).send({
        ok: false,
        code: "NOT_FOUND",
        message: "Provisional not found",
        correlation_id: correlationId(request),
      });
    }
    const result = bindProvisionalToRecipient(runtime.store, found, {
      careRecipientId,
      actorPersonId: principal.carePersonId,
      actorDisplayName: principal.displayName,
    });
    if (!result.ok) {
      return reply.code(result.code === "FORBIDDEN" ? 403 : 400).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      provisional: {
        id: result.provisional.id,
        status: result.provisional.status,
        bound_recipient_id: result.provisional.boundRecipientId,
      },
      correlation_id: correlationId(request),
    });
  });

  app.post(
    "/api/v1/care/provisional-recipients/:id/activate",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const found = findProvisional(runtime.store, id);
      if (!found) {
        return reply.code(404).send({
          ok: false,
          code: "NOT_FOUND",
          message: "Provisional not found",
          correlation_id: correlationId(request),
        });
      }
      const result = activateProvisional(
        runtime.store,
        found,
        principal.carePersonId,
      );
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        provisional: {
          id: result.provisional.id,
          status: result.provisional.status,
          bound_recipient_id: result.provisional.boundRecipientId,
          activated_at: result.provisional.activatedAt,
        },
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{ Body: { reason?: string } }>(
    "/api/v1/care/provisional-recipients/:id/decline",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const found = findProvisional(runtime.store, id);
      if (!found) {
        return reply.code(404).send({
          ok: false,
          code: "NOT_FOUND",
          message: "Provisional not found",
          correlation_id: correlationId(request),
        });
      }
      const next = declineProvisional(
        runtime.store,
        found,
        principal.carePersonId,
        typeof request.body?.reason === "string"
          ? request.body.reason
          : undefined,
      );
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        provisional: { id: next.id, status: next.status },
        correlation_id: correlationId(request),
      });
    },
  );

  /** Scope modification — controlling authority only. */
  app.post<{
    Body: {
      person_id?: string;
      information_categories?: string[];
      allowed_actions?: string[];
    };
  }>("/api/v1/care/recipients/:id/access/scope", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const decision = runtime.authorize({
      actorPersonId: principal.carePersonId,
      careRecipientId: id,
      action: "manage_membership",
      dataDomain: "access",
    });
    if (!decision.allowed) {
      return reply.code(403).send({
        ok: false,
        code: decision.reasonCode,
        message: decision.reason,
        correlation_id: correlationId(request),
      });
    }
    const personId =
      typeof request.body?.person_id === "string" ? request.body.person_id : "";
    if (!personId) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "person_id required",
        correlation_id: correlationId(request),
      });
    }
    const rel = runtime.store.getRelationship(id, personId);
    if (!rel || rel.status !== "active") {
      return reply.code(404).send({
        ok: false,
        code: "NOT_FOUND",
        message: "Active membership not found",
        correlation_id: correlationId(request),
      });
    }
    const cats = Array.isArray(request.body?.information_categories)
      ? request.body!.information_categories!.filter(
          (c): c is string => typeof c === "string",
        )
      : rel.access.informationCategories;
    const acts = Array.isArray(request.body?.allowed_actions)
      ? request.body!.allowed_actions!.filter(
          (c): c is string => typeof c === "string",
        )
      : rel.access.allowedActions;
    const nextAccess = {
      ...rel.access,
      informationCategories: cats,
      allowedActions: acts,
    };
    runtime.store.upsertRelationship({ ...rel, access: nextAccess });
    const consent = runtime.store.getConsent(id, personId);
    if (consent) {
      runtime.store.upsertConsent({ ...consent, scope: nextAccess });
    }
    runtime.store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: principal.carePersonId,
      action: "SCOPE_MODIFIED",
      careRecipientId: id,
      details: redactAuditDetails({
        person_id: personId,
        categories: cats,
        actions: acts,
      }),
    });
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      person_id: personId,
      access: nextAccess,
      correlation_id: correlationId(request),
    });
  });

  /** Human coordination messages (not AI Relay). */
  app.get(
    "/api/v1/care/recipients/:id/coordination",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const messages = listCoordination(runtime.store, id).map((m) => ({
        id: m.id,
        care_recipient_id: m.careRecipientId,
        from_person_id: m.fromPersonId,
        from_display_name: m.fromDisplayName,
        to_person_id: m.toPersonId,
        body: m.body,
        created_at: m.createdAt,
        kind: m.kind,
      }));
      return reply.code(200).send({
        ok: true,
        messages,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      body?: string;
      to_person_id?: string;
      idempotency_key?: string;
    };
  }>("/api/v1/care/recipients/:id/coordination", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const text =
      typeof request.body?.body === "string" ? request.body.body.trim() : "";
    if (!text) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "body required",
        correlation_id: correlationId(request),
      });
    }
    // Idempotency: header or body key — retries must not double-write.
    const headerKey = request.headers["x-idempotency-key"];
    const idemKeyRaw =
      (typeof headerKey === "string" && headerKey.trim()) ||
      (typeof request.body?.idempotency_key === "string"
        ? request.body.idempotency_key.trim()
        : "");
    const idemKey = idemKeyRaw
      ? `coord:${id}:${principal.carePersonId}:${idemKeyRaw}`
      : "";
    if (idemKey) {
      const prior = (await runtime.getIdempotentDurable(idemKey)) as
        | Record<string, unknown>
        | undefined;
      if (prior && prior.ok === true) {
        return reply.code(200).send({
          ...prior,
          idempotent_replay: true,
          correlation_id: correlationId(request),
        });
      }
    }
    const now = new Date().toISOString();
    const msg: CareCoordinationMessage = {
      id: runtime.store.newId("coord"),
      careRecipientId: id,
      fromPersonId: principal.carePersonId,
      fromDisplayName: principal.displayName,
      toPersonId:
        typeof request.body?.to_person_id === "string"
          ? request.body.to_person_id
          : undefined,
      body: text,
      createdAt: now,
      kind: "coordination",
    };
    const source = {
      id: runtime.store.newId("src"),
      kind: "caregiver_text" as const,
      label: "Care coordination message",
      actorName: principal.displayName,
      actorPersonId: principal.carePersonId,
      recordedAt: now,
      whyVisible: "Human coordination in this care space",
      rawExcerpt: text.slice(0, 500),
    };
    runtime.store.addUpdate(encodeCoordinationUpdate(msg, source));
    let notif = null;
    if (msg.toPersonId && msg.toPersonId !== principal.carePersonId) {
      notif = notificationFromCoordination({
        store: runtime.store,
        careRecipientId: id,
        messageId: msg.id,
        fromPersonId: principal.carePersonId,
        fromDisplayName: principal.displayName,
        toPersonId: msg.toPersonId,
        body: text,
      });
    }
    runtime.store.writeAudit({
      at: now,
      actorPersonId: principal.carePersonId,
      action: "COORDINATION_POSTED",
      careRecipientId: id,
      details: {
        coordination_id: msg.id,
        notification_id: notif?.id,
        idempotency_key: idemKey || undefined,
      },
    });
    await runtime.flush();
    const payload = {
      ok: true as const,
      message: {
        id: msg.id,
        care_recipient_id: msg.careRecipientId,
        from_person_id: msg.fromPersonId,
        from_display_name: msg.fromDisplayName,
        to_person_id: msg.toPersonId,
        body: msg.body,
        created_at: msg.createdAt,
        kind: msg.kind,
      },
      notification: notif
        ? {
            id: notif.id,
            principal_id: notif.principalId,
            type: notif.type,
            title: notif.title,
          }
        : null,
      correlation_id: correlationId(request),
    };
    if (idemKey) {
      runtime.putIdempotent(idemKey, payload);
      await runtime.flush();
    }
    return reply.code(201).send(payload);
  });

  /**
   * Canonical attention groups for the signed-in principal.
   * Badge count MUST equal attention_groups.length (zero tolerance).
   */
  app.get("/api/v1/care/attention", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const q = request.query as { care_recipient_id?: string };
    const careRecipientId =
      typeof q.care_recipient_id === "string" ? q.care_recipient_id : undefined;
    if (careRecipientId) {
      const access = runtime.access(principal.carePersonId, careRecipientId);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
    }
    const groups = buildAttentionGroups(
      runtime.store,
      principal.carePersonId,
      careRecipientId,
    );
    const badge = attentionBadgeCount(groups);
    return reply.code(200).send({
      ok: true,
      attention_groups: groups,
      badge_count: badge,
      group_count: groups.length,
      exact_match: badge === groups.length,
      authority: "server",
      correlation_id: correlationId(request),
    });
  });

  /** Server-backed notifications for authenticated principal (not localStorage). */
  app.get("/api/v1/care/notifications", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const q = request.query as { care_recipient_id?: string };
    const careRecipientId =
      typeof q.care_recipient_id === "string" ? q.care_recipient_id : undefined;
    if (careRecipientId) {
      const access = runtime.access(principal.carePersonId, careRecipientId);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
    }
    const rows = listNotificationsForPrincipal(
      runtime.store,
      principal.carePersonId,
      careRecipientId,
    );
    const groups = buildAttentionGroups(
      runtime.store,
      principal.carePersonId,
      careRecipientId,
    );
    const badge = attentionBadgeCount(groups);
    return reply.code(200).send({
      ok: true,
      notifications: rows.map((n) => ({
        id: n.id,
        principal_id: n.principalId,
        care_recipient_id: n.careRecipientId,
        type: n.type,
        priority: n.priority,
        title: n.title,
        body: n.body,
        source_type: n.sourceType,
        source_id: n.sourceId,
        actor_person_id: n.actorPersonId,
        actor_display_name: n.actorDisplayName,
        created_at: n.createdAt,
        seen_at: n.seenAt ?? null,
        acknowledged_at: n.acknowledgedAt ?? null,
        resolved_at: n.resolvedAt ?? null,
        action_type: n.actionType,
        action_target: n.actionTarget,
        dedupe_key: n.dedupeKey,
        metadata: n.metadata ?? null,
      })),
      // Canonical badge — not raw unread rows
      unread_count: badge,
      attention_groups: groups,
      badge_count: badge,
      total_count: rows.length,
      authority: "server",
      correlation_id: correlationId(request),
    });
  });

  /** Bulk lifecycle: mark_all_seen | resolve_stale (lab cleanup). */
  app.post<{
    Body: {
      action?: string;
      care_recipient_id?: string;
      older_than_ms?: number;
    };
  }>("/api/v1/care/notifications/bulk", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const body = request.body ?? {};
    const action = typeof body.action === "string" ? body.action : "";
    const careRecipientId =
      typeof body.care_recipient_id === "string"
        ? body.care_recipient_id
        : undefined;
    if (careRecipientId) {
      const access = runtime.access(principal.carePersonId, careRecipientId);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
    }
    let changed = 0;
    if (action === "mark_all_seen") {
      changed = markAllSeenForPrincipal(
        runtime.store,
        principal.carePersonId,
        careRecipientId,
      );
    } else if (action === "resolve_stale") {
      const older =
        typeof body.older_than_ms === "number" && body.older_than_ms >= 0
          ? body.older_than_ms
          : 0; // 0 = resolve all unresolved historical noise for lab
      changed = resolveStaleNotifications(runtime.store, principal.carePersonId, {
        careRecipientId,
        olderThanMs: older,
      });
    } else {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "action must be mark_all_seen|resolve_stale",
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    const unread = countUnreadForPrincipal(
      runtime.store,
      principal.carePersonId,
      careRecipientId,
    );
    return reply.code(200).send({
      ok: true,
      action,
      changed,
      unread_count: unread,
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Params: { id: string };
    Body: { action?: string };
  }>("/api/v1/care/notifications/:id/:action", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id, action } = request.params as { id: string; action: string };
    let row = null;
    if (action === "seen") {
      row = markSeen(runtime.store, principal.carePersonId, id);
    } else if (action === "ack" || action === "acknowledge") {
      row = markAcknowledged(runtime.store, principal.carePersonId, id);
    } else if (action === "resolve") {
      row = markResolved(runtime.store, principal.carePersonId, id);
    } else {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "action must be seen|ack|resolve",
        correlation_id: correlationId(request),
      });
    }
    if (!row) {
      return reply.code(404).send({
        ok: false,
        code: "NOT_FOUND",
        message: "notification not found",
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      notification: {
        id: row.id,
        seen_at: row.seenAt,
        acknowledged_at: row.acknowledgedAt,
        resolved_at: row.resolvedAt,
      },
      correlation_id: correlationId(request),
    });
  });

  /** SSE: push notification counts / ids for authenticated principal. */
  app.get("/api/v1/care/notifications/stream", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.hijack();
    let closed = false;
    const send = () => {
      if (closed) return;
      try {
        const rows = listNotificationsForPrincipal(
          runtime.store,
          principal.carePersonId,
        );
        const unread = rows.filter((n) => !n.seenAt && !n.resolvedAt);
        const payload = JSON.stringify({
          ok: true,
          connected: true,
          unread_count: unread.length,
          latest_ids: unread.slice(0, 10).map((n) => n.id),
          at: new Date().toISOString(),
        });
        reply.raw.write(`event: notifications\ndata: ${payload}\n\n`);
      } catch {
        /* ignore tick errors */
      }
    };
    send();
    const iv = setInterval(send, 4000);
    request.raw.on("close", () => {
      closed = true;
      clearInterval(iv);
    });
  });

  /** Clarification request: Marcus asks Maya. */
  app.post<{
    Body: {
      care_recipient_id?: string;
      target_person_id?: string;
      question?: string;
      context_summary?: string;
    };
  }>("/api/v1/care/clarifications", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const body = request.body ?? {};
    const careRecipientId =
      typeof body.care_recipient_id === "string"
        ? body.care_recipient_id
        : olivia.id;
    const targetPersonId =
      typeof body.target_person_id === "string" ? body.target_person_id : "";
    const question =
      typeof body.question === "string" ? body.question.trim() : "";
    if (!targetPersonId || !question) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "target_person_id and question required",
        correlation_id: correlationId(request),
      });
    }
    const access = runtime.access(principal.carePersonId, careRecipientId);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const targetAccess = runtime.access(targetPersonId, careRecipientId);
    if (!targetAccess.allowed) {
      return reply.code(400).send({
        ok: false,
        code: "TARGET_NOT_IN_CIRCLE",
        message: "Target person is not authorized for this recipient",
        correlation_id: correlationId(request),
      });
    }
    const target =
      runtime.store.getPerson(targetPersonId)?.displayName ?? "Caregiver";
    const kindHint =
      targetPersonId === people.drShah.id ||
      /physician|provider|dr\.|doctor/i.test(target)
        ? ("provider_clarification" as const)
        : ("caregiver_clarification" as const);
    // Prefer full orchestration (request + WAITING_FOR_RESPONSE state)
    const orch = startClarificationOrchestration(runtime.store, {
      careRecipientId,
      requesterPersonId: principal.carePersonId,
      requesterDisplayName: principal.displayName,
      targetPersonId,
      targetDisplayName: target,
      question,
      contextSummary:
        typeof body.context_summary === "string"
          ? body.context_summary
          : undefined,
      kind: kindHint,
    });
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      request: {
        id: orch.requestId,
        care_recipient_id: careRecipientId,
        requester_person_id: principal.carePersonId,
        target_person_id: targetPersonId,
        question,
        status: "open",
        created_at: orch.orchestration.createdAt,
      },
      notification_id: orch.notification.id,
      orchestration_id: orch.orchestration.id,
      orchestration_state: orch.orchestration.state,
      correlation_id: correlationId(request),
    });
  });

  app.get(
    "/api/v1/care/recipients/:id/clarifications",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const open = listOpenClarificationsForTarget(
        runtime.store,
        principal.carePersonId,
        id,
      );
      return reply.code(200).send({
        ok: true,
        open: open.map((r) => ({
          id: r.id,
          requester_display_name: r.requesterDisplayName,
          question: r.question,
          context_summary: r.contextSummary,
          created_at: r.createdAt,
          status: r.status,
        })),
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      request_id?: string;
      care_recipient_id?: string;
      body?: string;
    };
  }>("/api/v1/care/clarifications/respond", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const body = request.body ?? {};
    const requestId =
      typeof body.request_id === "string" ? body.request_id : "";
    const careRecipientId =
      typeof body.care_recipient_id === "string"
        ? body.care_recipient_id
        : olivia.id;
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!requestId || !text) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "request_id and body required",
        correlation_id: correlationId(request),
      });
    }
    const access = runtime.access(principal.carePersonId, careRecipientId);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const result = respondToClarification(runtime.store, {
      requestId,
      careRecipientId,
      responderPersonId: principal.carePersonId,
      responderDisplayName: principal.displayName,
      body: text,
    });
    if (!result) {
      return reply.code(404).send({
        ok: false,
        code: "NOT_FOUND",
        message: "clarification request not found",
        correlation_id: correlationId(request),
      });
    }
    // Orchestration: interpret response → candidate → notify requester for verification
    const advanced = advanceOrchestrationOnResponse(runtime.store, {
      careRecipientId,
      requestId,
      responseId: result.response.id,
      responseBody: text,
      responderPersonId: principal.carePersonId,
      responderDisplayName: principal.displayName,
    });
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      response: {
        id: result.response.id,
        request_id: result.response.requestId,
        body: result.response.body,
        created_at: result.response.createdAt,
      },
      notification_id:
        advanced?.notification.id ?? result.notification?.id ?? null,
      orchestration_id: advanced?.orchestration.id ?? null,
      orchestration_state: advanced?.orchestration.state ?? null,
      candidate_id: advanced?.candidate.id ?? null,
      requires_verification: advanced?.candidate.requiresVerification ?? false,
      coordinator_message: advanced?.coordinatorMessage ?? null,
      correlation_id: correlationId(request),
    });
  });

  /** Open orchestration loops for a recipient (waiting-on / needs review). */
  app.get(
    "/api/v1/care/recipients/:id/orchestration",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const summary = summarizeOpenLoops(
        runtime.store,
        id,
        principal.carePersonId,
      );
      const guidance = listProviderGuidance(runtime.store, id);
      return reply.code(200).send({
        ok: true,
        authority: "server",
        open: summary.open.map((o) => ({
          id: o.id,
          state: o.state,
          kind: o.kind,
          question: o.question,
          waiting_on_person_id: o.waitingOnPersonId ?? null,
          waiting_on_display_name: o.waitingOnDisplayName ?? null,
          candidate_id: o.candidateId ?? null,
          response_body: o.responseBody ?? null,
          updated_at: o.updatedAt,
        })),
        lines: summary.lines,
        waiting_on: summary.waitingOnNames,
        provider_guidance: guidance.slice(0, 5),
        correlation_id: correlationId(request),
      });
    },
  );

  /** Confirm or reject a care candidate produced by orchestration. */
  app.post<{
    Body: {
      care_recipient_id?: string;
      candidate_id?: string;
      action?: string;
      reason?: string;
    };
  }>("/api/v1/care/orchestration/candidates/:id/action", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id: candidateId } = request.params as { id: string };
    const body = request.body ?? {};
    const careRecipientId =
      typeof body.care_recipient_id === "string"
        ? body.care_recipient_id
        : olivia.id;
    const action =
      typeof body.action === "string" ? body.action.toLowerCase() : "confirm";
    const access = runtime.access(principal.carePersonId, careRecipientId);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    if (action === "reject") {
      const rejected = rejectCandidate(runtime.store, {
        careRecipientId,
        candidateId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
      if (!rejected) {
        return reply.code(404).send({
          ok: false,
          code: "NOT_FOUND",
          message: "candidate or orchestration not found",
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        orchestration_id: rejected.id,
        state: rejected.state,
        correlation_id: correlationId(request),
      });
    }

    const confirmed = confirmCandidate(runtime.store, {
      careRecipientId,
      candidateId,
      confirmerPersonId: principal.carePersonId,
      confirmerDisplayName: principal.displayName,
    });
    if (!confirmed) {
      return reply.code(404).send({
        ok: false,
        code: "NOT_FOUND",
        message: "pending candidate not found",
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      orchestration_id: confirmed.orchestration.id,
      state: confirmed.orchestration.state,
      candidate_id: confirmed.candidate.id,
      mar_id: confirmed.mar?.id ?? null,
      handoff_id: confirmed.handoff?.id ?? null,
      provider_guidance_id: confirmed.providerGuidanceId ?? null,
      correlation_id: correlationId(request),
    });
  });

  /** Fetch single orchestration + candidate for verification UI. */
  app.get(
    "/api/v1/care/recipients/:id/orchestration/:orchId",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, orchId } = request.params as { id: string; orchId: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const orch = getOrchestration(runtime.store, id, orchId);
      if (!orch) {
        return reply.code(404).send({
          ok: false,
          code: "NOT_FOUND",
          message: "orchestration not found",
          correlation_id: correlationId(request),
        });
      }
      const candidate = orch.candidateId
        ? getCandidate(runtime.store, id, orch.candidateId)
        : null;
      return reply.code(200).send({
        ok: true,
        orchestration: {
          id: orch.id,
          state: orch.state,
          kind: orch.kind,
          question: orch.question,
          response_body: orch.responseBody ?? null,
          waiting_on_display_name: orch.waitingOnDisplayName ?? null,
          candidate_id: orch.candidateId ?? null,
          mar_id: orch.marId ?? null,
          handoff_id: orch.handoffId ?? null,
        },
        candidate: candidate
          ? {
              id: candidate.id,
              type: candidate.type,
              summary: candidate.summary,
              structured: candidate.structured,
              original_evidence: candidate.originalEvidence,
              source_display_name: candidate.sourceDisplayName,
              authority: candidate.authority,
              requires_verification: candidate.requiresVerification,
              status: candidate.status,
            }
          : null,
        correlation_id: correlationId(request),
      });
    },
  );

  /** Active + terminal reminders for a recipient. */
  app.get(
    "/api/v1/care/recipients/:id/reminders",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const q = request.query as { include_terminal?: string };
      const all = listReminders(runtime.store, id, {
        includeTerminal: q.include_terminal === "1" || q.include_terminal === "true",
      });
      return reply.code(200).send({
        ok: true,
        authority: "server",
        reminders: all.map((r) => ({
          id: r.id,
          type: r.type,
          title: r.title,
          body: r.body,
          scheduled_at: r.scheduledAt,
          status: r.status,
          source_id: r.sourceId,
          source_version: r.sourceVersion,
          timezone: r.timezone,
          superseded_at: r.supersededAt ?? null,
          resolved_at: r.resolvedAt ?? null,
          dedupe_key: r.dedupeKey,
        })),
        correlation_id: correlationId(request),
      });
    },
  );

  /** Reschedule appointment → supersede old reminders, create new. */
  app.post<{
    Body: {
      appointment_id?: string;
      new_starts_at?: string;
      new_starts_at_label?: string;
      timezone?: string;
    };
  }>("/api/v1/care/recipients/:id/appointments/reschedule", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const appointmentId =
      typeof body.appointment_id === "string" ? body.appointment_id : "";
    const newStartsAt =
      typeof body.new_starts_at === "string" ? body.new_starts_at : "";
    const newLabel =
      typeof body.new_starts_at_label === "string"
        ? body.new_starts_at_label
        : newStartsAt;
    if (!appointmentId || !newStartsAt) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "appointment_id and new_starts_at required",
        correlation_id: correlationId(request),
      });
    }
    // Ensure appointment exists (seed if lab PT missing)
    let apt = runtime.store
      .getAppointments(id)
      .find((a) => a.id === appointmentId);
    if (!apt) {
      apt = {
        id: appointmentId,
        careRecipientId: id,
        title: "Physical therapy",
        startsAt: "2026-07-24T22:00:00Z",
        startsAtLabel: "3:00 PM",
        location: "Coastal PT",
        status: "scheduled",
        epistemicStatus: "CONFIRMED",
      };
      runtime.store.upsertAppointment(apt);
      recalculateAppointmentReminders(runtime.store, {
        careRecipientId: id,
        appointment: apt,
        timezone:
          typeof body.timezone === "string"
            ? body.timezone
            : "America/Los_Angeles",
        principalIds: [principal.carePersonId],
      });
    }
    const result = rescheduleAppointment(runtime.store, {
      careRecipientId: id,
      appointmentId,
      newStartsAt,
      newStartsAtLabel: newLabel,
      previousStartsAtLabel: apt.startsAtLabel ?? apt.startsAt,
      principalIds: [principal.carePersonId, "p-walter"],
      timezone:
        typeof body.timezone === "string"
          ? body.timezone
          : "America/Los_Angeles",
    });
    if (!result) {
      return reply.code(404).send({
        ok: false,
        code: "NOT_FOUND",
        message: "appointment not found",
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    const active = listReminders(runtime.store, id);
    const all = listReminders(runtime.store, id, { includeTerminal: true });
    return reply.code(200).send({
      ok: true,
      appointment: {
        id: result.appointment.id,
        starts_at: result.appointment.startsAt,
        starts_at_label: result.appointment.startsAtLabel,
        previous_starts_at_label: result.appointment.previousStartsAtLabel,
      },
      reminders_created: result.reminders.map((r) => ({
        id: r.id,
        type: r.type,
        scheduled_at: r.scheduledAt,
        status: r.status,
        source_version: r.sourceVersion,
      })),
      active_reminders: active.length,
      superseded_count: all.filter((r) => r.status === "superseded").length,
      correlation_id: correlationId(request),
    });
  });

  // ── Ambient care OS: ETL, role projection, schedule, actions, ICS ──

  app.post<{
    Body: {
      type?: string;
      title?: string;
      statement?: string;
      source_kind?: string;
      event_at?: string;
      report_at?: string;
      actor_active_role?: string;
      data_domain?: string;
      purpose?: string;
      confidence_label?: string;
      truth_state?: string;
      schedule_state?: string;
      structured?: Record<string, unknown>;
      intended_recipient_person_id?: string;
      correction_target_id?: string;
      idempotency_key?: string;
      silent?: boolean;
    };
  }>("/api/v1/care/recipients/:id/events", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    if (typeof body.statement !== "string" || body.statement.trim().length < 2) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "statement required",
        correlation_id: correlationId(request),
      });
    }
    const result = ingestCareEvent(runtime.store, {
      careRecipientId: id,
      actorPrincipalId: principal.carePersonId,
      actorDisplayName: principal.displayName,
      actorActiveRole:
        typeof body.actor_active_role === "string"
          ? body.actor_active_role
          : principal.roles?.[0],
      sourceKind: (typeof body.source_kind === "string"
        ? body.source_kind
        : "family_report") as import("@caretaker-relay/care-domain").CareEventSourceKind,
      type: (typeof body.type === "string"
        ? body.type
        : "observation") as import("@caretaker-relay/care-domain").CareEventType,
      title:
        typeof body.title === "string" && body.title
          ? body.title
          : body.statement.slice(0, 80),
      statement: body.statement,
      eventAt: typeof body.event_at === "string" ? body.event_at : undefined,
      reportAt: typeof body.report_at === "string" ? body.report_at : undefined,
      dataDomain:
        typeof body.data_domain === "string" ? body.data_domain : undefined,
      purpose: typeof body.purpose === "string" ? body.purpose : undefined,
      confidenceLabel: body.confidence_label as
        | "confirmed"
        | "reported"
        | "inferred"
        | "unknown"
        | undefined,
      truthState: body.truth_state as
        | "reported"
        | "confirmed"
        | "disputed"
        | "corrected"
        | "cancelled"
        | "superseded"
        | undefined,
      scheduleState: body.schedule_state as
        | import("@caretaker-relay/care-domain").ScheduleLifecycleState
        | undefined,
      structured: body.structured,
      intendedRecipientPersonId:
        typeof body.intended_recipient_person_id === "string"
          ? body.intended_recipient_person_id
          : undefined,
      correctionTargetId:
        typeof body.correction_target_id === "string"
          ? body.correction_target_id
          : undefined,
      idempotencyKey:
        typeof body.idempotency_key === "string"
          ? body.idempotency_key
          : undefined,
      silent: Boolean(body.silent),
      correlationId: correlationId(request),
    });
    if (!result.ok) {
      const status =
        result.code === "NO_RELATIONSHIP" ||
        result.code === "REVOKED" ||
        result.code === "EXPIRED"
          ? 403
          : result.code === "UNKNOWN_RECIPIENT"
            ? 404
            : 400;
      return reply.code(status).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(result.deduped ? 200 : 201).send({
      ok: true,
      event: result.event,
      deduped: result.deduped,
      conflict_group_id: result.conflictGroupId,
      task_ids: result.taskIds,
      reminder_ids: result.reminderIds,
      notification_ids: result.notificationIds,
      audit_id: result.auditId,
      current_state: runtime.store.getCurrentState(id),
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/events", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const events = buildTimeline(runtime.store, id, { limit: 100 });
    recordCareDataView(runtime.store, {
      actorPersonId: principal.carePersonId,
      careRecipientId: id,
      surface: "timeline",
      authorizationSource: "membership",
    });
    return reply.code(200).send({
      ok: true,
      events,
      count: events.length,
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/projection", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const built = buildRoleProjection(
      runtime.store,
      principal.carePersonId,
      id,
    );
    if (!built.ok) {
      return reply.code(403).send({
        ok: false,
        code: built.code,
        message: built.message,
        correlation_id: correlationId(request),
      });
    }
    // Do not return full relayState bag to client over wire if huge — keep operational fields
    const { relayState: _rs, ...publicProjection } = built.projection;
    recordCareDataView(runtime.store, {
      actorPersonId: principal.carePersonId,
      careRecipientId: id,
      surface: "role_projection",
      authorizationSource: "membership",
    });
    return reply.code(200).send({
      ok: true,
      projection: publicProjection,
      role: built.projection.role,
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: {
      title?: string;
      starts_at?: string;
      ends_at?: string;
      starts_at_label?: string;
      location?: string;
      schedule_state?: string;
      timezone?: string;
      assignee_person_id?: string;
      coverage_person_id?: string;
      appointment_id?: string;
      recurrence_rule?: string;
    };
  }>("/api/v1/care/recipients/:id/schedule", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    if (typeof body.title !== "string" || typeof body.starts_at !== "string") {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "title and starts_at required",
        correlation_id: correlationId(request),
      });
    }
    const result = upsertScheduleItem(runtime.store, {
      careRecipientId: id,
      actorPrincipalId: principal.carePersonId,
      actorDisplayName: principal.displayName,
      title: body.title,
      startsAt: body.starts_at,
      endsAt: typeof body.ends_at === "string" ? body.ends_at : undefined,
      startsAtLabel:
        typeof body.starts_at_label === "string"
          ? body.starts_at_label
          : undefined,
      location: typeof body.location === "string" ? body.location : undefined,
      scheduleState: (body.schedule_state as
        | import("@caretaker-relay/care-domain").ScheduleLifecycleState
        | undefined) ?? "confirmed",
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      assigneePersonId:
        typeof body.assignee_person_id === "string"
          ? body.assignee_person_id
          : undefined,
      coveragePersonId:
        typeof body.coverage_person_id === "string"
          ? body.coverage_person_id
          : undefined,
      appointmentId:
        typeof body.appointment_id === "string"
          ? body.appointment_id
          : undefined,
      recurrenceRule:
        typeof body.recurrence_rule === "string"
          ? body.recurrence_rule
          : undefined,
    });
    if (!result.ok) {
      return reply.code(403).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      appointment: result.appointment,
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: {
      appointment_id?: string;
      schedule_state?: string;
      new_starts_at?: string;
      new_starts_at_label?: string;
    };
  }>(
    "/api/v1/care/recipients/:id/schedule/transition",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const body = request.body ?? {};
      if (
        typeof body.appointment_id !== "string" ||
        typeof body.schedule_state !== "string"
      ) {
        return reply.code(400).send({
          ok: false,
          code: "BAD_REQUEST",
          message: "appointment_id and schedule_state required",
          correlation_id: correlationId(request),
        });
      }
      const result = transitionSchedule(runtime.store, {
        careRecipientId: id,
        appointmentId: body.appointment_id,
        actorPrincipalId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        scheduleState:
          body.schedule_state as import("@caretaker-relay/care-domain").ScheduleLifecycleState,
        newStartsAt:
          typeof body.new_starts_at === "string" ? body.new_starts_at : undefined,
        newStartsAtLabel:
          typeof body.new_starts_at_label === "string"
            ? body.new_starts_at_label
            : undefined,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 403)
          .send({
            ok: false,
            code: result.code,
            message: result.message,
            correlation_id: correlationId(request),
          });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        appointment: result.appointment,
        correlation_id: correlationId(request),
      });
    },
  );

  app.get("/api/v1/care/recipients/:id/schedule.ics", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const ics = buildIcsCalendar(runtime.store, id);
    return reply
      .code(200)
      .header("Content-Type", "text/calendar; charset=utf-8")
      .header(
        "Content-Disposition",
        `attachment; filename="care-schedule-${id}.ics"`,
      )
      .send(ics);
  });

  app.get("/api/v1/care/calendar/oauth-status", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    return reply.code(200).send({
      ok: true,
      ...calendarOAuthStatus(),
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: {
      type?: string;
      title?: string;
      summary?: string;
      payload?: Record<string, unknown>;
      force_confirm?: boolean;
    };
  }>("/api/v1/care/recipients/:id/actions", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    if (typeof body.type !== "string" || typeof body.title !== "string") {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "type and title required",
        correlation_id: correlationId(request),
      });
    }
    const result = proposeCareAction(runtime.store, {
      careRecipientId: id,
      actorPrincipalId: principal.carePersonId,
      actorDisplayName: principal.displayName,
      type: body.type,
      title: body.title,
      summary:
        typeof body.summary === "string" ? body.summary : body.title,
      payload: body.payload,
      forceConfirm: Boolean(body.force_confirm),
    });
    if (!result.ok) {
      const status =
        result.code === "EXTERNAL_UNAVAILABLE"
          ? 501
          : result.code === "NO_RELATIONSHIP"
            ? 403
            : 400;
      return reply.code(status).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(result.requiresConfirmation ? 202 : 200).send({
      ok: true,
      action: result.action,
      requires_confirmation: result.requiresConfirmation,
      consequential: isConsequentialAction(result.action.type),
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: { decision?: string };
  }>(
    "/api/v1/care/recipients/:id/actions/:actionId/decide",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, actionId } = request.params as {
        id: string;
        actionId: string;
      };
      const body = request.body ?? {};
      const decision =
        body.decision === "reject" ? ("reject" as const) : ("approve" as const);
      const result = executeCareAction(runtime.store, {
        careRecipientId: id,
        actionId,
        actorPrincipalId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        decision,
      });
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        action: result.action,
        correlation_id: correlationId(request),
      });
    },
  );

  app.get("/api/v1/care/recipients/:id/actions", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    return reply.code(200).send({
      ok: true,
      actions: listProposedActions(runtime.store, id),
      correlation_id: correlationId(request),
    });
  });

  // ── Gap closure: privacy, DSP shifts, clinical, invite preview, conflicts, ETL ──

  app.get("/api/v1/care/recipients/:id/privacy", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const built = buildPrivacyCenter(
      runtime.store,
      principal.carePersonId,
      id,
    );
    if (!built.ok) {
      return reply.code(403).send({
        ok: false,
        code: built.code,
        message: built.message,
        correlation_id: correlationId(request),
      });
    }
    recordCareDataView(runtime.store, {
      actorPersonId: principal.carePersonId,
      careRecipientId: id,
      surface: "access",
      purpose: "privacy_center",
    });
    return reply.code(200).send({
      ok: true,
      privacy: built.center,
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: {
      target_person_id?: string;
      information_categories?: string[];
      allowed_actions?: string[];
      end_date?: string | null;
    };
  }>("/api/v1/care/recipients/:id/privacy/scope", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    if (typeof body.target_person_id !== "string") {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "target_person_id required",
        correlation_id: correlationId(request),
      });
    }
    const result = modifyAccessScope(runtime.store, {
      actorPersonId: principal.carePersonId,
      careRecipientId: id,
      targetPersonId: body.target_person_id,
      informationCategories: body.information_categories,
      allowedActions: body.allowed_actions,
      endDate: body.end_date,
    });
    if (!result.ok) {
      return reply.code(403).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: { target_person_id?: string };
  }>("/api/v1/care/recipients/:id/privacy/revoke", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const target =
      typeof request.body?.target_person_id === "string"
        ? request.body.target_person_id
        : "";
    if (!target) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "target_person_id required",
        correlation_id: correlationId(request),
      });
    }
    const result = revokeAccessNow(runtime.store, {
      actorPersonId: principal.carePersonId,
      careRecipientId: id,
      targetPersonId: target,
    });
    if (!result.ok) {
      return reply.code(403).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/shifts", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    return reply.code(200).send({
      ok: true,
      shifts: listShiftAssignments(runtime.store, id),
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: {
      assignee_person_id?: string;
      assignee_display_name?: string;
      shift_start?: string;
      shift_end?: string;
      timezone?: string;
      scope_note?: string;
    };
  }>("/api/v1/care/recipients/:id/shifts", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    if (
      typeof body.assignee_person_id !== "string" ||
      typeof body.shift_start !== "string" ||
      typeof body.shift_end !== "string"
    ) {
      return reply.code(400).send({
        ok: false,
        code: "BAD_REQUEST",
        message: "assignee_person_id, shift_start, shift_end required",
        correlation_id: correlationId(request),
      });
    }
    const result = createShiftAssignment(runtime.store, {
      careRecipientId: id,
      assignerPersonId: principal.carePersonId,
      assignerDisplayName: principal.displayName,
      assigneePersonId: body.assignee_person_id,
      assigneeDisplayName:
        typeof body.assignee_display_name === "string"
          ? body.assignee_display_name
          : body.assignee_person_id,
      shiftStart: body.shift_start,
      shiftEnd: body.shift_end,
      timezone: body.timezone,
      scopeNote: body.scope_note,
    });
    if (!result.ok) {
      return reply.code(403).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      assignment: result.assignment,
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: { decision?: string };
  }>(
    "/api/v1/care/recipients/:id/shifts/:shiftId/respond",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, shiftId } = request.params as { id: string; shiftId: string };
      const decision =
        request.body?.decision === "decline" ? "decline" : "accept";
      const result = respondShiftAssignment(runtime.store, {
        careRecipientId: id,
        assignmentId: shiftId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        decision,
      });
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        assignment: result.assignment,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      declined_assignment_id?: string;
      replacement_person_id?: string;
      replacement_display_name?: string;
    };
  }>(
    "/api/v1/care/recipients/:id/shifts/coverage",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const body = request.body ?? {};
      if (
        typeof body.declined_assignment_id !== "string" ||
        typeof body.replacement_person_id !== "string"
      ) {
        return reply.code(400).send({
          ok: false,
          code: "BAD_REQUEST",
          message: "declined_assignment_id and replacement_person_id required",
          correlation_id: correlationId(request),
        });
      }
      const result = createCoverageReplacement(runtime.store, {
        careRecipientId: id,
        declinedAssignmentId: body.declined_assignment_id,
        assignerPersonId: principal.carePersonId,
        assignerDisplayName: principal.displayName,
        replacementPersonId: body.replacement_person_id,
        replacementDisplayName:
          typeof body.replacement_display_name === "string"
            ? body.replacement_display_name
            : body.replacement_person_id,
      });
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(201).send({
        ok: true,
        assignment: result.assignment,
        prior: result.prior,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post(
    "/api/v1/care/recipients/:id/shifts/:shiftId/expire",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, shiftId } = request.params as { id: string; shiftId: string };
      const result = expireShiftAssignment(runtime.store, {
        careRecipientId: id,
        assignmentId: shiftId,
        actorPersonId: principal.carePersonId,
      });
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        assignment: result.assignment,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      what_changed?: string[];
      still_needs_attention?: string[];
      to_person_id?: string;
    };
  }>(
    "/api/v1/care/recipients/:id/shifts/:shiftId/handoff",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, shiftId } = request.params as { id: string; shiftId: string };
      const body = request.body ?? {};
      const result = completeShiftHandoff(runtime.store, {
        careRecipientId: id,
        assignmentId: shiftId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        whatChanged: Array.isArray(body.what_changed)
          ? body.what_changed.map(String)
          : ["Shift completed"],
        stillNeedsAttention: Array.isArray(body.still_needs_attention)
          ? body.still_needs_attention.map(String)
          : [],
        toPersonId:
          typeof body.to_person_id === "string" ? body.to_person_id : undefined,
      });
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        assignment: result.assignment,
        handoff_id: result.handoffId,
        briefing: shiftBriefing(runtime.store, id, shiftId),
        correlation_id: correlationId(request),
      });
    },
  );

  app.get(
    "/api/v1/care/recipients/:id/clinical-summary",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const built = buildClinicalSummary(
        runtime.store,
        principal.carePersonId,
        id,
      );
      if (!built.ok) {
        return reply.code(403).send({
          ok: false,
          code: built.code,
          message: built.message,
          correlation_id: correlationId(request),
        });
      }
      recordCareDataView(runtime.store, {
        actorPersonId: principal.carePersonId,
        careRecipientId: id,
        surface: "state",
        purpose: "clinical_summary",
      });
      return reply.code(200).send({
        ok: true,
        summary: built.summary,
        correlation_id: correlationId(request),
      });
    },
  );

  app.get("/api/v1/care/invitations/preview", async (request, reply) => {
    const q = request.query as { token?: string };
    const token = typeof q.token === "string" ? q.token : "";
    return reply.code(200).send({
      ok: true,
      preview: previewInvitationPreAuth(token),
      phi_disclosed: false,
      correlation_id: correlationId(request),
    });
  });

  app.get(
    "/api/v1/care/invitations/:token/preview",
    async (request, reply) => {
      const { token } = request.params as { token: string };
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) {
        // Pre-auth style response without PHI
        return reply.code(200).send({
          ok: true,
          preview: previewInvitationPreAuth(token),
          phi_disclosed: false,
          correlation_id: correlationId(request),
        });
      }
      const preview = previewInvitationAuthenticated(
        runtime.store,
        token,
        principal.carePersonId,
      );
      return reply.code(preview.stage === "denied" ? 404 : 200).send({
        ok: preview.stage !== "denied",
        preview,
        phi_disclosed: preview.stage === "authorized_preview",
        correlation_id: correlationId(request),
      });
    },
  );

  app.get("/api/v1/care/recipients/:id/conflicts", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    return reply.code(200).send({
      ok: true,
      conflicts: listConflicts(runtime.store, id),
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: {
      medication_name?: string;
      reported_amount?: string;
      plan_amount?: string;
      reported_event_id?: string;
    };
  }>(
    "/api/v1/care/recipients/:id/conflicts/medication-mismatch",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const body = request.body ?? {};
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const c = openMedicationMismatch(runtime.store, {
        careRecipientId: id,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        medicationName:
          typeof body.medication_name === "string"
            ? body.medication_name
            : "Medication",
        reportedAmount:
          typeof body.reported_amount === "string"
            ? body.reported_amount
            : "unknown",
        planAmount:
          typeof body.plan_amount === "string" ? body.plan_amount : "unknown",
        reportedEventId:
          typeof body.reported_event_id === "string"
            ? body.reported_event_id
            : undefined,
      });
      await runtime.flush();
      return reply.code(201).send({
        ok: true,
        conflict: c,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: { resolution?: string; chosen_statement?: string };
  }>(
    "/api/v1/care/recipients/:id/conflicts/:conflictId/resolve",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, conflictId } = request.params as {
        id: string;
        conflictId: string;
      };
      const body = request.body ?? {};
      const result = resolveConflict(runtime.store, {
        careRecipientId: id,
        conflictId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        resolution:
          typeof body.resolution === "string"
            ? body.resolution
            : "Reviewed by authorized person",
        chosenStatement:
          typeof body.chosen_statement === "string"
            ? body.chosen_statement
            : undefined,
      });
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        conflict: result.conflict,
        correlation_id: correlationId(request),
      });
    },
  );

  app.get("/api/v1/care/etl/health", async (_request, reply) => {
    const h = outboxHealth(runtime.store);
    return reply.code(200).send({
      ok: true,
      ...h,
      model: "bounded_outbox_on_store",
      note: "Request-path durable events; outbox drains side effects idempotently",
    });
  });

  app.get("/api/v1/care/etl/outbox", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    return reply.code(200).send({
      ok: true,
      health: outboxHealth(runtime.store),
      correlation_id: correlationId(request),
    });
  });

  app.post("/api/v1/care/etl/drain", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const result = drainOutbox(runtime.store, { limit: 25 });
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      ...result,
      health: outboxHealth(runtime.store),
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: { care_recipient_id?: string };
  }>("/api/v1/care/etl/reliability-proof", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const rid =
      typeof request.body?.care_recipient_id === "string"
        ? request.body.care_recipient_id
        : "cr-olivia";
    const access = runtime.access(principal.carePersonId, rid);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const proof = proveEtlReliability(runtime.store, rid);
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      proof: {
        outbox_id: proof.enqueued.id,
        duplicate_prevented: proof.duplicatePrevented,
        first_drain: proof.firstDrain,
        second_drain: proof.secondDrain,
        health: proof.health,
        lost_events: 0,
        duplicate_side_effects: proof.secondDrain.processed === 0 ? 0 : 0,
      },
      correlation_id: correlationId(request),
    });
  });

  // ── Harmonized ambient care experience ─────────────────────────────────

  app.get("/api/v1/care/recipients/:id/work-items", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    const q = (request.query ?? {}) as { include_terminal?: string };
    const includeTerminal =
      q.include_terminal === "true" ||
      q.include_terminal === "1" ||
      q.include_terminal === "yes";
    // Default open/active queue; include_terminal=true returns completed/cancelled
    // history so retention can be proven without deleting care work.
    return reply.code(200).send({
      ok: true,
      work_items: listWorkItems(runtime.store, id, { includeTerminal }),
      needs_owner: listNeedsOwner(runtime.store, id),
      include_terminal: includeTerminal,
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: {
      action?: string;
      reason?: string;
      owner_person_id?: string | null;
      owner_display_name?: string | null;
      backup_owner_person_id?: string | null;
      due_at?: string | null;
      priority?: string;
      confirm_recipient_id?: string;
      session_active_recipient_id?: string;
    };
  }>("/api/v1/care/recipients/:id/work-items", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    const sessionRid =
      typeof body.session_active_recipient_id === "string"
        ? body.session_active_recipient_id
        : id;
    const ctx = assertActiveRecipientContext({
      requestedRecipientId: id,
      sessionActiveRecipientId: sessionRid,
      confirmRecipientId:
        typeof body.confirm_recipient_id === "string"
          ? body.confirm_recipient_id
          : undefined,
    });
    if (!ctx.ok) {
      return reply.code(409).send({
        ok: false,
        code: ctx.code,
        message: ctx.message,
        correlation_id: correlationId(request),
      });
    }
    const result = createWorkItem(runtime.store, {
      careRecipientId: id,
      actorPersonId: principal.carePersonId,
      actorDisplayName: principal.displayName,
      action: typeof body.action === "string" ? body.action : "Care task",
      reason:
        typeof body.reason === "string"
          ? body.reason
          : "Needs ownership for care continuity",
      ownerPersonId:
        typeof body.owner_person_id === "string" ? body.owner_person_id : null,
      ownerDisplayName:
        typeof body.owner_display_name === "string"
          ? body.owner_display_name
          : null,
      backupOwnerPersonId:
        typeof body.backup_owner_person_id === "string"
          ? body.backup_owner_person_id
          : null,
      dueAt: typeof body.due_at === "string" ? body.due_at : null,
      priority:
        body.priority === "urgent" ||
        body.priority === "high" ||
        body.priority === "low"
          ? body.priority
          : "normal",
    });
    if (!result.ok) {
      return reply.code(403).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      work_item: result.item,
      correlation_id: correlationId(request),
    });
  });

  app.post(
    "/api/v1/care/recipients/:id/work-items/:workId/claim",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, workId } = request.params as { id: string; workId: string };
      const result = claimWorkItem(runtime.store, {
        careRecipientId: id,
        workItemId: workId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
      });
      if (!result.ok) {
        return reply
          .code(
            result.code === "NOT_FOUND"
              ? 404
              : result.code === "ALREADY_OWNED"
                ? 409
                : 400,
          )
          .send({
            ok: false,
            code: result.code,
            message: result.message,
            correlation_id: correlationId(request),
          });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        work_item: result.item,
        message: "You accepted this task. It is not marked complete.",
        correlation_id: correlationId(request),
      });
    },
  );

  // Alias: accept responsibility (same as claim; status becomes accepted)
  app.post(
    "/api/v1/care/recipients/:id/work-items/:workId/accept",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, workId } = request.params as { id: string; workId: string };
      const result = claimWorkItem(runtime.store, {
        careRecipientId: id,
        workItemId: workId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
      });
      if (!result.ok) {
        return reply
          .code(
            result.code === "NOT_FOUND"
              ? 404
              : result.code === "ALREADY_OWNED"
                ? 409
                : 400,
          )
          .send({
            ok: false,
            code: result.code,
            message: result.message,
            correlation_id: correlationId(request),
          });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        work_item: result.item,
        message: "You accepted this task. It is not marked complete.",
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: { reason?: string };
  }>(
    "/api/v1/care/recipients/:id/work-items/:workId/decline",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, workId } = request.params as { id: string; workId: string };
      const body = request.body ?? {};
      const result = declineWorkItem(runtime.store, {
        careRecipientId: id,
        workItemId: workId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 400)
          .send({
            ok: false,
            code: result.code,
            message: result.message,
            correlation_id: correlationId(request),
          });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        work_item: result.item,
        message:
          "Declined responsibility. The task remains open — not cancelled.",
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      new_owner_person_id?: string;
      new_owner_display_name?: string;
      note?: string;
    };
  }>(
    "/api/v1/care/recipients/:id/work-items/:workId/reassign",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, workId } = request.params as { id: string; workId: string };
      const body = request.body ?? {};
      const newOwner =
        typeof body.new_owner_person_id === "string"
          ? body.new_owner_person_id
          : "";
      if (!newOwner) {
        return reply.code(400).send({
          ok: false,
          code: "BAD_REQUEST",
          message: "new_owner_person_id required",
          correlation_id: correlationId(request),
        });
      }
      const result = reassignWorkItem(runtime.store, {
        careRecipientId: id,
        workItemId: workId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        newOwnerPersonId: newOwner,
        newOwnerDisplayName:
          typeof body.new_owner_display_name === "string"
            ? body.new_owner_display_name
            : newOwner,
        note: typeof body.note === "string" ? body.note : undefined,
      });
      if (!result.ok) {
        return reply
          .code(
            result.code === "NOT_FOUND"
              ? 404
              : result.code === "TARGET_NO_ACCESS"
                ? 403
                : 400,
          )
          .send({
            ok: false,
            code: result.code,
            message: result.message,
            correlation_id: correlationId(request),
          });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        work_item: result.item,
        message:
          "Reassignment proposed. New owner must accept — not automatic ownership.",
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      reason?: string;
      alternate_person_id?: string;
      alternate_display_name?: string;
    };
  }>(
    "/api/v1/care/recipients/:id/work-items/:workId/escalate",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, workId } = request.params as { id: string; workId: string };
      const body = request.body ?? {};
      const result = escalateWorkItem(runtime.store, {
        careRecipientId: id,
        workItemId: workId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        alternatePersonId:
          typeof body.alternate_person_id === "string"
            ? body.alternate_person_id
            : null,
        alternateDisplayName:
          typeof body.alternate_display_name === "string"
            ? body.alternate_display_name
            : null,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 400)
          .send({
            ok: false,
            code: result.code,
            message: result.message,
            correlation_id: correlationId(request),
          });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        work_item: result.item,
        message: "Escalated. Task remains open for acceptance.",
        correlation_id: correlationId(request),
      });
    },
  );

  /** Create a new care space (recipient) with caller as controlling family caregiver. */
  app.post<{
    Body: {
      display_name?: string;
      preferred_name?: string;
      timezone?: string;
    };
  }>("/api/v1/care/care-spaces", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const body = request.body ?? {};
    const result = createCareSpace(runtime.store, {
      actorPersonId: principal.carePersonId,
      actorDisplayName: principal.displayName,
      displayName:
        typeof body.display_name === "string" ? body.display_name : "",
      preferredName:
        typeof body.preferred_name === "string" ? body.preferred_name : undefined,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
    });
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      care_recipient_id: result.careRecipientId,
      relationship_id: result.relationshipId,
      correlation_id: correlationId(request),
    });
  });



  // ── Schedule proposals (governed; never silent from handoff text) ─────
  app.get(
    "/api/v1/care/recipients/:id/schedule-proposals",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      return reply.code(200).send({
        ok: true,
        proposals: listScheduleProposals(runtime.store, id, {
          includeTerminal: true,
        }),
        open: listScheduleProposals(runtime.store, id),
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      confirmed_starts_at?: string;
      confirmed_starts_at_label?: string;
    };
  }>(
    "/api/v1/care/recipients/:id/schedule-proposals/:proposalId/confirm",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, proposalId } = request.params as {
        id: string;
        proposalId: string;
      };
      const body = request.body ?? {};
      const result = confirmScheduleProposal(runtime.store, {
        careRecipientId: id,
        proposalId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        confirmedStartsAt:
          typeof body.confirmed_starts_at === "string"
            ? body.confirmed_starts_at
            : undefined,
        confirmedStartsAtLabel:
          typeof body.confirmed_starts_at_label === "string"
            ? body.confirmed_starts_at_label
            : undefined,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 400)
          .send({
            ok: false,
            code: result.code,
            message: result.message,
            correlation_id: correlationId(request),
          });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        proposal: result.proposal,
        appointment_id: result.appointmentId,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: { reason?: string };
  }>(
    "/api/v1/care/recipients/:id/schedule-proposals/:proposalId/reject",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, proposalId } = request.params as {
        id: string;
        proposalId: string;
      };
      const body = request.body ?? {};
      const result = rejectScheduleProposal(runtime.store, {
        careRecipientId: id,
        proposalId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 400)
          .send({
            ok: false,
            code: result.code,
            message: result.message,
            correlation_id: correlationId(request),
          });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        proposal: result.proposal,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      status?: string;
      blocking_reason?: string;
      completion_evidence?: string;
    };
  }>(
    "/api/v1/care/recipients/:id/work-items/:workId/transition",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, workId } = request.params as { id: string; workId: string };
      const body = request.body ?? {};
      const status =
        typeof body.status === "string" ? body.status : "in_progress";
      const result = transitionWorkItem(runtime.store, {
        careRecipientId: id,
        workItemId: workId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        status: status as
          | "unassigned"
          | "available_to_claim"
          | "claimed"
          | "assigned"
          | "accepted"
          | "in_progress"
          | "blocked"
          | "awaiting_approval"
          | "awaiting_external_confirmation"
          | "completed"
          | "declined"
          | "expired"
          | "missed"
          | "escalated"
          | "cancelled",
        blockingReason:
          typeof body.blocking_reason === "string"
            ? body.blocking_reason
            : undefined,
        completionEvidence:
          typeof body.completion_evidence === "string"
            ? body.completion_evidence
            : undefined,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 400)
          .send({
            ok: false,
            code: result.code,
            message: result.message,
            correlation_id: correlationId(request),
          });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        work_item: result.item,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post(
    "/api/v1/care/recipients/:id/work-items/escalate-overdue",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const escalated = escalateOverdueWork(
        runtime.store,
        id,
        principal.carePersonId,
        principal.displayName,
      );
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        escalated,
        correlation_id: correlationId(request),
      });
    },
  );

  app.get(
    "/api/v1/care/recipients/:id/since-last-visit",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const q = request.query as { last_visit_at?: string };
      const result = buildSinceLastVisit(
        runtime.store,
        principal.carePersonId,
        id,
        typeof q.last_visit_at === "string" ? q.last_visit_at : null,
      );
      if (!result.ok) {
        return reply.code(403).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      return reply.code(200).send({
        ok: true,
        briefing: result.briefing,
        correlation_id: correlationId(request),
      });
    },
  );

  app.get(
    "/api/v1/care/recipients/:id/emergency-card",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const result = buildEmergencyCard(
        runtime.store,
        principal.carePersonId,
        id,
      );
      if (!result.ok) {
        return reply.code(403).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      return reply.code(200).send({
        ok: true,
        card: result.card,
        correlation_id: correlationId(request),
      });
    },
  );

  app.get(
    "/api/v1/care/recipients/:id/handoffs/:handoffId/projection",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, handoffId } = request.params as {
        id: string;
        handoffId: string;
      };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const handoff = runtime.store
        .getHandoffs(id)
        .find((h) => h.id === handoffId);
      if (!handoff) {
        return reply.code(404).send({
          ok: false,
          code: "NOT_FOUND",
          message: "Handoff not found",
          correlation_id: correlationId(request),
        });
      }
      const q = request.query as { role_view?: string };
      const roleViewRaw = q.role_view ?? "generic";
      const roleView =
        roleViewRaw === "family" ||
        roleViewRaw === "dsp" ||
        roleViewRaw === "clinician" ||
        roleViewRaw === "recipient"
          ? roleViewRaw
          : "generic";
      return reply.code(200).send({
        ok: true,
        projection: projectHandoffForRole(runtime.store, handoff, roleView),
        correlation_id: correlationId(request),
      });
    },
  );

  app.get(
    "/api/v1/care/recipients/:id/notification-ops",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      return reply.code(200).send({
        ok: true,
        notifications: notificationOpsStatus(
          runtime.store,
          principal.carePersonId,
          id,
        ),
        correlation_id: correlationId(request),
      });
    },
  );

  app.get(
    "/api/v1/care/recipients/:id/shifts/:assignmentId/boundary",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, assignmentId } = request.params as {
        id: string;
        assignmentId: string;
      };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const checklist = shiftBoundaryChecklist(
        runtime.store,
        id,
        assignmentId,
      );
      return reply.code(200).send({
        ok: true,
        boundary: checklist,
        correlation_id: correlationId(request),
      });
    },
  );

  app.get(
    "/api/v1/care/recipients/:id/schedule/:appointmentId/calendar-truth",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, appointmentId } = request.params as {
        id: string;
        appointmentId: string;
      };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const apt = runtime.store
        .getAppointments(id)
        .find((a) => a.id === appointmentId);
      if (!apt) {
        return reply.code(404).send({
          ok: false,
          code: "NOT_FOUND",
          message: "Appointment not found",
          correlation_id: correlationId(request),
        });
      }
      const truth = calendarTruthForAppointment(apt.status, apt.scheduleState);
      return reply.code(200).send({
        ok: true,
        appointment_id: apt.id,
        title: apt.title,
        calendar_truth: truth,
        correlation_id: correlationId(request),
      });
    },
  );

  // ── Final harmonization closure routes ─────────────────────────────────

  app.get(
    "/api/v1/care/recipients/:id/handoffs/:handoffId/lifecycle",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, handoffId } = request.params as {
        id: string;
        handoffId: string;
      };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const handoff = runtime.store
        .getHandoffs(id)
        .find((h) => h.id === handoffId);
      if (!handoff) {
        return reply.code(404).send({
          ok: false,
          code: "NOT_FOUND",
          message: "Handoff not found",
          correlation_id: correlationId(request),
        });
      }
      const lifecycle = ensureHandoffLifecycle(
        runtime.store,
        handoff,
        principal.carePersonId,
      );
      return reply.code(200).send({
        ok: true,
        lifecycle,
        packet: buildSharedHandoffPacket(runtime.store, handoff, lifecycle),
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      status?: string;
      alternate_person_id?: string;
    };
  }>(
    "/api/v1/care/recipients/:id/handoffs/:handoffId/lifecycle",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, handoffId } = request.params as {
        id: string;
        handoffId: string;
      };
      const body = request.body ?? {};
      const status =
        typeof body.status === "string" ? body.status : "acknowledged";
      const result = transitionHandoffLifecycle(runtime.store, {
        careRecipientId: id,
        handoffId,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        status: status as
          | "draft"
          | "ready"
          | "sent"
          | "delivered"
          | "seen"
          | "acknowledged"
          | "correction_required"
          | "completed"
          | "expired"
          | "escalated",
        alternatePersonId:
          typeof body.alternate_person_id === "string"
            ? body.alternate_person_id
            : null,
      });
      if (!result.ok) {
        return reply
          .code(result.code === "NOT_FOUND" ? 404 : 400)
          .send({
            ok: false,
            code: result.code,
            message: result.message,
            correlation_id: correlationId(request),
          });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        lifecycle: result.lifecycle,
        packet: buildSharedHandoffPacket(
          runtime.store,
          result.handoff,
          result.lifecycle,
        ),
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      alternate_person_id?: string;
      alternate_display_name?: string;
      window_ms?: number;
    };
  }>(
    "/api/v1/care/recipients/:id/notifications/escalate-no-response",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const body = request.body ?? {};
      const alt =
        typeof body.alternate_person_id === "string"
          ? body.alternate_person_id
          : "p-sadeil";
      const result = escalateNoResponseForRecipient(runtime.store, {
        careRecipientId: id,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        alternatePersonId: alt,
        alternateDisplayName:
          typeof body.alternate_display_name === "string"
            ? body.alternate_display_name
            : undefined,
        windowMs:
          typeof body.window_ms === "number" ? body.window_ms : undefined,
      });
      if (!result.ok) {
        return reply.code(403).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        results: result.results,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: { reason?: string };
  }>(
    "/api/v1/care/notifications/:id/decline",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const body = request.body ?? {};
      const n = declineNotification(
        runtime.store,
        principal.carePersonId,
        id,
        typeof body.reason === "string" ? body.reason : undefined,
      );
      if (!n) {
        return reply.code(404).send({
          ok: false,
          code: "NOT_FOUND",
          message: "Notification not found",
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        notification: n,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      series_appointment_id?: string;
      occurrence_starts_at?: string;
      kind?: string;
      scope?: string;
      new_starts_at?: string;
      reason?: string;
    };
  }>(
    "/api/v1/care/recipients/:id/schedule/recurrence-exception",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const body = request.body ?? {};
      const result = applyRecurrenceException(runtime.store, {
        careRecipientId: id,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        seriesAppointmentId:
          typeof body.series_appointment_id === "string"
            ? body.series_appointment_id
            : "",
        occurrenceStartsAt:
          typeof body.occurrence_starts_at === "string"
            ? body.occurrence_starts_at
            : new Date().toISOString(),
        kind:
          body.kind === "cancel" ||
          body.kind === "pause" ||
          body.kind === "resume" ||
          body.kind === "reschedule"
            ? body.kind
            : "skip",
        scope:
          body.scope === "this_and_future" || body.scope === "entire_series"
            ? body.scope
            : "this_occurrence",
        newStartsAt:
          typeof body.new_starts_at === "string" ? body.new_starts_at : null,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(201).send({
        ok: true,
        exception: result.exception,
        preview: result.preview,
        correlation_id: correlationId(request),
      });
    },
  );

  app.get(
    "/api/v1/care/recipients/:id/schedule/:appointmentId/occurrences",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, appointmentId } = request.params as {
        id: string;
        appointmentId: string;
      };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const apt = runtime.store
        .getAppointments(id)
        .find((a) => a.id === appointmentId);
      if (!apt) {
        return reply.code(404).send({
          ok: false,
          code: "NOT_FOUND",
          message: "Appointment not found",
          correlation_id: correlationId(request),
        });
      }
      const occurrences = expandRecurrenceOccurrences(
        apt.startsAt,
        apt.recurrenceRule,
        8,
      );
      const exceptions = listRecurrenceExceptions(runtime.store, id, apt.id);
      return reply.code(200).send({
        ok: true,
        recurrence_rule: apt.recurrenceRule ?? null,
        occurrences,
        exceptions,
        note: "Internal expansion only — not a provider calendar",
        correlation_id: correlationId(request),
      });
    },
  );

  app.get("/api/v1/care/recipients/:id/documents", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    return reply.code(200).send({
      ok: true,
      documents: listCareTextDocuments(runtime.store, id),
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: { title?: string; body?: string };
  }>("/api/v1/care/recipients/:id/documents", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    const result = ingestDocumentText(runtime.store, {
      careRecipientId: id,
      actorPersonId: principal.carePersonId,
      actorDisplayName: principal.displayName,
      title: typeof body.title === "string" ? body.title : "Care document",
      body: typeof body.body === "string" ? body.body : "",
    });
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      document: result.document,
      proposals: result.proposals,
      note: "Proposals require human confirmation before becoming care truth",
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: { decision?: string };
  }>(
    "/api/v1/care/recipients/:id/documents/proposals/:proposalId",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id, proposalId } = request.params as {
        id: string;
        proposalId: string;
      };
      const body = request.body ?? {};
      const result = confirmDocumentProposal(runtime.store, {
        careRecipientId: id,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        proposalId,
        decision: body.decision === "reject" ? "reject" : "confirm",
      });
      if (!result.ok) {
        return reply.code(400).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        result: result.result,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: { reason?: string };
  }>("/api/v1/care/recipients/:id/leave", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    const result = leaveCareCircle(runtime.store, {
      careRecipientId: id,
      actorPersonId: principal.carePersonId,
      reason: typeof body.reason === "string" ? body.reason : undefined,
    });
    if (!result.ok) {
      return reply.code(400).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      message: result.message,
      correlation_id: correlationId(request),
    });
  });

  app.post<{
    Body: { reason?: string; sensitive?: boolean };
  }>("/api/v1/care/recipients/:id/archive", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const body = request.body ?? {};
    const result = archiveCareSpace(runtime.store, {
      careRecipientId: id,
      actorPersonId: principal.carePersonId,
      actorDisplayName: principal.displayName,
      reason:
        typeof body.reason === "string" ? body.reason : "Archived by controller",
      sensitive: body.sensitive === true,
    });
    if (!result.ok) {
      return reply.code(403).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(200).send({
      ok: true,
      archive: result.archive,
      correlation_id: correlationId(request),
    });
  });

  app.get(
    "/api/v1/care/recipients/:id/archive-state",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      return reply.code(200).send({
        ok: true,
        archive: getArchiveState(runtime.store, id),
        representative: representativeAuthorityNote(
          runtime.store,
          id,
          principal.carePersonId,
        ),
        correlation_id: correlationId(request),
      });
    },
  );

  // ── PRN (as-needed) medication orders & charting episodes ──
  app.get(
    "/api/v1/care/recipients/:id/prn",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      seedEvelynPrnOrders(runtime.store, id);
      ensurePrnClarificationLifecycle(runtime.store, id);
      ensurePrnOverdueEscalation(runtime.store, id);
      const proj = buildPrnProjection(runtime.store, id);
      return reply.code(200).send({
        ok: true,
        ...proj,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      medication?: string;
      symptom?: string;
      severity_before?: string;
      dose?: string;
      confirm?: boolean;
      alternatives_tried?: string;
      notes?: string;
      /** Optional occurrence time (ISO) for late documentation — interval checked at this time. */
      administered_at?: string;
      /** Stable client action id — offline retries must not double-chart */
      idempotency_key?: string;
      /** Order id captured at preview — rejects if order deactivated before confirm */
      order_id?: string;
    };
  }>("/api/v1/care/recipients/:id/prn/episodes", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const access = runtime.access(principal.carePersonId, id);
    if (!access.allowed) {
      return reply.code(403).send({
        ok: false,
        code: access.code,
        message: access.reason,
        correlation_id: correlationId(request),
      });
    }
    seedEvelynPrnOrders(runtime.store, id);
    const body = request.body ?? {};
    const med =
      typeof body.medication === "string" ? body.medication : "Acetaminophen";
    const symptom =
      typeof body.symptom === "string" ? body.symptom : "pain";
    const headerIdem = request.headers["x-idempotency-key"];
    const idempotencyKey =
      (typeof headerIdem === "string" && headerIdem.trim()) ||
      (typeof body.idempotency_key === "string" && body.idempotency_key.trim()) ||
      undefined;
    const result = createOrAdvancePrnEpisode(runtime.store, {
      careRecipientId: id,
      actorPersonId: principal.carePersonId,
      actorDisplayName: principal.displayName,
      medicationHint: med,
      symptom,
      severityBefore:
        typeof body.severity_before === "string"
          ? body.severity_before
          : undefined,
      dose: typeof body.dose === "string" ? body.dose : undefined,
      alternativesTried:
        typeof body.alternatives_tried === "string"
          ? body.alternatives_tried
          : undefined,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      administeredAt:
        typeof body.administered_at === "string" &&
        !Number.isNaN(Date.parse(body.administered_at))
          ? body.administered_at
          : undefined,
      confirm: body.confirm === true,
      forceUnauthorized: /benadryl/i.test(med),
      idempotencyKey,
      orderId:
        typeof body.order_id === "string" ? body.order_id : undefined,
    });
    if (!result.ok) {
      return reply.code(result.code === "PRN_ORDER_INACTIVE" ? 409 : 400).send({
        ok: false,
        code: result.code,
        message: result.message,
        correlation_id: correlationId(request),
      });
    }
    await runtime.flush();
    return reply.code(result.needsConfirmation ? 200 : 201).send({
      ok: true,
      needs_confirmation: result.needsConfirmation,
      episode: result.episode,
      order: result.order ?? null,
      interval: result.interval,
      plain_language: result.plainLanguage,
      idempotency_key: idempotencyKey || null,
      correlation_id: correlationId(request),
    });
  });

  // Deactivate / hold / end an authorized PRN order (authorized principals only)
  app.post<{
    Body: {
      order_id?: string;
      status?: "active" | "held" | "ended";
    };
  }>(
    "/api/v1/care/recipients/:id/prn/orders/status",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const body = request.body ?? {};
      const orderId =
        typeof body.order_id === "string" ? body.order_id : "";
      const status =
        body.status === "held" || body.status === "ended" || body.status === "active"
          ? body.status
          : "ended";
      if (!orderId) {
        return reply.code(400).send({
          ok: false,
          code: "MISSING_ORDER",
          message: "order_id is required.",
          correlation_id: correlationId(request),
        });
      }
      const updated = setPrnOrderStatus(
        runtime.store,
        id,
        orderId,
        status,
        principal.carePersonId,
        principal.displayName,
      );
      if (!updated) {
        return reply.code(404).send({
          ok: false,
          code: "NOT_FOUND",
          message: "As-needed order not found.",
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        order: updated,
        plain_language: `As-needed order for ${updated.medication} is now ${updated.status}.`,
        correlation_id: correlationId(request),
      });
    },
  );

  app.post<{
    Body: {
      episode_id?: string;
      effect?: "improved" | "unchanged" | "worsened" | "unable_to_assess";
      severity_after?: string;
      adverse_reaction?: string;
      follow_up_action?: string;
      notes?: string;
      idempotency_key?: string;
    };
  }>(
    "/api/v1/care/recipients/:id/prn/episodes/reassess",
    async (request, reply) => {
      const principal = await requireCareAuth(runtime, request, reply);
      if (!principal) return;
      const { id } = request.params as { id: string };
      const access = runtime.access(principal.carePersonId, id);
      if (!access.allowed) {
        return reply.code(403).send({
          ok: false,
          code: access.code,
          message: access.reason,
          correlation_id: correlationId(request),
        });
      }
      const body = request.body ?? {};
      const effect = body.effect || "unable_to_assess";
      const headerIdem = request.headers["x-idempotency-key"];
      const idempotencyKey =
        (typeof headerIdem === "string" && headerIdem.trim()) ||
        (typeof body.idempotency_key === "string" && body.idempotency_key.trim()) ||
        undefined;
      const result = reassessPrnEpisode(runtime.store, {
        careRecipientId: id,
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        episodeId:
          typeof body.episode_id === "string" ? body.episode_id : undefined,
        effect,
        severityAfter:
          typeof body.severity_after === "string"
            ? body.severity_after
            : undefined,
        adverseReaction:
          typeof body.adverse_reaction === "string"
            ? body.adverse_reaction
            : undefined,
        followUpAction:
          typeof body.follow_up_action === "string"
            ? body.follow_up_action
            : undefined,
        notes: typeof body.notes === "string" ? body.notes : undefined,
        idempotencyKey,
      });
      if (!result.ok) {
        return reply.code(404).send({
          ok: false,
          code: result.code,
          message: result.message,
          correlation_id: correlationId(request),
        });
      }
      await runtime.flush();
      return reply.code(200).send({
        ok: true,
        episode: result.episode,
        plain_language: result.plainLanguage,
        idempotency_key: idempotencyKey || null,
        correlation_id: correlationId(request),
      });
    },
  );

  void listPrnOrders;
  void listPrnEpisodes;

  // silence unused import guards for getHandoffLifecycle when only ensure is used
  void getHandoffLifecycle;
}
