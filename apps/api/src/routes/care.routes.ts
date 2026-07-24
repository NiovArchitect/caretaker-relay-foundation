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
  notificationFromCoordination,
  listNotificationsForPrincipal,
  markSeen,
  markAcknowledged,
  markResolved,
  createClarificationRequest,
  respondToClarification,
  listOpenClarificationsForTarget,
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

export async function registerCareRoutes(
  app: FastifyInstance,
  runtime: CareRuntimeService,
): Promise<void> {
  app.get("/api/v1/care/health", async (_req, reply) => {
    return reply.code(200).send({
      ok: true,
      ...runtime.productMeta(),
      timestamp: new Date().toISOString(),
    });
  });

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
    if (!result.ok) {
      const status = result.code === "SUSPENDED" ? 403 : 401;
      return reply.code(status).send({
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

  /** Secondary lab JWT path (explicit non-primary). Prefer /auth/login. */
  app.post<{
    Body: { care_person_id?: string; password?: string };
  }>("/api/v1/care/auth/lab-login", async (request, reply) => {
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
    return reply.code(200).send({
      ok: true,
      care_recipient_id: id,
      today: {
        events: state?.events ?? [],
        tasks: state?.tasks ?? [],
        appointments: state?.appointments ?? [],
        observations: state?.observations ?? [],
        open_safety_reviews: state?.openSafetyReviews ?? [],
        latest_handoff: latestHandoff,
        last_updated_at: state?.lastUpdatedAt ?? null,
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
    return reply.code(200).send({
      ok: true,
      access: runtime.access(principal.carePersonId, id),
      who_can_see_what: runtime.whoCanSee(id),
      correlation_id: correlationId(request),
    });
  });

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

    const temporal = interpretHumanTime(text);
    // Prefer explicit body.mode; otherwise runtime production default (llm when keys present)
    const mode = body.mode ?? runtime.understandMode;
    const result = await runtime.loop.proposeFromInput(text, mapped.ctx, {
      mode,
    });

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
      const prior = runtime.getIdempotent(idem);
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

    runtime.store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: principal.carePersonId,
      action: "CARE_ANSWER",
      careRecipientId,
      details: {
        question: question.slice(0, 200),
        intent: result.intent,
        persona: result.persona,
        model_path: result.modelPath,
        turn_id: result.turnId,
        conversation_id: result.conversationId,
        can_deterministic: result.canDeterministic,
      },
    });
    await runtime.flush();

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
      state: runtime.store.getCurrentState(id),
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
    return reply.code(200).send({
      ok: true,
      handoffs: runtime.store.getHandoffs(id),
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/timeline", async (request, reply) => {
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
      events: runtime.store.getEvents(id),
      corrections: runtime.store.getCorrections(id),
      audit: runtime.store.listAudit({ careRecipientId: id }),
      correlation_id: correlationId(request),
    });
  });

  app.get("/api/v1/care/recipients/:id/export", async (request, reply) => {
    const principal = await requireCareAuth(runtime, request, reply);
    if (!principal) return;
    const { id } = request.params as { id: string };
    const q = request.query as { format?: string };
    const format = q?.format === "markdown" ? "markdown" : "json";
    const result = runtime.export(principal.carePersonId, id, format);
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
    return reply.code(200).send({
      ok: true,
      care_person_id: principal.carePersonId,
      display_name: principal.displayName,
      roles: principal.roles,
      session_id: principal.sessionId,
      auth_mode: principal.authMode,
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
    const invitee =
      runtime.store.getPerson(inviteeId) ??
      Object.values(people).find((p) => p.id === inviteeId);
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
    const role = (body.role as CareRelationshipRole) || "family_caregiver";
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
    const inv = findInvitationByTokenGlobal(
      runtime.store,
      [olivia.id],
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
    const access = defaultInviteAccess(inv.role);
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
    runtime.store.upsertRelationship({
      id: existingRel?.id ?? `rel-${inv.inviteePersonId}`,
      careRecipientId: inv.careRecipientId,
      personId: inv.inviteePersonId,
      role: inv.role,
      roleLabel: inv.roleLabel,
      responsibilities: existingRel?.responsibilities?.length
        ? existingRel.responsibilities
        : ["Care continuity"],
      access,
      status: "active",
      startDate: existingRel?.startDate ?? now.slice(0, 10),
      endDate: undefined,
    });
    runtime.store.upsertConsent({
      id: existingConsent?.id ?? `consent-${inv.inviteePersonId}`,
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
    Body: { body?: string; to_person_id?: string };
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
      },
    });
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
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
      authority: "server",
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
    const result = createClarificationRequest(runtime.store, {
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
    });
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      request: {
        id: result.request.id,
        care_recipient_id: result.request.careRecipientId,
        requester_person_id: result.request.requesterPersonId,
        target_person_id: result.request.targetPersonId,
        question: result.request.question,
        status: result.request.status,
        created_at: result.request.createdAt,
      },
      notification_id: result.notification.id,
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
    await runtime.flush();
    return reply.code(201).send({
      ok: true,
      response: {
        id: result.response.id,
        request_id: result.response.requestId,
        body: result.response.body,
        created_at: result.response.createdAt,
      },
      notification_id: result.notification?.id ?? null,
      correlation_id: correlationId(request),
    });
  });
}
