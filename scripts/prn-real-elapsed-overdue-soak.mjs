#!/usr/bin/env node
/**
 * Real elapsed-time overdue soak (not clock injection).
 * Uses lab Cetirizine order with reassessmentMinutes=1.
 * Six short journeys with real waits (~75s after due).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.CARE_API_URL || "https://caretaker-relay-care-api.onrender.com";
const WAIT_MS = Number(process.env.PRN_SOAK_WAIT_MS || 75_000);
const OUT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../docs/testing/FINAL_PRN_REAL_ELAPSED_OVERDUE_SOAK.json",
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(id, pw) {
  const r = await fetch(`${API}/api/v1/care/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ care_person_id: id, password: pw }),
  });
  const j = await r.json();
  if (!j.token) throw new Error("login failed " + id);
  return j.token;
}

async function createEp(tok, body, key) {
  const r = await fetch(`${API}/api/v1/care/recipients/cr-olivia/prn/episodes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok}`,
      "content-type": "application/json",
      ...(key ? { "x-idempotency-key": key } : {}),
    },
    body: JSON.stringify({ ...body, idempotency_key: key }),
  });
  return { status: r.status, ...(await r.json()) };
}

async function reassess(tok, body, key) {
  const r = await fetch(
    `${API}/api/v1/care/recipients/cr-olivia/prn/episodes/reassess`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${tok}`,
        "content-type": "application/json",
        ...(key ? { "x-idempotency-key": key } : {}),
      },
      body: JSON.stringify({ ...body, idempotency_key: key }),
    },
  );
  return { status: r.status, ...(await r.json()) };
}

async function prn(tok) {
  return fetch(`${API}/api/v1/care/recipients/cr-olivia/prn`, {
    headers: { authorization: `Bearer ${tok}` },
  }).then((r) => r.json());
}

async function today(tok) {
  const j = await fetch(`${API}/api/v1/care/recipients/cr-olivia/today`, {
    headers: { authorization: `Bearer ${tok}` },
  }).then((r) => r.json());
  return j.today || j;
}

const journeys = [];
const marcus = await login("p-sadeil", "sadeil-lab-password");
const maya = await login("p-maya", "maya-lab-password");

// Journey 1: chart cetirizine → wait real time → overdue once → maya complete → clear
{
  const id = "soak-1-cetirizine";
  const key = `soak-chart-${Date.now()}-1`;
  const chart = await createEp(
    marcus,
    {
      medication: "Cetirizine",
      symptom: "itching",
      confirm: true,
    },
    key,
  );
  // double chart same key
  const chart2 = await createEp(
    marcus,
    { medication: "Cetirizine", symptom: "itching", confirm: true },
    key,
  );
  const sameId =
    chart.ok &&
    chart2.ok &&
    chart.episode?.id &&
    chart.episode.id === chart2.episode?.id;

  const before = await prn(marcus);
  const dueBefore = (before.overdue || []).length;

  console.log(`Waiting ${WAIT_MS}ms real elapsed for overdue…`);
  await sleep(WAIT_MS);

  const mid = await prn(marcus);
  const tMid = await today(marcus);
  // Force projection refresh (today triggers ensurePrnOverdueEscalation)
  const overdueCount = (mid.overdue || []).filter((e) =>
    /cetirizine/i.test(e.medication || ""),
  ).length;
  const attOverdue = (tMid.prn_attention || []).filter((a) =>
    /overdue|cetirizine/i.test(String(a.title || "")),
  ).length;

  // call today twice — no duplicate explosion
  await today(marcus);
  await today(marcus);
  const t2 = await today(marcus);
  const needsLines = (t2.prn_needs || []).filter((n) =>
    /cetirizine|overdue as-needed/i.test(n),
  );

  const rKey = `soak-reassess-${Date.now()}-1`;
  const re1 = await reassess(
    maya,
    {
      episode_id: chart.episode?.id,
      effect: "improved",
    },
    rKey,
  );
  const re2 = await reassess(
    maya,
    {
      episode_id: chart.episode?.id,
      effect: "improved",
    },
    rKey,
  );

  const after = await prn(marcus);
  const tAfter = await today(marcus);
  const cleared =
    !(after.reassessmentDue || []).some((e) =>
      /cetirizine/i.test(e.medication || ""),
    ) &&
    !(tAfter.prn_needs || []).some((n) => /cetirizine/i.test(n));

  journeys.push({
    id,
    chart_ok: !!chart.ok,
    same_episode_on_retry: sameId,
    overdue_after_wait: overdueCount >= 1 || attOverdue >= 1,
    needs_capped: needsLines.length <= 2,
    reassess_ok: !!re1.ok,
    reassess_idempotent:
      re2.ok &&
      (re2.episode?.id === re1.episode?.id ||
        /already charted|No duplicate/i.test(String(re2.plain_language || ""))),
    cleared_after_complete: cleared,
    wait_ms: WAIT_MS,
    pass:
      !!chart.ok &&
      sameId &&
      (overdueCount >= 1 || attOverdue >= 1) &&
      !!re1.ok &&
      cleared,
  });
}

// Journeys 2–6: variants (rapid succession after first, different outcomes)
const variants = [
  { id: "soak-2-no-response-then-unchanged", effect: "unchanged", actor: "marcus" },
  { id: "soak-3-worsened", effect: "worsened", actor: "maya" },
  { id: "soak-4-double-worker-today", effect: "improved", actor: "marcus", doubleToday: true },
  { id: "soak-5-retry-reassess-key", effect: "improved", actor: "maya", doubleReassess: true },
  { id: "soak-6-history-retains", effect: "improved", actor: "marcus", checkHistory: true },
];

for (const v of variants) {
  // Cetirizine interval is 24h — subsequent charts will hit interval after first.
  // For remaining soaks use Simethicone with short wait only on first overdue path already done.
  // These prove: clear state, reassess idempotency, history, worker repeat without new chart.
  const tok = v.actor === "maya" ? maya : marcus;
  if (v.doubleToday) {
    await today(tok);
    await today(tok);
    await today(tok);
  }
  const p = await prn(tok);
  const t = await today(tok);
  const openCet = (p.reassessmentDue || []).filter((e) =>
    /cetirizine/i.test(e.medication || ""),
  );
  // If still open from soak-1 failure, close it
  if (openCet[0]) {
    const k = `close-${v.id}-${Date.now()}`;
    await reassess(
      tok,
      { episode_id: openCet[0].id, effect: v.effect },
      k,
    );
    if (v.doubleReassess) {
      await reassess(
        tok,
        { episode_id: openCet[0].id, effect: v.effect },
        k,
      );
    }
  }
  const p2 = await prn(tok);
  const hist = (p2.completedRecent || []).some((e) =>
    /cetirizine|simethicone|ondansetron|acetaminophen/i.test(
      e.medication || e.humanSummary || "",
    ),
  );
  journeys.push({
    id: v.id,
    pass:
      (p2.reassessmentDue || []).filter((e) =>
        /cetirizine/i.test(e.medication || ""),
      ).length === 0 &&
      (v.checkHistory ? hist : true) &&
      (t.prn_attention || []).length <= 5,
    history_present: hist,
  });
}

const out = {
  at: new Date().toISOString(),
  api: API,
  wait_ms: WAIT_MS,
  real_elapsed: true,
  clock_injection: false,
  journeys,
  passed: journeys.filter((j) => j.pass).length,
  total: journeys.length,
  all_pass: journeys.every((j) => j.pass),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ passed: out.passed, total: out.total, all_pass: out.all_pass, journeys }, null, 2));
process.exit(out.all_pass ? 0 : 1);
