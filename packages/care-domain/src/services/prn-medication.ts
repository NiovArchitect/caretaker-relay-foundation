/**
 * PRN (as-needed / pro re nata) medication orders and charting episodes.
 *
 * Authoritative charting pattern (reason → administration → result), adapted
 * for multi-setting care. Not a universal legal claim for every license type.
 *
 * Storage: CareUpdate rows with PRN_ORDER_V1: / PRN_EPISODE_V1: prefixes
 * (same durability pattern as Relay focus — no separate migration).
 *
 * Safety:
 * - Caregivers cannot invent or authorize PRN doses via chat.
 * - OTC / unauthorized reports stay REPORTED, not active plan.
 * - Relay never recommends a dose or activates plan changes.
 */

import type { CareStore } from "../store/memory-store.js";
import type { CareUpdate, SourceRef } from "../types.js";
import { evaluateAccess } from "./access.js";

const ORDER_PREFIX = "PRN_ORDER_V1:";
const EPISODE_PREFIX = "PRN_EPISODE_V1:";
/** Durable idempotency map: key → episodeId for confirm retries / offline recovery */
const IDEM_PREFIX = "PRN_IDEM_V1:";

export type PrnLifecycle =
  | "symptom_reported"
  | "order_matched"
  | "needs_clarification"
  | "eligible"
  | "awaiting_confirmation"
  | "administered"
  | "refused"
  | "withheld"
  | "unavailable"
  | "reassessment_due"
  | "effective"
  | "partially_effective"
  | "ineffective"
  | "adverse_effect"
  | "escalated"
  | "completed"
  | "cancelled";

export type PrnOrder = {
  id: string;
  careRecipientId: string;
  medication: string;
  strength: string;
  allowedDose: string;
  route: string;
  indication: string;
  minIntervalHours: number;
  maxDosesPer24h?: number;
  maxDailyAmount?: string;
  reassessmentMinutes: number;
  requiredPreChecks: string[];
  authorizedBy: string;
  authorizedAt: string;
  status: "active" | "held" | "ended";
  specialInstructions?: string;
  sourceLabel: string;
};

export type PrnEpisode = {
  id: string;
  careRecipientId: string;
  orderId: string;
  medication: string;
  dose: string;
  route: string;
  indication: string;
  symptom: string;
  severityBefore?: string;
  alternativesTried?: string;
  outcome:
    | "administered"
    | "refused"
    | "withheld"
    | "unavailable"
    | "reported_unauthorized";
  administeredAt?: string;
  administeredByPersonId: string;
  administeredByName: string;
  lifecycle: PrnLifecycle;
  reassessmentDueAt?: string;
  reassessmentCompletedAt?: string;
  severityAfter?: string;
  effect?: "improved" | "unchanged" | "worsened" | "unable_to_assess";
  adverseReaction?: string;
  followUpAction?: string;
  notes?: string;
  unauthorizedReport?: boolean;
  createdAt: string;
  updatedAt: string;
  epistemicStatus: "REPORTED" | "CONFIRMED" | "CORRECTED";
};

export type PrnProjection = {
  recipientId: string;
  orders: Array<PrnOrder & { humanSummary: string }>;
  openEpisodes: Array<PrnEpisode & { humanStatus: string; humanSummary: string }>;
  completedRecent: Array<PrnEpisode & { humanStatus: string; humanSummary: string }>;
  reassessmentDue: Array<PrnEpisode & { humanStatus: string; humanSummary: string }>;
  /** Incomplete reassessments past due time (subset of reassessmentDue). */
  overdue: Array<
    PrnEpisode & {
      humanStatus: string;
      humanSummary: string;
      overdueMinutes: number;
    }
  >;
};

/** True when any administered PRN episode still needs effectiveness charted. */
export function hasOpenPrnReassessment(
  store: CareStore,
  careRecipientId: string,
  nowMs: number = Date.now(),
): boolean {
  return listPrnEpisodes(store, careRecipientId).some(
    (e) =>
      e.outcome === "administered" &&
      !e.reassessmentCompletedAt &&
      !e.effect &&
      (e.lifecycle === "reassessment_due" ||
        e.lifecycle === "administered" ||
        (!!e.reassessmentDueAt && Date.parse(e.reassessmentDueAt) <= nowMs + 60_000)),
  );
}

function isIncompleteReassessment(e: PrnEpisode): boolean {
  return (
    e.outcome === "administered" &&
    !e.reassessmentCompletedAt &&
    (e.lifecycle === "reassessment_due" ||
      e.lifecycle === "administered" ||
      (!!e.reassessmentDueAt && !e.effect))
  );
}

function source(
  personId: string,
  displayName: string,
  label: string,
): SourceRef {
  return {
    id: `src-prn-${personId}-${Date.now().toString(36)}`,
    kind: "caregiver_text",
    label,
    actorName: displayName,
    actorPersonId: personId,
    recordedAt: new Date().toISOString(),
    whyVisible: "PRN medication charting for this care recipient.",
  };
}

