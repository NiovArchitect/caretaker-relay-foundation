import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUDIT_PRODUCT_TAG,
  FORBIDDEN_PEER_PRODUCT_IDS,
  FOUNDATION_ORIGIN_SHA,
  LOCAL_DATABASE_NAME,
  PRODUCT_ID,
  PRODUCT_NAMESPACE,
  REDIS_KEY_PREFIX,
  assertCaretakerProductId,
  isForbiddenPeerProduct,
  queueName,
  redisKey,
} from "../../../packages/product-identity/src/index";

const root = resolve(__dirname, "../../..");

describe("Caretaker Relay product isolation", () => {
  it("uses caretaker-relay product identity", () => {
    expect(PRODUCT_ID).toBe("caretaker-relay");
    expect(PRODUCT_NAMESPACE).toBe("cr");
    expect(AUDIT_PRODUCT_TAG).toBe("caretaker-relay");
    expect(LOCAL_DATABASE_NAME).toBe("caretaker_relay_dev");
    expect(REDIS_KEY_PREFIX).toBe("cr:");
    expect(FOUNDATION_ORIGIN_SHA).toMatch(/^[a-f0-9]{40}$/);
  });

  it("forbids Otzar as self product id", () => {
    expect(isForbiddenPeerProduct("otzar")).toBe(true);
    expect(isForbiddenPeerProduct("niov-otzar")).toBe(true);
    expect(isForbiddenPeerProduct("caretaker-relay")).toBe(false);
    expect(() => assertCaretakerProductId("otzar")).toThrow(/Invalid product id/);
    expect(() => assertCaretakerProductId("caretaker-relay")).not.toThrow();
  });

  it("namespaces redis keys and queues under cr", () => {
    expect(redisKey(["session", "abc"])).toBe("cr:session:abc");
    expect(queueName("handoff")).toBe("cr.queues.handoff");
  });

  it("root package.json is not niov-foundation / otzar product name", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    ) as { name: string; description?: string };
    expect(pkg.name).toBe("caretaker-relay-foundation");
    expect(pkg.name).not.toBe("niov-foundation");
    expect(String(pkg.description ?? "").toLowerCase()).toMatch(/caretaker/);
  });

  it("docker-compose local stack does not use Otzar container names or DB", () => {
    const compose = readFileSync(
      resolve(root, "docker-compose.local.yml"),
      "utf8",
    );
    expect(compose).toMatch(/caretaker_relay/);
    expect(compose).toMatch(/cr-local-pg/);
    expect(compose).not.toMatch(/container_name:\s*niov-local-pg\b/);
    expect(compose).not.toMatch(/POSTGRES_DB:\s*foundation_test\b/);
    expect(compose).not.toMatch(/api\.otzar\.ai/);
    expect(compose).not.toMatch(/app\.otzar\.ai/);
  });

  it("render blueprint is not otzar-api / otzar domains", () => {
    const render = readFileSync(resolve(root, "render.yaml"), "utf8");
    expect(render).toMatch(/caretaker-relay-api/);
    expect(render).not.toMatch(/name:\s*otzar-api\b/);
    expect(render).not.toMatch(/api\.otzar\.ai/);
    expect(render).not.toMatch(/app\.otzar\.ai/);
    expect(render).not.toMatch(/OTZAR_ENTITY_ID/);
  });

  it("env example uses caretaker database and product tags", () => {
    const env = readFileSync(resolve(root, ".env.example"), "utf8");
    expect(env).toMatch(/caretaker_relay/);
    expect(env).toMatch(/PRODUCT_ID=caretaker-relay/);
    expect(env).not.toMatch(/postgresql:\/\/otzar:otzar@/);
    expect(env).not.toMatch(/CONTROL_TOWER_URL=https:\/\/app\.otzar\.ai/);
  });

  it("provenance and isolation docs exist", () => {
    for (const rel of [
      "docs/FOUNDATION_ORIGIN.md",
      "docs/UPSTREAM_PORTING_POLICY.md",
      "docs/PRODUCT_ISOLATION.md",
    ]) {
      expect(existsSync(resolve(root, rel))).toBe(true);
    }
    const origin = readFileSync(
      resolve(root, "docs/FOUNDATION_ORIGIN.md"),
      "utf8",
    );
    expect(origin).toContain(FOUNDATION_ORIGIN_SHA);
    expect(origin).toContain("niov-foundation");
  });

  it("forbidden peer list is non-empty and stable", () => {
    expect(FORBIDDEN_PEER_PRODUCT_IDS.length).toBeGreaterThan(0);
    expect([...FORBIDDEN_PEER_PRODUCT_IDS]).toContain("otzar");
  });
});
