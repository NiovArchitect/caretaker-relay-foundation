/**
 * Care audit event taxonomy + retention policy (product documentation as code).
 * Does not claim legal retention compliance without counsel.
 */

export const CARE_AUDIT_ACTIONS = [
  "ACCOUNT_REGISTERED",
  "CONTACT_VERIFICATION_ISSUED",
  "CONTACT_VERIFIED",
  "FOUNDATION_AUTH_LOGIN",
  "CARE_LAB_LOGIN",
  "CARE_LAB_EMAIL_LOGIN",
  "LOGIN_FAILED",
  "SESSION_LOGOUT",
  "SESSION_REVOKED",
  "SESSIONS_REVOKED_ALL",
  "INVITATION_CREATED",
  "INVITATION_ACCEPTED",
  "ACCESS_REQUEST_SUBMITTED",
  "ACCESS_REQUEST_APPROVED",
  "ACCESS_REQUEST_DENIED",
  "ACCESS_REVOKED",
  "SCOPE_MODIFIED",
  "PROVISIONAL_RECIPIENT_CREATED",
  "PROVISIONAL_RECIPIENT_BOUND",
  "PROVISIONAL_RECIPIENT_ACTIVATED",
  "PROVISIONAL_RECIPIENT_DECLINED",
  "CARE_ANSWER",
  "CARE_UNDERSTAND",
  "CARE_EXPORT",
  "CARE_DATA_VIEW",
  "CARE_DATA_WRITE",
  "AI_MODEL_CALL_BLOCKED",
  "AI_MODEL_CALL",
  "ACCOUNT_SUSPENDED",
] as const;

export type CareAuditAction = (typeof CARE_AUDIT_ACTIONS)[number];

export const AUDIT_RETENTION_POLICY = {
  product_default_days: 365,
  security_events_days: 730,
  note: "Operational default only — legal retention requires counsel and customer contract.",
  authorized_viewers: ["controlling_authority", "security_ops", "incident_response"],
  tamper: "append-only CareAuditRow; no client mutation API",
  deletion: "soft retention hold during investigation; hard delete EXTERNAL process",
} as const;

export function isKnownAuditAction(action: string): boolean {
  return (CARE_AUDIT_ACTIONS as readonly string[]).includes(action);
}