export function humanLifecycle(lc: PrnLifecycle): string {
  switch (lc) {
    case "symptom_reported":
      return "Symptom noted";
    case "order_matched":
      return "Matched authorized as-needed instruction";
    case "needs_clarification":
      return "Needs a few details";
    case "eligible":
      return "Ready to verify";
    case "awaiting_confirmation":
      return "Waiting for confirmation";
    case "administered":
      return "Given — follow-up needed";
    case "refused":
      return "Refused";
    case "withheld":
      return "Withheld";
    case "unavailable":
      return "Medication unavailable";
    case "reassessment_due":
      return "Check how they are feeling";
    case "effective":
      return "Helped";
    case "partially_effective":
      return "Helped some";
    case "ineffective":
      return "Did not help";
    case "adverse_effect":
      return "Unexpected reaction";
    case "escalated":
      return "Escalated to care team";
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    default:
      return "As-needed medication update";
  }
}

function encodeOrder(order: PrnOrder, src: SourceRef): CareUpdate {
  return {
    id: order.id,
    careRecipientId: order.careRecipientId,
    toPersonId: src.actorPersonId || "system",
    summary: ORDER_PREFIX + JSON.stringify(order),
    status: "ready",
    safetyClass: "high",
    source: src,
  };
}

function encodeEpisode(ep: PrnEpisode, src: SourceRef): CareUpdate {
  return {
    id: ep.id,
    careRecipientId: ep.careRecipientId,
    toPersonId: ep.administeredByPersonId || src.actorPersonId || "system",
    summary: EPISODE_PREFIX + JSON.stringify(ep),
    status: "ready",
    safetyClass: "high",
    source: src,
  };
}

function decodeOrder(u: CareUpdate): PrnOrder | null {
  if (!u.summary?.startsWith(ORDER_PREFIX)) return null;
  try {
    return JSON.parse(u.summary.slice(ORDER_PREFIX.length)) as PrnOrder;
  } catch {
    return null;
  }
}

function decodeEpisode(u: CareUpdate): PrnEpisode | null {
  if (!u.summary?.startsWith(EPISODE_PREFIX)) return null;
  try {
    return JSON.parse(u.summary.slice(EPISODE_PREFIX.length)) as PrnEpisode;
  } catch {
    return null;
  }
}

/** All orders including held/ended (for stale-confirm and supersede checks). */
export function listAllPrnOrders(
  store: CareStore,
  careRecipientId: string,
): PrnOrder[] {
  const map = new Map<string, PrnOrder>();
  for (const u of store.getUpdates(careRecipientId)) {
    const o = decodeOrder(u);
    if (o) map.set(o.id, o);
  }
  return [...map.values()];
}

export function listPrnOrders(
  store: CareStore,
  careRecipientId: string,
): PrnOrder[] {
  return listAllPrnOrders(store, careRecipientId).filter(
    (o) => o.status === "active",
  );
}

export function setPrnOrderStatus(
  store: CareStore,
  careRecipientId: string,
  orderId: string,
  status: PrnOrder["status"],
  actorPersonId: string,
  actorDisplayName: string,
): PrnOrder | null {
  const all = listAllPrnOrders(store, careRecipientId);
  const order = all.find((o) => o.id === orderId);
  if (!order) return null;
  const updated = { ...order, status };
  return upsertPrnOrder(store, updated, actorPersonId, actorDisplayName);
}

function findIdempotentEpisode(
  store: CareStore,
  careRecipientId: string,
  idempotencyKey: string,
): PrnEpisode | undefined {
  const key = idempotencyKey.trim();
  if (!key) return undefined;
  for (const u of store.getUpdates(careRecipientId)) {
    if (!u.summary?.startsWith(IDEM_PREFIX)) continue;
    try {
      const row = JSON.parse(u.summary.slice(IDEM_PREFIX.length)) as {
        key?: string;
        episodeId?: string;
      };
      if (row.key === key && row.episodeId) {
        return listPrnEpisodes(store, careRecipientId).find(
          (e) => e.id === row.episodeId,
        );
      }
    } catch {
      /* skip */
    }
  }
  return undefined;
}

function recordIdempotency(
  store: CareStore,
  careRecipientId: string,
  idempotencyKey: string,
  episodeId: string,
  actorPersonId: string,
  actorDisplayName: string,
): void {
  const key = idempotencyKey.trim();
  if (!key) return;
  store.addUpdate({
    id: `prn-idem-${key.slice(0, 48)}`,
    careRecipientId,
    toPersonId: actorPersonId,
    summary:
      IDEM_PREFIX +
      JSON.stringify({ key, episodeId, at: new Date().toISOString() }),
    status: "ready",
    safetyClass: "high",
    source: source(actorPersonId, actorDisplayName, "PRN confirm idempotency"),
  });
}

export function listPrnEpisodes(
  store: CareStore,
  careRecipientId: string,
): PrnEpisode[] {
  const map = new Map<string, PrnEpisode>();
  for (const u of store.getUpdates(careRecipientId)) {
    const e = decodeEpisode(u);
    if (e) map.set(e.id, e);
  }
  return [...map.values()].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
}

export function getPrnOrder(
  store: CareStore,
  careRecipientId: string,
  orderId: string,
): PrnOrder | undefined {
  return listPrnOrders(store, careRecipientId).find((o) => o.id === orderId);
}

export function upsertPrnOrder(
  store: CareStore,
  order: PrnOrder,
  actorPersonId: string,
  actorDisplayName: string,
): PrnOrder {
  store.addUpdate(
    encodeOrder(order, source(actorPersonId, actorDisplayName, "PRN order")),
  );
  store.writeAudit({
    at: new Date().toISOString(),
    actorPersonId,
    action: "PRN_ORDER_UPSERT",
    careRecipientId: order.careRecipientId,
    details: { order_id: order.id, medication: order.medication },
  });
  return order;
}

