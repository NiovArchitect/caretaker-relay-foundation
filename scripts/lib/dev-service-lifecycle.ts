/**
 * Finite lifecycle helpers for Care API / Vite.
 *
 * Pattern (never wait for process exit as success):
 *   START → WAIT_HEALTH(timeout) → ASSERT → RUN WORK → STOP → ASSERT_PORT_FREE
 *
 * Persistent servers are optional (LEAVE_SERVICES=1) and must be detached
 * explicitly — they must not block a finite validation harness.
 */

import { spawn, type ChildProcess, execSync } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const FOUNDATION_ROOT = resolve(HERE, "../..");
const APP_ROOT = resolve(FOUNDATION_ROOT, "../caretaker-relay");
const RUN_DIR = resolve(FOUNDATION_ROOT, ".care-dev-run");

export type ManagedService = {
  name: string;
  port: number;
  healthUrl: string;
  pid: number;
  pgid: number;
  pidFile: string;
  child: ChildProcess;
};

function ensureRunDir() {
  mkdirSync(RUN_DIR, { recursive: true });
}

export function pidFileFor(name: string) {
  return resolve(RUN_DIR, `${name}.pid`);
}

export function isPortListening(port: number): boolean {
  try {
    const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export async function waitForHealth(
  url: string,
  opts?: { timeoutMs?: number; intervalMs?: number; expectBodyMatch?: RegExp },
): Promise<{ ok: boolean; status?: number; body?: string; ms: number }> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;
  const intervalMs = opts?.intervalMs ?? 400;
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      const body = await res.text();
      last = body.slice(0, 200);
      const match = opts?.expectBodyMatch
        ? opts.expectBodyMatch.test(body)
        : res.ok;
      if (res.ok && match) {
        return { ok: true, status: res.status, body, ms: Date.now() - start };
      }
    } catch (e) {
      last = String(e);
    }
    await sleep(intervalMs);
  }
  return { ok: false, body: last, ms: Date.now() - start };
}

export async function startDetached(
  name: string,
  opts: {
    cwd: string;
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    port: number;
    healthUrl: string;
    healthMatch?: RegExp;
    healthTimeoutMs?: number;
  },
): Promise<ManagedService> {
  ensureRunDir();
  if (isPortListening(opts.port)) {
    throw new Error(
      `${name}: port ${opts.port} already in use — stop existing service first`,
    );
  }

  const logPath = resolve(RUN_DIR, `${name}.log`);
  const out = createWriteStream(logPath, { flags: "a" });
  // detached + unref so parent can exit without waiting on the child
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);

  const pid = child.pid;
  if (!pid) {
    throw new Error(`${name}: spawn failed (no pid)`);
  }
  // On Unix, process group id equals pid when detached:true
  const pgid = pid;
  const pidFile = pidFileFor(name);
  writeFileSync(
    pidFile,
    JSON.stringify(
      {
        name,
        pid,
        pgid,
        port: opts.port,
        healthUrl: opts.healthUrl,
        startedAt: new Date().toISOString(),
        cwd: opts.cwd,
        command: [opts.command, ...opts.args].join(" "),
      },
      null,
      2,
    ),
  );

  // Do NOT await child exit. Only wait for health with hard timeout.
  child.unref();

  const health = await waitForHealth(opts.healthUrl, {
    timeoutMs: opts.healthTimeoutMs ?? 45_000,
    expectBodyMatch: opts.healthMatch,
  });
  if (!health.ok) {
    await stopByName(name, { force: true });
    throw new Error(
      `${name}: health check failed after ${health.ms}ms (${opts.healthUrl}): ${health.body}`,
    );
  }

  return {
    name,
    port: opts.port,
    healthUrl: opts.healthUrl,
    pid,
    pgid,
    pidFile,
    child,
  };
}

