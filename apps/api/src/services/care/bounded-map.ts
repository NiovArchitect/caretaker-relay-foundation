/**
 * Process-local Map with max size (LRU-ish FIFO on insert overflow) and optional TTL.
 * Used for acceleration caches that must not grow without bound.
 * Durable facts belong in Prisma; this is never the sole source of truth for
 * multi-instance or post-restart safety-critical state.
 */

export interface BoundedMapOptions {
  maxSize: number;
  /** Entry lifetime in ms; 0 = no TTL. */
  ttlMs?: number;
  /** Metric name for structured logs / stats. */
  name?: string;
}

export interface BoundedMapStats {
  name: string;
  size: number;
  maxSize: number;
  ttlMs: number;
  inserts: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
}

export class BoundedMap<V> {
  private readonly data = new Map<string, { value: V; at: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly name: string;
  private inserts = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(opts: BoundedMapOptions) {
    if (opts.maxSize < 1) {
      throw new Error("BoundedMap maxSize must be >= 1");
    }
    this.maxSize = opts.maxSize;
    this.ttlMs = opts.ttlMs ?? 0;
    this.name = opts.name ?? "bounded-map";
  }

  get size(): number {
    this.sweepExpired();
    return this.data.size;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  get(key: string): V | undefined {
    const entry = this.data.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (this.ttlMs > 0 && Date.now() - entry.at > this.ttlMs) {
      this.data.delete(key);
      this.expirations += 1;
      this.misses += 1;
      return undefined;
    }
    // refresh LRU order: re-insert at end
    this.data.delete(key);
    this.data.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.data.has(key)) {
      this.data.delete(key);
    }
    this.data.set(key, { value, at: Date.now() });
    this.inserts += 1;
    while (this.data.size > this.maxSize) {
      const oldest = this.data.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.data.delete(oldest);
      this.evictions += 1;
    }
  }

  delete(key: string): boolean {
    return this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }

  /** Iterate live (non-expired) entries. */
  *entries(): IterableIterator<[string, V]> {
    this.sweepExpired();
    for (const [k, e] of this.data) {
      yield [k, e.value];
    }
  }

  stats(): BoundedMapStats {
    this.sweepExpired();
    return {
      name: this.name,
      size: this.data.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
      inserts: this.inserts,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }

  private sweepExpired(): void {
    if (this.ttlMs <= 0) return;
    const now = Date.now();
    for (const [k, e] of this.data) {
      if (now - e.at > this.ttlMs) {
        this.data.delete(k);
        this.expirations += 1;
      }
    }
  }
}

/**
 * Simple concurrency gate: at most `max` concurrent runners; excess wait in queue.
 * Rejects when queue exceeds maxQueue (back-pressure).
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private admitted = 0;
  private rejected = 0;
  private completed = 0;

  constructor(
    private readonly max: number,
    private readonly maxQueue: number,
    private readonly name = "concurrency-gate",
  ) {
    if (max < 1) throw new Error("ConcurrencyGate max must be >= 1");
  }

  get activeCount(): number {
    return this.active;
  }

  get queueDepth(): number {
    return this.waiters.length;
  }

  stats() {
    return {
      name: this.name,
      max: this.max,
      maxQueue: this.maxQueue,
      active: this.active,
      queueDepth: this.waiters.length,
      admitted: this.admitted,
      rejected: this.rejected,
      completed: this.completed,
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      this.admitted += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueue) {
      this.rejected += 1;
      return Promise.reject(
        new Error(
          `${this.name}: queue full (maxQueue=${this.maxQueue}, active=${this.active})`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({
        resolve: () => {
          this.active += 1;
          this.admitted += 1;
          resolve();
        },
        reject,
      });
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.completed += 1;
    const next = this.waiters.shift();
    if (next) next.resolve();
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