export function matchPrnOrder(
  store: CareStore,
  careRecipientId: string,
  medicationHint: string,
  indicationHint?: string,
): PrnOrder | undefined {
  const hint = medicationHint.toLowerCase();
  const ind = (indicationHint || "").toLowerCase();
  const orders = listPrnOrders(store, careRecipientId);
  const byName = orders.filter(
    (o) =>
      o.medication.toLowerCase().includes(hint) ||
      hint.includes(o.medication.toLowerCase().split(" ")[0]!) ||
      (hint.includes("tylenol") && /acetaminophen|tylenol/i.test(o.medication)) ||
      (hint.includes("acetaminophen") && /acetaminophen|tylenol/i.test(o.medication)),
  );
  if (byName.length === 1) return byName[0];
  if (ind && byName.length) {
    const byInd = byName.find((o) => o.indication.toLowerCase().includes(ind));
    if (byInd) return byInd;
  }
  if (ind) {
    const byIndOnly = orders.find((o) =>
      o.indication.toLowerCase().includes(ind),
    );
    if (byIndOnly) return byIndOnly;
  }
  return byName[0];
}

export function lastPrnAdministration(
  store: CareStore,
  careRecipientId: string,
  orderId: string,
): PrnEpisode | undefined {
  return listPrnEpisodes(store, careRecipientId).find(
    (e) =>
      e.orderId === orderId &&
      e.outcome === "administered" &&
      e.administeredAt,
  );
}

export function intervalAllows(
  order: PrnOrder,
  last?: PrnEpisode,
  now = Date.now(),
): { ok: boolean; human: string } {
  if (!last?.administeredAt) {
    return {
      ok: true,
      human: "No recent as-needed dose is recorded within the restricted interval.",
    };
  }
  const lastMs = Date.parse(last.administeredAt);
  if (Number.isNaN(lastMs)) {
    return { ok: true, human: "Prior dose time is unclear; verify the chart." };
  }
  const minMs = order.minIntervalHours * 60 * 60 * 1000;
  const elapsed = now - lastMs;
  if (elapsed < minMs) {
    const waitH = ((minMs - elapsed) / 3600000).toFixed(1);
    return {
      ok: false,
      human: `A dose of ${order.medication} was recorded ${formatWhen(last.administeredAt)}. The authorized interval is every ${order.minIntervalHours} hours — about ${waitH} hours remain before another dose is allowed under the order.`,
    };
  }
  return {
    ok: true,
    human: `Last recorded as-needed dose was ${formatWhen(last.administeredAt)}; the minimum interval appears clear.`,
  };
}

function formatWhen(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return "earlier";
  }
}

export function buildPrnProjection(
  store: CareStore,
  careRecipientId: string,
  nowMs: number = Date.now(),
): PrnProjection {
  const orders = listPrnOrders(store, careRecipientId).map((o) => ({
    ...o,
    humanSummary: `${o.medication} ${o.allowedDose} by ${o.route} as needed for ${o.indication} (min every ${o.minIntervalHours}h) · authorized by ${o.authorizedBy}`,
  }));
  const episodes = listPrnEpisodes(store, careRecipientId);
  const open = episodes.filter(
    (e) =>
      isIncompleteReassessment(e) ||
      e.lifecycle === "needs_clarification" ||
      e.lifecycle === "awaiting_confirmation" ||
      e.unauthorizedReport === true,
  );
  const reassess = episodes.filter((e) => isIncompleteReassessment(e));
  const completed = episodes
    .filter((e) =>
      ["completed", "effective", "partially_effective", "ineffective"].includes(
        e.lifecycle,
      ) || !!e.reassessmentCompletedAt,
    )
    .slice(0, 8);

  const enrich = (e: PrnEpisode) => ({
    ...e,
    humanStatus: humanLifecycle(e.lifecycle),
    humanSummary: summarizeEpisode(e),
  });

  const overdue = reassess
    .filter(
      (e) =>
        !!e.reassessmentDueAt && Date.parse(e.reassessmentDueAt) < nowMs,
    )
    .map((e) => ({
      ...enrich(e),
      humanStatus: "Follow-up overdue — check how they feel now",
      overdueMinutes: Math.max(
        0,
        Math.round((nowMs - Date.parse(e.reassessmentDueAt!)) / 60_000),
      ),
    }));

  return {
    recipientId: careRecipientId,
    orders,
    openEpisodes: open.map(enrich),
    completedRecent: completed.map(enrich),
    reassessmentDue: reassess.map(enrich),
    overdue,
  };
}

/**
 * Ensure overdue incomplete PRN reassessments appear once on handoff attention
 * and once in audit — no duplicate tasks/notifications on repeated projection.
 */
