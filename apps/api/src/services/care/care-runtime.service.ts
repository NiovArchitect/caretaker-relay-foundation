/**
 * Care runtime host — Foundation AuthService + Prisma CareStore + CareLoopService.
 */

import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  CareLoopService,
  MemoryCareStore,
  seedOliviaScenario,
  exportCareData,
  whoCanSeeWhat,
  evaluateAccess,
  authorize,
  listAuthorizedRecipients,
  createVerificationChallenge,
  verifyContactCode,
  isContactVerified,
  normalizeEmail,
  isAccountSuspended,
  suspendAccount,
  reactivateAccount,
  people,
  type CareStore,
  type LLMProvider,
  type AuthCareContext,
  type VerificationBundle,
  type AuthorizeInput,
  type AuthorizeResult,
} from "@caretaker-relay/care-domain";
import { CareAuthService } from "@caretaker-relay/care-domain/care-auth";
import { FileCareStore } from "@caretaker-relay/care-domain/file-store";
import { PRODUCT_ID } from "@caretaker-relay/product-identity";
import { createEntity } from "@niov/database";
import { AuthService } from "../auth.service.js";
import { MemoryNonceStore, type NonceStore } from "../../redis.js";
import { logger } from "../../logger.js";
import {
  PrismaCareStore,
  linkPrincipal,
  resolveCarePersonFromEntity,
} from "./prisma-care-store.js";

export type CareStoreBackend = "memory" | "file" | "prisma";

export interface CareRuntimeConfig {
  jwtSecret: string;
  storeBackend?: CareStoreBackend;
  storePath?: string;
  seedOlivia?: boolean;
  understandMode?: "fixture" | "llm";
  llmProvider?: LLMProvider;
  authService?: AuthService;
  nonceStore?: NonceStore;
  /** When true, seed Foundation Entity rows + CarePrincipalLink for Evelyn Carter cast */
  seedFoundationAuth?: boolean;
}

export class CareRuntimeService {
  store: CareStore;
  loop: CareLoopService;
  /** Lab JWT helper (secondary); primary is foundationAuth when available */
  readonly labAuth: CareAuthService;
  foundationAuth: AuthService | null;
  readonly durable: boolean;
  readonly storeBackend: CareStoreBackend;
  readonly storePath?: string;
  private prismaStore: PrismaCareStore | null = null;
  private pendingBundles = new Map<
    string,
    { bundle: VerificationBundle; ctx: AuthCareContext; rawText: string }
  >();
  private jwtSecret: string;
  private nonceStore: NonceStore;
  private readonly _understandMode: "fixture" | "llm";
  private readonly _llmReady: boolean;

  private constructor(config: CareRuntimeConfig, store: CareStore, backend: CareStoreBackend) {
    this.jwtSecret = config.jwtSecret;
    this.nonceStore = config.nonceStore ?? new MemoryNonceStore();
    this.store = store;
    this.storeBackend = backend;
    this.durable = backend === "file" || backend === "prisma";
    this.storePath = config.storePath;
    this._understandMode = config.understandMode ?? "fixture";
    this._llmReady = Boolean(config.llmProvider) && this._understandMode === "llm";
    this.labAuth = new CareAuthService(config.jwtSecret);
    this.foundationAuth =
      config.authService ??
      new AuthService({
        jwtSecret: config.jwtSecret,
        nonceStore: this.nonceStore,
      });
    if (store instanceof PrismaCareStore) {
      this.prismaStore = store;
    }
    this.loop = new CareLoopService({
      store: this.store,
      defaultMode: this._understandMode,
      provider: config.llmProvider,
    });
  }

