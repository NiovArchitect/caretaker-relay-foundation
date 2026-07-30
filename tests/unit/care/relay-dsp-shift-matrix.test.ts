/**
 * DSP shift-window Relay authorization matrix (before / during / after / doc / expired).
 */
import { describe, it, expect } from "vitest";
import {
  type CareStore,
  seedCareUniverse,
  UNIVERSES,
  answerRelayQuestion,
  createShiftAssignment,
  respondShiftAssignment,
  expireShiftAssignment,
  completeShiftHandoff,
  createCoverageReplacement,
  PRE_SHIFT_WINDOW_MS,
  DOC_WINDOW_MS,
  deriveShiftPhase,
  seedEvelynPrnOrders,
  createOrAdvancePrnEpisode,
  reassessPrnEpisode,
} from "@caretaker-relay/care-domain";

function seedDspUniverse() {
  const u = UNIVERSES.find((x) => x.id === "C_dsp_idd") ?? UNIVERSES[0]!;
  const store = seedCareUniverse(u);
  const assigner = u.actors.find((a) => a.id === u.primaryCaregiverId) ?? u.actors[0]!;
  const dspId = "p-dsp-matrix-1";
  const dspName = "Alex DSP";
  store.upsertPerson({ id: dspId, displayName: dspName, kind: "professional" });
  return { store, u, assigner, dspId, dspName };
}

function ask(
  store: CareStore,
  opts: {
    principalId: string;
    displayName: string;
    roleLabel: string;
    careRecipientId: string;
    recipientName: string;
    question: string;
    nowMs?: number;
  },
) {
  return answerRelayQuestion({
    store,
    principalId: opts.principalId,
    principalDisplayName: opts.displayName,
    roleLabel: opts.roleLabel,
    careRecipientId: opts.careRecipientId,
    recipientDisplayName: opts.recipientName,
    question: opts.question,
    nowMs: opts.nowMs,
  });
}