export function ensurePrnOverdueEscalation(
  store: CareStore,
  careRecipientId: string,
  nowMs: number = Date.now(),
): { overdueCount: number; escalated: string[] } {
  const proj = buildPrnProjection(store, careRecipientId, nowMs);
  const escalated: string[] = [];
  if (!proj.overdue.length) return { overdueCount: 0, escalated };

  try {
    const handoffs = store.getHandoffs(careRecipientId);
    const latest = handoffs[handoffs.length - 1];
    if (latest) {
      const open = [...(latest.stillNeedsAttention ?? [])];
      let changed = false;
      for (const e of proj.overdue.slice(0, 3)) {
        const line = `Overdue as-needed follow-up: ${e.medication} for ${e.symptom} — check how they feel now`;
        if (
          !open.some(
            (x) =>
              /overdue as-needed follow-up/i.test(x) &&
              new RegExp(e.medication, "i").test(x),
          )
        ) {
          open.push(line);
          changed = true;
          escalated.push(e.id);
        }
      }
      if (changed) {
        latest.stillNeedsAttention = open.slice(0, 12);
        store.addHandoff({ ...latest });
      }
    }
  } catch {
    /* optional */
  }

  for (const e of proj.overdue.slice(0, 3)) {
    // Idempotent audit: one PRN_REASSESS_OVERDUE per episode id
    const already = store
      .listAudit({ careRecipientId })
      .some(
        (a) =>
          a.action === "PRN_REASSESS_OVERDUE" &&
          (a.details as { episode_id?: string } | undefined)?.episode_id ===
            e.id,
      );
    if (!already) {
      store.writeAudit({
        at: new Date(nowMs).toISOString(),
        actorPersonId: "system",
        action: "PRN_REASSESS_OVERDUE",
        careRecipientId,
        details: {
          episode_id: e.id,
          medication: e.medication,
          overdue_minutes: e.overdueMinutes,
        },
      });
      if (!escalated.includes(e.id)) escalated.push(e.id);
    }
  }

  return { overdueCount: proj.overdue.length, escalated };
}

function summarizeEpisode(e: PrnEpisode): string {
  const when = e.administeredAt ? formatWhen(e.administeredAt) : "time pending";
  const effect =
    e.effect === "improved"
      ? "helped"
      : e.effect === "unchanged"
        ? "no clear change"
        : e.effect === "worsened"
          ? "worsened"
          : e.effect === "unable_to_assess"
            ? "unable to assess"
            : humanLifecycle(e.lifecycle);
  if (e.outcome === "administered") {
    return `${e.medication} ${e.dose} given ${when} for ${e.symptom || e.indication} · ${effect}${e.severityAfter ? ` (now ${e.severityAfter})` : ""}`;
  }
  return `${e.medication}: ${humanLifecycle(e.lifecycle)} · ${e.symptom || e.indication}`;
}

export type CreatePrnEpisodeInput = {
  careRecipientId: string;
  actorPersonId: string;
  actorDisplayName: string;
  medicationHint: string;
  symptom: string;
  severityBefore?: string;
  dose?: string;
  route?: string;
  administeredAt?: string;
  alternativesTried?: string;
  notes?: string;
  /** If true, do not invent authorization — flag unauthorized report */
  forceUnauthorized?: boolean;
  confirm?: boolean;
  /** Stable client key so offline retries never double-chart */
  idempotencyKey?: string;
  /** Order id from preview — used to reject stale confirms after deactivation */
  orderId?: string;
};

export type CreatePrnEpisodeResult =
  | {
      ok: true;
      episode: PrnEpisode;
      order?: PrnOrder;
      interval: { ok: boolean; human: string };
      needsConfirmation: boolean;
      plainLanguage: string;
    }
  | { ok: false; code: string; message: string };

/**
 * Create or advance a PRN episode from caregiver report.
 * Never invents a dose when authorized order has a dose — uses order.allowedDose
 * only when caregiver confirms administration of that order.
 */
