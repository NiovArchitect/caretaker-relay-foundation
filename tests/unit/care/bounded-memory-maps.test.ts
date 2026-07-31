/**
 * Memory reliability: bounded maps, concurrency gate, store inventory counts.
 * No public network. No PHI assertions.
 */
import { describe, expect, it } from "vitest";
import { MemoryCareStore } from "@caretaker-relay/care-domain";
import {
  BoundedMap,
  ConcurrencyGate,
} from "../../../apps/api/src/services/care/bounded-map.js";

describe("BoundedMap", () => {
  it("evicts oldest when over maxSize", () => {
    const m = new BoundedMap<number>({ name: "t", maxSize: 3 });
    m.set("a", 1);
    m.set("b", 2);
    m.set("c", 3);
    m.set("d", 4);
    expect(m.has("a")).toBe(false);
    expect(m.get("b")).toBe(2);
    expect(m.get("d")).toBe(4);
    const s = m.stats();
    expect(s.size).toBe(3);
    expect(s.evictions).toBeGreaterThanOrEqual(1);
  });

  it("expires entries after TTL", async () => {
    const m = new BoundedMap<string>({ name: "ttl", maxSize: 10, ttlMs: 30 });
    m.set("k", "v");
    expect(m.get("k")).toBe("v");
    await new Promise((r) => setTimeout(r, 45));
    expect(m.get("k")).toBeUndefined();
    expect(m.stats().expirations).toBeGreaterThanOrEqual(1);
  });
});

describe("ConcurrencyGate", () => {
  it("limits concurrent runners and queues", async () => {
    const gate = new ConcurrencyGate(1, 5, "test_gate");
    let concurrent = 0;
    let peak = 0;
    const run = async (ms: number) =>
      gate.run(async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, ms));
        concurrent -= 1;
        return ms;
      });
    const results = await Promise.all([run(40), run(10), run(10)]);
    expect(results).toEqual([40, 10, 10]);
    expect(peak).toBe(1);
    expect(gate.stats().completed).toBe(3);
  });

  it("rejects when queue is full", async () => {
    const gate = new ConcurrencyGate(1, 1, "full");
    const slow = gate.run(() => new Promise((r) => setTimeout(r, 80)));
    // fill the single queue slot
    const queued = gate.run(async () => "q");
    await expect(
      gate.run(async () => "overflow"),
    ).rejects.toThrow(/queue full/);
    await slow;
    await queued;
  });
});

describe("MemoryCareStore.inventoryCounts", () => {
  it("returns zeroed counts on empty store and grows by family", () => {
    const store = new MemoryCareStore();
    const empty = store.inventoryCounts();
    expect(empty.people).toBe(0);
    expect(empty.recipients).toBe(0);
    store.upsertPerson({
      id: "p1",
      displayName: "Test",
      kind: "family_caregiver",
    });
    store.upsertRecipient({
      id: "r1",
      displayName: "Recipient",
      householdId: "h1",
    });
    const after = store.inventoryCounts();
    expect(after.people).toBe(1);
    expect(after.recipients).toBe(1);
    // Ensure no PHI keys
    expect(JSON.stringify(after)).not.toMatch(/Test|Recipient|h1|p1|r1/);
  });
});

describe("payload history bound constants", () => {
  it("history limit clamps to [1, 200]", () => {
    const clamp = (raw: number) =>
      Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : 100;
    expect(clamp(0)).toBe(1);
    expect(clamp(50)).toBe(50);
    expect(clamp(9999)).toBe(200);
    expect(clamp(Number.NaN)).toBe(100);
  });
});
