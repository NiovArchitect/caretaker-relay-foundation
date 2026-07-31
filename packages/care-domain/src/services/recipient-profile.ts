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

/** Mobility / transfer / assistive support from authorized profile fields. */
export function answerMobilitySupport(
  recipient: CareRecipient | undefined,
): string {
  const name =
    recipient?.preferredName || recipient?.displayName || "this person";
  const p = profileOf(recipient);
  const parts: string[] = [];
  if (p.mobilityBaseline) {
    parts.push(`Mobility baseline on file: ${p.mobilityBaseline}`);
  }
  if (p.assistiveDevices?.length) {
    parts.push(
      `Assistive devices: ${p.assistiveDevices.join("; ")}`,
    );
  } else if (p.mobilityBaseline) {
    parts.push(`Assistive devices: none listed beyond baseline notes`);
  }
  if (p.supportNeeds?.length) {
    const mobilityRelated = p.supportNeeds.filter((s) =>
      /mobility|transfer|walk|transport|stand|assist|physical/i.test(s),
    );
    const list =
      mobilityRelated.length > 0 ? mobilityRelated : p.supportNeeds.slice(0, 3);
    parts.push(
      `Support needs on file:\n` + list.map((s) => `• ${s}`).join("\n"),
    );
  }
  if (p.safetyConsiderations?.length) {
    const safetyMob = p.safetyConsiderations.filter((s) =>
      /dizz|mobility|fall|stand|transfer|walk/i.test(s),
    );
    if (safetyMob.length) {
      parts.push(
        `Safety considerations:\n` + safetyMob.map((s) => `• ${s}`).join("\n"),
      );
    }
  }
  if (p.careGoals?.length) {
    const goals = p.careGoals.filter((g) =>
      /mobility|walk|safe|dizz/i.test(g),
    );
    if (goals.length) {
      parts.push(
        `Related care goals:\n` + goals.map((g) => `• ${g}`).join("\n"),
      );
    }
  }
  if (!parts.length) {
    return (
      `I don't have mobility, transfer, or assistive-device details on file for ${name}. ` +
      `If you observe support needs during this visit, document them so they become shared care context.`
    );
  }
  return (
    `Transfer / mobility support for ${name} (authorized care profile):\n` +
    parts.map((x) => (x.startsWith("Support") || x.startsWith("Safety") || x.startsWith("Related") ? x : `• ${x}`)).join("\n") +
    `\n\nThis is functional baseline on file — not a new clinical order. ` +
    `If transfer needs have changed, update the record after you observe them.`
  );
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

/**
 * Read-only clinical retrieve answers — never invent orders or vitals.
 * Used when caregivers ask for profile domains that may not be on file yet.
 */
export function answerClinicalRetrieve(
  domain:
    | "vitals"
    | "oxygen"
    | "surgeries"
    | "therapies"
    | "comorbidities"
    | "code_status"
    | "diet"
    | "devices"
    | "orientation"
    | "mobility",
  recipient: CareRecipient | undefined,
): string {
  const name =
    recipient?.preferredName || recipient?.displayName || "this person";
  const p = profileOf(recipient);
  switch (domain) {
    case "vitals": {
      const notes = p.supportNeeds?.filter((s) =>
        /vital|bp|blood pressure|heart|temp|spo2|weight/i.test(s),
      );
      if (notes?.length) {
        return (
          `Verified vital-related notes on file for ${name}:\n` +
          notes.map((n) => `• ${n}`).join("\n") +
          `\n\nNo automated vital-sign chart is attached. Open Health & Care Details or Care for documented measurements when available.`
        );
      }
      return `No verified recent vital signs are currently on file for ${name}. This is an information gap — not a new charting action. An authorized person can record measurements or request them from the clinical team.`;
    }
    case "oxygen": {
      const devices = p.assistiveDevices ?? [];
      const ox = devices.filter((d) => /oxygen|o2|nasal|ventilat|airway/i.test(d));
      const safety = p.safetyConsiderations?.filter((s) =>
        /oxygen|o2|breath|airway|respiratory/i.test(s),
      );
      if (ox.length || safety?.length) {
        return (
          `Respiratory / oxygen-related items on file for ${name}:\n` +
          [...ox, ...(safety ?? [])].map((x) => `• ${x}`).join("\n") +
          `\n\nThese are profile notes — not a live device reading.`
        );
      }
      return `No verified oxygen or airway-support device is currently listed for ${name}. That is not the same as “not on oxygen” if a clinician has ordered it elsewhere — check Health & Care Details or confirm with the clinical team.`;
    }
    case "surgeries":
      return `No verified surgical history is currently on file for ${name}. This is an important gap. An authorized person can add it or request confirmation from her clinician.`;
    case "therapies": {
      const goals = p.careGoals?.filter((g) =>
        /therap|pt|ot|speech|rehab|recovery|hip|mobility/i.test(g),
      );
      if (goals?.length) {
        return (
          `Therapy-related goals on file for ${name}:\n` +
          goals.map((g) => `• ${g}`).join("\n") +
          `\n\nUpcoming therapy appointments appear on Today / Schedule when scheduled.`
        );
      }
      return `No verified ongoing therapy plan text is on file beyond scheduled appointments for ${name}. Check Today for PT/OT times, or open Health & Care Details when therapy goals are documented.`;
    }
    case "comorbidities":
      return answerDiagnosisQuestion(recipient);
    case "code_status": {
      // Never invent POLST/DNR. Caregiver free-text healthConcerns are NOT verified orders.
      const docs = p.advanceCareDocuments ?? [];
      if (docs.length) {
        const lines = docs.map((d) => {
          const ver = d.verificationState.replace(/_/g, " ");
          return (
            `• ${d.documentType} — ${ver}` +
            (d.currentStatusSummary ? `: ${d.currentStatusSummary}` : "") +
            (d.signer ? ` · signer ${d.signer}` : "") +
            (d.signerRole ? ` (${d.signerRole})` : "") +
            (d.effectiveDate ? ` · effective ${d.effectiveDate}` : "") +
            (d.jurisdiction ? ` · ${d.jurisdiction}` : "") +
            (d.sourceDocumentLabel ? ` · source: ${d.sourceDocumentLabel}` : "")
          );
        });
        return (
          `Advance-care / code-status documents on file for ${name}:\n` +
          lines.join("\n") +
          `\n\nA POLST is a portable medical order (when valid in the applicable state). ` +
          `An advance directive expresses broader wishes and may appoint a decision-maker. ` +
          `Only verificationState “verified medical order” is treated as an order — not caregiver labels.`
        );
      }
      const concerns = p.healthConcerns ?? [];
      const codeish = concerns.filter((c) =>
        /dnr|dni|polst|full code|advance directive|code status|comfort/i.test(c),
      );
      if (codeish.length) {
        return (
          `Unverified caregiver/care-plan notes mention code-status language for ${name}:\n` +
          codeish.map((c) => `• ${c}`).join("\n") +
          `\n\nThese are reported/unverified — not a signed POLST or medical order. ` +
          `Do not treat them as Full Code / DNR / DNI orders. Confirm with the clinical team or document source.`
        );
      }
      return `No verified code-status order (Full Code, DNR/DNI, POLST, or comfort-focused treatment) is currently on file for ${name}. Document missing — do not invent one. An authorized person can add the state-applicable form or request confirmation from her clinician.`;
    }
    case "diet": {
      const diet = p.supportNeeds?.filter((s) =>
        /diet|swallow|texture|food|meal|nutrition|puree|sodium|diabetic/i.test(s),
      );
      if (diet?.length) {
        return (
          `Diet / swallowing notes on file for ${name}:\n` +
          diet.map((d) => `• ${d}`).join("\n")
        );
      }
      return `No verified diet, texture, or swallowing instruction is currently on file for ${name}. Check the care plan or ask the clinical team before changing food or fluid texture.`;
    }
    case "devices": {
      const devices = p.assistiveDevices ?? [];
      if (devices.length) {
        return (
          `Devices and equipment on file for ${name}:\n` +
          devices.map((d) => `• ${d}`).join("\n")
        );
      }
      return `No medical or assistive devices are listed on file for ${name} yet.`;
    }
    case "orientation": {
      const notes = [
        ...(p.communicationNeeds ?? []),
        ...(p.safetyConsiderations ?? []),
        ...(p.healthConcerns ?? []),
      ].filter((s) =>
        /orient|cognit|memory|confus|acting like|baseline|dementia|alert/i.test(
          s,
        ),
      );
      if (notes.length) {
        return (
          `Orientation / cognitive baseline notes on file for ${name}:\n` +
          notes.map((n) => `• ${n}`).join("\n") +
          `\n\nIf they are not acting like themself right now, document a new observation — this answer is retrieve-only.`
        );
      }
      return `No verified orientation or cognitive baseline is currently on file for ${name}. This is an information gap — not a charting action. An authorized person can add baseline notes or request them from the clinical team.`;
    }
    case "mobility":
      return answerMobilitySupport(recipient);
    default:
      return `No verified information is on file for that clinical domain for ${name}.`;
  }
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
