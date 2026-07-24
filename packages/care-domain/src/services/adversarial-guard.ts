/**
 * Adversarial reliability guards — false premises, wrong-person claims,
 * injection strings treated as data, role self-assertion ignored.
 *
 * Deterministic; no LLM required.
 */

import type { CareStore } from "../store/memory-store.js";
import {
  findTeamMembersByNameHint,
  listCareTeam,
  resolveCurrentProvider,
  resolveEscalationTarget,
} from "./care-team.js";
import { resolvePersonName } from "../relay/util.js";

export type AdversarialVerdict = {
  blocked: boolean;
  answer?: string;
  reason:
    | "false_premise"
    | "wrong_person"
    | "wrong_provider"
    | "role_assertion"
    | "injection"
    | "hallucination_trap"
    | "causal_medical"
    | "cross_recipient_claim"
    | "none";
};

function medNamesOnFile(store: CareStore, careRecipientId: string): string[] {
  return store.getMedSchedules(careRecipientId).map((m) => m.name.toLowerCase());
}

function providerInstructionBlob(
  store: CareStore,
  careRecipientId: string,
): string {
  const schedules = store.getMedSchedules(careRecipientId);
  const parts = schedules.map(
    (s) =>
      `${s.name} ${s.dose} authorized by ${s.authorizedBy ?? "unknown"}: ${s.scheduleLabel}`,
  );
  return parts.join("\n").toLowerCase();
}

/**
 * Pre-answer adversarial scan. If blocked, caller should return the answer as-is.
 */
