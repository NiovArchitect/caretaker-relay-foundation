/**
 * Care-domain LLM provider contract.
 *
 * Mirrors Foundation's LLMProvider shape (apps/api/src/services/llm/llm.service.ts)
 * so Understand can use the real Foundation abstraction without a parallel client.
 *
 * When apps/api is available, inject Foundation getLLMProvider() / MockLLMProvider.
 * Care domain must not ship a second production HTTP client for Anthropic/OpenAI.
 */

export type LLMResult =
  | { ok: true; text: string; provider: string; model: string }
  | { ok: false; code: string; fallback_message: string; provider: string };

export interface LLMProvider {
  readonly name: string;
  generateResponse(
    args: { system: string; user: string; context?: string },
    opts?: { fixtureKey?: string },
  ): Promise<LLMResult>;
}

/**
 * Adapter that wraps an already-constructed Foundation LLMProvider.
 * Used when caretaker-relay-foundation API process injects its service.
 */
export function adaptFoundationLLMProvider(provider: LLMProvider): LLMProvider {
  return provider;
}

/** Scripted provider for deterministic care tests — explicitly FIXTURE-class. */
export class CareScriptedLLMProvider implements LLMProvider {
  readonly name = "care-scripted-fixture";
  private readonly scripts: Array<{ match: RegExp | string; response: string }>;

  constructor(
    scripts: Array<{ match: RegExp | string; response: string }> = [],
  ) {
    this.scripts = scripts;
  }

  async generateResponse(
    args: { system: string; user: string; context?: string },
  ): Promise<LLMResult> {
    for (const s of this.scripts) {
      const hit =
        typeof s.match === "string"
          ? args.user.includes(s.match)
          : s.match.test(args.user);
      if (hit) {
        return {
          ok: true,
          text: s.response,
          provider: this.name,
          model: "fixture-script",
        };
      }
    }
    return {
      ok: false,
      code: "NO_SCRIPT",
      fallback_message: "CareScriptedLLMProvider has no matching script",
      provider: this.name,
    };
  }
}
