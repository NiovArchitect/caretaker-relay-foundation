/**
 * Process lifecycle proof — finite validation must not hang on persistent servers.
 *
 * START → HEALTH (timeout) → STOP → PORT FREE
 * Parent never waits for server process exit as success criterion.
 *
 * Run (needs 5434 DB; uses ephemeral ports 13100/15180 to avoid clashing with manual dev):
 *
 *   export DATABASE_URL='postgresql://caretaker:caretaker_local_only@localhost:5434/caretaker_relay_dev?schema=public'
 *   export DIRECT_URL="$DATABASE_URL"
 *   npx vitest --config vitest.unit.config.ts --run tests/unit/care/dev-service-lifecycle.test.ts
 */

import { describe, expect, it, afterAll } from "vitest";
import {
  startCareApi,
  startViteApp,
  stopByName,
  stopAllCareDevServices,
  isPortListening,
  waitForHealth,
} from "../../../scripts/lib/dev-service-lifecycle";

const has5434 =
  (process.env.DATABASE_URL ?? "").includes("5434") &&
  (process.env.DATABASE_URL ?? "").includes("caretaker_relay_dev");

const API_PORT = 13100;
const VITE_PORT = 15180;

describe.skipIf(!has5434)("dev service lifecycle (finite)", () => {
  afterAll(async () => {
    await stopByName("care-api", { force: true });
    await stopByName("vite-app", { force: true });
    // Extra sweep on ephemeral ports used by this test
    for (const port of [API_PORT, VITE_PORT]) {
      if (isPortListening(port)) {
        try {
          const { execSync } = await import("node:child_process");
          const pids = execSync(`lsof -ti :${port}`, { encoding: "utf8" })
            .trim()
            .split("\n")
            .filter(Boolean);
          for (const p of pids) {
            try {
              process.kill(Number(p), "SIGKILL");
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }, 30_000);

  it(
    "start care-api → health → stop → port free (no indefinite wait)",
    async () => {
      // Clean slate for ephemeral API port
      if (isPortListening(API_PORT)) {
        const { execSync } = await import("node:child_process");
        try {
          const pids = execSync(`lsof -ti :${API_PORT}`, { encoding: "utf8" })
            .trim()
            .split("\n");
          for (const p of pids) process.kill(Number(p), "SIGKILL");
        } catch {
          // ignore
        }
      }

      const startedAt = Date.now();
      const api = await startCareApi({ port: API_PORT });
      expect(api.pid).toBeGreaterThan(0);
      expect(isPortListening(API_PORT)).toBe(true);

      const health = await waitForHealth(api.healthUrl, {
        timeoutMs: 5_000,
        expectBodyMatch: /caretaker-relay/,
      });
      expect(health.ok).toBe(true);
      expect(health.body).toMatch(/"durable"\s*:\s*true/);
      expect(health.body).toMatch(/"store_backend"\s*:\s*"prisma"/);

      // Finite stop — must not wait for natural exit forever
      const stop = await stopByName("care-api", { force: true, waitMs: 10_000 });
      expect(stop.portFree).toBe(true);
      expect(isPortListening(API_PORT)).toBe(false);

      const elapsed = Date.now() - startedAt;
      // Entire lifecycle well under any "wait forever" threshold
      expect(elapsed).toBeLessThan(90_000);
    },
    120_000,
  );

  it(
    "start vite → shell health → stop → port free",
    async () => {
      if (isPortListening(VITE_PORT)) {
        const { execSync } = await import("node:child_process");
        try {
          const pids = execSync(`lsof -ti :${VITE_PORT}`, { encoding: "utf8" })
            .trim()
            .split("\n");
          for (const p of pids) process.kill(Number(p), "SIGKILL");
        } catch {
          // ignore
        }
      }

      const startedAt = Date.now();
      const vite = await startViteApp({
        port: VITE_PORT,
        apiUrl: `http://127.0.0.1:${API_PORT}`,
      });
      expect(vite.pid).toBeGreaterThan(0);

      const health = await waitForHealth(vite.healthUrl, {
        timeoutMs: 20_000,
        expectBodyMatch: /caretaker|vite|root/i,
      });
      expect(health.ok).toBe(true);
      expect(isPortListening(VITE_PORT)).toBe(true);

      const stop = await stopByName("vite-app", { force: true, waitMs: 10_000 });
      expect(stop.portFree).toBe(true);
      expect(isPortListening(VITE_PORT)).toBe(false);

      expect(Date.now() - startedAt).toBeLessThan(60_000);
    },
    90_000,
  );

  it("stopAll is idempotent when nothing is running", async () => {
    await stopAllCareDevServices();
    expect(isPortListening(API_PORT)).toBe(false);
    expect(isPortListening(VITE_PORT)).toBe(false);
  });
});