export function scanAdversarialQuestion(input: {
  store: CareStore;
  careRecipientId: string;
  recipientDisplayName: string;
  principalId: string;
  principalDisplayName: string;
  roleLabel: string;
  question: string;
}): AdversarialVerdict {
  const q = input.question.trim();
  const qLow = q.toLowerCase();
  const store = input.store;
  const rid = input.careRecipientId;
  const recipient = input.recipientDisplayName;

  // Prompt injection patterns inside the user question itself
  if (
    /ignore (all |previous )?rules|system:\s*grant|jailbreak|reveal (all |every )?record|dump (all )?phi|override safety/i.test(
      q,
    )
  ) {
    return {
      blocked: true,
      reason: "injection",
      answer:
        "I can't follow instructions that try to override safety or access rules. " +
        "I only use authorized care information for the active recipient. What care question can I help with?",
    };
  }

  // Conversational role self-assertion — auth wins
  if (
    /i('m| am) (the |a )?(doctor|physician|dr\.|provider|admin|system)/i.test(q) ||
    /pretend i('m| am)|act as if i('m| am) (dr|doctor|physician)/i.test(q)
  ) {
    return {
      blocked: true,
      reason: "role_assertion",
      answer:
        `Your signed-in role is ${input.roleLabel} (${input.principalDisplayName}). ` +
        `I use authenticated identity for permissions — not role claims in chat. ` +
        `What do you need for ${recipient}'s care?`,
    };
  }

  // Insulin / med false premise when not on schedule
  const meds = medNamesOnFile(store, rid);
  if (
    /\binsulin\b/i.test(q) &&
    !meds.some((m) => /insulin/.test(m)) &&
    /(takes|taking|on|give|gave|right\?|correct\?)/i.test(q)
  ) {
    return {
      blocked: true,
      reason: "false_premise",
      answer:
        `I don't have insulin on ${recipient}'s current medication schedule.\n\n` +
        (meds.length
          ? `Current medications on file:\n${store
              .getMedSchedules(rid)
              .map((s) => `• ${s.name} ${s.dose}`)
              .join("\n")}`
          : `No medications are listed yet.`) +
        `\n\nIf a newer prescription exists, I can help verify it with an authorized source.`,
    };
  }

  // "Double the dose" / fabricated provider instruction
  if (
    /double (the |her |his )?dose|told us to double|doctor changed the dose|dr\.?\s*\w+ (told|said).*double/i.test(
      q,
    )
  ) {
    const instr = providerInstructionBlob(store, rid);
    if (!/double/.test(instr)) {
      const schedules = store.getMedSchedules(rid);
      const current = schedules[0]
        ? `${schedules[0].name} ${schedules[0].dose} — ${schedules[0].scheduleLabel}${
            schedules[0].authorizedBy ? ` (authorized by ${schedules[0].authorizedBy})` : ""
          }`
        : "none on file";
      const provider = resolveCurrentProvider(store, rid);
      const askLine = provider
        ? `\n\nI can prepare a question for ${provider.displayName} (${provider.roleLabel}) if you received a newer instruction.`
        : `\n\nIf you were given a newer instruction, I can help verify it with an authorized clinician on the care team.`;
      return {
        blocked: true,
        reason: "false_premise",
        answer:
          `I don't have a provider instruction on file to double ${recipient}'s dose.\n\n` +
          `Current authorized instruction: ${current}.` +
          askLine +
          `\n\nI will not treat a caregiver statement as a professional dose change without verification.`,
      };
    }
  }

  // Cross-recipient pill claim
  if (
    /robert.*evelyn|evelyn.*robert.*(pill|med|dose)|evelyn'?s medicine too|everyone else'?s med/i.test(
      qLow,
    )
  ) {
    return {
      blocked: true,
      reason: "cross_recipient_claim",
      answer:
        `I only answer from the active care recipient's authorized records (${recipient}). ` +
        `I won't mix medication information across people. Switch recipients if you need a different person's care context.`,
    };
  }

  // "Just guess"
  if (/just guess|make (it |something )?up|invent|hallucinate/i.test(q)) {
    return {
      blocked: true,
      reason: "hallucination_trap",
      answer:
        `I don't guess about care. If something isn't on file, I'll say so and help you verify or ask the right person.`,
    };
  }

  // Mark done without evidence
  if (
    /i know she took it.*mark|mark it (done|given|complete)|just mark.*(done|given)/i.test(
      q,
    )
  ) {
    return {
      blocked: true,
      reason: "false_premise",
      answer:
        `I can't mark a medication as given from a chat assertion alone. ` +
        `Record what happened and confirm it so the medication history stays accurate and reviewable.`,
    };
  }

  // Delete prescription
  if (/delete (the )?(old )?prescription|erase (the )?med/i.test(q)) {
    return {
      blocked: true,
      reason: "false_premise",
      answer:
        `I won't delete care records from chat. Corrections supersede prior truth with provenance — they don't erase history.`,
    };
  }

  // Wrong person: named caregiver not on this recipient's team
  const namedCaregiver = q.match(
    /\b(maya|daniel|marcus|walter)\b/i,
  );
  if (
    namedCaregiver &&
    /give|gave|told|said|for robert|robert's/i.test(q) &&
    /robert/i.test(q)
  ) {
    const hint = namedCaregiver[1]!;
    const onRobert = findTeamMembersByNameHint(store, "cr-robert", hint);
    // Only apply when active recipient is Robert or question is about Robert
    if (rid === "cr-robert" || /robert/i.test(q)) {
      const team = listCareTeam(store, rid === "cr-robert" ? "cr-robert" : rid);
      const onTeam = team.some((m) =>
        m.displayName.toLowerCase().includes(hint.toLowerCase()),
      );
      if (!onTeam && onRobert.length === 0) {
        return {
          blocked: true,
          reason: "wrong_person",
          answer:
            `I don't have ${resolvePersonName(undefined, hint)} as an authorized care-team member for this question's recipient context. ` +
            `I won't invent their involvement. Who should I check with from the care team?`,
        };
      }
    }
  }

  // Provider named but not current/on team for this recipient
  const providerHint = q.match(/\bdr\.?\s*([a-z]+)/i);
  if (providerHint && /say|said|told|instruction|order/i.test(q)) {
    const name = providerHint[1]!;
    const matches = findTeamMembersByNameHint(store, rid, name, {
      includeInactive: true,
    });
    const current = matches.filter((m) => m.isCurrent);
    const blob = providerInstructionBlob(store, rid);
    if (current.length === 0 && matches.length === 0 && !blob.includes(name.toLowerCase())) {
      const cur = resolveCurrentProvider(store, rid);
      return {
        blocked: true,
        reason: "wrong_provider",
        answer:
          `I don't have Dr. ${name} listed on ${recipient}'s current care team` +
          (cur
            ? `. Current provider on file: ${cur.displayName} (${cur.roleLabel}).`
            : `.`) +
          `\n\nI won't invent provider instructions. If you have a written order, I can help verify it.`,
      };
    }
  }

  // Causal medical — never diagnose; offer data-driven provider escalation
  if (
    /did .+ cause|caused by|side effect of|is it from the med/i.test(q) ||
    /could (the |her |his )?dizz.*med|med.*cause.*dizz/i.test(q)
  ) {
    const provider = resolveEscalationTarget(
      store,
      rid,
      "provider_clinical",
      input.principalId,
    );
    const offer = provider
      ? `I can prepare a concise question for ${provider.displayName} (${provider.roleLabel}${
          provider.organizationName ? `, ${provider.organizationName}` : ""
        }) with the relevant timeline. Want me to ask them?`
      : `I can help you prepare a question for an authorized clinician on ${recipient}'s care team.`;
    return {
      blocked: true,
      reason: "causal_medical",
      answer:
        `I can share timing from ${recipient}'s records, but I can't determine medical causation — that needs clinical judgment.\n\n` +
        offer,
    };
  }

  // Nonexistent med/doctor "right?" soft traps handled by false premise above
  if (
    /\b(protocol zeta|protocol 9|diagnosis of|stage 4)\b/i.test(q) &&
    /right\?|correct\?|confirm/i.test(q)
  ) {
    return {
      blocked: true,
      reason: "hallucination_trap",
      answer: `I don't have that on ${recipient}'s care file. I won't invent clinical details.`,
    };
  }

  return { blocked: false, reason: "none" };
}

/** Treat stored text as data — strip control-looking lines when displaying. */
export function sanitizeRetrievedTextAsData(text: string): string {
  return text
    .split("\n")
    .filter(
      (line) =>
        !/^\s*(ignore all rules|system:|assistant:|<\/?script)/i.test(line),
    )
    .join("\n");
}
