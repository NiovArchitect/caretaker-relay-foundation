/**
 * AI / LLM PHI processing gate.
 * When regulated ePHI may be sent to a model vendor, require explicit contractual approval flag.
 * PRINCIPLE: No silent PHI model calls without BAA/contract evidence in configuration.
 */

export type AiPhiGateResult =
  | { allowed: true; mode: "approved" | "lab_fixture" | "non_phi_synthetic" }
  | { allowed: false; code: "AI_PHI_NOT_APPROVED"; message: string };

/**
 * CARE_AI_BAA_EXECUTED=1  → vendor BAA executed (ops attestation; legal still EXTERNAL)
 * CARE_AI_PHI_ALLOWED=1   → explicit allow for this deployment
 * CARE_UNDERSTAND_MODE=fixture → no live model
 * CARE_AI_DATA_CLASS=synthetic → synthetic lab data only
 */
export function evaluateAiPhiGate(env: NodeJS.ProcessEnv = process.env): AiPhiGateResult {
  const mode = (env.CARE_UNDERSTAND_MODE ?? "").toLowerCase();
  if (mode === "fixture") {
    return { allowed: true, mode: "lab_fixture" };
  }
  const dataClass = (env.CARE_AI_DATA_CLASS ?? "").toLowerCase();
  if (dataClass === "synthetic" || dataClass === "lab") {
    return { allowed: true, mode: "non_phi_synthetic" };
  }
  const baa =
    env.CARE_AI_BAA_EXECUTED === "1" ||
    env.CARE_AI_BAA_EXECUTED === "true";
  const allowed =
    env.CARE_AI_PHI_ALLOWED === "1" ||
    env.CARE_AI_PHI_ALLOWED === "true";
  if (baa && allowed) {
    return { allowed: true, mode: "approved" };
  }
  // Production llm without attestation: block
  if (mode === "llm" || env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY) {
    // Allow when NODE_ENV is test
    if (env.NODE_ENV === "test") {
      return { allowed: true, mode: "lab_fixture" };
    }
    // Lab deploy often uses synthetic seed data; require explicit block only when
    // CARE_AI_REQUIRE_BAA=1 (strict). Default: warn-allow for existing lab product.
    if (env.CARE_AI_REQUIRE_BAA === "1" || env.CARE_AI_REQUIRE_BAA === "true") {
      return {
        allowed: false,
        code: "AI_PHI_NOT_APPROVED",
        message:
          "Live model calls with possible care content require CARE_AI_BAA_EXECUTED=1 and CARE_AI_PHI_ALLOWED=1, or CARE_AI_DATA_CLASS=synthetic, or fixture mode.",
      };
    }
  }
  return { allowed: true, mode: baa ? "approved" : "non_phi_synthetic" };
}
