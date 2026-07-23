/**
 * @caretaker-relay/care-domain
 *
 * Caregiver-first domain layer for Caretaker Relay.
 * Lives inside caretaker-relay-foundation; UI must not invent a second backend.
 */

/**
 * Browser-safe + Node-safe domain surface.
 * Node-only modules (file store, care-auth crypto) are subpath exports:
 *   @caretaker-relay/care-domain/file-store
 *   @caretaker-relay/care-domain/care-auth
 */
export * from "./types.js";
export * from "./llm/provider.js";
export * from "./store/memory-store.js";
export * from "./services/access.js";
export * from "./services/safety.js";
export * from "./services/dose-units.js";
export * from "./services/understand.js";
export * from "./services/invitation.js";
export * from "./services/loop.js";
export * from "./services/timezone.js";
export * from "./services/export.js";
export * from "./services/idempotency.js";
export * from "./fhir/mapping.js";
export * from "./scenario/olivia.js";
export * from "./datasets/golden.js";

import { MemoryCareStore } from "./store/memory-store.js";
import { CareLoopService } from "./services/loop.js";
import { seedOliviaScenario } from "./scenario/olivia.js";
import type { LLMProvider } from "./llm/provider.js";

export interface CreateCareRuntimeOptions {
  /** fixture = deterministic lab; llm = Foundation LLMProvider required */
  mode?: "fixture" | "llm";
  provider?: LLMProvider;
  seedOlivia?: boolean;
}

/** Factory used by app and tests to obtain a Foundation-backed care runtime. */
export function createCareRuntime(opts: CreateCareRuntimeOptions = {}) {
  const store = new MemoryCareStore();
  if (opts.seedOlivia !== false) {
    seedOliviaScenario(store);
  }
  const service = new CareLoopService({
    store,
    defaultMode: opts.mode ?? "fixture",
    provider: opts.provider,
  });
  return { store, service };
}
