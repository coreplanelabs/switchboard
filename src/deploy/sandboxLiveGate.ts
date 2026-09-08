import { FLEET_BUSY_REASON } from "../execution/sandboxErrors.js";
import { decideLive, LIVE_GATE_DEADLINE_MS, type HealthzBody } from "./liveGate.js";

// The sandbox Worker's live gate — the pure half. A sandbox deploy is two
// artifacts: the Worker version `wrangler deploy` uploads at once, and the
// container image Cloudflare rolls out afterwards, instance by instance. In
// between, the new Worker code can be handed a container still running the
// previous image, and a Durable Object created then stays on it: 2026-09-07
// (#569) the review of #520 started 111 s after the upload, landed on a 0.3.7
// container under the 0.12.9 SDK, and every exec failed with an EMPTY error
// for 90 s. "Deployed" therefore means nothing here until three independent
// signals agree — the Worker serves the deployed commit, every RUNNING
// instance of the container application is on the application's version, and
// a real `echo ok` through a probe thread answers from an instance on that
// version. Each signal has its own named `waiting` reason, and nothing the
// rollout can cause (a full fleet, a booting container, an in-body error) is
// a failure before the deadline. No node:* imports; src/deploy/run.ts does
// the fetching, the wrangler calls and the clock.

/** One read of a bearer-gated `/healthz`: the HTTP status with the parsed body, or why the request itself failed. */
export type HealthRead = { status: number; body: HealthzBody | undefined } | { error: string };

/** A value read from outside the process, or the reason it could not be. */
export type Read<T> = { value: T } | { error: string };

/** One row of `wrangler containers instances <app> --json`, reduced to what the gate reads:
 *  `name` is the Durable Object name (our thread key), `version` the instance's `app_version`. */
export interface ContainerInstance {
  name: string | null;
  state: string;
  version: number | null;
}

/** The one JSON document a streamed `/exec` answer ends with (features/execution.md item 3). */
export interface ExecBody {
  stdout?: unknown;
  stderr?: unknown;
  exitCode?: unknown;
  error?: unknown;
  reason?: unknown;
}

/** The probe's outcome: the Worker's document, or why none arrived (transport, HTTP status, not JSON). */
export type ProbeResult = { body: ExecBody } | { error: string };

export interface SandboxLiveInput {
  health: HealthRead;
  /** `null` when not read this poll (the runner reads the rollout and probes only once the Worker is live). */
  appVersion: Read<number> | null;
  instances: Read<ContainerInstance[]> | null;
  probe: ProbeResult | null;
  /** The probe's thread key — the instance `name` the probe must be found under. */
  probeThreadKey: string;
  deployedCommit: string;
  elapsedMs: number;
}

/** `live` with the three facts that proved it; `waiting` with the one that does
 *  not hold yet; `failed` when waiting cannot help — the deadline passed, or a
 *  credential is rejected (the CLI exits non-zero: never success when not live). */
export type SandboxLiveDecision =
  { kind: "live"; summary: string } | { kind: "waiting"; reason: string } | { kind: "failed"; reason: string };

/** The probe's command and its budget: a trivial command, sized so a cold container start fits. */
export const PROBE_COMMAND = "echo ok";
export const PROBE_TIMEOUT_MS = 60_000;
/** The probe's thread key. One per deployed commit, so every poll of one gate
 *  reuses ONE Durable Object — the probe holds one fleet slot for the 5-min idle window. */
export function probeThreadKey(commit: string): string {
  return `deploy-gate:${commit}`;
}

/** The SDK's boot-time text, matched loosely: the Worker may wrap it (a recycle message keeps the original in parentheses). */
const CONTAINER_STARTING = /Container is starting/i;

/** The first signal: is the Worker at `healthUrl` serving the deployed commit?
 *  `decideLive`'s rules for the body; a rejected bearer is `fatal` (waiting
 *  cannot fix a credential). Exported because the runner reads the rollout and
 *  probes only once this holds. */
