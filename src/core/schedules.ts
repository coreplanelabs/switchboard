import type { Actor, Grants } from "./authz/types.js";
import { parseIngressTokenMap, tokenForSubject } from "./ingressTokens.js";

// The schedule registry (#244): the ONE catalog of every cron any of our
// Cloudflare Workers runs. Each Worker's `wrangler.jsonc` `triggers.crons` must
// equal the registry's expressions for that worker (a unit test enforces it per
// worker), and each Worker's `scheduled()` looks its firing up HERE — so a
// schedule can never exist in one place and not the other.
//
// A schedule has three independent facets:
//   worker   — whose wrangler.jsonc carries the cron and whose `scheduled()` fires it
//   action   — what a firing does: `run` (the bot shim POSTs the generic /ingress as
//              the `cron` identity with the command text; the dispatcher does the
//              rest — run id, event stream, /runs/<id>, history), `healthz` (the bot
//              shim touches the container), `watchdog` (the resident Worker sweeps
//              its residents)
//   internal — plumbing nobody operates: never rendered on /runs, never recorded
//
// Anything expressible as a chat command is a one-line `run` entry here; grow
// commands, not action types.
//
// Node-free on purpose: the shims (workerd) import this file by relative path,
// like deploy/cloudflare-memory imports src/core/memory/engine.ts. Nothing in
// here may touch node:* modules.

/** The system identity every scheduled run is dispatched as. Its bearer lives
 *  in SWITCHBOARD_INGRESS_TOKENS as `{"<token>": {"subject": "cron", "channel":
 *  "cron"}}` — the same map every ingress caller uses, no extra secret. The
 *  dispatcher sees `http:cron`; whatever a scheduled command requires (e.g.
 *  `friction propose` → `permissions.repoManagement`) must be granted to it. */
export const CRON_IDENTITY = "cron";

/** The Workers that run crons: `bot` = deploy/cloudflare (the shim in front of
 *  the bot container), `resident` = deploy/cloudflare-resident. */
export type ScheduleWorker = "bot" | "resident";

export interface RunAction {
  type: "run";
  /** The exact text POSTed to /ingress — a chat command the dispatcher answers. */
  command: string;
  /** The ingress identity (`subject`) whose token the shim presents. */
  identity: string;
  /** Who the firing IS under the one authorization model (plan U2/U3, R9): the
   *  `schedule` actor `schedule:<name>` with the grants the registry declares
   *  for it — the floor `ConfigStore.grantsFor` serves for that id; a native
   *  `grants["schedule:<name>"]` entry in config.yaml replaces them. The shim
   *  still authenticates as `identity` above (the dispatcher sees
   *  `http:<identity>`) until a later unit hands firings to this actor; the
   *  grants are declared here so that switch is a wiring change, not a policy one. */
  actor: Pick<Actor, "kind" | "id" | "grants"> & { kind: "schedule"; id: `schedule:${string}` };
}

/** The `schedule` actor for a run schedule's name, holding exactly `grants`. */
export function scheduleActor(name: string, grants: Grants): RunAction["actor"] {
  return { kind: "schedule", id: `schedule:${name}`, grants };
}

/** What the weekly pass needs: read the fleet's runs (`friction report` is a
 *  run read across every channel — the #395 fix) and file proposals. No repos. */
const SELF_IMPROVEMENT_GRANTS: Grants = Object.freeze({ actions: new Set(["friction:read", "friction:write"]), channels: "all", repos: new Set<string>() });

export type ScheduleAction =
  | RunAction
  /** Bot shim: GET the container's /healthz — starts it if stopped, renews its activity timeout. */
  | { type: "healthz" }
  /** Resident Worker: one watchdog pass over every resident (re-arm dead refresh chains, time out stuck onboarding). */
  | { type: "watchdog" };

export interface ScheduleDef {
  name: string;
  /** Five-field cron expression, UTC (Cloudflare Workers cron triggers are UTC). */
  cron: string;
  description: string;
  worker: ScheduleWorker;
  action: ScheduleAction;
  /** Infrastructure plumbing: not shown on the /runs Scheduled panel, no firing recorded. */
  internal?: true;
}

export type RunSchedule = ScheduleDef & { action: RunAction };

export function isRunSchedule(s: ScheduleDef): s is RunSchedule {
  return s.action.type === "run";
}

