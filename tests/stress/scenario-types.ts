/** Brutal real-stack stress scenario record (CR-STRESS-XXX). */

export type BoundaryTag =
  | "REAL_AUTH"
  | "REAL_HTTP"
  | "REAL_PRISMA"
  | "REAL_AUDIT"
  | "REAL_PROVENANCE"
  | "REAL_RESTART"
  | "FIXTURE_UNDERSTAND"
  | "LIVE_MODEL"
  | "BROWSER"
  | "FAULT_INJECTED"
  | "CONCURRENT"
  | "MOCKED";

export type Severity = "P0" | "P1" | "P2" | "P3" | null;

export interface ScenarioResult {
  id: string;
  threat: string;
  preconditions: string;
  principal: string;
  careRecipient: string;
  input: string;
  realBoundaries: BoundaryTag[];
  faultInjected: string;
  expected: string;
  actual: string;
  databaseAssertion: string;
  auditAssertion: string;
  projectionAssertion: string;
  pass: boolean;
  severityIfFail: Severity;
  evidencePath?: string;
  notes?: string;
  bugId?: string;
}
