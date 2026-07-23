/**
 * Focused Caretaker Relay care runtime Fastify app.
 * Primary: Foundation AuthService + Prisma CareStore when DATABASE_URL set.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { CareRuntimeService, type CareStoreBackend } from "./services/care/care-runtime.service.js";
import { registerCareRoutes } from "./routes/care.routes.js";
import type { LLMProvider } from "@caretaker-relay/care-domain";
import { MemoryNonceStore } from "./redis.js";
import { logger } from "./logger.js";

export interface BuildCareAppConfig {
  jwtSecret?: string;
  storeBackend?: CareStoreBackend;
  storePath?: string | null;
  durable?: boolean;
  seedOlivia?: boolean;
  seedFoundationAuth?: boolean;
  understandMode?: "fixture" | "llm";
  llmProvider?: LLMProvider;
  logger?: boolean;
}

export interface CareApp {
  app: FastifyInstance;
  runtime: CareRuntimeService;
}

function resolveUnderstandMode(
  config: BuildCareAppConfig,
): "fixture" | "llm" {
  if (config.understandMode) return config.understandMode;
  const env = process.env.CARE_UNDERSTAND_MODE?.toLowerCase();
  if (env === "fixture") return "fixture";
  if (env === "llm") return "llm";
  // Auto: prefer llm when a provider key is present
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) return "llm";
  return "fixture";
}

function tryCreateLlmProvider(): import("@caretaker-relay/care-domain").LLMProvider | undefined {
  try {
    // Dynamic import of Foundation factory — only when keys exist
    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLLMProvider } = require("./services/llm/llm.service.js") as {
      getLLMProvider: () => import("@caretaker-relay/care-domain").LLMProvider;
    };
    return getLLMProvider();
  } catch (err) {
    logger.warn({ err }, "LLM provider unavailable; care understand stays fixture");
    return undefined;
  }
}

export async function buildCareApp(
  config: BuildCareAppConfig = {},
): Promise<CareApp> {
  const jwtSecret =
    config.jwtSecret ??
    process.env.JWT_SECRET ??
    "caretaker-relay-care-lab-jwt-secret-do-not-use-in-prod";

  let storeBackend = config.storeBackend;
  if (!storeBackend) {
    if (config.storePath) storeBackend = "file";
    else if (config.durable === false) storeBackend = "memory";
    else if (process.env.DATABASE_URL) storeBackend = "prisma";
    else if (config.durable) storeBackend = "file";
    else storeBackend = "memory";
  }

  const understandMode = resolveUnderstandMode(config);
  const llmProvider =
    config.llmProvider ??
    (understandMode === "llm" ? tryCreateLlmProvider() : undefined);
  const effectiveMode: "fixture" | "llm" =
    understandMode === "llm" && llmProvider ? "llm" : "fixture";

  const runtime = await CareRuntimeService.create({
    jwtSecret,
    storeBackend,
    storePath: config.storePath ?? undefined,
    seedOlivia: config.seedOlivia ?? true,
    seedFoundationAuth: config.seedFoundationAuth ?? storeBackend === "prisma",
    understandMode: effectiveMode,
    llmProvider,
    nonceStore: new MemoryNonceStore(),
  });

  const app = Fastify({
    logger: config.logger ?? false,
  });

  /**
   * CORS for Caretaker Relay caregiver UI.
   * Lab defaults remain loopback. Online deploy must set CARE_CORS_ORIGINS and/or
   * CARETAKER_APP_URL / PUBLIC_APP_URL to the HTTPS frontend origin.
   * DEPLOYMENT REQUIREMENT — not a product-behavior redesign.
   */
  const defaultLab =
    "http://127.0.0.1:5180,http://localhost:5180,http://127.0.0.1:5173,http://localhost:5173";
  const fromEnv = [
    process.env.CARE_CORS_ORIGINS,
    process.env.CARETAKER_APP_URL,
    process.env.PUBLIC_APP_URL,
    process.env.CORS_ORIGIN,
  ]
    .filter(Boolean)
    .join(",");
  const labOrigins = new Set(
    (fromEnv || defaultLab)
      .split(",")
      .map((s) => s.trim().replace(/\/$/, ""))
      .filter(Boolean),
  );

  app.addHook("onRequest", async (request, reply) => {
    const id =
      (request.headers["x-request-id"] as string | undefined) ??
      `req-${Date.now().toString(36)}`;
    reply.header("x-request-id", id);

    const origin = request.headers.origin;
    if (origin && labOrigins.has(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header(
        "access-control-allow-headers",
        "authorization,content-type,x-request-id,x-correlation-id",
      );
      reply.header(
        "access-control-allow-methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
      reply.header("vary", "Origin");
    }

    if (request.method === "OPTIONS") {
      return reply.code(204).send();
    }
  });

  await registerCareRoutes(app, runtime);

  app.get("/api/v1/health", async (_req, reply) => {
    return reply.code(200).send({
      ok: true,
      service: "caretaker-relay-care-api",
      product_id: "caretaker-relay",
      timestamp: new Date().toISOString(),
      care: runtime.productMeta(),
      understand_mode: effectiveMode,
      llm_provider_ready: Boolean(llmProvider),
      llm_keys_present: Boolean(
        process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY,
      ),
    });
  });

  return { app, runtime };
}

export async function startCareApiServer(
  config: BuildCareAppConfig = {},
): Promise<CareApp> {
  const port = Number.parseInt(
    process.env.PORT ?? process.env.CARE_API_PORT ?? "3100",
    10,
  );
  const built = await buildCareApp({
    ...config,
    storeBackend: config.storeBackend ?? (process.env.DATABASE_URL ? "prisma" : "file"),
    logger: true,
  });
  await built.app.listen({ port, host: "0.0.0.0" });
  built.app.log.info(
    { port, care: built.runtime.productMeta() },
    "Caretaker Relay care API listening",
  );
  return built;
}

if (process.argv[1]?.includes("care-app")) {
  startCareApiServer().catch((err) => {
    logger.error({ err }, "Failed to start Caretaker Relay care API");
    process.exit(1);
  });
}
