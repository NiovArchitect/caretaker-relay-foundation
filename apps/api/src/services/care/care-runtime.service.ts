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
  people,
  type CareStore,
  type LLMProvider,
  type AuthCareContext,
  type VerificationBundle,
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
      const lab = this.labAuth.validateBearer(authorizationHeader);
      if (lab.ok) {
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
    const lab = this.labAuth.validateBearer(authorizationHeader);
    if (lab.ok) {
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
