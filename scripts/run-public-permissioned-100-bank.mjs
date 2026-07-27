#!/usr/bin/env node
/**
 * Public HTTP permissioned bank smoke + results merge.
 * Full multi-variant authorization matrix runs in:
 *   tests/unit/care/relay-public-permissioned-100-bank.eval.test.ts (≥600 evals)
 *
 * This script hits the live API for the full 100-question set as an authorized
 * family caregiver, plus unauth denial.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const API = process.env.CARE_API_URL || "https://caretaker-relay-care-api.onrender.com";
const bank = JSON.parse(
  readFileSync(resolve(root, "tests/fixtures/caregiver-relay-100-question-bank.json"), "utf8"),
);
const questions = bank.questions ?? [];

async function post(path, body, token) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = "Bearer " + token;
  const res = await fetch(API + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  let j = {};
  try {
    j = await res.json();
  } catch {
    /* ignore */
  }
  return { status: res.status, body: j };
}

const unauth = await post("/api/v1/care/answer", {
  question: "How is Evelyn?",
  care_recipient_id: "cr-olivia",
});

let token = null;
const login = await post("/api/v1/care/auth/login", {
  care_person_id: "p-sadeil",
  password: "sadeil-lab-password",
});
if (login.status === 200) token = login.body.token;

let answered = 0;
let failed = 0;
const samples = [];
if (token) {
  for (const q of questions) {
    const template = q.question || q.text || q.prompt || "";
    const r = await post(
      "/api/v1/care/answer",
      {
        question: String(template).replace(/\{name\}/gi, "Evelyn"),
        care_recipient_id: "cr-olivia",
      },
      token,
    );
    if (r.status === 200 && r.body && (r.body.ok === true || r.body.answer)) {
      answered++;
    } else {
      failed++;
    }
    if (samples.length < 15) {
      samples.push({
        id: q.id,
        status: r.status,
        preview: String(r.body?.answer || r.body?.message || "").slice(0, 100),
      });
    }
  }
}

// Merge local matrix if present
let local = null;
const localPath = resolve(root, "docs/testing/PUBLIC_PERMISSIONED_100_BANK_RESULTS.json");
if (existsSync(localPath)) {
  try {
    local = JSON.parse(readFileSync(localPath, "utf8"));
  } catch {
    /* ignore */
  }
}

const summary = {
  public_http: {
    api: API,
    unauth_status: unauth.status,
    public_questions: questions.length,
    public_answered: answered,
    public_failed: failed,
    samples,
    timestamp: new Date().toISOString(),
  },
  local_matrix: local,
};

mkdirSync(resolve(root, "docs/testing"), { recursive: true });
writeFileSync(
  resolve(root, "docs/testing/PUBLIC_PERMISSIONED_100_BANK_HTTP.json"),
  JSON.stringify(summary, null, 2),
);
console.log(JSON.stringify(summary.public_http, null, 2));
process.exit(unauth.status === 401 && answered >= 70 ? 0 : 1);