export const SCHEDULES: readonly ScheduleDef[] = [
  {
    name: "keep-alive",
    cron: "* * * * *",
    worker: "bot",
    internal: true,
    description: "Container keep-alive (GET /healthz) — also what restarts the container after a deploy or platform maintenance. Not a run.",
    action: { type: "healthz" },
  },
  {
    name: "self-improvement",
    cron: "0 14 * * 1",
    worker: "bot",
    description: "Weekly self-improvement pass (#84): cluster the friction ledger and file deduped `self-improvement` issues. Proposals only.",
    action: { type: "run", command: "friction propose", identity: CRON_IDENTITY, actor: scheduleActor("self-improvement", SELF_IMPROVEMENT_GRANTS) },
  },
  {
    name: "resident-watchdog",
    cron: "*/10 * * * *",
    worker: "resident",
    description:
      "Resident watchdog (KTD4): re-arm dead refresh alarm chains (marking degraded(alarm-missed)) and time out stuck onboarding. Cadence must stay shorter than the resident SLEEP_AFTER (20m). Not a run.",
    action: { type: "watchdog" },
  },
];

/** The schedules one Worker's wrangler.jsonc must carry and its `scheduled()` fires. */
export function schedulesFor(worker: ScheduleWorker): ScheduleDef[] {
  return SCHEDULES.filter((s) => s.worker === worker);
}

/** The schedule a Workers `ScheduledController.cron` belongs to, looked up
 *  among THAT worker's schedules only (two workers may share an expression). */
export function scheduleForCron(cron: string, worker: ScheduleWorker): ScheduleDef | undefined {
  return SCHEDULES.find((s) => s.worker === worker && s.cron === cron);
}

// ---------------------------------------------------------------------------
// Cron evaluation — enough of Vixie cron to compute "next fire" for the panel
// ---------------------------------------------------------------------------

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  /** 0 = Sunday … 6 = Saturday (an input `7` is folded to 0). */
  dayOfWeek: Set<number>;
  /** Whether the day fields were `*` — decides the dom/dow OR rule. */
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

function parseField(field: string, min: number, max: number): Set<number> | undefined {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return undefined;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (!Number.isInteger(step) || step < 1) return undefined;
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else {
      const [a, b] = m[1].split("-").map(Number);
      // Vixie cron: a step needs a range (`*` or `a-b`); `5/2` is malformed.
      if (b === undefined && m[2] !== undefined) return undefined;
      lo = a;
      hi = b ?? a;
    }
    if (lo < min || hi > max || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Parse a five-field cron expression; undefined for anything malformed (no
 *  names, no `@daily` macros — the registry uses plain numerics). */
export function parseCron(expr: string): CronSpec | undefined {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === "") return undefined;
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dayOfMonth = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  const dowRaw = parseField(fields[4], 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dowRaw) return undefined;
  const dayOfWeek = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    anyDayOfMonth: fields[2] === "*",
    anyDayOfWeek: fields[4] === "*",
  };
}

/** How far ahead `nextFire` searches before giving up (a Feb 30 never fires). */
const NEXT_FIRE_HORIZON_DAYS = 366 * 5;

/** The first firing time (ms, UTC) strictly after `fromMs`; undefined when the
 *  expression is malformed or nothing fires within the horizon. */
