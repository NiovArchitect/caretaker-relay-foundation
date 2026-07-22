/**
 * Medication dose unit parsing and comparison.
 *
 * Responsibility: detect material quantity/unit discrepancies for human review.
 * Does NOT recommend doses or practice medicine.
 *
 * Mass and volume are never auto-converted without concentration.
 */

export type DoseDimension = "mass" | "volume" | "count" | "unknown";

export type ParsedDose =
  | {
      kind: "quantity";
      value: number;
      unit: string;
      dimension: DoseDimension;
      /** Canonical magnitude in base unit (mg for mass, mL for volume). */
      baseValue: number;
      baseUnit: string;
      raw: string;
      confidence: "high" | "low";
    }
  | {
      kind: "missing_unit";
      value: number;
      raw: string;
    }
  | {
      kind: "ambiguous";
      raw: string;
      reason: string;
    };

export type DoseCompareResult =
  | { status: "match"; recorded: ParsedDose; authorized: ParsedDose }
  | {
      status: "discrepancy";
      severity: "high" | "moderate";
      message: string;
      recordedDose: string;
      authorizedDose: string;
      recorded: ParsedDose;
      authorized: ParsedDose;
    }
  | {
      status: "unresolved";
      severity: "high" | "moderate";
      message: string;
      recordedDose: string;
      authorizedDose: string;
      recorded?: ParsedDose;
      authorized?: ParsedDose;
    };

const WORD_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  half: 0.5,
};

/** Normalize free-text numbers: "two point five", "2 point 5", "two and a half". */
export function normalizeNumericWords(text: string): string {
  let t = text.toLowerCase();
  t = t.replace(/\btwo\s+and\s+a\s+half\b/g, "2.5");
  t = t.replace(/\bone\s+and\s+a\s+half\b/g, "1.5");
  t = t.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+point\s+(zero|one|two|three|four|five|six|seven|eight|nine)\b/g,
    (_, a: string, b: string) => `${WORD_NUMBERS[a]}.${WORD_NUMBERS[b]}`,
  );
  t = t.replace(
    /\b(\d+)\s*point\s*(\d+)\b/g,
    (_, a: string, b: string) => `${a}.${b}`,
  );
  t = t.replace(/\bhalf\s+a\b/g, "0.5");
  // STT spacing: "M G" → mg
  t = t.replace(/\bm\s+g\b/g, "mg");
  t = t.replace(/\bm\s*c\s*g\b/g, "mcg");
  return t;
}

type UnitSpec = {
  unit: string;
  dimension: DoseDimension;
  /** Multiply value to get base unit magnitude. */
  toBase: number;
  baseUnit: string;
  aliases: RegExp;
};

const UNIT_SPECS: UnitSpec[] = [
  {
    unit: "mcg",
    dimension: "mass",
    toBase: 0.001, // → mg
    baseUnit: "mg",
    aliases: /(?:mcg|µg|ug|micrograms?|mics?|megs?)\b/i,
  },
  {
    unit: "mg",
    dimension: "mass",
    toBase: 1,
    baseUnit: "mg",
    aliases: /(?:mg|milligrams?|m\s*g)\b/i,
  },
  {
    unit: "g",
    dimension: "mass",
    toBase: 1000, // → mg
    baseUnit: "mg",
    aliases: /(?:grams?|grammes?|\bg\b)/i,
  },
  {
    unit: "mL",
    dimension: "volume",
    toBase: 1,
    baseUnit: "mL",
    aliases: /(?:mL|ml|milliliters?|millilitres?)\b/i,
  },
  {
    unit: "L",
    dimension: "volume",
    toBase: 1000, // → mL
    baseUnit: "mL",
    aliases: /(?:liters?|litres?|\bL\b)/i,
  },
  {
    unit: "tablet",
    dimension: "count",
    toBase: 1,
    baseUnit: "tablet",
    aliases: /(?:tablets?|tabs?|pills?)\b/i,
  },
];

