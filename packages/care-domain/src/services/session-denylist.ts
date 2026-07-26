/**
 * Bounded lab-JWT session denylist.
 * Foundation AuthService sessions terminate via DB; lab JWTs need explicit revoke.
 * Entries expire with the token TTL (default 12h) and are pruned on access.
 */

export interface DenylistEntry {
  sessionId: string;
  revokedAt: number;
  expiresAt: number;
  reason: string;
  actorPersonId?: string;
}

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_ENTRIES = 50_000;

export class SessionDenylist {
  private entries = new Map<string, DenylistEntry>();

  revoke(
    sessionId: string,
    opts?: {
      ttlMs?: number;
      reason?: string;
      actorPersonId?: string;
      now?: number;
    },
  ): void {
    const now = opts?.now ?? Date.now();
    const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.prune(now);
    if (this.entries.size >= MAX_ENTRIES) {
      // Drop oldest by expiresAt
      const sorted = [...this.entries.values()].sort(
        (a, b) => a.expiresAt - b.expiresAt,
      );
      const drop = sorted.slice(0, Math.ceil(MAX_ENTRIES * 0.1));
      for (const e of drop) this.entries.delete(e.sessionId);
    }
    this.entries.set(sessionId, {
      sessionId,
      revokedAt: now,
      expiresAt: now + ttl,
      reason: opts?.reason ?? "logout",
      actorPersonId: opts?.actorPersonId,
    });
  }

  /** Revoke many sessions for a principal (track by optional index). */
  revokeAllForPrincipal(
    sessionIds: string[],
    opts?: { reason?: string; actorPersonId?: string },
  ): number {
    let n = 0;
    for (const sid of sessionIds) {
      this.revoke(sid, opts);
      n += 1;
    }
    return n;
  }

  isRevoked(sessionId: string, now = Date.now()): boolean {
    this.prune(now);
    const e = this.entries.get(sessionId);
    if (!e) return false;
    if (e.expiresAt <= now) {
      this.entries.delete(sessionId);
      return false;
    }
    return true;
  }

  prune(now = Date.now()): number {
    let removed = 0;
    for (const [k, v] of this.entries) {
      if (v.expiresAt <= now) {
        this.entries.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }
}

/** Process-wide denylist for care lab JWT path (per API process). */
export const careLabSessionDenylist = new SessionDenylist();