export function decideWorker(
  health: HealthRead,
  deployedCommit: string,
): { ok: true; commit: string } | { ok: false; reason: string; fatal: boolean } {
  if ("error" in health) return { ok: false, fatal: false, reason: `Worker: GET /healthz failed: ${health.error}` };
  if (health.status === 401 || health.status === 403)
    return {
      ok: false,
      fatal: true,
      reason: `Worker: GET /healthz → HTTP ${health.status} — the SANDBOX_TOKEN bearer is rejected; waiting cannot fix a credential`,
    };
  const d = decideLive(health.body, deployedCommit, 0);
  return d.kind === "live"
    ? { ok: true, commit: d.commit }
    : { ok: false, fatal: false, reason: `Worker: ${d.reason}` };
}

const waiting = (reason: string): SandboxLiveDecision => ({ kind: "waiting", reason });

function judge(input: SandboxLiveInput): SandboxLiveDecision {
  const worker = decideWorker(input.health, input.deployedCommit);
  if (!worker.ok) return worker.fatal ? { kind: "failed", reason: worker.reason } : waiting(worker.reason);

  // The rollout: every RUNNING instance is on the application's version. Other
  // states are ignored — a stopping old instance is on its way out, a stopped or
  // failed one serves nobody, and a provisioning one is not yet placed.
  if (input.appVersion === null || input.instances === null) return waiting("rollout: not read yet");
  if ("error" in input.appVersion) return waiting(`rollout: ${input.appVersion.error}`);
  if ("error" in input.instances) return waiting(`rollout: ${input.instances.error}`);
  const appVersion = input.appVersion.value;
  const running = input.instances.value.filter((i) => i.state === "running");
  const stale = running.filter((i) => i.version !== appVersion);
  if (stale.length > 0) {
    const versions = [...new Set(stale.map((i) => (i.version === null ? "?" : String(i.version))))].join("/");
    return waiting(
      `rollout in progress — ${stale.length} of ${running.length} running instance(s) still on version ${versions}, app version ${appVersion}`,
    );
  }

  // The probe: `echo ok` through the gate's own thread. Everything the rollout
  // can cause is `waiting`: a full fleet (capacity, execution.md item 14), a
  // booting container, ANY in-body error — an EMPTY one included, which is the
  // #569 shape: the 0.12.9 SDK against a previous-image container — and a
  // nonzero exit. Only the deadline turns these into a failure.
  if (input.probe === null) return waiting("probe: not sent yet");
  if ("error" in input.probe) return waiting(`probe: ${input.probe.error}`);
  const body = input.probe.body;
  if (body.reason === FLEET_BUSY_REASON)
    return waiting("probe: fleet busy — no free instance for the probe thread (max_instances reached)");
  if (typeof body.error === "string" && CONTAINER_STARTING.test(body.error))
    return waiting("probe: container starting");
  if ("error" in body)
    return waiting(
      body.error === ""
        ? "probe: /exec failed with an EMPTY error — the probe's container may still run the previous image (#569)"
        : `probe: /exec failed — ${typeof body.error === "string" ? body.error : JSON.stringify(body.error)}`,
    );
  if (body.exitCode !== 0) {
    const stderr = typeof body.stderr === "string" ? body.stderr.trim() : "";
    return waiting(`probe: \`${PROBE_COMMAND}\` exited ${String(body.exitCode)}${stderr ? `: ${stderr}` : ""}`);
  }
  const stdout = typeof body.stdout === "string" ? body.stdout.trim() : "";
  if (stdout !== "ok") return waiting(`probe: \`${PROBE_COMMAND}\` printed ${JSON.stringify(stdout)}`);

  // The probe answered — from which image? Its instance is listed under the
  // thread key and must be on the application's version too.
  const mine = input.instances.value.find((i) => i.name === input.probeThreadKey);
  if (!mine) return waiting(`probe instance ${input.probeThreadKey} not listed yet`);
  if (mine.version !== appVersion)
    return waiting(
      `probe instance ${input.probeThreadKey} is on version ${mine.version === null ? "?" : mine.version}, app version ${appVersion} — the probe landed on a previous image`,
    );
  return {
    kind: "live",
    summary: `Worker serves ${worker.commit.slice(0, 7)}; rollout complete (${running.length} running instance(s) on version ${appVersion}); probe \`${PROBE_COMMAND}\` exit 0 from ${input.probeThreadKey} (version ${appVersion})`,
  };
}

