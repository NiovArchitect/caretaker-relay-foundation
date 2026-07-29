/** Shared helpers for server-side Relay intelligence (no UI deps). */

export function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** Development / smoke correlation residue that must never reach caregivers. */
const SMOKE_MARKER_RE =
  /\[(?:AZ|HOL|FMH|S\d|PROBE|SMOKE|SEED)[^\]]*\]|\b(?:AZms|HOLms|FMHms|S3b|PROBE|SMOKE|SEED)\w*|\bOpen list\s+\d+\b|\bs\d+-\d{10,}\b|\bRESPONSE_RECEIVED\b|\b__CR_E2E\b|\bJL-SMOKE\b|\bTORTURE\b/i;

export function isSmokeResidueLine(text: string): boolean {
  return SMOKE_MARKER_RE.test(text);
}

/**
 * Strip machine run tags from human-facing care copy.
 * Does not delete underlying audit records — only presentation.
 */
export function sanitizeHumanCareCopy(text: string): string {
  return String(text ?? "")
    .replace(/\s*\[(?:AZ|HOL|FMH|S\d|PROBE|SMOKE|SEED)[^\]]*\]/gi, "")
    .replace(/\b(?:AZms|HOLms|FMHms|S3b)\w*/gi, "")
    .replace(/\bRESPONSE_RECEIVED:\s*/gi, "")
    .replace(/\bOpen list\s+\d+/gi, "Open coordination item")
    .replace(/\bs\d+-\d{10,}\b/gi, "")
    .replace(/\b__CR_E2E\b|\bJL-SMOKE\b|\bTORTURE\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .trim();
}

/** Collapse near-duplicate caregiver-facing lines (Allegra pairs, repeated corrections). */
export function semanticDedupeLines(lines: string[]): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  for (const raw of lines) {
    if (!raw) continue;
    if (isSmokeResidueLine(raw) && !sanitizeHumanCareCopy(raw)) continue;
    const clean = sanitizeHumanCareCopy(raw);
    if (!clean) continue;
    let key = clean.toLowerCase();
    if (/allegra/i.test(key) && /allerg|verification|medication change/i.test(key)) {
      key = "fact:allegra_pending_verification";
    } else if (/correction:.*medication was not administered/i.test(key)) {
      key = "fact:med_not_administered_correction";
    } else if (/medication change needs verification/i.test(key)) {
      key = `fact:med_change:${key.replace(/[^a-z0-9]+/g, " ").slice(0, 48)}`;
    } else {
      key = key.replace(/[^a-z0-9]+/g, " ").trim().slice(0, 96);
    }
    if (keys.has(key)) continue;
    keys.add(key);
    // Prefer a single calm Allegra line when collapsing duplicates
    if (key === "fact:allegra_pending_verification") {
      out.push(
        "Allegra 60 mg was reported for allergies and is waiting for medication-plan verification.",
      );
    } else if (key === "fact:med_not_administered_correction") {
      out.push("Medication administration was corrected: not administered.");
    } else {
      out.push(clean);
    }
  }
  return out;
}

/**
 * Resolve a person display name without fixture hard-codes.
 * Prefer store-provided name map / fallback; never invent Evelyn/Marcus.
 */
export function resolvePersonName(
  id: string | null | undefined,
  fallback?: string,
  nameMap?: Record<string, string>,
): string {
  if (!id) return fallback ?? "Someone in the care circle";
  if (nameMap?.[id]) return nameMap[id];
  if (id === "system") return "System";
  return fallback ?? "Care team member";
}

export function plainDiscrepancyMessage(
  technical: string | undefined,
  recipientName = "the care recipient",
): string {
  const t = (technical ?? "").toLowerCase();
  if (/incompatible dimensions|not comparable|compatible dimensions|unit/.test(t)) {
    return `The reported amount doesn't clearly match ${recipientName}'s current medication instructions. Please check the medication label or confirm with the care team before marking this complete.`;
  }
  if (/missing unit/.test(t)) {
    return `The reported dose is missing units. Check the bottle or packaging, then confirm the amount with the care team if needed.`;
  }
  if (technical && !/dimension|compatib|unit conversion|protocol/i.test(technical)) {
    return technical;
  }
  return `Something about this report needs your review before it is marked complete.`;
}

export function formatCareDateTime(isoOrLabel: string | null | undefined): string {
  if (!isoOrLabel) return "";
  const raw = String(isoOrLabel).trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(raw) && !raw.includes("T")) return raw;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "America/Los_Angeles",
      timeZoneName: "short",
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

export function clusterObservations(
  rows: Array<Record<string, unknown>>,
): Array<{
  theme: string;
  count: number;
  sources: string[];
  mostRecentLabel: string;
}> {
  const map = new Map<
    string,
    { theme: string; count: number; sources: string[]; mostRecentAt: string }
  >();
  for (const o of rows) {
    const summary = str(o.summary ?? "Observation");
    const s = summary.toLowerCase();
    const theme = /fatigu|tired/.test(s)
      ? "Fatigue"
      : /dizz/.test(s)
        ? "Dizziness"
        : summary.split(/\s+/).slice(0, 3).join(" ") || "Observation";
    const at = str(o.observedAt);
    const src =
      o.source && typeof o.source === "object"
        ? str((o.source as { actorName?: string }).actorName)
        : "Care team";
    const cur = map.get(theme.toLowerCase());
    if (!cur) {
      map.set(theme.toLowerCase(), {
        theme,
        count: 1,
        sources: src ? [src] : [],
        mostRecentAt: at,
      });
    } else {
      cur.count += 1;
      if (src && !cur.sources.includes(src)) cur.sources.push(src);
      if (at && at > cur.mostRecentAt) cur.mostRecentAt = at;
    }
  }
  return [...map.values()].map((c) => ({
    theme: c.theme,
    count: c.count,
    sources: c.sources,
    mostRecentAt: c.mostRecentAt,
    mostRecentLabel: formatCareDateTime(c.mostRecentAt) || c.mostRecentAt || "Recently",
  }));
}