export function nextFire(expr: string, fromMs: number): number | undefined {
  const spec = parseCron(expr);
  if (!spec) return undefined;
  const hours = [...spec.hour].sort((a, b) => a - b);
  const minutes = [...spec.minute].sort((a, b) => a - b);
  // Start at the next whole minute after `from`.
  const start = new Date(Math.floor(fromMs / 60_000) * 60_000 + 60_000);
  let day = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  for (let i = 0; i < NEXT_FIRE_HORIZON_DAYS; i++, day += 86_400_000) {
    const d = new Date(day);
    if (!spec.month.has(d.getUTCMonth() + 1)) continue;
    const domOk = spec.dayOfMonth.has(d.getUTCDate());
    const dowOk = spec.dayOfWeek.has(d.getUTCDay());
    // Vixie rule: both restricted → either matches; otherwise the restricted one decides.
    const dayOk = spec.anyDayOfMonth ? dowOk : spec.anyDayOfWeek ? domOk : domOk || dowOk;
    if (!dayOk) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = day + h * 3_600_000 + m * 60_000;
        if (t >= start.getTime()) return t;
      }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Firing records — what a firing left behind, for the /runs Scheduled panel
// ---------------------------------------------------------------------------

/** How a firing ended. The four run statuses mirror the ingress run receipt;
 *  `no-run` = ingress answered 200 without a run receipt; `ingress-error` =
 *  non-2xx (401 unknown identity, 503 disabled, 5xx bot down); `misconfigured`
 *  = the shim could not even plan the request (no `cron` token) and ran nothing. */
export type FiringOutcome = "completed" | "failed" | "stopped_soft" | "stopped_hard" | "no-run" | "ingress-error" | "misconfigured";

const OUTCOMES: ReadonlySet<string> = new Set<FiringOutcome>(["completed", "failed", "stopped_soft", "stopped_hard", "no-run", "ingress-error", "misconfigured"]);

export interface ScheduleFiring {
  /** `ScheduleDef.name`. */
  schedule: string;
  /** Wall-clock ms when the shim fired. */
  firedAt: number;
  /** The run the dispatcher created, when one was. */
  runId?: string;
  outcome: FiringOutcome;
  /** A short human note: the reply's first line, or the HTTP status + error. Capped. */
  detail?: string;
}

/** Detail cap: a firing record is a row on a dashboard, never a report. */
export const FIRING_DETAIL_MAX = 300;

export function isScheduleFiring(v: unknown): v is ScheduleFiring {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  if (typeof f.schedule !== "string" || f.schedule === "") return false;
  if (typeof f.firedAt !== "number" || !Number.isFinite(f.firedAt)) return false;
  if (typeof f.outcome !== "string" || !OUTCOMES.has(f.outcome)) return false;
  if (f.runId !== undefined && typeof f.runId !== "string") return false;
  if (f.detail !== undefined && typeof f.detail !== "string") return false;
  return true;
}

// ---------------------------------------------------------------------------
// The shim's two pure steps: plan the /ingress request, interpret its answer
// ---------------------------------------------------------------------------

export type FiringPlan =
  | { ok: true; token: string; body: { text: string; thread: string } }
  | { ok: false; reason: string };

/** Turn a run schedule into the /ingress request the shim sends. Fail-closed:
 *  without a usable `SWITCHBOARD_INGRESS_TOKENS` entry for the schedule's
 *  identity there is no request — the reason is for the log and the firing
 *  record, never guessed around. Each firing gets its own thread key so two
 *  firings never share a conversation. */
export function planScheduledFiring(schedule: RunSchedule, ingressTokensJson: string | undefined, firedAt: number): FiringPlan {
  if (!ingressTokensJson || ingressTokensJson.trim() === "") return { ok: false, reason: "SWITCHBOARD_INGRESS_TOKENS is not set" };
  const parsed = parseIngressTokenMap(ingressTokensJson);
  if (parsed.ok === false) return { ok: false, reason: `SWITCHBOARD_INGRESS_TOKENS is ${parsed.reason}` };
  const token = tokenForSubject(parsed.tokens, schedule.action.identity);
  if (!token) return { ok: false, reason: `SWITCHBOARD_INGRESS_TOKENS has no entry with subject "${schedule.action.identity}"` };
  return { ok: true, token, body: { text: schedule.action.command, thread: `${schedule.name}-${firedAt}` } };
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "stopped_soft", "stopped_hard"]);

/** The firing detail is the reply's FIRST non-empty line, whitespace-collapsed
 *  and capped: the head line of every command reply is its one-line summary
 *  (e.g. `🔍 *Friction proposals* — 244 runs analyzed · 23 recurring patterns`);
 *  the body under it is the long form, which the /runs panel has no room for. */
function cap(text: string): string {
  const first = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const line = first.replace(/\s+/g, " ").trim();
  return line.length > FIRING_DETAIL_MAX ? `${line.slice(0, FIRING_DETAIL_MAX - 1)}…` : line;
}

/** Build the firing record from the /ingress response. A 2xx with a run
 *  receipt yields the run's id + terminal status; a 2xx without one is
 *  `no-run`; anything else is `ingress-error` with the status and the error
 *  field (or the raw body) as detail. */
export function interpretIngressResponse(schedule: RunSchedule, firedAt: number, status: number, bodyText: string): ScheduleFiring {
  let body: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === "object" && parsed !== null) body = parsed as Record<string, unknown>;
  } catch {
    // non-JSON body: handled below
  }
  if (status < 200 || status >= 300) {
    const error: unknown = body?.error;
    const reason = typeof error === "string" ? error : bodyText;
    return { schedule: schedule.name, firedAt, outcome: "ingress-error", detail: cap(`HTTP ${status} ${reason}`) };
  }
  const run = body?.run as Record<string, unknown> | undefined;
  const reply = typeof body?.reply === "string" ? body.reply : undefined;
  if (run && typeof run.id === "string" && typeof run.status === "string" && RUN_STATUSES.has(run.status)) {
    return {
      schedule: schedule.name,
      firedAt,
      runId: run.id,
      outcome: run.status as FiringOutcome,
      ...(reply !== undefined ? { detail: cap(reply) } : {}),
    };
  }
  return { schedule: schedule.name, firedAt, outcome: "no-run", ...(reply !== undefined ? { detail: cap(reply) } : {}) };
}