export function createOrAdvancePrnEpisode(
  store: CareStore,
  input: CreatePrnEpisodeInput,
): CreatePrnEpisodeResult {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }

  // Offline / retry recovery: same idempotency key → same episode, no second dose
  if (input.confirm && input.idempotencyKey) {
    const prior = findIdempotentEpisode(
      store,
      input.careRecipientId,
      input.idempotencyKey,
    );
    if (prior) {
      return {
        ok: true,
        episode: prior,
        order: listAllPrnOrders(store, input.careRecipientId).find(
          (o) => o.id === prior.orderId,
        ),
        interval: { ok: true, human: "n/a (idempotent retry)" },
        needsConfirmation: false,
        plainLanguage:
          `Already recorded: as-needed **${prior.medication} ${prior.dose}**` +
          (prior.administeredAt
            ? ` at ${formatWhen(prior.administeredAt)}`
            : "") +
          ` for **${prior.symptom}**. No duplicate administration was added.`,
      };
    }
  }

  // Stale order: explicit orderId no longer active → reject confirm with no chart
  if (input.confirm && input.orderId) {
    const byId = listAllPrnOrders(store, input.careRecipientId).find(
      (o) => o.id === input.orderId,
    );
    if (byId && byId.status !== "active") {
      return {
        ok: false,
        code: "PRN_ORDER_INACTIVE",
        message:
          `The as-needed instruction for **${byId.medication}** is no longer active ` +
          `(${byId.status}). Nothing was charted. Ask an authorized reviewer if a current order is on file.`,
      };
    }
  }

  let order = input.orderId
    ? listPrnOrders(store, input.careRecipientId).find(
        (o) => o.id === input.orderId,
      )
    : undefined;
  if (!order) {
    order = matchPrnOrder(
      store,
      input.careRecipientId,
      input.medicationHint,
      input.symptom,
    );
  }

  // Confirm path: medication matches only an inactive order → reject (stale preview)
  if (input.confirm && !order && !input.forceUnauthorized) {
    const inactiveMatch = listAllPrnOrders(store, input.careRecipientId).find(
      (o) =>
        o.status !== "active" &&
        (o.id === input.orderId ||
          o.medication.toLowerCase().includes(input.medicationHint.toLowerCase()) ||
          input.medicationHint
            .toLowerCase()
            .includes(o.medication.toLowerCase().split(" ")[0]!)),
    );
    if (inactiveMatch) {
      return {
        ok: false,
        code: "PRN_ORDER_INACTIVE",
        message:
          `The as-needed instruction for **${inactiveMatch.medication}** changed or was deactivated. ` +
          `Nothing was charted from the previous check. Verify the current plan with an authorized reviewer.`,
      };
    }
  }

  if (!order || input.forceUnauthorized) {
    // Unauthorized / OTC report — chart as reported only
    const now = new Date().toISOString();
    const ep: PrnEpisode = {
      id: store.newId("prn-ep"),
      careRecipientId: input.careRecipientId,
      orderId: "unauthorized",
      medication: input.medicationHint,
      dose: input.dose || "dose not confirmed",
      route: input.route || "not confirmed",
      indication: input.symptom || "not confirmed",
      symptom: input.symptom || "not confirmed",
      severityBefore: input.severityBefore,
      alternativesTried: input.alternativesTried,
      outcome: "reported_unauthorized",
      administeredAt: input.administeredAt || now,
      administeredByPersonId: input.actorPersonId,
      administeredByName: input.actorDisplayName,
      lifecycle: "needs_clarification",
      notes: input.notes,
      unauthorizedReport: true,
      createdAt: now,
      updatedAt: now,
      epistemicStatus: "REPORTED",
    };
    store.addUpdate(
      encodeEpisode(
        ep,
        source(input.actorPersonId, input.actorDisplayName, "PRN unauthorized report"),
      ),
    );
    return {
      ok: true,
      episode: ep,
      interval: { ok: false, human: "No authorized as-needed order matched." },
      needsConfirmation: true,
      plainLanguage:
        `I can record that **${input.medicationHint}** was reported as given for **${input.symptom || "a symptom"}**, ` +
        `but I do **not** see it as an authorized as-needed medication in the current plan. ` +
        `Please verify the medication, dose, and time. Relay will flag it for review and will **not** add it to the active plan.`,
    };
  }

  const last = lastPrnAdministration(store, input.careRecipientId, order.id);
  const now = new Date();
  const adminAt = input.administeredAt || now.toISOString();
  const interval = intervalAllows(order, last, Date.parse(adminAt));
  const dose = input.dose || order.allowedDose;
  const route = input.route || order.route;

  // Without explicit confirm, return preview-eligible state only (no durable episode yet)
  if (!input.confirm) {
    const previewId = store.newId("prn-ep");
    const due = new Date(
      now.getTime() + order.reassessmentMinutes * 60 * 1000,
    ).toISOString();
    const plain =
      `**As-needed check for ${order.medication}**\n` +
      `• Reason: ${input.symptom || order.indication}` +
      (input.severityBefore ? ` (${input.severityBefore})` : "") +
      `\n• Authorized dose: ${order.allowedDose} by ${order.route}\n` +
      `• Indication on file: ${order.indication}\n` +
      `• Interval: ${interval.human}\n` +
      (interval.ok
        ? `• Status: Ready to verify\n`
        : `• Status: Interval concern — do not invent a new dose\n`) +
      `• Follow-up: reassess in about ${order.reassessmentMinutes} minutes\n\n` +
      `Reply **confirm PRN** to chart this as given, or **cancel** to discard. ` +
      `Relay does not recommend doses and will not change the medication plan.`;
    // Stash awaiting confirmation as episode with awaiting_confirmation (only if confirm path needs id)
    void previewId;
    void due;
    return {
      ok: true,
      order,
      interval,
      needsConfirmation: true,
      plainLanguage: plain,
      episode: {
        id: previewId,
        careRecipientId: input.careRecipientId,
        orderId: order.id,
        medication: order.medication,
        dose,
        route,
        indication: order.indication,
        symptom: input.symptom || order.indication,
        severityBefore: input.severityBefore,
        alternativesTried: input.alternativesTried,
        outcome: "administered",
        administeredAt: adminAt,
        administeredByPersonId: input.actorPersonId,
        administeredByName: input.actorDisplayName,
        lifecycle: "awaiting_confirmation",
        reassessmentDueAt: due,
        notes: input.notes,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        epistemicStatus: "REPORTED",
      },
    };
  }

  // Idempotency: if an incomplete administration already exists for this order,
  // do not create a second episode (double-tap / retry / dual-reporter).
  const existingOpen = listPrnEpisodes(store, input.careRecipientId).find(
    (e) =>
      e.orderId === order.id &&
      e.outcome === "administered" &&
      !e.reassessmentCompletedAt &&
      !e.effect &&
      (e.lifecycle === "reassessment_due" || e.lifecycle === "administered"),
  );
  if (existingOpen) {
    if (input.idempotencyKey) {
      recordIdempotency(
        store,
        input.careRecipientId,
        input.idempotencyKey,
        existingOpen.id,
        input.actorPersonId,
        input.actorDisplayName,
      );
    }
    return {
      ok: true,
      episode: existingOpen,
      order,
      interval,
      needsConfirmation: false,
      plainLanguage:
        `As-needed **${existingOpen.medication} ${existingOpen.dose}** for **${existingOpen.symptom}** is already charted` +
        (existingOpen.administeredAt
          ? ` at ${formatWhen(existingOpen.administeredAt)}`
          : "") +
        `.\nFollow-up still open: check how they feel` +
        (existingOpen.reassessmentDueAt
          ? ` around ${formatWhen(existingOpen.reassessmentDueAt)}`
          : "") +
        `.\nNo second dose was recorded. Tell me how the symptom is now to complete the result.`,
    };
  }

  // Double-submit after a just-completed chart (same order, same actor, <90s):
  // return the completed episode without inventing a second administration.
  const justCompleted = listPrnEpisodes(store, input.careRecipientId).find((e) => {
    if (
      e.orderId !== order.id ||
      e.outcome !== "administered" ||
      !e.reassessmentCompletedAt ||
      e.administeredByPersonId !== input.actorPersonId
    )
      return false;
    const age = now.getTime() - Date.parse(e.reassessmentCompletedAt);
    return age >= 0 && age < 90_000;
  });
  if (justCompleted && !interval.ok) {
    return {
      ok: true,
      episode: justCompleted,
      order,
      interval,
      needsConfirmation: false,
      plainLanguage:
        `That as-needed dose of **${justCompleted.medication}** was already recorded` +
        (justCompleted.administeredAt
          ? ` at ${formatWhen(justCompleted.administeredAt)}`
          : "") +
        `. No duplicate administration was added.`,
    };
  }

  if (!interval.ok) {
    return {
      ok: false,
      code: "PRN_INTERVAL",
      message: interval.human,
    };
  }

  const due = new Date(
    Date.parse(adminAt) + order.reassessmentMinutes * 60 * 1000,
  ).toISOString();
  const ep: PrnEpisode = {
    id: store.newId("prn-ep"),
    careRecipientId: input.careRecipientId,
    orderId: order.id,
    medication: order.medication,
    dose,
    route,
    indication: order.indication,
    symptom: input.symptom || order.indication,
    severityBefore: input.severityBefore,
    alternativesTried: input.alternativesTried,
    outcome: "administered",
    administeredAt: adminAt,
    administeredByPersonId: input.actorPersonId,
    administeredByName: input.actorDisplayName,
    lifecycle: "reassessment_due",
    reassessmentDueAt: due,
    notes: input.notes,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    epistemicStatus: "REPORTED",
  };
  store.addUpdate(
    encodeEpisode(
      ep,
      source(input.actorPersonId, input.actorDisplayName, "PRN administration"),
    ),
  );
  if (input.idempotencyKey) {
    recordIdempotency(
      store,
      input.careRecipientId,
      input.idempotencyKey,
      ep.id,
      input.actorPersonId,
      input.actorDisplayName,
    );
  }
  // Also MAR-style med record for lineage with schedules
  store.addMedRecord({
    id: store.newId("mar-prn"),
    careRecipientId: input.careRecipientId,
    name: `${order.medication} (as needed)`,
    doseRecorded: dose,
    administeredAt: adminAt,
    administeredByPersonId: input.actorPersonId,
    status: "recorded",
    epistemicStatus: "REPORTED",
    source: source(
      input.actorPersonId,
      input.actorDisplayName,
      `PRN for ${ep.symptom}`,
    ),
  });
  store.writeAudit({
    at: now.toISOString(),
    actorPersonId: input.actorPersonId,
    action: "PRN_ADMINISTERED",
    careRecipientId: input.careRecipientId,
    details: {
      episode_id: ep.id,
      order_id: order.id,
      symptom: ep.symptom,
      dose,
      idempotency_key: input.idempotencyKey || undefined,
    },
  });

  // Continuity: append one open line to latest handoff (same canonical episode)
  try {
    const handoffs = store.getHandoffs(input.careRecipientId);
    const latest = handoffs[handoffs.length - 1];
    if (latest) {
      const line = `As-needed follow-up: ${order.medication} ${dose} for ${ep.symptom} at ${formatWhen(adminAt)} — check how they feel`;
      const open = latest.stillNeedsAttention ?? [];
      if (!open.some((x) => x.includes(ep.id) || x.includes(order.medication))) {
        latest.stillNeedsAttention = [...open, line].slice(0, 12);
        store.addHandoff({ ...latest });
      }
    }
  } catch {
    /* handoff optional */
  }

  return {
    ok: true,
    episode: ep,
    order,
    interval,
    needsConfirmation: false,
    plainLanguage:
      `Charted as-needed **${order.medication} ${dose}** by ${route} for **${ep.symptom}**` +
      (ep.severityBefore ? ` (${ep.severityBefore})` : "") +
      ` at ${formatWhen(adminAt)}.\n` +
      `Follow-up: check how they feel around ${formatWhen(due)}.\n` +
      `This is caregiver-reported charting, not a new medication-plan instruction.`,
  };
}

