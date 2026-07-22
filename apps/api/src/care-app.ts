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

  const runtime = await CareRuntimeService.create({
    jwtSecret,
    storeBackend,
    storePath: config.storePath ?? undefined,
    seedOlivia: config.seedOlivia ?? true,
    seedFoundationAuth: config.seedFoundationAuth ?? storeBackend === "prisma",
    understandMode: config.understandMode ?? "fixture",
    llmProvider: config.llmProvider,
    nonceStore: new MemoryNonceStore(),
  });

  const app = Fastify({
    logger: config.logger ?? false,
  });

  app.addHook("onRequest", async (request, reply) => {
    const id =
      (request.headers["x-request-id"] as string | undefined) ??
      `req-${Date.now().toString(36)}`;
    reply.header("x-request-id", id);
  });

  await registerCareRoutes(app, runtime);

  app.get("/api/v1/health", async (_req, reply) => {
    return reply.code(200).send({
      ok: true,
      service: "caretaker-relay-care-api",
      product_id: "caretaker-relay",
      timestamp: new Date().toISOString(),
      care: runtime.productMeta(),
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
