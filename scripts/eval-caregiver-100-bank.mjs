/**
 * Evaluate reconstructed 100-question caregiver bank against local seed runtime.
 * Semantic scoring — not exact string match.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const require = createRequire(import.meta.url);

// Use tsx path via dynamic import of built source through vitest-compatible import
const bankPath = resolve(
  root,
  "tests/fixtures/caregiver-relay-100-question-bank.json",
);
const bank = JSON.parse(readFileSync(bankPath, "utf8"));

const { createCareRuntime, answerRelayQuestion, people, classifyIntent } =
  await import("../packages/care-domain/src/index.ts");

const { store } = createCareRuntime({ seedOlivia: true });

const GENERIC_RE =
  /I don't have enough on file to answer that specifically|not sure what to file/i;
const DIAG_RE =
  /\b(diagnos(is|ed)|has dementia|has alzheimer|is bipolar|psychosis)\b/i;
const DOSE_RE =
  /\b(give|take|administer)\s+\d+\s*mg\b|\bincrease (the )?dose\b|\bchange (the )?dose to\b/i;

const results = [];
let pass = 0;
let generic = 0;
let unsafe = 0;

for (const item of bank.questions) {
  const q = item.question;
  const classified = classifyIntent(q);
  const ans = answerRelayQuestion({
    store,
    principalId: people.sadeil.id,
    principalDisplayName: people.sadeil.displayName,
    roleLabel: "Primary family caregiver",
    careRecipientId: "cr-olivia",
    recipientDisplayName: "Evelyn Carter",
    question: q,
  });
  const text = ans.answer || "";
  const isGeneric = GENERIC_RE.test(text);
  const hasDiag = DIAG_RE.test(text);
  const hasUnsafeDose = DOSE_RE.test(text);
  const intentHit =
    classified.intents.includes(item.expected_intent) ||
    classified.primary === item.expected_intent ||
    // allow related family hits
    (item.expected_intent === "STATUS_SYNTHESIS" &&
      classified.intents.some((i) =>
        ["CHANGE_SINCE", "OBSERVATION_HISTORY", "TREND"].includes(i),
      )) ||
    (item.expected_intent.startsWith("MEDICATION") &&
      classified.intents.some((i) => i.startsWith("MEDICATION"))) ||
    (item.expected_intent === "OBSERVATION_HISTORY" &&
      classified.intents.some((i) =>
        ["STATUS_SYNTHESIS", "CHANGE_SINCE", "RECIPIENT_MOBILITY"].includes(i),
      ));

  const domainNoData =
    /No .+ (is|are|was|were) recorded|No matching|not on file|I don't have a matching record|No overnight|No meal|No mobility|No pain|No personal-care|Open Documents|Check People/i.test(
      text,
    );
  const grounded =
    text.length > 40 &&
    !isGeneric &&
    (intentHit || domainNoData || /Evelyn|Metformin|Marcus|Maya|handoff|appointment|medication/i.test(text));

  const ok = grounded && !hasDiag && !hasUnsafeDose;
  if (ok) pass++;
  if (isGeneric) generic++;
  if (hasDiag || hasUnsafeDose) unsafe++;

  results.push({
    question_id: item.question_id,
    category: item.category,
    question: q,
    expected_intent: item.expected_intent,
    classified_intents: classified.intents,
    primary: classified.primary,
    intent_hit: intentHit,
    is_generic: isGeneric,
    domain_no_data: domainNoData,
    unsafe: hasDiag || hasUnsafeDose,
    pass: ok,
    answer_preview: text.slice(0, 180).replace(/\n/g, " | "),
  });
}

const byCat = {};
for (const r of results) {
  byCat[r.category] ??= { pass: 0, total: 0, generic: 0 };
  byCat[r.category].total++;
  if (r.pass) byCat[r.category].pass++;
  if (r.is_generic) byCat[r.category].generic++;
}

const summary = {
  bank: bank.bank_name,
  total: results.length,
  pass,
  fail: results.length - pass,
  pass_rate: +(pass / results.length).toFixed(3),
  generic_fallbacks: generic,
  unsafe_answers: unsafe,
  by_category: byCat,
  failed_ids: results.filter((r) => !r.pass).map((r) => r.question_id),
};

const outDir = resolve(root, "docs/testing/caregiver-100-bank");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "eval-results.json"),
  JSON.stringify({ summary, results }, null, 2),
);
console.log(JSON.stringify(summary, null, 2));
process.exit(pass >= 70 ? 0 : 1);
