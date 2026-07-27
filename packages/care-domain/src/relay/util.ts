/** Shared helpers for server-side Relay intelligence (no UI deps). */

export function str(v: unknown): string {
  return v == null ? "" : String(v);
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