  static async create(config: CareRuntimeConfig): Promise<CareRuntimeService> {
    const backend: CareStoreBackend =
      config.storeBackend ??
      (process.env.CARE_STORE_BACKEND as CareStoreBackend | undefined) ??
      (process.env.DATABASE_URL ? "prisma" : config.storePath ? "file" : "memory");

    let store: CareStore;
    if (backend === "prisma") {
      store = await PrismaCareStore.create({ load: true });
    } else if (backend === "file" || config.storePath) {
      const path =
        config.storePath ??
        resolve(
          process.cwd(),
          process.env.CARE_STORE_PATH ?? ".data/caretaker-relay-care-store.json",
        );
      store = new FileCareStore(path);
    } else {
      store = new MemoryCareStore();
    }

    const runtime = new CareRuntimeService(config, store, backend);

    if (config.seedOlivia !== false) {
      // Always re-upsert Evelyn Carter scenario relationships so lab access matrix
      // is not left in a revoked state from a prior run.
      seedOliviaScenario(store);
      if (store instanceof PrismaCareStore) {
        await store.flush();
      } else if (store instanceof FileCareStore) {
        store.persist();
      }
    }

    if (config.seedFoundationAuth !== false && backend === "prisma") {
      await runtime.ensureFoundationPrincipals();
    }

    return runtime;
  }

  /** Seed Entity + password + CarePrincipalLink for Evelyn Carter cast (idempotent). */
  async ensureFoundationPrincipals(): Promise<void> {
    const cast: Array<{
      person: (typeof people)[keyof typeof people];
      email: string;
      password: string;
      roles: string[];
    }> = [
      {
        person: people.sadeil,
        email: "sadeil.care@caretaker-relay.test",
        password: "sadeil-lab-password",
        roles: ["family_caregiver", "primary"],
      },
      {
        person: people.maya,
        email: "maya.care@caretaker-relay.test",
        password: "maya-lab-password",
        roles: ["family_caregiver", "adult_child"],
      },
      {
        person: people.walter,
        email: "walter.care@caretaker-relay.test",
        password: "walter-lab-password",
        roles: ["professional", "paid_caregiver"],
      },
      {
        person: people.drShah,
        email: "drshah.care@caretaker-relay.test",
        password: "drshah-lab-password",
        roles: ["provider", "physician"],
      },
      {
        person: people.unauthorized,
        email: "unauthorized.care@caretaker-relay.test",
        password: "unauth-lab-password",
        roles: ["family_caregiver"],
      },
      {
        person: people.otherHouseholdCaregiver,
        email: "other-hh.care@caretaker-relay.test",
        password: "other-hh-lab-password",
        roles: ["family_caregiver"],
      },
    ];

    const { getEntityByEmail } = await import("@niov/database");
    for (const c of cast) {
      try {
        let entity = await getEntityByEmail(c.email);
        if (!entity) {
          entity = await createEntity({
            entity_type: "PERSON",
            display_name: c.person.displayName,
            public_key: `cr_pk_${c.person.id}`,
            email: c.email,
            password: c.password,
            clearance_level: 2,
          });
        }
        await linkPrincipal(
          entity.entity_id,
          c.person.id,
          c.person.displayName,
          c.roles,
        );
      } catch (err) {
        const entity = await getEntityByEmail(c.email);
        if (entity) {
          await linkPrincipal(
            entity.entity_id,
            c.person.id,
            c.person.displayName,
            c.roles,
          );
        } else {
          logger.warn(
            { err, email: c.email },
            "[care] seed principal failed",
          );
        }
      }
    }
  }

