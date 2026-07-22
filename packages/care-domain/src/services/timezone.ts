/**
 * Timezone policy for Caretaker Relay.
 *
 * Storage: ISO-8601 UTC for machine fields.
 * Display: care-recipient timezone primary; caregiver timezone for actor labels.
 * Human expressions ("Thursday at 2:30") retained as original text until resolved.
 */

export interface TimezoneContext {
  careRecipientTimeZone: string;
  caregiverTimeZone: string;
  appointmentProviderTimeZone?: string;
  /** IANA names preferred, e.g. America/New_York */
}

export interface TemporalInterpretation {
  originalExpression: string;
  resolvedIsoUtc?: string;
  resolvedLocalLabel?: string;
  timeZoneUsed?: string;
  status: "RESOLVED" | "AMBIGUOUS" | "UNRESOLVED";
  notes: string[];
}

export const DEFAULT_TIMEZONE_CONTEXT: TimezoneContext = {
  careRecipientTimeZone: "America/New_York",
  caregiverTimeZone: "America/New_York",
  appointmentProviderTimeZone: "America/New_York",
};

/**
 * Interpret a human time phrase. Does NOT silently invent certainty.
 * "Thursday at 2:30" without anchor date/timezone remains AMBIGUOUS.
 */
export function interpretHumanTime(
  expression: string,
  ctx: TimezoneContext = DEFAULT_TIMEZONE_CONTEXT,
  opts?: { referenceDateIso?: string },
): TemporalInterpretation {
  const notes: string[] = [];
  const trimmed = expression.trim();
  if (!trimmed) {
    return {
      originalExpression: expression,
      status: "UNRESOLVED",
      notes: ["Empty time expression"],
    };
  }

  // Absolute ISO already
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) {
    return {
      originalExpression: expression,
      resolvedIsoUtc: new Date(trimmed).toISOString(),
      timeZoneUsed: "UTC",
      status: "RESOLVED",
      notes: ["Parsed as absolute timestamp"],
    };
  }

  const timeMatch = trimmed.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?\b/,
  );
  const hasWeekday = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(
    trimmed,
  );
  const aroundNoon = /around\s+noon|at\s+noon|12\s*pm/i.test(trimmed);

  if (aroundNoon) {
    notes.push(
      `Retained human expression; noon relative to care-recipient TZ ${ctx.careRecipientTimeZone}`,
    );
    notes.push("Exact calendar date not specified — AMBIGUOUS without care-day anchor");
    return {
      originalExpression: expression,
      resolvedLocalLabel: "around noon",
      timeZoneUsed: ctx.careRecipientTimeZone,
      status: "AMBIGUOUS",
      notes,
    };
  }

  if (timeMatch && hasWeekday) {
    const hour = Number(timeMatch[1]);
    const minute = timeMatch[2] ? Number(timeMatch[2]) : 0;
    const mer = timeMatch[3]?.toLowerCase();
    let h24 = hour;
    if (mer === "pm" && hour < 12) h24 = hour + 12;
    if (mer === "am" && hour === 12) h24 = 0;
    if (!mer && hour <= 12 && /2:30|14:30/.test(trimmed) === false && hour < 8) {
      // ambiguous meridem
      notes.push("AM/PM not specified");
    }
    notes.push(
      `Weekday+time expression; care-recipient TZ=${ctx.careRecipientTimeZone}; caregiver TZ=${ctx.caregiverTimeZone}`,
    );
    if (ctx.careRecipientTimeZone !== ctx.caregiverTimeZone) {
      notes.push(
        "Caregiver and care-recipient timezones differ — display both; do not silently convert without confirm",
      );
    }
    notes.push(
      "Calendar date of 'next Thursday' depends on reference care day — left AMBIGUOUS until confirmed",
    );
    if (opts?.referenceDateIso) {
      notes.push(`Reference date provided: ${opts.referenceDateIso} (not auto-applied without confirm)`);
    }
    return {
      originalExpression: expression,
      resolvedLocalLabel: `${h24.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")} local`,
      timeZoneUsed: ctx.careRecipientTimeZone,
      status: "AMBIGUOUS",
      notes,
    };
  }

  if (timeMatch) {
    return {
      originalExpression: expression,
      status: "AMBIGUOUS",
      timeZoneUsed: ctx.careRecipientTimeZone,
      notes: [
        "Time-of-day without full date context",
        `Would use care-recipient TZ ${ctx.careRecipientTimeZone} if confirmed`,
      ],
    };
  }

  return {
    originalExpression: expression,
    status: "UNRESOLVED",
    notes: ["No structured time parse; keep original expression"],
  };
}

/** DST / cross-zone lab checks (synthetic). */
export function timezonePolicyNotes(): string[] {
  return [
    "Machine storage is always UTC ISO when resolved.",
    "Human expressions are preserved until caregiver confirms.",
    "Cross-zone: show both caregiver and care-recipient local labels.",
    "DST: use IANA zones via runtime Intl; never fixed UTC-5 assumptions for display.",
    "Appointment provider timezone may differ from household.",
  ];
}
