/**
 * Production configuration fail-closed gates for Caretaker Relay care API.
 * Unsafe combinations fail startup or disable capabilities.
 */

export type CareDeploymentMode =
  | "synthetic_demo"
  | "consumer"
  | "regulated_restricted"
  | "regulated_ai_enabled"
  | "test";

export interface CareConfigValidation {
  ok: boolean;
  mode: CareDeploymentMode;
  errors: string[];
  warnings: string[];
  flags: {
    labLoginEnabled: boolean;
    testVerifyCodesAllowed: boolean;
    aiLiveAllowed: boolean;
    multiInstanceSessionSafe: boolean;
    sharedRevocationBackend: "memory_shared" | "redis" | "none";
  };
  /** Safe for /health — no secrets */
  publicStatus: Record<string, string | boolean | number>;
}

export function resolveCareDeploymentMode(
  env: NodeJS.ProcessEnv = process.env,
): CareDeploymentMode {
  const explicit = (env.CARE_DEPLOYMENT_MODE ?? "").toLowerCase();
  if (
    explicit === "synthetic_demo" ||
    explicit === "consumer" ||
    explicit === "regulated_restricted" ||
    explicit === "regulated_ai_enabled" ||
    explicit === "test"
  ) {
    return explicit;
  }
  if (env.NODE_ENV === "test") return "test";
  if (env.NODE_ENV !== "production") return "synthetic_demo";
  // Production without explicit mode: conservative
  return "regulated_restricted";
}