export type ReassessPrnInput = {
  careRecipientId: string;
  actorPersonId: string;
  actorDisplayName: string;
  episodeId?: string;
  effect: "improved" | "unchanged" | "worsened" | "unable_to_assess";
  severityAfter?: string;
  adverseReaction?: string;
  followUpAction?: string;
  notes?: string;
};

export function reassessPrnEpisode(
  store: CareStore,
  input: ReassessPrnInput,
): CreatePrnEpisodeResult {
  const access = evaluateAccess(
    store,
    input.actorPersonId,
    input.careRecipientId,
  );
  if (!access.allowed) {
    return { ok: false, code: access.code, message: access.reason };
  }
  const episodes = listPrnEpisodes(store, input.careRecipientId);
  const ep =
    (input.episodeId
      ? episodes.find((e) => e.id === input.episodeId)
      : undefined) ||
    episodes.find(
      (e) =>
        e.outcome === "administered" &&
        !e.reassessmentCompletedAt &&
        (e.lifecycle === "reassessment_due" ||
          e.lifecycle === "administered" ||
          !!e.reassessmentDueAt),
    ) ||
    // Latest administered episode still missing effect result
    episodes.find(
      (e) => e.outcome === "administered" && !e.effect && !e.reassessmentCompletedAt,
    ) ||
    episodes.find((e) => e.outcome === "administered" && !e.effect);
  if (!ep) {
    return {
      ok: false,
      code: "NOT_FOUND",
      message: "No open as-needed follow-up episode is on file to update.",
    };
  }
  const now = new Date().toISOString();
  let lifecycle: PrnLifecycle = "completed";
  if (input.adverseReaction) lifecycle = "adverse_effect";
  else if (input.effect === "improved") lifecycle = "effective";
  else if (input.effect === "unchanged" || input.effect === "worsened") {
    lifecycle = "ineffective";
  }

  const updated: PrnEpisode = {
    ...ep,
    lifecycle,
    effect: input.effect,
    severityAfter: input.severityAfter,
    adverseReaction: input.adverseReaction,
    followUpAction: input.followUpAction,
    reassessmentCompletedAt: now,
    updatedAt: now,
    notes: [ep.notes, input.notes].filter(Boolean).join(" · ") || undefined,
  };
  // Chart closure: keep effect on the episode; terminal lifecycle for completed chart rows
  if (input.effect === "improved") {
    updated.lifecycle = "completed";
  } else if (input.effect === "unchanged" || input.effect === "worsened") {
    updated.lifecycle = "completed";
    updated.followUpAction =
      input.followUpAction ||
      "Contact authorized care team — as-needed dose did not resolve the symptom (do not invent another dose).";
  }
  if (input.adverseReaction) {
    updated.lifecycle = "adverse_effect";
    updated.followUpAction =
      input.followUpAction ||
      "Report unexpected reaction to authorized clinician / care team.";
  }

  store.addUpdate(
    encodeEpisode(
      updated,
      source(input.actorPersonId, input.actorDisplayName, "PRN reassessment"),
    ),
  );
  store.writeAudit({
    at: now,
    actorPersonId: input.actorPersonId,
    action: "PRN_REASSESSED",
    careRecipientId: input.careRecipientId,
    details: {
      episode_id: updated.id,
      effect: input.effect,
      severity_after: input.severityAfter,
    },
  });

  // Clear stale handoff open lines for this medication when result is charted
  try {
    const handoffs = store.getHandoffs(input.careRecipientId);
    const latest = handoffs[handoffs.length - 1];
    if (latest?.stillNeedsAttention?.length) {
      latest.stillNeedsAttention = latest.stillNeedsAttention.filter(
        (x) =>
          !/as-needed follow-up/i.test(x) ||
          !new RegExp(updated.medication, "i").test(x),
      );
      store.addHandoff({ ...latest });
    }
  } catch {
    /* optional */
  }

  const effectPhrase =
    input.effect === "improved"
      ? "helped"
      : input.effect === "unchanged"
        ? "did not clearly help"
        : input.effect === "worsened"
          ? "symptoms worsened"
          : "could not be assessed";

  return {
    ok: true,
    episode: updated,
    interval: { ok: true, human: "n/a" },
    needsConfirmation: false,
    plainLanguage:
      `Follow-up charted for **${updated.medication}** given for **${updated.symptom}**: **${effectPhrase}**` +
      (input.severityAfter ? ` (now ${input.severityAfter})` : "") +
      (input.adverseReaction
        ? `. Unexpected reaction noted: ${input.adverseReaction}.`
        : ".") +
      (updated.followUpAction ? `\nNext step: ${updated.followUpAction}` : "") +
      `\nHistory keeps reason, administration, and result together.`,
  };
}