// ---------------------------------------------------------------------------
// The resident watchdog's firing record
// ---------------------------------------------------------------------------

/** The shape `runWatchdog` (deploy/cloudflare-resident/worker.ts) returns; only
 *  the fields the firing record summarizes are typed here. */
export interface WatchdogSummary {
  cap: number;
  count: number;
  /** `error` is already a message (`runWatchdog` passes rejections through `errMsg`).
   *  `disk` is the resident's last disk sample gauge (`{usedKiB, totalKiB, …}`,
   *  features/resident-repos.md item 55) when it has one. */
  results: ReadonlyArray<{ resource: string; state?: unknown; reason?: unknown; action?: unknown; error?: string; disk?: unknown }>;
}

/** The fullest resident's disk, as `<pct>% (<owner/name>)`, from the per-resident
 *  gauges a watchdog pass carries; undefined when no resident has measured. */
function fullestDisk(results: WatchdogSummary["results"]): string | undefined {
  let best: { pct: number; resource: string } | undefined;
  for (const r of results) {
    const d = r.disk as { usedKiB?: unknown; totalKiB?: unknown } | null | undefined;
    if (!d || typeof d.usedKiB !== "number" || typeof d.totalKiB !== "number" || d.totalKiB <= 0) continue;
    const pct = Math.round((d.usedKiB / d.totalKiB) * 100);
    if (!best || pct > best.pct) best = { pct, resource: r.resource };
  }
  return best ? `${best.pct}% (${best.resource.replace(/^repo:/, "")})` : undefined;
}

/** Turn a watchdog pass (or the error it threw) into a firing record. A pass is
 *  `completed` when every resident was checked; any per-resident error — or a
 *  throw before the sweep — is `failed`, naming the first failing resident. */
export function watchdogFiring(schedule: ScheduleDef, firedAt: number, result: WatchdogSummary | Error): ScheduleFiring {
  if (result instanceof Error) return { schedule: schedule.name, firedAt, outcome: "failed", detail: cap(`watchdog threw: ${result.message}`) };
  const errors = result.results.filter((r) => r.error !== undefined);
  const reArmed = result.results.filter((r) => r.action === "re-armed").length;
  const timedOut = result.results.filter((r) => r.action === "provision-timed-out").length;
  const disk = fullestDisk(result.results);
  const counts = `${result.count}/${result.cap} residents · ${reArmed} re-armed · ${timedOut} timed out · ${errors.length} errors${disk ? ` · disk max ${disk}` : ""}`;
  const first = errors[0];
  return {
    schedule: schedule.name,
    firedAt,
    outcome: errors.length > 0 ? "failed" : "completed",
    detail: cap(first ? `${counts} — ${first.resource}: ${String(first.error)}` : counts),
  };
}

// ---------------------------------------------------------------------------
// Recording a firing on the state Worker's ScheduleDO (shared by both shims)
// ---------------------------------------------------------------------------

export interface ScheduleRecorderConfig {
  /** `STATE_WORKER_URL` var: the state Worker's base URL. */
  url: string | undefined;
  /** `MEMORY_TOKEN` secret: the state Worker's bearer. */
  token: string | undefined;
}

export type RecordResult = { ok: true } | { ok: false; reason: string };

/** POST the firing to `<url>/schedules/record`. Best-effort telemetry for the
 *  /runs Scheduled panel: a failure is returned for the caller's log line, never
 *  thrown — the firing's real work already happened and is its own record.
 *  Fail-closed on config: no URL or bearer → nothing sent. */
export async function recordFiring(config: ScheduleRecorderConfig, firing: ScheduleFiring, fetchImpl: typeof fetch = fetch): Promise<RecordResult> {
  if (!config.url) return { ok: false, reason: "STATE_WORKER_URL var is not set" };
  if (!config.token) return { ok: false, reason: "MEMORY_TOKEN secret is not set" };
  try {
    const res = await fetchImpl(`${config.url.replace(/\/+$/, "")}/schedules/record`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ firing }),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `state Worker HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
