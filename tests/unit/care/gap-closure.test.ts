import { describe, it, expect, beforeEach } from "vitest";
import {
  createCareRuntime,
  people,
  buildPrivacyCenter,
  revokeAccessNow,
  modifyAccessScope,
  createShiftAssignment,
  respondShiftAssignment,
  createCoverageReplacement,
  expireShiftAssignment,
  completeShiftHandoff,
  buildClinicalSummary,
  openMedicationMismatch,
  resolveConflict,
  listConflicts,
  previewInvitationPreAuth,
  previewInvitationAuthenticated,
  proveEtlReliability,
  newInviteToken,
  encodeInvitationUpdate,
  defaultInviteAccess,
} from "@caretaker-relay/care-domain";

describe("gap closure services", () => {
  let store: ReturnType<typeof createCareRuntime>["store"];
  beforeEach(() => {
    ({ store } = createCareRuntime({ seedOlivia: true }));
  });

  it("privacy center for controlling family", () => {
    const p = buildPrivacyCenter(store, people.sadeil.id, "cr-olivia");
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.center.canManage).toBe(true);
    expect(p.center.people.length).toBeGreaterThan(0);
    expect(p.center.aiUseExplanation.toLowerCase()).toMatch(/relay/);
  });

  it("scope modify and revoke", () => {
    const mod = modifyAccessScope(store, {
      actorPersonId: people.sadeil.id,
      careRecipientId: "cr-olivia",
      targetPersonId: people.maya.id,
      informationCategories: ["daily"],
      allowedActions: ["view"],
    });
    expect(mod.ok).toBe(true);
    const rev = revokeAccessNow(store, {
      actorPersonId: people.sadeil.id,
      careRecipientId: "cr-olivia",
      targetPersonId: people.maya.id,
    });
    expect(rev.ok).toBe(true);
    const access = store.getRelationship("cr-olivia", people.maya.id);
    expect(access?.status).toBe("revoked");
  });

  it("DSP decline → coverage → accept → handoff → expire prior", () => {
    const created = createShiftAssignment(store, {
      careRecipientId: "cr-olivia",
      assignerPersonId: people.sadeil.id,
      assignerDisplayName: people.sadeil.displayName,
      assigneePersonId: people.walter.id,
      assigneeDisplayName: people.walter.displayName,
      shiftStart: new Date(Date.now() + 3600_000).toISOString(),
      shiftEnd: new Date(Date.now() + 5 * 3600_000).toISOString(),
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const declined = respondShiftAssignment(store, {
      careRecipientId: "cr-olivia",
      assignmentId: created.assignment.id,
      actorPersonId: people.walter.id,
      actorDisplayName: people.walter.displayName,
      decision: "decline",
    });
    expect(declined.ok).toBe(true);
    if (!declined.ok) return;
    expect(declined.assignment.status).toBe("declined");
    const cov = createCoverageReplacement(store, {
      careRecipientId: "cr-olivia",
      declinedAssignmentId: created.assignment.id,
      assignerPersonId: people.sadeil.id,
      assignerDisplayName: people.sadeil.displayName,
      replacementPersonId: "p-dsp-replacement",
      replacementDisplayName: "Replacement DSP",
    });
    expect(cov.ok).toBe(true);
    if (!cov.ok) return;
    const accepted = respondShiftAssignment(store, {
      careRecipientId: "cr-olivia",
      assignmentId: cov.assignment.id,
      actorPersonId: "p-dsp-replacement",
      actorDisplayName: "Replacement DSP",
      decision: "accept",
    });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const handoff = completeShiftHandoff(store, {
      careRecipientId: "cr-olivia",
      assignmentId: cov.assignment.id,
      actorPersonId: "p-dsp-replacement",
      actorDisplayName: "Replacement DSP",
      whatChanged: ["Completed mobility walk"],
      stillNeedsAttention: ["Evening med"],
    });
    expect(handoff.ok).toBe(true);
    const exp = expireShiftAssignment(store, {
      careRecipientId: "cr-olivia",
      assignmentId: cov.assignment.id,
      actorPersonId: people.sadeil.id,
    });
    expect(exp.ok).toBe(true);
    if (!exp.ok) return;
    expect(exp.assignment.status).toBe("expired");
  });

  it("clinical summary for physician", () => {
    const s = buildClinicalSummary(store, people.drShah.id, "cr-olivia");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.summary.boundaries.length).toBeGreaterThan(0);
    expect(s.summary.medicationPlan.length).toBeGreaterThan(0);
  });

  it("medication conflict never auto-decides dose", () => {
    const c = openMedicationMismatch(store, {
      careRecipientId: "cr-olivia",
      actorPersonId: people.sadeil.id,
      actorDisplayName: people.sadeil.displayName,
      medicationName: "Metformin",
      reportedAmount: "1000 mg",
      planAmount: "500 mg",
    });
    expect(c.kind).toBe("medication_mismatch");
    expect(c.whyCannotDecide.toLowerCase()).toMatch(/does not select dosage|care plan/);
    const open = listConflicts(store, "cr-olivia");
    expect(open.some((x) => x.id === c.id)).toBe(true);
    const resolved = resolveConflict(store, {
      careRecipientId: "cr-olivia",
      conflictId: c.id,
      actorPersonId: people.drShah.id,
      actorDisplayName: people.drShah.displayName,
      resolution: "Keep authorized plan 500 mg",
      chosenStatement: "Authorized Metformin 500 mg confirmed after review",
    });
    expect(resolved.ok).toBe(true);
  });

  it("invite pre-auth and invalid auth disclose zero PHI", () => {
    const pre = previewInvitationPreAuth("short");
    expect(pre.stage).toBe("pre_auth");
    expect(JSON.stringify(pre).toLowerCase()).not.toMatch(/evelyn|olivia|metformin/);
    const bad = previewInvitationAuthenticated(store, "invalid-token-xyz-12345", people.sadeil.id);
    expect(bad.stage).toBe("denied");
    if (bad.stage === "denied") {
      expect(bad.phi_disclosed).toBe(false);
      expect(JSON.stringify(bad).toLowerCase()).not.toMatch(/evelyn|metformin/);
    }
  });

  it("ETL outbox reliability: no duplicate side effects", () => {
    const proof = proveEtlReliability(store, "cr-olivia");
    expect(proof.duplicatePrevented).toBe(true);
    expect(proof.firstDrain.succeeded).toBeGreaterThanOrEqual(1);
    expect(proof.secondDrain.processed).toBe(0);
  });
});