/**
 * Seed synthetic authorized PRN orders for lab recipients.
 * Recipient-agnostic: only writes when the care space lacks that order class.
 * Not a universal formulary — protocol pack for synthetic lab only.
 */
export function seedEvelynPrnOrders(
  store: CareStore,
  careRecipientId = "cr-olivia",
): void {
  // Use all statuses so ended/held lab orders are not re-activated on every request
  const orders = listAllPrnOrders(store, careRecipientId);
  if (!orders.some((o) => /acetaminophen|tylenol/i.test(o.medication))) {
    upsertPrnOrder(
      store,
      {
        id: `prn-order-acetaminophen-${careRecipientId}`,
        careRecipientId,
        medication: "Acetaminophen",
        strength: "500 mg",
        allowedDose: "500 mg",
        route: "by mouth",
        indication: "pain",
        minIntervalHours: 6,
        maxDosesPer24h: 4,
        reassessmentMinutes: 60,
        requiredPreChecks: ["confirm symptom", "check last dose interval"],
        authorizedBy: "Dr. Priya Shah",
        authorizedAt: "2026-07-01T00:00:00Z",
        status: "active",
        specialInstructions: "As needed for pain. Do not exceed labeled maximum.",
        sourceLabel: "Authorized PRN order (synthetic lab)",
      },
      "p-dr-shah",
      "Dr. Priya Shah",
    );
  }
  // Second authorized class so multi-journey demos are not blocked by pain-interval
  // after a recent acetaminophen chart (interval safety remains per-order).
  if (!orders.some((o) => /ondansetron/i.test(o.medication))) {
    upsertPrnOrder(
      store,
      {
        id: `prn-order-ondansetron-${careRecipientId}`,
        careRecipientId,
        medication: "Ondansetron",
        strength: "4 mg",
        allowedDose: "4 mg",
        route: "by mouth",
        indication: "nausea",
        minIntervalHours: 8,
        maxDosesPer24h: 3,
        reassessmentMinutes: 45,
        requiredPreChecks: ["confirm symptom", "check last dose interval"],
        authorizedBy: "Dr. Priya Shah",
        authorizedAt: "2026-07-01T00:00:00Z",
        status: "active",
        specialInstructions: "As needed for nausea. Do not invent a dose.",
        sourceLabel: "Authorized PRN order (synthetic lab)",
      },
      "p-dr-shah",
      "Dr. Priya Shah",
    );
  }
  // Third class for offline-idempotency / reliability demos when other intervals are open
  if (!orders.some((o) => /simethicone/i.test(o.medication))) {
    upsertPrnOrder(
      store,
      {
        id: `prn-order-simethicone-${careRecipientId}`,
        careRecipientId,
        medication: "Simethicone",
        strength: "80 mg",
        allowedDose: "80 mg",
        route: "by mouth",
        indication: "gas",
        minIntervalHours: 4,
        maxDosesPer24h: 6,
        reassessmentMinutes: 30,
        requiredPreChecks: ["confirm symptom", "check last dose interval"],
        authorizedBy: "Dr. Priya Shah",
        authorizedAt: "2026-07-01T00:00:00Z",
        status: "active",
        specialInstructions: "As needed for gas discomfort. Do not invent a dose.",
        sourceLabel: "Authorized PRN order (synthetic lab)",
      },
      "p-dr-shah",
      "Dr. Priya Shah",
    );
  }
}

