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
  type VerificationBundle,
} from "@caretaker-relay/care-domain";

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
    const result = await runtime.loop.proposeFromInput(text, mapped.ctx, {
      mode: body.mode,
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
}
