/**
 * PHI / secret redaction for operational logs and audit detail payloads.
 * Prefer structured IDs + correlation IDs over free-text care content.
 */

const SECRET_KEYS =
  /pass(word)?|token|secret|authorization|cookie|api[_-]?key|refresh|jwt|otp|code|invite/i;
const PHI_KEYS =
  /name|email|phone|address|dob|date_of_birth|medication|dose|note|transcript|prompt|response|body|content|ssn|mrn/i;

const REDACTED = "[REDACTED]";

export function redactString(value: string, maxLen = 80): string {
  if (!value) return value;
  // Tokens / bearer
  if (/^eyJ[A-Za-z0-9_-]+\./.test(value)) return REDACTED;
  if (/Bearer\s+\S+/i.test(value)) return value.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  // Email-like
  let out = value.replace(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    "[email]",
  );
  // Phone-like
  out = out.replace(
    /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    "[phone]",
  );
  // Long free text likely care notes
  if (out.length > maxLen) {
    out = out.slice(0, maxLen) + "…";
  }
  return out;
}

export function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (depth > 6) return REDACTED;
  if (SECRET_KEYS.test(key)) return REDACTED;
  if (value == null) return value;
  if (typeof value === "string") {
    if (PHI_KEYS.test(key) && value.length > 0) {
      // Keep short enums; redact longer free text
      if (value.length > 24 || /@/.test(value)) return redactString(value, 40);
    }
    return redactString(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((v, i) => redactValue(String(i), v, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

/** Safe audit/details object for CareAuditRow.details */
export function redactAuditDetails(
  details: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!details) return {};
  return redactValue("details", details) as Record<string, unknown>;
}

/** Safe operational log line fields */
export function redactLogFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return redactValue("log", fields) as Record<string, unknown>;
}

export const PHI_REDACTION_RULES = {
  forbid_in_ops_logs: [
    "raw_passwords",
    "verification_codes",
    "invite_tokens",
    "api_secrets",
    "full_unredacted_prompts",
    "care_note_bodies",
    "document_content",
  ],
  prefer: ["correlation_id", "actor_person_id", "care_recipient_id", "action", "reason_code"],
} as const;
