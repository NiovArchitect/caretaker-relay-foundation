/**
 * Person-first care recipient profile helpers.
 * Age and identity answers are deterministic; never invent DOB or diagnoses.
 */

import type { CareRecipient, CareRecipientProfile } from "../types.js";

/** Whole years from DOB ISO date to asOf (defaults to now). */
export function ageFromDateOfBirth(
  dateOfBirth: string,
  asOf: Date = new Date(),
): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOfBirth.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (!y || mo < 0 || mo > 11 || !d) return null;
  let age = asOf.getFullYear() - y;
  const hadBirthday =
    asOf.getMonth() > mo || (asOf.getMonth() === mo && asOf.getDate() >= d);
  if (!hadBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

export function profileOf(recipient: CareRecipient | undefined): CareRecipientProfile {
  return recipient?.profile ?? {};
}

export function answerAgeQuestion(
  recipient: CareRecipient | undefined,
): string {
  const name = recipient?.preferredName || recipient?.displayName || "this person";
  const dob = recipient?.profile?.dateOfBirth;
  if (!dob) {
    return `I don't have ${name}'s date of birth on file, so I can't confirm age.`;
  }
  const age = ageFromDateOfBirth(dob);
  if (age == null) {
    return `I have a date of birth on file for ${name}, but I can't calculate age from it reliably.`;
  }
  return `${name} is ${age} years old (date of birth on file: ${dob}).`;
}

export function answerDiagnosisQuestion(
  recipient: CareRecipient | undefined,
): string {
  const name = recipient?.preferredName || recipient?.displayName || "this person";
  const conditions = (recipient?.profile?.confirmedConditions ?? []).filter(
    (c) => c.verification === "CONFIRMED" && c.status === "active",
  );
  const concerns = recipient?.profile?.healthConcerns ?? [];
  if (conditions.length === 0) {
    let out = `I don't have a confirmed diagnosis on file for ${name}.`;
    if (concerns.length) {
      out +=
        `\n\nKnown care concerns (not diagnoses):\n` +
        concerns.map((c) => `• ${c}`).join("\n");
    }
    return out;
  }
  const lines = conditions.map((c) => {
    const src = c.sourceLabel ? ` (${c.sourceLabel})` : "";
    return `• ${c.label}${src}`;
  });
  let out = `${name} has ${conditions.length} confirmed condition${
    conditions.length === 1 ? "" : "s"
  } on file:\n${lines.join("\n")}`;
  if (concerns.length) {
    out +=
      `\n\nSeparately, the care plan tracks these as observations/concerns — not diagnoses:\n` +
      concerns.map((c) => `• ${c}`).join("\n");
  }
  return out;
}

export function answerIdentityOverview(
  recipient: CareRecipient | undefined,
): string {
  const name = recipient?.displayName || "this person";
  const pref = recipient?.preferredName;
  const p = profileOf(recipient);
  const parts: string[] = [];
  parts.push(pref && pref !== name ? `${name} (prefers ${pref})` : name);
  if (p.dateOfBirth) {
    const age = ageFromDateOfBirth(p.dateOfBirth);
    if (age != null) parts.push(`${age} years old`);
  }
  if (p.pronouns) parts.push(p.pronouns);
  if (p.primaryLanguage) parts.push(`Primary language: ${p.primaryLanguage}`);
  if (p.primaryProviderName) parts.push(`Primary provider: ${p.primaryProviderName}`);
  if (p.dailyRoutineSummary) parts.push(`Routine: ${p.dailyRoutineSummary}`);
  if (p.careLocationSummary) parts.push(`Care setting: ${p.careLocationSummary}`);
  if (p.profileSourceSummary) {
    parts.push(`Source note: ${p.profileSourceSummary}`);
  }
  return parts.join("\n");
}

export function emergencySnapshot(
  recipient: CareRecipient | undefined,
  medLines: string[],
): string {
  const name = recipient?.displayName || "Care recipient";
  const p = profileOf(recipient);
  const lines: string[] = [`Essential care snapshot — ${name}`];
  if (p.dateOfBirth) {
    const age = ageFromDateOfBirth(p.dateOfBirth);
    lines.push(
      `DOB: ${p.dateOfBirth}${age != null ? ` · age ${age}` : ""}`,
    );
  } else {
    lines.push("DOB / age: not on file");
  }
  const allergies = p.allergies?.map((a) => a.label).join("; ");
  lines.push(`Allergies: ${allergies || "not on file"}`);
  const conds = (p.confirmedConditions ?? [])
    .filter((c) => c.verification === "CONFIRMED")
    .map((c) => c.label);
  lines.push(
    `Confirmed conditions: ${conds.length ? conds.join("; ") : "none on file"}`,
  );
  lines.push(
    medLines.length
      ? `Medications on file:\n${medLines.map((m) => `• ${m}`).join("\n")}`
      : "Medications: none listed",
  );
  if (p.mobilityBaseline) lines.push(`Mobility: ${p.mobilityBaseline}`);
  if (p.communicationNeeds?.length) {
    lines.push(`Communication: ${p.communicationNeeds.join("; ")}`);
  }
  if (p.primaryProviderName) lines.push(`Primary provider: ${p.primaryProviderName}`);
  if (p.emergencyContacts?.length) {
    lines.push(
      "Emergency contacts:\n" +
        p.emergencyContacts
          .map(
            (c) =>
              `• ${c.name}${c.relationship ? ` · ${c.relationship}` : ""}${
                c.phone ? ` · ${c.phone}` : ""
              }`,
          )
          .join("\n"),
    );
  }
  lines.push(
    "Only verified fields above are listed. Missing items are not invented.",
  );
  return lines.join("\n");
}

/** Synthetic lab availability slots — Schedule/Slot honesty (not live EHR). */
export function syntheticProviderSlots(args: {
  providerHint?: string;
  dayIso?: string;
}): Array<{ startsAtLabel: string; slotId: string; available: boolean }> {
  const day = args.dayIso ?? "2026-07-29";
  // Lab-only free/busy for Coastal Family Medicine style demo
  return [
    {
      slotId: `slot-${day}-0900`,
      startsAtLabel: `Wednesday, July 29 · 9:00 AM PDT`,
      available: true,
    },
    {
      slotId: `slot-${day}-1100`,
      startsAtLabel: `Wednesday, July 29 · 11:00 AM PDT`,
      available: true,
    },
    {
      slotId: `slot-${day}-1400`,
      startsAtLabel: `Wednesday, July 29 · 2:00 PM PDT`,
      available: true,
    },
    {
      slotId: `slot-${day}-1530`,
      startsAtLabel: `Wednesday, July 29 · 3:30 PM PDT`,
      available: false,
    },
  ];
}