/**
 * Parse a recorded or authorized dose string into a structured quantity.
 * Accepts phrases already extracted (e.g. "2.5 grams") or short labels.
 */
export function parseDose(input: string): ParsedDose | null {
  if (!input || !input.trim()) return null;
  const raw = input.trim();
  const normalized = normalizeNumericWords(raw);

  // Ambiguous non-numeric / vague quantifiers
  if (
    /\b(a couple|some|a few|about|approx|approximately|maybe|several)\b/i.test(
      normalized,
    )
  ) {
    return {
      kind: "ambiguous",
      raw,
      reason: "Non-numeric or vague quantity",
    };
  }
  if (/\b(half\s+a\s+tablet|one\s+pill|a\s+pill|tablet|pill)\b/i.test(normalized)) {
    // count without strength → unresolved for mg comparison
    const tab = normalized.match(
      /(\d+(?:\.\d+)?)\s*(?:tablets?|tabs?|pills?)\b/i,
    );
    if (tab) {
      const value = parseFloat(tab[1]!);
      return {
        kind: "quantity",
        value,
        unit: "tablet",
        dimension: "count",
        baseValue: value,
        baseUnit: "tablet",
        raw: tab[0],
        confidence: "high",
      };
    }
    return {
      kind: "ambiguous",
      raw,
      reason: "Count unit without tablet strength — cannot convert to mg",
    };
  }

  // Numeric + unit (prefer longer unit aliases)
  const numUnit = normalized.match(
    /(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s*([a-zµμ\s]+)?/i,
  );
  if (!numUnit) {
    if (/\bnan\b|null|undefined/i.test(normalized)) {
      return { kind: "ambiguous", raw, reason: "Malformed quantity" };
    }
    return null;
  }

  const value = Number(numUnit[1]);
  if (!Number.isFinite(value)) {
    return { kind: "ambiguous", raw, reason: "Non-finite quantity" };
  }
  if (value < 0) {
    return { kind: "ambiguous", raw, reason: "Negative quantity" };
  }

  const unitText = (numUnit[2] ?? "").trim();
  if (!unitText) {
    // bare number
    return { kind: "missing_unit", value, raw: String(value) };
  }

  for (const spec of UNIT_SPECS) {
    // Match unit text alone or as full suffix
    if (spec.aliases.test(unitText) || spec.aliases.test(normalized)) {
      // Avoid matching bare "g" inside "mg" — already ordered mcg/mg before g
      if (spec.unit === "g" && /mg|mcg|micro/i.test(unitText)) continue;
      if (spec.unit === "L" && /mL|ml|milli/i.test(unitText)) continue;
      return {
        kind: "quantity",
        value,
        unit: spec.unit,
        dimension: spec.dimension,
        baseValue: value * spec.toBase,
        baseUnit: spec.baseUnit,
        raw: `${value} ${spec.unit}`,
        confidence: /megs|mics/i.test(unitText) ? "low" : "high",
      };
    }
  }

  return {
    kind: "ambiguous",
    raw,
    reason: `Unrecognized unit “${unitText}”`,
  };
}

/** Extract first dose phrase from a caregiver utterance. */
export function extractDoseFromText(text: string): string | undefined {
  const normalized = normalizeNumericWords(text);
  // Explicit unit phrases
  const withUnit = normalized.match(
    /(\d+(?:\.\d+)?)\s*(?:micrograms?|milligrams?|milliliters?|millilitres?|grams?|grammes?|mcg|µg|ug|mg|mL|ml|g|L|megs?|mics?|tablets?|tabs?|pills?|m\s*g)\b/i,
  );
  if (withUnit) return withUnit[0].replace(/\s+/g, " ").trim();

  // bare number near medication context only — return bare for missing-unit handling
  if (
    /medication|meds|dose|mg|gave|administered/i.test(normalized) &&
    /(\d+(?:\.\d+)?)\b/.test(normalized)
  ) {
    // Prefer number immediately after "medication" or "dose"
    const near = normalized.match(
      /(?:medication|meds|dose)\s+(\d+(?:\.\d+)?)\b/i,
    );
    if (near) return near[1];
  }
  return undefined;
}

/**
 * Compare recorded administration dose vs authorized schedule dose.
 * Never invents mass↔volume conversion without concentration.
 */
export function compareMedicationDoses(
  recordedDose: string | undefined,
  authorizedDose: string,
): DoseCompareResult | undefined {
  if (!recordedDose?.trim()) return undefined;

  const recorded = parseDose(recordedDose);
  const authorized = parseDose(authorizedDose);

  if (!recorded) return undefined;
  if (!authorized || authorized.kind !== "quantity") {
    return {
      status: "unresolved",
      severity: "high",
      message:
        "Cannot interpret authorized dose instruction for comparison. Requires human review.",
      recordedDose: recordedDose.trim(),
      authorizedDose,
      recorded,
    };
  }

  if (recorded.kind === "missing_unit") {
    return {
      status: "unresolved",
      severity: "high",
      message:
        "Reported dose is missing units. Relay will not assume milligrams. Requires human review.",
      recordedDose: recordedDose.trim(),
      authorizedDose,
      recorded,
      authorized,
    };
  }

  if (recorded.kind === "ambiguous") {
    return {
      status: "unresolved",
      severity: "high",
      message: `Reported dose is ambiguous (${recorded.reason}). Requires human review.`,
      recordedDose: recordedDose.trim(),
      authorizedDose,
      recorded,
      authorized,
    };
  }

  // recorded is quantity
  if (recorded.dimension !== authorized.dimension) {
    return {
      status: "discrepancy",
      severity: "high",
      message:
        "Reported dose unit is not comparable to the authorized instruction (incompatible dimensions). Relay will not invent a conversion.",
      recordedDose: recorded.raw,
      authorizedDose: authorized.raw,
      recorded,
      authorized,
    };
  }

  if (recorded.dimension === "count" || authorized.dimension === "count") {
    // count vs mass: unless both count, unresolved
    if (recorded.dimension !== authorized.dimension) {
      return {
        status: "unresolved",
        severity: "high",
        message:
          "Count-based report cannot be converted to the authorized dose without tablet strength. Requires human review.",
        recordedDose: recorded.raw,
        authorizedDose: authorized.raw,
        recorded,
        authorized,
      };
    }
  }

  // Same dimension — compare base values
  const a = recorded.baseValue;
  const b = authorized.baseValue;
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return {
      status: "unresolved",
      severity: "high",
      message: "Dose quantities are not comparable. Requires human review.",
      recordedDose: recorded.raw,
      authorizedDose: authorized.raw,
      recorded,
      authorized,
    };
  }

  // Relative tolerance for floating point (e.g. 0.0025 g = 2.5 mg)
  const rel = Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
  const abs = Math.abs(a - b);
  if (rel < 1e-6 || abs < 1e-6) {
    if (recorded.confidence === "low") {
      return {
        status: "unresolved",
        severity: "moderate",
        message:
          "Dose may match but unit transcription confidence is low. Requires human review.",
        recordedDose: recorded.raw,
        authorizedDose: authorized.raw,
        recorded,
        authorized,
      };
    }
    return { status: "match", recorded, authorized };
  }

  const ratio = a / b;
  const severity: "high" | "moderate" =
    ratio >= 10 || ratio <= 0.1 || abs >= b * 0.5 ? "high" : "moderate";

  return {
    status: "discrepancy",
    severity,
    message:
      severity === "high"
        ? "Recorded dose does not match the authorized care instruction (material quantity or unit difference). Relay will not choose."
        : "Recorded dose differs from the authorized care instruction. Relay will not choose.",
    recordedDose: recorded.raw,
    authorizedDose: authorized.raw,
    recorded,
    authorized,
  };
}