export function validateCareProductionConfig(
  env: NodeJS.ProcessEnv = process.env,
): CareConfigValidation {
  const mode = resolveCareDeploymentMode(env);
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProd = env.NODE_ENV === "production";
  const hasRedis = Boolean(env.REDIS_URL);
  const baa =
    env.CARE_AI_BAA_EXECUTED === "1" || env.CARE_AI_BAA_EXECUTED === "true";
  const phiAllowed =
    env.CARE_AI_PHI_ALLOWED === "1" || env.CARE_AI_PHI_ALLOWED === "true";
  const requireBaa =
    env.CARE_AI_REQUIRE_BAA === "1" ||
    env.CARE_AI_REQUIRE_BAA === "true" ||
    mode === "regulated_restricted" ||
    mode === "regulated_ai_enabled";
  const understand = (env.CARE_UNDERSTAND_MODE ?? "").toLowerCase();
  const labLogin =
    env.CARE_LAB_LOGIN_ENABLED === "1" ||
    env.CARE_LAB_LOGIN_ENABLED === "true" ||
    (!isProd && mode === "synthetic_demo") ||
    mode === "test";

  // Production must disable lab login unless explicitly isolated
  let labLoginEnabled = labLogin;
  if (isProd && mode !== "synthetic_demo" && env.CARE_LAB_LOGIN_ENABLED !== "1") {
    labLoginEnabled = false;
  }
  if (isProd && labLoginEnabled && mode.startsWith("regulated")) {
    errors.push("Lab login cannot be enabled in regulated production mode");
  }

  // Test verify codes
  const testCodes =
    env.CARE_EXPOSE_VERIFY_CODE === "1" ||
    (env.CARE_VERIFICATION_PROVIDER ?? "none") === "test";
  let testVerifyCodesAllowed = testCodes && !isProd;
  if (isProd && env.CARE_EXPOSE_VERIFY_CODE === "1") {
    errors.push("CARE_EXPOSE_VERIFY_CODE cannot be set in production");
    testVerifyCodesAllowed = false;
  }
  if (isProd && (env.CARE_VERIFICATION_PROVIDER ?? "") === "test") {
    errors.push("Test verification provider cannot run in production");
  }

  // AI
  // Synthetic/lab competition universe may use Grok without PHI BAA (Mode B).
  // Live PHI (Mode C) still requires dual BAA+PHI flags.
  const syntheticUniverse =
    env.CARE_AI_DATA_CLASS === "synthetic" ||
    env.CARE_AI_DATA_CLASS === "lab";
  let aiLiveAllowed = true;
  if (syntheticUniverse) {
    aiLiveAllowed = true;
    if (understand === "llm" || env.XAI_API_KEY || env.OPENAI_API_KEY) {
      warnings.push(
        "CARE_AI_DATA_CLASS=synthetic|lab: live model permitted for synthetic/de-identified care universes only (per-recipient server check still required)",
      );
    }
  } else if (mode === "regulated_restricted") {
    if (
      understand === "llm" ||
      env.ANTHROPIC_API_KEY ||
      env.OPENAI_API_KEY ||
      env.XAI_API_KEY
    ) {
      if (!baa || !phiAllowed) {
        // Fail closed: disable live AI rather than crash entire API if already deployed
        aiLiveAllowed = false;
        warnings.push(
          "regulated_restricted: live AI disabled without BAA+PHI allow flags (set CARE_AI_BAA_EXECUTED=1 and CARE_AI_PHI_ALLOWED=1, or CARE_AI_DATA_CLASS=synthetic)",
        );
      }
    }
  }
  if (!syntheticUniverse && mode === "regulated_ai_enabled") {
    if (!baa || !phiAllowed) {
      errors.push(
        "regulated_ai_enabled requires CARE_AI_BAA_EXECUTED=1 and CARE_AI_PHI_ALLOWED=1",
      );
      aiLiveAllowed = false;
    }
  }
  if (
    !syntheticUniverse &&
    requireBaa &&
    understand === "llm" &&
    (!baa || !phiAllowed)
  ) {
    aiLiveAllowed = false;
  }

  // Shared revocation
  const multiInstance =
    env.CARE_MULTI_INSTANCE === "1" ||
    env.RENDER_INSTANCE_COUNT === "2" ||
    Number(env.WEB_CONCURRENCY ?? "1") > 1;
  let sharedRevocationBackend: "memory_shared" | "redis" | "none" = hasRedis
    ? "redis"
    : "memory_shared";
  let multiInstanceSessionSafe = hasRedis;
  if (isProd && multiInstance && !hasRedis) {
    errors.push(
      "Multi-instance production requires REDIS_URL for shared session revocation",
    );
    multiInstanceSessionSafe = false;
  }
  if (isProd && !hasRedis && mode.startsWith("regulated")) {
    warnings.push(
      "No REDIS_URL: session revocation is memory-shared per process only",
    );
  }

  // JWT secret
  if (
    isProd &&
    (!env.JWT_SECRET ||
      env.JWT_SECRET.includes("do-not-use") ||
      env.JWT_SECRET.length < 16)
  ) {
    errors.push("Production JWT_SECRET missing or insecure");
  }

  // CORS
  if (isProd && !env.CARE_CORS_ORIGINS && !env.CARETAKER_APP_URL) {
    warnings.push("CARE_CORS_ORIGINS / CARETAKER_APP_URL not set");
  }

  const ok = errors.length === 0;
  return {
    ok,
    mode,
    errors,
    warnings,
    flags: {
      labLoginEnabled,
      testVerifyCodesAllowed,
      aiLiveAllowed,
      multiInstanceSessionSafe,
      sharedRevocationBackend,
    },
    publicStatus: {
      deployment_mode: mode,
      config_ok: ok,
      lab_login_enabled: labLoginEnabled,
      ai_live_allowed: aiLiveAllowed,
      multi_instance_session_safe: multiInstanceSessionSafe,
      shared_revocation: sharedRevocationBackend,
      understand_mode: understand || "auto",
      care_ai_data_class: env.CARE_AI_DATA_CLASS ?? "unset",
      synthetic_universe: syntheticUniverse,
      verification_provider: env.CARE_VERIFICATION_PROVIDER ?? "none",
      error_count: errors.length,
      warning_count: warnings.length,
    },
  };
}
