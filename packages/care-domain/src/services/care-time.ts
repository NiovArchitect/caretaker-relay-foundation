/**
 * Care time model — recorded_at vs effective_at, recipient timezone display.
 * Server is authoritative for now; presentation uses care-space timezone.
 */

export const DEFAULT_CARE_TIMEZONE = "America/Los_Angeles";

export type CareTimeStamps = {
  recordedAt: string;
  effectiveAt: string;
  displayTimezone: string;
  precision: "exact" | "day" | "approximate" | "unknown";
};

/** Parse caregiver language into effective time relative to recordedAt. */
export function resolveEffectiveAt(
  rawText: string,
  recordedAt: Date = new Date(),
  careTimezone: string = DEFAULT_CARE_TIMEZONE,
): CareTimeStamps {
  const recordedIso = recordedAt.toISOString();
  const lower = rawText.toLowerCase();
  let effective = new Date(recordedAt.getTime());
  let precision: CareTimeStamps["precision"] = "exact";

  if (/\byesterday\b/.test(lower)) {
    effective = new Date(recordedAt.getTime() - 24 * 60 * 60 * 1000);
    precision = "day";
  } else if (/\bthis morning\b/.test(lower)) {
    // Morning of care day in care timezone — approximate local morning
    precision = "approximate";
  } else if (/\blast night\b/.test(lower)) {
    effective = new Date(recordedAt.getTime() - 12 * 60 * 60 * 1000);
    precision = "approximate";
  } else if (/\btoday\b|\bnow\b|right now/.test(lower)) {
    precision = "exact";
  } else if (/\b(\d{1,2})\s*(am|pm|:)/i.test(lower)) {
    precision = "approximate";
  }

  return {
    recordedAt: recordedIso,
    effectiveAt: effective.toISOString(),
    displayTimezone: careTimezone,
    precision,
  };
}

export function formatInCareTimezone(
  iso: string,
  careTimezone: string = DEFAULT_CARE_TIMEZONE,
): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: careTimezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