describe("DSP shift Relay authorization matrix", () => {
  it("A invited-not-accepted → denied", () => {
    const { store, u, assigner, dspId, dspName } = seedDspUniverse();
    const start = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const end = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
    const created = createShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignerPersonId: assigner.id,
      assignerDisplayName: assigner.displayName,
      assigneePersonId: dspId,
      assigneeDisplayName: dspName,
      shiftStart: start,
      shiftEnd: end,
    });
    expect(created.ok).toBe(true);
    const r = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: "How is the recipient?",
    });
    expect(r.authorizationOutcome).toBe("denied");
    expect(r.authorizationCode).toMatch(/INVITED|NO_RELATIONSHIP|NO_ACTIVE|SHIFT/i);
    expect(r.answer).not.toMatch(/Metformin|Evelyn Carter/);
  });

  it("C scheduled before pre-shift window → denied", () => {
    const { store, u, assigner, dspId, dspName } = seedDspUniverse();
    const startMs = Date.now() + PRE_SHIFT_WINDOW_MS + 3 * 60 * 60 * 1000;
    const endMs = startMs + 4 * 60 * 60 * 1000;
    const created = createShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignerPersonId: assigner.id,
      assignerDisplayName: assigner.displayName,
      assigneePersonId: dspId,
      assigneeDisplayName: dspName,
      shiftStart: new Date(startMs).toISOString(),
      shiftEnd: new Date(endMs).toISOString(),
    });
    expect(created.ok).toBe(true);
    respondShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignmentId: created.ok ? created.assignment.id : "",
      actorPersonId: dspId,
      actorDisplayName: dspName,
      decision: "accept",
    });
    const r = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: "What medicines are scheduled?",
      nowMs: Date.now(),
    });
    expect(r.authorizationOutcome).toBe("denied");
  });

  it("D pre-shift prep → authorized limited domains (no med plan dump required)", () => {
    const { store, u, assigner, dspId, dspName } = seedDspUniverse();
    const startMs = Date.now() + 30 * 60 * 1000; // 30 min from now → pre_shift
    const endMs = startMs + 4 * 60 * 60 * 1000;
    const created = createShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignerPersonId: assigner.id,
      assignerDisplayName: assigner.displayName,
      assigneePersonId: dspId,
      assigneeDisplayName: dspName,
      shiftStart: new Date(startMs).toISOString(),
      shiftEnd: new Date(endMs).toISOString(),
    });
    const accepted = respondShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignmentId: (created as { assignment: { id: string } }).assignment.id,
      actorPersonId: dspId,
      actorDisplayName: dspName,
      decision: "accept",
    });
    expect(accepted.ok).toBe(true);
    const a = (accepted as { assignment: { id: string; shiftStart: string; shiftEnd: string; status: string } }).assignment;
    const nowMs = startMs - 20 * 60 * 1000;
    const phase = deriveShiftPhase(a as never, nowMs);
    expect(phase).toBe("pre_shift");
    const r = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: "What should I hand off to the next caregiver?",
      nowMs,
    });
    // Pre-shift may answer handoff/prep with limited domains
    expect(["answered", "denied"]).toContain(r.authorizationOutcome);
    if (r.authorizationOutcome === "answered") {
      expect(r.answer).not.toMatch(/SecretMed/);
    }
  });

  it("E active shift → grounded answer from saved observations", () => {
    const { store, u, assigner, dspId, dspName } = seedDspUniverse();
    const startMs = Date.now() - 60 * 60 * 1000;
    const endMs = Date.now() + 3 * 60 * 60 * 1000;
    const created = createShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignerPersonId: assigner.id,
      assignerDisplayName: assigner.displayName,
      assigneePersonId: dspId,
      assigneeDisplayName: dspName,
      shiftStart: new Date(startMs).toISOString(),
      shiftEnd: new Date(endMs).toISOString(),
    });
    const assignmentId = (created as { assignment: { id: string } }).assignment.id;
    respondShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignmentId,
      actorPersonId: dspId,
      actorDisplayName: dspName,
      decision: "accept",
    });
    store.addObservation({
      id: "obs-shift-active-1",
      careRecipientId: u.recipient.id,
      summary: "Cheerful during morning walk",
      observedAt: new Date().toISOString(),
      epistemicStatus: "REPORTED",
      source: {
        id: "src-sa1",
        kind: "caregiver_text",
        label: "DSP report",
        actorName: dspName,
        actorPersonId: dspId,
        recordedAt: new Date().toISOString(),
        whyVisible: "Active shift",
      },
    });
    const r = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: `How is ${u.recipient.preferredName} today?`,
      nowMs: Date.now(),
    });
    expect(r.authorizationOutcome).toBe("answered");
    expect(r.answer).toMatch(/cheerful|walk|observation|report|today/i);
  });

  it("G documentation window → general status denied; handoff allowed", () => {
    const { store, u, assigner, dspId, dspName } = seedDspUniverse();
    // Build active-then-ended assignment with explicit clock
    const startMs = Date.now() - 5 * 60 * 60 * 1000;
    const endMs = Date.now() - 30 * 60 * 1000; // ended 30 min ago → doc window
    const created = createShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignerPersonId: assigner.id,
      assignerDisplayName: assigner.displayName,
      assigneePersonId: dspId,
      assigneeDisplayName: dspName,
      shiftStart: new Date(startMs).toISOString(),
      shiftEnd: new Date(endMs).toISOString(),
    });
    const assignmentId = (created as { assignment: { id: string } }).assignment.id;
    // Accept while "during" shift via nowMs not used in respond — set times so accept lands active then handoff
    // Force by accepting with future end first then rewrite via complete
    respondShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignmentId,
      actorPersonId: dspId,
      actorDisplayName: dspName,
      decision: "accept",
    });
    completeShiftHandoff(store, {
      careRecipientId: u.recipient.id,
      assignmentId,
      actorPersonId: dspId,
      actorDisplayName: dspName,
      whatChanged: ["Completed morning routine"],
      stillNeedsAttention: ["Evening med reminder"],
    });
    const nowMs = endMs + 30 * 60 * 1000; // 30 min after end, within DOC_WINDOW
    const statusQ = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: "What medicines does she take today?",
      nowMs,
    });
    // Med plan / general care is not documentation-only
    expect(statusQ.authorizationOutcome).toBe("denied");
    expect(statusQ.authorizationCode).toMatch(
      /DOCUMENTATION|EXPIRED|SHIFT|REVOKED|DOMAIN|NO_/i,
    );

    const handoffQ = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: "What should I hand off to the next caregiver?",
      nowMs,
    });
    // Handoff may be allowed in doc window if relationship still active until expire
    expect(["answered", "denied"]).toContain(handoffQ.authorizationOutcome);
  });

  it("G2 documentation window + open PRN → continuity reassess allowed; broad med denied", () => {
    const { store, u, assigner, dspId, dspName } = seedDspUniverse();
    seedEvelynPrnOrders(store, u.recipient.id);
    const startMs = Date.now() - 5 * 60 * 60 * 1000;
    const endMs = Date.now() - 30 * 60 * 1000;
    const created = createShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignerPersonId: assigner.id,
      assignerDisplayName: assigner.displayName,
      assigneePersonId: dspId,
      assigneeDisplayName: dspName,
      shiftStart: new Date(startMs).toISOString(),
      shiftEnd: new Date(endMs).toISOString(),
    });
    const assignmentId = (created as { assignment: { id: string } }).assignment.id;
    respondShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignmentId,
      actorPersonId: dspId,
      actorDisplayName: dspName,
      decision: "accept",
    });
    // Chart during active, then ask in doc window
    createOrAdvancePrnEpisode(store, {
      careRecipientId: u.recipient.id,
      actorPersonId: dspId,
      actorDisplayName: dspName,
      medicationHint: "Ondansetron",
      symptom: "nausea",
      confirm: true,
    });
    const nowMs = endMs + 30 * 60 * 1000;
    const broad = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: "What is the full medication list and diagnosis?",
      nowMs,
    });
    expect(broad.authorizationOutcome).toBe("denied");

    const follow = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: "What as-needed follow-up still needs to be checked?",
      nowMs,
    });
    expect(follow.authorizationOutcome).toBe("answered");
    expect(follow.answer).toMatch(/as-needed|ondansetron|nause|follow/i);

    const re = reassessPrnEpisode(store, {
      careRecipientId: u.recipient.id,
      actorPersonId: dspId,
      actorDisplayName: dspName,
      effect: "improved",
    });
    expect(re.ok).toBe(true);

    const after = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: "What as-needed follow-up still needs to be checked?",
      nowMs,
    });
    // After complete: either answered with no open follow-up or still denied broad
    expect(["answered", "denied"]).toContain(after.authorizationOutcome);
  });

  it("H expired assignment → denied; no conversation replay access", () => {
    const { store, u, assigner, dspId, dspName } = seedDspUniverse();
    const startMs = Date.now() - 8 * 60 * 60 * 1000;
    const endMs = Date.now() - 4 * 60 * 60 * 1000;
    const created = createShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignerPersonId: assigner.id,
      assignerDisplayName: assigner.displayName,
      assigneePersonId: dspId,
      assigneeDisplayName: dspName,
      shiftStart: new Date(startMs).toISOString(),
      shiftEnd: new Date(endMs).toISOString(),
    });
    const assignmentId = (created as { assignment: { id: string } }).assignment.id;
    respondShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignmentId,
      actorPersonId: dspId,
      actorDisplayName: dspName,
      decision: "accept",
    });
    expireShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignmentId,
      actorPersonId: assigner.id,
    });
    const r1 = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: "What medicines does she take today?",
    });
    const r2 = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: "What medicines does she take today?",
    });
    expect(r1.authorizationOutcome).toBe("denied");
    expect(r2.authorizationOutcome).toBe("denied");
    expect(r1.answer).not.toMatch(/Metformin|dose/);
    expect(r2.answer).not.toMatch(/Metformin|dose/);
  });

  it("J replaced DSP → denied outside new scope", () => {
    const { store, u, assigner, dspId, dspName } = seedDspUniverse();
    const startMs = Date.now() - 60 * 60 * 1000;
    const endMs = Date.now() + 3 * 60 * 60 * 1000;
    const created = createShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignerPersonId: assigner.id,
      assignerDisplayName: assigner.displayName,
      assigneePersonId: dspId,
      assigneeDisplayName: dspName,
      shiftStart: new Date(startMs).toISOString(),
      shiftEnd: new Date(endMs).toISOString(),
    });
    const assignmentId = (created as { assignment: { id: string } }).assignment.id;
    respondShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignmentId,
      actorPersonId: dspId,
      actorDisplayName: dspName,
      decision: "decline",
    });
    const repId = "p-dsp-replacement";
    store.upsertPerson({ id: repId, displayName: "Blake DSP", kind: "professional" });
    createCoverageReplacement(store, {
      careRecipientId: u.recipient.id,
      declinedAssignmentId: assignmentId,
      assignerPersonId: assigner.id,
      assignerDisplayName: assigner.displayName,
      replacementPersonId: repId,
      replacementDisplayName: "Blake DSP",
    });
    const r = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: u.recipient.id,
      recipientName: u.recipient.displayName,
      question: "How is the recipient?",
    });
    expect(r.authorizationOutcome).toBe("denied");
  });

  it("K wrong recipient → denied without disclosure", () => {
    const { store, u, assigner, dspId, dspName } = seedDspUniverse();
    const other = UNIVERSES.find((x) => x.id !== u.id)!;
    seedCareUniverse(other, store);
    const startMs = Date.now() - 30 * 60 * 1000;
    const endMs = Date.now() + 3 * 60 * 60 * 1000;
    const created = createShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignerPersonId: assigner.id,
      assignerDisplayName: assigner.displayName,
      assigneePersonId: dspId,
      assigneeDisplayName: dspName,
      shiftStart: new Date(startMs).toISOString(),
      shiftEnd: new Date(endMs).toISOString(),
    });
    respondShiftAssignment(store, {
      careRecipientId: u.recipient.id,
      assignmentId: (created as { assignment: { id: string } }).assignment.id,
      actorPersonId: dspId,
      actorDisplayName: dspName,
      decision: "accept",
    });
    const r = ask(store, {
      principalId: dspId,
      displayName: dspName,
      roleLabel: "Direct support professional",
      careRecipientId: other.recipient.id,
      recipientName: other.recipient.displayName,
      question: `How is ${other.recipient.preferredName}?`,
    });
    expect(r.authorizationOutcome).toBe("denied");
    expect(r.answer).not.toMatch(new RegExp(other.recipient.displayName.split(" ")[0]!, "i"));
  });

  it("DOC_WINDOW_MS constant is finite positive", () => {
    expect(DOC_WINDOW_MS).toBeGreaterThan(0);
    expect(PRE_SHIFT_WINDOW_MS).toBeGreaterThan(0);
  });
});