/**
 * The decision for one poll: `live` only when the Worker, the rollout and the
 * probe all hold; otherwise `waiting` with the first signal that does not,
 * checked in that order (each later signal is meaningless while an earlier one
 * fails). At `deadlineMs` the same reason becomes `failed`; a rejected bearer
 * is `failed` at once.
 */
export function decideSandboxLive(
  input: SandboxLiveInput,
  deadlineMs: number = LIVE_GATE_DEADLINE_MS,
): SandboxLiveDecision {
  const d = judge(input);
  if (d.kind !== "waiting" || input.elapsedMs < deadlineMs) return d;
  return {
    kind: "failed",
    reason: `${d.reason} — still not live after ${Math.round(input.elapsedMs / 60_000)} min (deadline ${deadlineMs / 60_000} min)`,
  };
}

// ---- parsers for what the runner reads -------------------------------------------------------------

/** wrangler may print its banner before a `--json` payload; the document starts at the first `[` or `{`. */
export function parseWranglerJson(text: string): unknown {
  const starts = [text.indexOf("["), text.indexOf("{")].filter((i) => i >= 0);
  if (starts.length === 0) return undefined;
  try {
    return JSON.parse(text.slice(Math.min(...starts))) as unknown;
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An `app_version`: a number, or a numeric string; anything else is unknown. */
function asVersion(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** The id of the application named `name` in `wrangler containers list --json`. */
export function containerAppId(listing: unknown, name: string): string | undefined {
  if (!Array.isArray(listing)) return undefined;
  const app = listing.find((a) => isRecord(a) && a.name === name);
  return app && isRecord(app) && typeof app.id === "string" ? app.id : undefined;
}

/** The application's `version` from `wrangler containers info <id> --json`. */
export function parseAppVersion(info: unknown): number | null {
  return isRecord(info) ? asVersion(info.version) : null;
}

/** One page of `wrangler containers instances <id> --json`: a bare array
 *  (unpaginated) or `{ instances, result_info: { next_page_token } }` (with
 *  `--per-page`/`--page-token`). `undefined` when it is neither. */
export function parseInstancesPage(
  page: unknown,
): { rows: ContainerInstance[]; nextPageToken: string | null } | undefined {
  let rows: unknown;
  let next: unknown = null;
  if (Array.isArray(page)) rows = page;
  else if (isRecord(page) && Array.isArray(page.instances)) {
    rows = page.instances;
    next = isRecord(page.result_info) ? page.result_info.next_page_token : null;
  } else return undefined;
  return {
    rows: (rows as unknown[]).filter(isRecord).map((r) => ({
      name: typeof r.name === "string" ? r.name : null,
      state: typeof r.state === "string" ? r.state : "unknown",
      version: asVersion(r.version),
    })),
    nextPageToken: typeof next === "string" && next !== "" ? next : null,
  };
}

/** The streamed `/exec` body: whitespace heartbeats around ONE JSON object. */
export function parseExecStream(text: string): ProbeResult {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    return isRecord(parsed)
      ? { body: parsed }
      : { error: `/exec answered non-object JSON: ${text.trim().slice(0, 120)}` };
  } catch {
    return { error: `/exec answered no JSON document: ${JSON.stringify(text.trim().slice(0, 120))}` };
  }
}