export function answerPrnQuestion(
  store: CareStore,
  careRecipientId: string,
  recipientName: string,
  question: string,
): string | null {
  const q = question.toLowerCase();
  const proj = buildPrnProjection(store, careRecipientId);
  if (
    !/prn|as[- ]?needed|as needed|can (she|he|they|evelyn).{0,20}(have|take)|pain medicine|when was (her |the )?last (as-needed|prn)|did it help|follow-?up|reassess|what prn/i.test(
      q,
    )
  ) {
    // still answer if only PRN orders context and question about pain med
    if (!/pain|nausea|itch|wheez|fever|constipat|anxiety|as needed/i.test(q)) {
      return null;
    }
  }

  if (/what prn|as-needed medication|prn medication can|can .{0,20}take for pain|pain medicine|what prn medication can/i.test(q)) {
    if (!proj.orders.length) {
      return `I do not see an authorized as-needed (PRN) medication on file for ${recipientName}. I will not invent a dose. Ask a clinician or authorized primary if a PRN order should be added to the plan.`;
    }
    const lines = proj.orders.map(
      (o) =>
        `• ${o.humanSummary || `${o.medication} ${o.allowedDose} by ${o.route} as needed for ${o.indication}`}`,
    );
    return (
      `${recipientName} has authorized as-needed medication instructions on file:\n${lines.join("\n")}\n\n` +
      `Relay does not recommend giving a dose. If a symptom is present, say what you observe and I can help check the order and charting steps.`
    );
  }

  if (/last (as-needed|prn)|when was .{0,20}(prn|as-needed|pain med)/i.test(q)) {
    const last = proj.completedRecent[0] || proj.openEpisodes[0];
    if (!last) {
      return `No as-needed administration is charted yet for ${recipientName}.`;
    }
    return `Latest as-needed chart entry: ${last.humanSummary}.`;
  }

  if (/follow-?up|reassess|did it help|what still needs.{0,20}chart/i.test(q)) {
    if (proj.reassessmentDue.length) {
      return (
        `As-needed follow-up still open for ${recipientName}:\n` +
        proj.reassessmentDue
          .slice(0, 3)
          .map((e) => `• ${e.humanSummary} — ${e.humanStatus}`)
          .join("\n") +
        `\nTell me how they are feeling now (better, unchanged, or worse).`
      );
    }
    return `No overdue as-needed follow-up is open for ${recipientName}.`;
  }

  if (proj.orders.length && /prn|as-needed|as needed/.test(q)) {
    return (
      `As-needed summary for ${recipientName}:\n` +
      proj.orders.map((o) => `• ${o.humanSummary}`).join("\n") +
      (proj.reassessmentDue.length
        ? `\nOpen follow-ups:\n` +
          proj.reassessmentDue.map((e) => `• ${e.humanSummary}`).join("\n")
        : "\nNo open PRN follow-ups.")
    );
  }

  return null;
}
