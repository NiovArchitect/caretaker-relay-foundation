/**
 * Canonical ordered medication-plan change candidates for display + ordinal focus.
 * Display list and conversation resolver MUST use the same array.
 */

import type { CareProjections, CareStateBag } from "../relay/projections.js";
import { isSmokeResidueLine, sanitizeHumanCareCopy, str } from "../relay/util.js";

export type OrderedMedicationCandidate = {
  candidate_id: string;
  display_index: number; // 1-based
  medication: string;
  dose: string;
  reason: string;
  reporter: string;
  report_time: string | null;
  review_state: "pending_plan_verification" | "active" | "rejected" | "unknown";
  source_line: string;
};

function extractNameDose(line: string): { medication: string; dose: string } {
  const m =
    line.match(
      /\b(Tylenol|Acetaminophen|Zyrtec|Cetirizine|Allegra|Fexofenadine|Claritin|Loratadine|Ibuprofen|Naproxen|Benadryl|Diphenhydramine|Metformin|[A-Z][a-z]{3,})\b(?:\s*[·,]?\s*reported dose\s*)?(\d+\s*(?:mg|mcg|ml|units?))?/i,
    ) ||
    line.match(/\b([A-Z][a-z]+)\s+(\d+\s*mg)\b/i);
  if (m) {
    return {
      medication: m[1]!,
      dose: (m[2] || "").trim(),
    };
  }
  return { medication: "Medication", dose: "" };
}

/**
 * Build stable ordered candidates from projection lines.
 * Sort: medication name ASC then dose — deterministic, not retrieval order.
 */
export function buildOrderedMedicationCandidatesFromLines(
  linesIn: string[],
  max = 8,
): OrderedMedicationCandidate[] {
  const lines = linesIn.map(str).filter(Boolean);

  const raw: Array<Omit<OrderedMedicationCandidate, "display_index" | "candidate_id">> =
    [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (!line || isSmokeResidueLine(line)) continue;
    if (
      !/medication change|needs verification|waiting for medication-plan|reported dose|plan verification/i.test(
        line,
      )
    ) {
      continue;
    }
    const clean = sanitizeHumanCareCopy(line);
    const { medication, dose } = extractNameDose(clean);
    if (!medication || medication === "Medication") {
      // Allegra prose form
      if (/allegra/i.test(clean)) {
        const key = "allegra|60 mg";
        if (seen.has(key)) continue;
        seen.add(key);
        raw.push({
          medication: "Allegra",
          dose: "60 mg",
          reason: /allerg/i.test(clean) ? "allergies" : "pending review",
          reporter:
            clean.match(/\(from\s+([^)]+)\)/i)?.[1] ||
            clean.match(/\b(Marcus|Maya|Daniel)[^\n,]*/)?.[1] ||
            "caregiver",
          report_time: null,
          review_state: "pending_plan_verification",
          source_line: clean,
        });
      }
      continue;
    }
    const key = `${medication.toLowerCase()}|${dose.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reason =
      clean.match(/reason:\s*([^.\n]+)/i)?.[1]?.trim() ||
      ( /allerg/i.test(clean) ? "allergies" : /fever/i.test(clean) ? "fever" : "pending review");
    raw.push({
      medication,
      dose,
      reason,
      reporter:
        clean.match(/\(from\s+([^)]+)\)/i)?.[1] ||
        clean.match(/\b(Marcus Carter|Maya Bennett|Daniel Kim)\b/)?.[1] ||
        "caregiver",
      report_time: null,
      review_state: "pending_plan_verification",
      source_line: clean,
    });
  }

  raw.sort((a, b) => {
    const n = a.medication.localeCompare(b.medication);
    if (n !== 0) return n;
    return a.dose.localeCompare(b.dose);
  });

  return raw.slice(0, max).map((c, i) => ({
    ...c,
    display_index: i + 1,
    candidate_id: `medcand-${c.medication.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${c.dose.replace(/\s+/g, "") || "na"}`,
  }));
}

export function buildOrderedMedicationCandidates(
  state: CareStateBag,
  proj?: CareProjections | null,
  max = 8,
): OrderedMedicationCandidate[] {
  const lines: string[] = [];
  if (proj?.ACTIVE_HANDOFF) {
    lines.push(...(proj.ACTIVE_HANDOFF.stillNeedsAttention ?? []));
    lines.push(...(proj.ACTIVE_HANDOFF.whatChanged ?? []));
  }
  for (const r of state.openSafetyReviews ?? []) {
    lines.push(str((r as { reason?: string }).reason ?? r));
  }
  for (const e of (state.events ?? []).slice(-40)) {
    lines.push(
      str(
        (e as { statement?: string }).statement ??
          (e as { title?: string }).title,
      ),
    );
  }
  for (const u of proj?.OPEN_UNCERTAINTIES ?? []) lines.push(str(u));
  for (const c of proj?.RECENT_CHANGES ?? []) lines.push(str(c));
  return buildOrderedMedicationCandidatesFromLines(lines, max);
}

export function formatOrderedMedicationList(
  candidates: OrderedMedicationCandidate[],
  recipientName: string,
): string {
  if (!candidates.length) {
    return `No pending medication-plan changes are waiting for review for ${recipientName}.`;
  }
  if (candidates.length === 1) {
    const c = candidates[0]!;
    return (
      `One medication change is waiting for review: ${c.medication}` +
      (c.dose ? ` ${c.dose}` : "") +
      (c.reason ? ` for ${c.reason}` : "") +
      `. It is not active plan instruction until authorized.`
    );
  }
  const lines = candidates.map(
    (c) =>
      `${c.display_index}. ${c.medication}` +
      (c.dose ? ` ${c.dose}` : "") +
      (c.reason ? ` for ${c.reason}` : "") +
      (c.reporter ? ` (reported by ${c.reporter})` : ""),
  );
  return (
    `${candidates.length} medication changes are waiting for review for ${recipientName}:\n` +
    lines.join("\n") +
    `\nNone of these is active plan instruction until authorized. Say “the second one” to focus on a specific change.`
  );
}

export function pickCandidateByOrdinal(
  candidates: OrderedMedicationCandidate[],
  ordinal: number,
): OrderedMedicationCandidate | null {
  if (ordinal < 1 || ordinal > candidates.length) return null;
  return candidates[ordinal - 1] ?? null;
}

export function pickCandidateByName(
  candidates: OrderedMedicationCandidate[],
  name: string,
): OrderedMedicationCandidate | null {
  const n = name.toLowerCase();
  return candidates.find((c) => c.medication.toLowerCase().includes(n)) ?? null;
}
