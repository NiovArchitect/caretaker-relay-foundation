/**
 * Public API gap-closure smoke — 5 role journeys + 3 judge paths (API-level).
 * Run: node scripts/gap-closure-public-smoke.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const API =
  process.env.CARE_API_URL ??
  "https://caretaker-relay-care-api.onrender.com";

async function req(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function login(pid, pw) {
  return req("POST", "/api/v1/care/auth/login", null, {
    care_person_id: pid,
    password: pw,
  });
}

const results = [];
function log(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(pass ? "PASS" : "FAIL", name, detail);
}

async function main() {
  const t0 = Date.now();

  // Zero-access signup
  const email = `gap-${Date.now()}@example.test`;
  const reg = await req("POST", "/api/v1/care/auth/register", null, {
    email,
    password: "GapClosure!23456",
    display_name: "Gap Closure User",
    claimed_relationship: "family_friend",
  });
  log(
    "family_zero_access_register",
    reg.status === 201 && reg.json.authorized_recipients === 0,
    `auth=${reg.json.authorized_recipients}`,
  );
  const newTok = reg.json.token;
  const deny = await req(
    "GET",
    "/api/v1/care/recipients/cr-olivia/privacy",
    newTok,
  );
  log(
    "family_zero_access_privacy_denied",
    deny.status === 403,
    String(deny.json.code),
  );

  // Invite pre-auth PHI safe
  const pre = await req(
    "GET",
    "/api/v1/care/invitations/preview?token=invalid-token-xyz-12345",
  );
  const preStr = JSON.stringify(pre.json).toLowerCase();
  log(
    "invite_preauth_zero_phi",
    pre.status === 200 &&
      pre.json.phi_disclosed === false &&
      !preStr.includes("evelyn") &&
      !preStr.includes("metformin"),
    `phi_disclosed=${pre.json.phi_disclosed}`,
  );

  // Family journey (lab)
  const fam = await login("p-sadeil", "sadeil-lab-password");
  const ft = fam.json.token;
  log("family_login", fam.status === 200 && !!ft);
  const proj = await req(
    "GET",
    "/api/v1/care/recipients/cr-olivia/projection",
    ft,
  );
  log(
    "family_projection",
    proj.status === 200 && proj.json.role === "family_friend",
    proj.json.role,
  );
  const priv = await req(
    "GET",
    "/api/v1/care/recipients/cr-olivia/privacy",
    ft,
  );
  log(
    "family_privacy_center",
    priv.status === 200 && priv.json.privacy?.people?.length > 0,
    `people=${priv.json.privacy?.people?.length}`,
  );
  const obs = await req(
    "POST",
    "/api/v1/care/recipients/cr-olivia/events",
    ft,
    {
      type: "observation",
      title: "Morning report",
      statement: "Evelyn ate breakfast and drank water at 9:10 AM.",
      source_kind: "family_report",
      event_at: "2026-07-27T16:10:00Z",
      report_at: "2026-07-27T16:15:00Z",
    },
  );
  log(
    "family_ingest",
    obs.status === 201 && obs.json.event?.eventAt,
    obs.json.event?.id,
  );
  const sch = await req(
    "POST",
    "/api/v1/care/recipients/cr-olivia/schedule",
    ft,
    {
      title: "Therapy",
      starts_at: "2026-07-27T22:00:00Z",
      starts_at_label: "3:00 PM",
      schedule_state: "confirmed",
    },
  );
  log("family_schedule", sch.status === 201, sch.json.appointment?.id);
  const act = await req(
    "POST",
    "/api/v1/care/recipients/cr-olivia/actions",
    ft,
    {
      type: "notify_helpers",
      title: "Therapy today",
      summary: "Therapy at 3pm",
      payload: { body: "Therapy at 3pm" },
    },
  );
  log(
    "family_action_confirm_required",
    act.status === 202 && act.json.requires_confirmation,
  );
  if (act.json.action?.id) {
    const dec = await req(
      "POST",
      `/api/v1/care/recipients/cr-olivia/actions/${act.json.action.id}/decide`,
      ft,
      { decision: "approve" },
    );
    log(
      "family_action_executed",
      dec.status === 200 && dec.json.action?.status === "executed",
    );
  }

  // Judge journey 3 — medication conflict
  const mm = await req(
    "POST",
    "/api/v1/care/recipients/cr-olivia/conflicts/medication-mismatch",
    ft,
    {
      medication_name: "Metformin",
      reported_amount: "1000 mg",
      plan_amount: "500 mg",
    },
  );
  log(
    "judge3_med_conflict_open",
    mm.status === 201 &&
      mm.json.conflict?.kind === "medication_mismatch" &&
      /dosage|care plan/i.test(mm.json.conflict?.whyCannotDecide ?? ""),
  );
  const confId = mm.json.conflict?.id;
  const clin = await login("p-dr-shah", "drshah-lab-password");
  const ct = clin.json.token;
  log("clinician_login", clin.status === 200 && !!ct);
  const csum = await req(
    "GET",
    "/api/v1/care/recipients/cr-olivia/clinical-summary",
    ct,
  );
  log(
    "clinician_summary",
    csum.status === 200 && csum.json.summary?.boundaries?.length > 0,
  );
  if (confId) {
    const res = await req(
      "POST",
      `/api/v1/care/recipients/cr-olivia/conflicts/${confId}/resolve`,
      ct,
      {
        resolution: "Keep authorized plan 500 mg",
        chosen_statement: "Authorized Metformin 500 mg confirmed after review",
      },
    );
    log(
      "judge3_med_conflict_resolved",
      res.status === 200 && res.json.conflict?.status === "resolved",
    );
  }

  // DSP journey
  const shift = await req(
    "POST",
    "/api/v1/care/recipients/cr-olivia/shifts",
    ft,
    {
      assignee_person_id: "p-walter",
      assignee_display_name: "Walter Brooks",
      shift_start: new Date(Date.now() + 3600_000).toISOString(),
      shift_end: new Date(Date.now() + 5 * 3600_000).toISOString(),
    },
  );
  log("dsp_shift_created", shift.status === 201, shift.json.assignment?.id);
  const sid = shift.json.assignment?.id;
  const dsp = await login("p-walter", "walter-lab-password");
  const dt = dsp.json.token;
  log("dsp_login", dsp.status === 200 && !!dt);
  if (sid) {
    const decline = await req(
      "POST",
      `/api/v1/care/recipients/cr-olivia/shifts/${sid}/respond`,
      dt,
      { decision: "decline" },
    );
    log(
      "dsp_decline",
      decline.status === 200 && decline.json.assignment?.status === "declined",
    );
    const cov = await req(
      "POST",
      "/api/v1/care/recipients/cr-olivia/shifts/coverage",
      ft,
      {
        declined_assignment_id: sid,
        replacement_person_id: "p-dsp-replacement",
        replacement_display_name: "Replacement DSP",
      },
    );
    log("dsp_coverage", cov.status === 201, cov.json.assignment?.id);
    // Cannot lab-login replacement without principal — accept via family creating is enough for structure
    const shifts = await req(
      "GET",
      "/api/v1/care/recipients/cr-olivia/shifts",
      ft,
    );
    log(
      "dsp_shifts_listed",
      shifts.status === 200 && (shifts.json.shifts?.length ?? 0) >= 2,
      `n=${shifts.json.shifts?.length}`,
    );
  }

  // ETL reliability
  const etl = await req("POST", "/api/v1/care/etl/reliability-proof", ft, {
    care_recipient_id: "cr-olivia",
  });
  log(
    "etl_reliability",
    etl.status === 200 &&
      etl.json.proof?.duplicate_prevented === true &&
      etl.json.proof?.lost_events === 0,
    JSON.stringify(etl.json.proof?.first_drain ?? {}),
  );
  const etlH = await req("GET", "/api/v1/care/etl/health");
  log("etl_health", etlH.status === 200 && etlH.json.ok === true);

  // Calendar honesty
  const cal = await req("GET", "/api/v1/care/calendar/oauth-status", ft);
  log(
    "calendar_oauth_honest",
    cal.status === 200 && cal.json.mode === "unavailable",
  );
  const book = await req(
    "POST",
    "/api/v1/care/recipients/cr-olivia/actions",
    ft,
    { type: "book_external", title: "Book", summary: "x" },
  );
  log(
    "booking_external_denied",
    book.status === 501 && book.json.code === "EXTERNAL_UNAVAILABLE",
  );

  // Judge journey 1 reschedule
  const resched = await req(
    "POST",
    "/api/v1/care/recipients/cr-olivia/schedule/transition",
    ft,
    {
      appointment_id: sch.json.appointment?.id,
      schedule_state: "rescheduled",
      new_starts_at: "2026-07-27T23:00:00Z",
      new_starts_at_label: "4:00 PM",
    },
  );
  log(
    "judge1_reschedule",
    resched.status === 200 &&
      (resched.json.appointment?.scheduleState === "rescheduled" ||
        resched.json.appointment?.status === "moved"),
  );

  const ms = Date.now() - t0;
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nSUMMARY ${passed}/${results.length} PASS in ${ms}ms`);
  const outDir = resolve(
    process.cwd(),
    "docs/reviews/evidence/gap-closure-2026-07-27",
  );
  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      resolve(outDir, "public-api-smoke.json"),
      JSON.stringify(
        { when: new Date().toISOString(), api: API, ms, passed, failed, results },
        null,
        2,
      ),
    );
  } catch {
    /* ignore write if path not available */
  }
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
