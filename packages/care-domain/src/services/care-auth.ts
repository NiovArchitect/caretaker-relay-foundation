/**
 * Care authentication → AuthCareContext resolution.
 *
 * Production path: Foundation AuthService JWT (entity_id) mapped to care person.
 * Lab path: care-lab JWT with carePersonId claim, signed with same JWT secret style.
 *
 * Authority ≠ relationship: even authenticated principals must pass evaluateAccess.
 */

import { createHmac, randomUUID } from "node:crypto";
import type { CareStore } from "../store/memory-store.js";
import type { AuthCareContext } from "../types.js";
import { people, careRecipient, HOUSEHOLD_OLIVIA } from "../scenario/olivia.js";

export interface CareSessionClaims {
  sub: string; // care person id OR foundation entity id
  sid: string; // session id
  carePersonId: string;
  displayName: string;
  roles: string[];
  ops: string[];
  exp: number;
  iat: number;
  iss: "caretaker-relay-care-auth";
  kind: "care_lab" | "foundation_mapped";
}

export interface CarePrincipalDirectoryEntry {
  carePersonId: string;
  displayName: string;
  roles: string[];
  /** Optional Foundation entity_id when linked */
  foundationEntityId?: string;
  passwordLab?: string;
}

/** Lab directory for Olivia scenario principals (synthetic). */
export function defaultLabDirectory(): CarePrincipalDirectoryEntry[] {
  return [
    {
      carePersonId: people.sadeil.id,
      displayName: people.sadeil.displayName,
      roles: ["family_caregiver", "primary"],
      passwordLab: "sadeil-lab-password",
    },
    {
      carePersonId: people.maya.id,
      displayName: people.maya.displayName,
      roles: ["family_caregiver", "adult_child"],
      passwordLab: "maya-lab-password",
    },
    {
      carePersonId: people.walter.id,
      displayName: people.walter.displayName,
      roles: ["professional", "paid_caregiver"],
      passwordLab: "walter-lab-password",
    },
    {
      carePersonId: people.drShah.id,
      displayName: people.drShah.displayName,
      roles: ["provider", "physician"],
      passwordLab: "drshah-lab-password",
    },
    {
      carePersonId: people.unauthorized.id,
      displayName: people.unauthorized.displayName,
      roles: ["family_caregiver"],
      passwordLab: "unauth-lab-password",
    },
    {
      carePersonId: people.otherHouseholdCaregiver.id,
      displayName: people.otherHouseholdCaregiver.displayName,
      roles: ["family_caregiver"],
      passwordLab: "other-hh-lab-password",
    },
  ];
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signHs256(payload: object, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const sig = createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

function verifyHs256(
  token: string,
  secret: string,
): CareSessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const h = parts[0];
  const b = parts[1];
  const s = parts[2];
  if (!h || !b || !s) return null;
  const data = `${h}.${b}`;
  const expected = createHmac("sha256", secret).update(data).digest("base64url");
  if (s !== expected) return null;
  try {
    const json = JSON.parse(
      Buffer.from(b.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "utf8",
      ),
    ) as CareSessionClaims;
    if (json.exp * 1000 < Date.now()) return null;
    if (json.iss !== "caretaker-relay-care-auth") return null;
    return json;
  } catch {
    return null;
  }
}

export class CareAuthService {
  constructor(
    private readonly secret: string,
    private readonly directory: CarePrincipalDirectoryEntry[] = defaultLabDirectory(),
  ) {}

  loginLab(
    carePersonId: string,
    password: string,
  ):
    | { ok: true; token: string; session_id: string; principal: CarePrincipalDirectoryEntry }
    | { ok: false; code: string; message: string } {
    const principal = this.directory.find((p) => p.carePersonId === carePersonId);
    if (!principal || principal.passwordLab !== password) {
      return {
        ok: false,
        code: "INVALID_CREDENTIALS",
        message: "Invalid care credentials",
      };
    }
    const session_id = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const claims: CareSessionClaims = {
      sub: principal.carePersonId,
      sid: session_id,
      carePersonId: principal.carePersonId,
      displayName: principal.displayName,
      roles: principal.roles,
      ops: ["read", "write"],
      iat: now,
      exp: now + 60 * 60 * 12,
      iss: "caretaker-relay-care-auth",
      kind: "care_lab",
    };
    const token = signHs256(claims, this.secret);
    return { ok: true, token, session_id, principal };
  }

  /**
   * Map a Foundation AuthService-validated entity to care principal
   * when a directory link exists.
   */
  mintFromFoundationEntity(
    entityId: string,
    sessionId: string,
    ops: string[],
  ):
    | { ok: true; token: string; claims: CareSessionClaims }
    | { ok: false; code: string; message: string } {
    const principal = this.directory.find((p) => p.foundationEntityId === entityId);
    if (!principal) {
      return {
        ok: false,
        code: "NO_CARE_MAPPING",
        message:
          "Foundation entity is authenticated but not linked to a care principal",
      };
    }
    const now = Math.floor(Date.now() / 1000);
    const claims: CareSessionClaims = {
      sub: entityId,
      sid: sessionId,
      carePersonId: principal.carePersonId,
      displayName: principal.displayName,
      roles: principal.roles,
      ops,
      iat: now,
      exp: now + 60 * 60 * 12,
      iss: "caretaker-relay-care-auth",
      kind: "foundation_mapped",
    };
    return { ok: true, token: signHs256(claims, this.secret), claims };
  }

  validateBearer(
    authorizationHeader: string | undefined,
  ):
    | { ok: true; claims: CareSessionClaims }
    | { ok: false; code: string; message: string } {
    if (!authorizationHeader?.startsWith("Bearer ")) {
      return {
        ok: false,
        code: "SESSION_INVALID",
        message: "Missing bearer token",
      };
    }
    const token = authorizationHeader.slice("Bearer ".length).trim();
    const claims = verifyHs256(token, this.secret);
    if (!claims) {
      return {
        ok: false,
        code: "SESSION_INVALID",
        message: "Invalid or expired care session",
      };
    }
    if (!claims.ops.includes("read") && !claims.ops.includes("write")) {
      return {
        ok: false,
        code: "OPERATION_NOT_PERMITTED",
        message: "Session has no care operations",
      };
    }
    return { ok: true, claims };
  }

  toAuthCareContext(
    claims: CareSessionClaims,
    careRecipientId: string,
    store: CareStore,
  ):
    | { ok: true; ctx: AuthCareContext }
    | { ok: false; code: string; message: string } {
    const recipient = store.getRecipient(careRecipientId);
    if (!recipient) {
      return {
        ok: false,
        code: "UNKNOWN_RECIPIENT",
        message: "Care recipient not found",
      };
    }
    return {
      ok: true,
      ctx: {
        actorPersonId: claims.carePersonId,
        actorDisplayName: claims.displayName,
        careRecipientId,
        householdId: recipient.householdId,
        sessionId: claims.sid,
        roles: claims.roles,
      },
    };
  }
}

export function defaultActiveCareRecipientId(): string {
  return careRecipient.id;
}

export function defaultHouseholdId(): string {
  return HOUSEHOLD_OLIVIA;
}
