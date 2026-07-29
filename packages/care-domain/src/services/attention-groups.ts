/**
 * Canonical principal-scoped attention groups.
 * Badge, attention panel, and API must all use the same array length.
 */

import type { CareStore } from "../store/memory-store.js";
import { isSmokeResidueLine } from "../relay/util.js";
import { listNotificationsForPrincipal } from "./notifications.js";
import { listWorkItems } from "./care-work-items.js";

export type AttentionGroup = {
  group_id: string;
  tenant_id: string;
  recipient_id: string;
  principal_id: string;
  semantic_issue: string;
  action_required: string;
  category:
    | "medication_review"
    | "medication_correction"
    | "transport"
    | "schedule_conflict"
    | "access"
    | "handoff"
    | "work"
    | "other";
  priority: "info" | "attention" | "important" | "urgent";
  created_at: string;
  due_at: string | null;
  resolution_state: "open" | "resolved";
  acknowledgment_required: boolean;
  work_id: string | null;
  notification_ids: string[];
  badge_eligible: boolean;
  badge_reason: string;
  display_title: string;
  display_body: string;
  eligible_roles: string[];
  escalation_policy: string;
};

function isProbeBlob(blob: string): boolean {
  return (
    isSmokeResidueLine(blob) ||
    /smoke_harness|automated_test_probe|performance_probe|__cr_e2e|probe calm/i.test(
      blob,
    )
  );
}

function categoryFromBlob(blob: string): AttentionGroup["category"] {
  if (/allegra|medication change|needs verification|dose unit|metformin|with.?lunch/i.test(blob))
    return "medication_review";
  if (/not administered|correction/i.test(blob)) return "medication_correction";
  if (/transport|ride|pickup/i.test(blob)) return "transport";
  if (/schedule|conflict|disagree|appointment/i.test(blob)) return "schedule_conflict";
  if (/access|invitation|owner|who can access/i.test(blob)) return "access";
  if (/handoff/i.test(blob)) return "handoff";
  if (/needs an owner|work|task/i.test(blob)) return "work";
  return "other";
}

function semanticKey(blob: string, category: AttentionGroup["category"]): string {
  const b = blob.toLowerCase();
  if (category === "medication_review") {
    if (/allegra/.test(b)) return "sem:allegra";
    if (/metformin|with.?lunch/.test(b)) return "sem:metformin";
    if (/dose unit|incompatible|ambiguous|cannot convert/.test(b)) return "sem:dose_unit";
    if (/tylenol|acetaminophen/.test(b)) return "sem:tylenol_change";
    if (/zyrtec|cetirizine/.test(b)) return "sem:zyrtec_change";
    if (/claritin|loratadine/.test(b)) return "sem:claritin_change";
    return "sem:med_review";
  }
  if (category === "medication_correction") return "sem:med_correction";
  if (category === "transport") return "sem:transport";
  if (category === "schedule_conflict") return "sem:schedule";
  if (category === "access") {
    if (/access request/.test(b)) return "sem:access_request";
    return "sem:access";
  }
  if (category === "handoff") return "sem:handoff";
  return `sem:${b.replace(/[^a-z0-9]+/g, " ").trim().slice(0, 40)}`;
}

function requiresAction(blob: string, type: string): boolean {
  return /needs|review|verify|correct|claim|waiting|unresolved|attention|confirm|mismatch|disagreement|access|transport|handoff|owner|verify/i.test(
    `${blob} ${type}`,
  );
}

function actionFor(category: AttentionGroup["category"]): string {
  switch (category) {
    case "medication_review":
      return "Review, correct, or reject the pending medication-plan change";
    case "medication_correction":
      return "Acknowledge the corrected administration record and review history";
    case "transport":
      return "Take the transport task or ask another helper";
    case "schedule_conflict":
      return "Choose which schedule note is correct";
    case "access":
      return "Approve, decline, or reassign the access request";
    case "handoff":
      return "Review unfinished handoff items before the next shift";
    case "work":
      return "Take this care work or reassign it";
    default:
      return "Review and resolve this care item";
  }
}

/**
 * Build the single canonical attention array for principal (+ optional recipient).
 * Badge count MUST equal groups.filter(g => g.badge_eligible).length
 * and the same array length when only badge_eligible groups are returned.
 */