export async function startCareApi(opts?: {
  port?: number;
  databaseUrl?: string;
}): Promise<ManagedService> {
  const port = opts?.port ?? Number(process.env.PORT ?? 3100);
  const databaseUrl =
    opts?.databaseUrl ??
    process.env.DATABASE_URL ??
    "postgresql://caretaker:caretaker_local_only@localhost:5434/caretaker_relay_dev?schema=public";
  return startDetached("care-api", {
    cwd: FOUNDATION_ROOT,
    command: "npm",
    args: ["run", "care:api"],
    env: {
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
      JWT_SECRET:
        process.env.JWT_SECRET ??
        "cr-local-dev-jwt-secret-not-for-production-32b",
      CARE_STORE_BACKEND: "prisma",
      CARE_UNDERSTAND_MODE: process.env.CARE_UNDERSTAND_MODE ?? "fixture",
      PORT: String(port),
    },
    port,
    healthUrl: `http://127.0.0.1:${port}/api/v1/care/health`,
    healthMatch: /"product_id"\s*:\s*"caretaker-relay"/,
  });
}

export async function startViteApp(opts?: {
  port?: number;
  apiUrl?: string;
}): Promise<ManagedService> {
  const port = opts?.port ?? 5180;
  const apiUrl = opts?.apiUrl ?? "http://127.0.0.1:3100";
  return startDetached("vite-app", {
    cwd: APP_ROOT,
    command: "npm",
    args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)],
    env: {
      VITE_CARE_TRANSPORT: "http",
      VITE_CARE_API_URL: apiUrl,
    },
    port,
    healthUrl: `http://127.0.0.1:${port}/`,
    healthMatch: /caretaker|vite|root/i,
  });
}

function killProcessGroup(pgid: number, signal: NodeJS.Signals = "SIGTERM") {
  try {
    process.kill(-pgid, signal);
  } catch {
    // already dead
  }
}

export async function stopByName(
  name: string,
  opts?: { force?: boolean; waitMs?: number },
): Promise<{ stopped: boolean; portFree: boolean }> {
  const pidFile = pidFileFor(name);
  let pgid: number | undefined;
  let port: number | undefined;
  if (existsSync(pidFile)) {
    try {
      const meta = JSON.parse(readFileSync(pidFile, "utf8")) as {
        pgid?: number;
        pid?: number;
        port?: number;
      };
      pgid = meta.pgid ?? meta.pid;
      port = meta.port;
    } catch {
      // ignore
    }
  }

  if (pgid) {
    killProcessGroup(pgid, "SIGTERM");
  }

  const waitMs = opts?.waitMs ?? 8_000;
  const start = Date.now();
  while (Date.now() - start < waitMs) {
    const still =
      (pgid ? isProcessAlive(pgid) : false) ||
      (port ? isPortListening(port) : false);
    if (!still) break;
    await sleep(200);
  }

  if (opts?.force !== false) {
    if (pgid && isProcessAlive(pgid)) {
      killProcessGroup(pgid, "SIGKILL");
    }
    if (port && isPortListening(port)) {
      try {
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

  await sleep(200);
  if (existsSync(pidFile)) {
    try {
      unlinkSync(pidFile);
    } catch {
      // ignore
    }
  }

  const portFree = port ? !isPortListening(port) : true;
  return { stopped: true, portFree };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopAllCareDevServices(): Promise<void> {
  await stopByName("vite-app", { force: true });
  await stopByName("care-api", { force: true });
  // Orphan sweep for common listeners
  for (const port of [3100, 5180]) {
    if (isPortListening(port)) {
      try {
        const pids = execSync(`lsof -ti :${port}`, { encoding: "utf8" })
          .trim()
          .split("\n")
          .filter(Boolean);
        for (const p of pids) {
          try {
            process.kill(Number(p), "SIGTERM");
          } catch {
            // ignore
          }
        }
        await sleep(500);
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
}

export { FOUNDATION_ROOT, APP_ROOT, RUN_DIR };