  /**
   * Foundation AuthService login → care principal mapping.
   */
  async foundationLogin(
    email: string,
    password: string,
  ): Promise<
    | {
        ok: true;
        token: string;
        session_id: string;
        entity_id: string;
        care_person_id: string;
        display_name: string;
        roles: string[];
        auth_mode: "foundation_auth_service";
      }
    | { ok: false; code: string; message: string }
  > {
    if (!this.foundationAuth) {
      return {
        ok: false,
        code: "AUTH_UNAVAILABLE",
        message: "Foundation AuthService not configured",
      };
    }
    const result = await this.foundationAuth.login(email, password, [
      "read",
      "write",
    ]);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message: result.message,
      };
    }
    const link = await resolveCarePersonFromEntity(result.entity_id);
    if (!link) {
      return {
        ok: false,
        code: "NO_CARE_MAPPING",
        message:
          "Authenticated Foundation entity is not linked to a care principal",
      };
    }
    this.store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: link.carePersonId,
      action: "FOUNDATION_AUTH_LOGIN",
      details: {
        entity_id: result.entity_id,
        session_id: result.session_id,
        auth_mode: "foundation_auth_service",
      },
    });
    await this.flush();
    return {
      ok: true,
      token: result.token,
      session_id: result.session_id,
      entity_id: result.entity_id,
      care_person_id: link.carePersonId,
      display_name: link.displayName,
      roles: link.roles,
      auth_mode: "foundation_auth_service",
    };
  }

  /**
   * Validate Bearer: prefer Foundation AuthService session, fall back to lab JWT.
   */
  async resolveBearer(
    authorizationHeader: string | undefined,
  ): Promise<
    | {
        ok: true;
        carePersonId: string;
        displayName: string;
        roles: string[];
        sessionId: string;
        entityId?: string;
        authMode: "foundation_auth_service" | "care_lab_jwt";
        allowed_operations: string[];
      }
    | { ok: false; code: string; message: string }
  > {
    if (!authorizationHeader?.startsWith("Bearer ")) {
      return {
        ok: false,
        code: "SESSION_INVALID",
        message: "Missing bearer token",
      };
    }
    const token = authorizationHeader.slice("Bearer ".length).trim();

    // Peek claims without verification to choose auth path (avoid lab JWT
    // hitting Foundation session lookup with undefined session_id).
    const peekIss = peekJwtIss(token);

    if (peekIss === "caretaker-relay-care-auth") {
      const lab = await this.labAuth.validateBearerShared(authorizationHeader);
      if (lab.ok) {
        if (isAccountSuspended(this.store, lab.claims.carePersonId)) {
          return {
            ok: false,
            code: "ACCOUNT_SUSPENDED",
            message: "Account is suspended",
          };
        }
        return {
          ok: true,
          carePersonId: lab.claims.carePersonId,
          displayName: lab.claims.displayName,
          roles: lab.claims.roles,
          sessionId: lab.claims.sid,
          authMode: "care_lab_jwt",
          allowed_operations: lab.claims.ops,
        };
      }
      return {
        ok: false,
        code: lab.code,
        message: lab.message,
      };
    }

    if (this.foundationAuth) {
      try {
        const validated = await this.foundationAuth.validateSession(
          token,
          "read",
        );
        if (validated.valid) {
          const link = await resolveCarePersonFromEntity(validated.entity_id);
          if (!link) {
            return {
              ok: false,
              code: "NO_CARE_MAPPING",
              message: "Session entity not linked to care principal",
            };
          }
          if (isAccountSuspended(this.store, link.carePersonId)) {
            return {
              ok: false,
              code: "ACCOUNT_SUSPENDED",
              message: "Account is suspended",
            };
          }
          return {
            ok: true,
            carePersonId: link.carePersonId,
            displayName: link.displayName,
            roles: link.roles,
            sessionId: validated.session_id,
            entityId: validated.entity_id,
            authMode: "foundation_auth_service",
            allowed_operations: validated.allowed_operations,
          };
        }
      } catch {
        // Fall through to lab JWT attempt
      }
    }

    // Lab JWT fallback (secondary path)
    const lab = await this.labAuth.validateBearerShared(authorizationHeader);
    if (lab.ok) {
      if (isAccountSuspended(this.store, lab.claims.carePersonId)) {
        return {
          ok: false,
          code: "ACCOUNT_SUSPENDED",
          message: "Account is suspended",
        };
      }
      return {
        ok: true,
        carePersonId: lab.claims.carePersonId,
        displayName: lab.claims.displayName,
        roles: lab.claims.roles,
        sessionId: lab.claims.sid,
        authMode: "care_lab_jwt",
        allowed_operations: lab.claims.ops,
      };
    }
    return {
      ok: false,
      code: lab.ok === false ? lab.code : "SESSION_INVALID",
      message: lab.ok === false ? lab.message : "Invalid session",
    };
  }

  toAuthCareContext(
    principal: {
      carePersonId: string;
      displayName: string;
      roles: string[];
      sessionId: string;
    },
    careRecipientId: string,
  ):
    | { ok: true; ctx: AuthCareContext }
    | { ok: false; code: string; message: string } {
    const recipient = this.store.getRecipient(careRecipientId);
    if (!recipient) {
      return {
        ok: false,
        code: "UNKNOWN_RECIPIENT",
        message: "Care recipient not found",
      };
    }
    return {
      ok: true,
      ctx: {
        actorPersonId: principal.carePersonId,
        actorDisplayName: principal.displayName,
        careRecipientId,
        householdId: recipient.householdId,
        sessionId: principal.sessionId,
        roles: principal.roles,
      },
    };
  }

  async flush(): Promise<void> {
    if (this.prismaStore) {
      await this.prismaStore.flush();
    } else if (this.store instanceof FileCareStore) {
      this.store.persist();
    }
  }

  /** Reload Prisma-backed care memory from DB (tests / restart simulation). */
  async reloadFromDatabase(): Promise<void> {
    if (this.prismaStore) {
      await this.prismaStore.load();
    }
  }

  stashBundle(
    bundle: VerificationBundle,
    ctx: AuthCareContext,
    rawText: string,
  ): string {
    const id = this.store.newId("vb");
    this.pendingBundles.set(id, { bundle, ctx, rawText });
    return id;
  }

  takeBundle(id: string) {
    return this.pendingBundles.get(id);
  }

  get understandMode(): "fixture" | "llm" {
    return this._understandMode;
  }

  get llmReady(): boolean {
    return this._llmReady;
  }

  productMeta() {
    return {
      product_id: PRODUCT_ID,
      durable: this.durable,
      store_backend: this.storeBackend,
      store_path: this.storePath ?? null,
      foundation_auth: Boolean(this.foundationAuth),
      understand_mode: this._understandMode,
      llm_ready: this._llmReady,
    };
  }

  whoCanSee(careRecipientId: string) {
    return whoCanSeeWhat(this.store, careRecipientId);
  }

  access(actorPersonId: string, careRecipientId: string) {
    return evaluateAccess(this.store, actorPersonId, careRecipientId);
  }

  /**
   * Central authorization decision — use for every recipient-scoped operation.
   */
  authorize(input: AuthorizeInput): AuthorizeResult {
    return authorize(this.store, input);
  }

  listMemberships(actorPersonId: string) {
    return listAuthorizedRecipients(this.store, actorPersonId);
  }

  /**
   * Register a durable care account with ZERO recipient memberships.
   * Role claim is stored as metadata only — never grants access.
   */
  async registerAccount(input: {
    preferredName: string;
    email: string;
    password: string;
    claimedRelationship?: string;
    termsVersion?: string;
  }): Promise<
    | {
        ok: true;
        token: string;
        session_id: string;
        care_person_id: string;
        entity_id?: string;
        display_name: string;
        roles: string[];
        account_status: "unverified" | "pending_access";
        authorized_recipients: number;
        auth_mode: "foundation_auth_service" | "care_lab_jwt";
        verification_code_dev_only?: string;
      }
    | { ok: false; code: string; message: string }
  > {
    const preferredName = input.preferredName.trim();
    const email = normalizeEmail(input.email);
    const password = input.password;
    if (preferredName.length < 2) {
      return {
        ok: false,
        code: "BAD_REQUEST",
        message: "preferred_name required (min 2 characters)",
      };
    }
    if (!email.includes("@")) {
      return {
        ok: false,
        code: "BAD_REQUEST",
        message: "valid email required",
      };
    }
    if (!password || password.length < 8) {
      return {
        ok: false,
        code: "BAD_REQUEST",
        message: "password must be at least 8 characters",
      };
    }

    const carePersonId = `p-acct-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const claimed = input.claimedRelationship?.trim() || "unspecified";
    const roles = ["account_holder", "pending_access", `claim:${claimed}`];

    // Prefer Foundation Entity + CarePrincipalLink when prisma backend available
    if (this.storeBackend === "prisma" && this.foundationAuth) {
      try {
        const { getEntityByEmail } = await import("@niov/database");
        const existing = await getEntityByEmail(email);
        if (existing) {
          return {
            ok: false,
            code: "EMAIL_IN_USE",
            message: "An account with this email already exists",
          };
        }
        const entity = await createEntity({
          entity_type: "PERSON",
          display_name: preferredName,
          public_key: `cr_pk_${carePersonId}`,
          email,
          password,
          clearance_level: 1,
        });
        await linkPrincipal(entity.entity_id, carePersonId, preferredName, roles);
        this.store.upsertPerson({
          id: carePersonId,
          displayName: preferredName,
          kind: "family_caregiver",
        });
        this.store.writeAudit({
          at: new Date().toISOString(),
          actorPersonId: carePersonId,
          action: "ACCOUNT_REGISTERED",
          details: {
            entity_id: entity.entity_id,
            email_domain: email.split("@")[1] ?? "",
            claimed_relationship: claimed,
            authorized_recipients: 0,
            terms_version: input.termsVersion ?? null,
          },
        });
        const { challenge, plainCode } = createVerificationChallenge(this.store, {
          carePersonId,
          channel: "email",
          contact: email,
        });
        await this.flush();
        const login = await this.foundationLogin(email, password);
        if (!login.ok) {
          return {
            ok: false,
            code: "REGISTERED_LOGIN_FAILED",
            message: login.message,
          };
        }
        return {
          ok: true,
          token: login.token,
          session_id: login.session_id,
          care_person_id: carePersonId,
          entity_id: entity.entity_id,
          display_name: preferredName,
          roles,
          account_status: "unverified",
          authorized_recipients: 0,
          auth_mode: "foundation_auth_service",
          // Lab/dev only: never log PHI; code returned only when CARE_EXPOSE_VERIFY_CODE=1
          verification_code_dev_only:
            process.env.CARE_EXPOSE_VERIFY_CODE === "1" ? plainCode : undefined,
        };
      } catch (err) {
        logger.warn({ err }, "[care] foundation register failed; falling back to lab account");
      }
    }

    // Lab / file / memory path — dynamic CareAuth principal, zero memberships
    this.labAuth.registerPrincipal({
      carePersonId,
      displayName: preferredName,
      roles,
      passwordLab: password,
      email,
      accountStatus: "unverified",
      claimedRelationship: claimed,
    });
    this.store.upsertPerson({
      id: carePersonId,
      displayName: preferredName,
      kind: "family_caregiver",
    });
    this.store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: carePersonId,
      action: "ACCOUNT_REGISTERED",
      details: {
        email_domain: email.split("@")[1] ?? "",
        claimed_relationship: claimed,
        authorized_recipients: 0,
        auth_path: "care_lab_register",
        terms_version: input.termsVersion ?? null,
      },
    });
    const { plainCode } = createVerificationChallenge(this.store, {
      carePersonId,
      channel: "email",
      contact: email,
    });
    await this.flush();
    const minted = this.labAuth.loginLab(carePersonId, password);
    if (!minted.ok) {
      return { ok: false, code: minted.code, message: minted.message };
    }
    return {
      ok: true,
      token: minted.token,
      session_id: minted.session_id,
      care_person_id: carePersonId,
      display_name: preferredName,
      roles,
      account_status: "unverified",
      authorized_recipients: 0,
      auth_mode: "care_lab_jwt",
      verification_code_dev_only:
        process.env.CARE_EXPOSE_VERIFY_CODE === "1" ||
        process.env.NODE_ENV !== "production"
          ? plainCode
          : undefined,
    };
  }

  issueContactVerification(carePersonId: string, email: string) {
    return createVerificationChallenge(this.store, {
      carePersonId,
      channel: "email",
      contact: email,
    });
  }

  verifyContact(carePersonId: string, code: string) {
    return verifyContactCode(this.store, { carePersonId, code });
  }

  isVerified(carePersonId: string): boolean {
    return isContactVerified(this.store, carePersonId);
  }

  async logoutSession(
    authorizationHeader: string | undefined,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const resolved = await this.resolveBearer(authorizationHeader);
    if (!resolved.ok) {
      return { ok: false, code: resolved.code, message: resolved.message };
    }
    if (
      resolved.authMode === "foundation_auth_service" &&
      this.foundationAuth &&
      resolved.entityId
    ) {
      await this.foundationAuth.logout(resolved.sessionId, resolved.entityId);
    }
    // Lab JWT path: local + shared multi-instance denylist
    if (resolved.authMode === "care_lab_jwt") {
      await this.labAuth.revokeSessionAsync(resolved.sessionId, {
        reason: "logout",
        actorPersonId: resolved.carePersonId,
        principalId: resolved.carePersonId,
      });
    }
    this.store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: resolved.carePersonId,
      action: "SESSION_LOGOUT",
      details: {
        session_id: resolved.sessionId,
        auth_mode: resolved.authMode,
      },
    });
    await this.flush();
    return { ok: true };
  }

  /** Revoke current session immediately (lab denylist + foundation terminate). */
  async revokeActiveSession(
    authorizationHeader: string | undefined,
    reason = "revoked",
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const resolved = await this.resolveBearer(authorizationHeader);
    if (!resolved.ok) {
      return { ok: false, code: resolved.code, message: resolved.message };
    }
    if (resolved.authMode === "care_lab_jwt") {
      await this.labAuth.revokeSessionAsync(resolved.sessionId, {
        reason,
        actorPersonId: resolved.carePersonId,
        principalId: resolved.carePersonId,
      });
    }
    if (
      resolved.authMode === "foundation_auth_service" &&
      this.foundationAuth &&
      resolved.entityId
    ) {
      await this.foundationAuth.logout(resolved.sessionId, resolved.entityId);
    }
    this.store.writeAudit({
      at: new Date().toISOString(),
      actorPersonId: resolved.carePersonId,
      action: "SESSION_REVOKED",
      details: {
        session_id: resolved.sessionId,
        reason,
        auth_mode: resolved.authMode,
      },
    });
    await this.flush();
    return { ok: true };
  }

  async suspendPrincipal(
    targetPersonId: string,
    actorPersonId: string,
    reason: string,
  ): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    if (!reason.trim()) {
      return { ok: false, code: "BAD_REQUEST", message: "reason required" };
    }
    // Lab admin: only primary seed principal or self-service not allowed for others without control
    // For product: Marcus-style controlling principal OR same person cannot suspend others without *
    suspendAccount(this.store, {
      carePersonId: targetPersonId,
      reason: reason.trim(),
      suspendedByPersonId: actorPersonId,
    });
    await this.labAuth.revokeAllSessionsForPrincipal(
      targetPersonId,
      "account_suspension",
    );
    await this.flush();
    return { ok: true };
  }

  async reactivatePrincipal(
    targetPersonId: string,
    actorPersonId: string,
  ): Promise<{ ok: true }> {
    reactivateAccount(this.store, {
      carePersonId: targetPersonId,
      reactivatedByPersonId: actorPersonId,
    });
    await this.flush();
    return { ok: true };
  }

  export(
    actorPersonId: string,
    careRecipientId: string,
    format: "json" | "markdown",
  ) {
    return exportCareData(this.store, actorPersonId, careRecipientId, format);
  }

  getIdempotent(key: string): unknown | undefined {
    if (this.prismaStore) return this.prismaStore.getIdempotent(key);
    if (
      this.store &&
      "getIdempotent" in this.store &&
      typeof (this.store as { getIdempotent: (k: string) => unknown })
        .getIdempotent === "function"
    ) {
      return (
        this.store as { getIdempotent: (k: string) => unknown }
      ).getIdempotent(key);
    }
    return undefined;
  }

  putIdempotent(key: string, body: unknown): void {
    if (this.prismaStore) {
      this.prismaStore.putIdempotent(key, body);
      return;
    }
    if (
      this.store &&
      "putIdempotent" in this.store &&
      typeof (this.store as { putIdempotent: (k: string, b: unknown) => void })
        .putIdempotent === "function"
    ) {
      (
        this.store as { putIdempotent: (k: string, b: unknown) => void }
      ).putIdempotent(key, body);
    }
  }

  // backward-compat alias used by older routes
  get auth(): CareAuthService {
    return this.labAuth;
  }

  static defaultStorePath(): string {
    return resolve(
      process.cwd(),
      process.env.CARE_STORE_PATH ?? ".data/caretaker-relay-care-store.json",
    );
  }
}

function peekJwtIss(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const payloadPart = parts[1];
    if (!payloadPart) return null;
    const json = JSON.parse(
      Buffer.from(
        payloadPart.replace(/-/g, "+").replace(/_/g, "/"),
        "base64",
      ).toString("utf8"),
    ) as { iss?: string };
    return typeof json.iss === "string" ? json.iss : null;
  } catch {
    return null;
  }
}
