/**
 * Caretaker Relay product identity.
 *
 * Runtime and deploy configuration must read from here (or config/product.ts)
 * so Otzar namespaces cannot be used by accident.
 */

export const PRODUCT_ID = "caretaker-relay" as const;
export const PRODUCT_NAME = "Caretaker Relay" as const;
export const PRODUCT_NAMESPACE = "cr" as const;
export const PRODUCT_SHORT = "CR" as const;

/** Peer products that must never share data paths with this product. */
export const FORBIDDEN_PEER_PRODUCT_IDS = ["otzar", "niov-otzar"] as const;

export const LOCAL_DATABASE_NAME = "caretaker_relay_dev" as const;
export const LOCAL_DATABASE_TEST_NAME = "caretaker_relay_test" as const;
export const REDIS_KEY_PREFIX = "cr:" as const;
export const QUEUE_NAMESPACE = "cr.queues" as const;
export const AUDIT_PRODUCT_TAG = "caretaker-relay" as const;
export const OBJECT_STORAGE_PREFIX = "cr/" as const;
export const ENCRYPTION_NAMESPACE = "caretaker-relay" as const;

export const DEFAULT_API_SERVICE_NAME = "caretaker-relay-api" as const;
export const DEFAULT_LOCAL_API_PORT = 3100 as const;
export const DEFAULT_LOCAL_APP_PORT = 5180 as const;

/** Source Foundation pin recorded at fork. */
export const FOUNDATION_ORIGIN_SHA =
  "afe1491d882cbca4b0ce95db6f85ec0ad85dd16f" as const;
export const FOUNDATION_ORIGIN_REPO = "niov-foundation" as const;

export type ProductId = typeof PRODUCT_ID;

export function assertCaretakerProductId(id: string): asserts id is ProductId {
  if (id !== PRODUCT_ID) {
    throw new Error(
      `Invalid product id "${id}". Expected "${PRODUCT_ID}". Cross-product configuration is forbidden.`,
    );
  }
  if ((FORBIDDEN_PEER_PRODUCT_IDS as readonly string[]).includes(id)) {
    throw new Error(`Forbidden peer product id used as self: ${id}`);
  }
}

export function isForbiddenPeerProduct(id: string): boolean {
  return (FORBIDDEN_PEER_PRODUCT_IDS as readonly string[]).includes(id);
}

export function redisKey(parts: string[]): string {
  return `${REDIS_KEY_PREFIX}${parts.join(":")}`;
}

export function queueName(name: string): string {
  return `${QUEUE_NAMESPACE}.${name}`;
}