export function buildAttentionGroups(
  store: CareStore,
  principalId: string,
  careRecipientId?: string,
): AttentionGroup[] {
  const notifs = listNotificationsForPrincipal(
    store,
    principalId,
    careRecipientId,
  );
  const byKey = new Map<string, AttentionGroup>();

  for (const n of notifs) {
    if (n.resolvedAt) continue;
    if (careRecipientId && n.careRecipientId !== careRecipientId) continue;
    const blob = `${n.title} ${n.body} ${n.type}`;
    if (isProbeBlob(blob)) continue;
    if (!requiresAction(blob, n.type)) continue;
    // Seen pure-awareness that still requires formal ack for corrections
    const category = categoryFromBlob(blob);
    const needsAck =
      category === "medication_correction" && !n.acknowledgedAt;
    if (n.seenAt && !needsAck && category === "other") continue;

    const sem = semanticKey(blob, category);
    const groupId = `${n.careRecipientId}:${sem}`;
    const existing = byKey.get(groupId);
    if (existing) {
      existing.notification_ids.push(n.id);
      if (n.createdAt < existing.created_at) existing.created_at = n.createdAt;
      continue;
    }

    const household =
      store.getRecipient(n.careRecipientId)?.householdId ?? "hh-unknown";

    byKey.set(groupId, {
      group_id: groupId,
      tenant_id: household,
      recipient_id: n.careRecipientId,
      principal_id: principalId,
      semantic_issue: sem,
      action_required: actionFor(category),
      category,
      priority:
        n.priority === "urgent"
          ? "urgent"
          : n.priority === "important"
            ? "important"
            : "attention",
      created_at: n.createdAt,
      due_at: null,
      resolution_state: "open",
      acknowledgment_required: needsAck,
      work_id: null,
      notification_ids: [n.id],
      badge_eligible: true,
      badge_reason: needsAck
        ? "Correction acknowledgment required for this principal"
        : "Unresolved actionable care item for this principal and recipient",
      display_title: n.title || category,
      display_body: n.body || actionFor(category),
      eligible_roles: ["family_primary", "family_caregiver", "dsp", "clinician"],
      escalation_policy:
        "If no response within 24h, escalate to alternate authorized helper; after 48h mark overdue in attention.",
    });
  }

  // Open work items without owners also generate attention (same semantic keys)
  if (careRecipientId) {
    try {
      const work = listWorkItems(store, careRecipientId);
      for (const w of work) {
        if (w.status === "completed" || w.status === "cancelled") continue;
        const blob = `${w.action} ${w.reason ?? ""} ${w.status}`;
        if (isProbeBlob(blob)) continue;
        const category = categoryFromBlob(blob);
        const sem = semanticKey(blob, category);
        const groupId = `${careRecipientId}:${sem}`;
        if (byKey.has(groupId)) {
          const g = byKey.get(groupId)!;
          g.work_id = w.id;
          continue;
        }
        if (w.ownerPersonId && w.ownerPersonId !== principalId) continue;
        const household =
          store.getRecipient(careRecipientId)?.householdId ?? "hh-unknown";
        byKey.set(groupId, {
          group_id: groupId,
          tenant_id: household,
          recipient_id: careRecipientId,
          principal_id: principalId,
          semantic_issue: sem,
          action_required: actionFor(category === "other" ? "work" : category),
          category: category === "other" ? "work" : category,
          priority: w.priority === "urgent" ? "urgent" : "attention",
          created_at: w.createdAt,
          due_at: w.dueAt ?? null,
          resolution_state: "open",
          acknowledgment_required: false,
          work_id: w.id,
          notification_ids: [],
          badge_eligible: true,
          badge_reason: "Open care work needs this principal or is unassigned",
          display_title: String(w.action).slice(0, 120),
          display_body: w.reason ?? actionFor("work"),
          eligible_roles: ["family_primary", "family_caregiver", "dsp"],
          escalation_policy:
            "If unclaimed after 24h, escalate to primary family caregiver; after 48h mark overdue.",
        });
      }
    } catch {
      /* work listing optional */
    }
  }

  return [...byKey.values()]
    .filter((g) => g.badge_eligible && g.resolution_state === "open")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function attentionBadgeCount(groups: AttentionGroup[]): number {
  return groups.filter((g) => g.badge_eligible).length;
}
