/**
 * Shared session revocation — multi-instance safe when backed by Redis/shared store.
 * Lab JWT path uses this instead of process-local-only denylist for production scale-out.
 *
 * Backends:
 * - memory: injectable shared Map (tests / single-instance)
 * - redis: via adapter set/get with TTL
 * - principal token version: invalidate all sessions for a principal
 */

export interface SharedRevocationAdapter {
  /** Set key with TTL seconds */
  setEx(key: string, ttlSeconds: number, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

const DEFAULT_TTL_SEC = 12 * 60 * 60;
const KEY_PREFIX = "cr:sess:rev:";
const PRINCIPAL_VER_PREFIX = "cr:sess:pver:";
const PRINCIPAL_SESSIONS_PREFIX = "cr:sess:plist:";

export class MemorySharedRevocationAdapter implements SharedRevocationAdapter {
  /** Shared across all MemorySharedRevocationAdapter instances when useGlobal=true */
  private static globalStore = new Map<
    string,
    { value: string; expiresAt: number }
  >();

  constructor(private readonly useGlobal = true) {}

  private store() {
    return this.useGlobal
      ? MemorySharedRevocationAdapter.globalStore
      : this.localStore;
  }
  private localStore = new Map<string, { value: string; expiresAt: number }>();

  async setEx(key: string, ttlSeconds: number, value: string): Promise<void> {
    this.store().set(key, {
      value,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  }

  async get(key: string): Promise<string | null> {
    const e = this.store().get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.store().delete(key);
      return null;
    }
    return e.value;
  }

  async del(key: string): Promise<void> {
    this.store().delete(key);
  }

  /** Test helper: clear global memory store */
  static clearGlobal(): void {
    MemorySharedRevocationAdapter.globalStore.clear();
  }
}

export class SharedSessionRevocation {
  constructor(
    private readonly adapter: SharedRevocationAdapter,
    private readonly ttlSeconds = DEFAULT_TTL_SEC,
  ) {}

  async revokeSession(
    sessionId: string,
    opts?: { reason?: string; actorPersonId?: string; principalId?: string },
  ): Promise<void> {
    const payload = JSON.stringify({
      reason: opts?.reason ?? "logout",
      at: new Date().toISOString(),
      actor: opts?.actorPersonId,
    });
    await this.adapter.setEx(KEY_PREFIX + sessionId, this.ttlSeconds, payload);
    if (opts?.principalId) {
      await this.trackPrincipalSession(opts.principalId, sessionId);
    }
  }

  async isSessionRevoked(sessionId: string): Promise<boolean> {
    const v = await this.adapter.get(KEY_PREFIX + sessionId);
    return v != null;
  }

  /**
   * Bump principal session version — any JWT minted before this version is invalid
   * when claims include pver (optional future). Also revokes tracked session ids.
   */
  async revokeAllForPrincipal(
    principalId: string,
    opts?: { reason?: string },
  ): Promise<number> {
    const verKey = PRINCIPAL_VER_PREFIX + principalId;
    const cur = await this.adapter.get(verKey);
    const next = String((Number(cur) || 0) + 1);
    await this.adapter.setEx(verKey, this.ttlSeconds * 7, next);

    const listKey = PRINCIPAL_SESSIONS_PREFIX + principalId;
    const raw = await this.adapter.get(listKey);
    let count = 0;
    if (raw) {
      try {
        const ids = JSON.parse(raw) as string[];
        for (const sid of ids) {
          await this.revokeSession(sid, {
            reason: opts?.reason ?? "principal_revoke_all",
            principalId,
          });
          count += 1;
        }
      } catch {
        /* ignore */
      }
    }
    await this.adapter.setEx(listKey, this.ttlSeconds, "[]");
    return count;
  }

  async getPrincipalVersion(principalId: string): Promise<number> {
    const v = await this.adapter.get(PRINCIPAL_VER_PREFIX + principalId);
    return Number(v) || 0;
  }

  async trackPrincipalSession(
    principalId: string,
    sessionId: string,
  ): Promise<void> {
    const listKey = PRINCIPAL_SESSIONS_PREFIX + principalId;
    const raw = await this.adapter.get(listKey);
    let ids: string[] = [];
    if (raw) {
      try {
        ids = JSON.parse(raw) as string[];
      } catch {
        ids = [];
      }
    }
    if (!ids.includes(sessionId)) ids.push(sessionId);
    // Cap list size
    if (ids.length > 100) ids = ids.slice(-100);
    await this.adapter.setEx(listKey, this.ttlSeconds, JSON.stringify(ids));
  }
}

/** Default shared store for lab JWT (memory global — multi-instance needs Redis adapter). */
let defaultShared: SharedSessionRevocation | null = null;

export function getSharedSessionRevocation(): SharedSessionRevocation {
  if (!defaultShared) {
    defaultShared = new SharedSessionRevocation(
      new MemorySharedRevocationAdapter(true),
    );
  }
  return defaultShared;
}

export function setSharedSessionRevocation(
  store: SharedSessionRevocation,
): void {
  defaultShared = store;
}

export function createSharedSessionRevocationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): {
  store: SharedSessionRevocation;
  backend: "memory_shared" | "redis";
  multiInstanceSafe: boolean;
} {
  // Redis adapter is injected by API layer when REDIS_URL present
  void env;
  return {
    store: getSharedSessionRevocation(),
    backend: "memory_shared",
    multiInstanceSafe: false,
  };
}
