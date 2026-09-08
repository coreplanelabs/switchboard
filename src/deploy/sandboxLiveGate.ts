import { FLEET_BUSY_REASON } from "../execution/sandboxErrors.js";
import { decideLive, LIVE_GATE_DEADLINE_MS, type HealthzBody } from "./liveGate.js";

// The sandbox Worker's live gate — the pure half. A sandbox deploy is two
// artifacts: the Worker version `wrangler deploy` uploads at once, and the
// container image Cloudflare rolls out afterwards, instance by instance. In
// between, the new Worker code can be handed a container still running the
// previous image, and a Durable Object created then stays on it: a thread
// placed a minute or two after the upload runs its whole life on the old
// image, and every exec fails with an EMPTY error. "Deployed" therefore means
// nothing here until three independent
// signals agree — the Worker serves the deployed commit, every RUNNING
// instance of the container application is on the application's version, and
// a real `echo ok` through a probe thread answers from an instance on that
// version. Each signal has its own named `waiting` reason, and nothing the
// rollout can cause (a full fleet, a booting container, an in-body error) is
// a failure before the deadline. The rollout signal has a TARGET: seconds
// after the upload the application can still report the PRE-deploy version —
// the deploy's new version has not registered yet — so every running instance
// trivially matches it and a probe runs on the old image; a gate judging
// "all instances on the app version" alone passes at once. So the runner
// reads the application before the upload and takes the target from
// wrangler's own container diff; the rollout
// counts only once the application has left the pre-deploy version. No node:*
// imports; src/deploy/run.ts does the fetching, the wrangler calls and the clock.

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

/** The container application as `wrangler containers info <id> --json` reports it: its `version`
 *  (bumped by every modification Cloudflare rolls out) and the image reference in `configuration.image`. */
export interface AppState {
  version: number;
  image: string | null;
}

/** What `wrangler deploy` said the container application moves to, read from its `Container application
 *  changes` diff: `image` is the reference a `+ "image"` line added, `null` when the diff changed other
 *  configuration only (a new version is still coming, its image unknown). The runner passes `null` in
 *  place of the whole target when wrangler printed no change — a Worker-only deploy rolls no container. */
export interface RolloutTarget {
  image: string | null;
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
  app: Read<AppState> | null;
  instances: Read<ContainerInstance[]> | null;
  probe: ProbeResult | null;
  /** The probe's thread key — the instance `name` the probe must be found under. */
  probeThreadKey: string;
  deployedCommit: string;
  /** The application as read BEFORE the upload — the version the rollout must leave. */
  before: Read<AppState>;
  /** wrangler's diff; `null` when it printed no container change (Worker-only deploy, no rollout expected). */
  target: RolloutTarget | null;
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

/** An image reference's digest, short: `…@sha256:eb7d4f28…` → `sha256:eb7d4f28`; a reference without one as is. */
export function shortImage(ref: string): string {
  const m = /@(sha256):([0-9a-f]+)$/i.exec(ref);
  return m ? `${m[1]}:${m[2].slice(0, 8)}` : ref;
}

/**
 * Has the application left its pre-deploy state? `ok` with how the rollout is
 * described once complete; otherwise the waiting reason. Two independent
 * pieces of evidence, either suffices: the version is above the pre-deploy one
 * (the primary signal — Cloudflare bumps it for every modification it rolls
 * out), or the application reports the very image wrangler's diff added. With
 * the pre-deploy read failed AND no image in the diff there is no evidence to
 * wait for, and the reason says so until the deadline.
 */
function rolloutAdvanced(
  app: AppState,
  before: Read<AppState>,
  target: RolloutTarget,
): { ok: true; from: string } | { ok: false; reason: string } {
  if ("value" in before) {
    if (app.version > before.value.version) return { ok: true, from: `up from ${before.value.version}` };
    const image = app.image === null ? "" : ` / image ${shortImage(app.image)}`;
    return {
      ok: false,
      reason: `rollout: application still at pre-deploy version ${before.value.version}${image} — the deploy's new version is not registered yet`,
    };
  }
  if (target.image !== null && app.image === target.image) return { ok: true, from: `image ${shortImage(app.image)}` };
  if (target.image === null)
    return {
      ok: false,
      reason: `rollout: pre-deploy version unreadable (${before.error}) and the deploy printed no image — cannot tell when the new version registers`,
    };
  return {
    ok: false,
    reason: `rollout: pre-deploy version unreadable (${before.error}); application image ${app.image === null ? "?" : shortImage(app.image)} is not the deploy's ${shortImage(target.image)}`,
  };
}

function judge(input: SandboxLiveInput): SandboxLiveDecision {
  const worker = decideWorker(input.health, input.deployedCommit);
  if (!worker.ok) return worker.fatal ? { kind: "failed", reason: worker.reason } : waiting(worker.reason);

  // The rollout, first its target: when wrangler printed a container change the
  // application must have LEFT the version read before the upload — instances
  // "all on the app version" mean nothing while that version is the old one.
  // A Worker-only deploy (no change printed) rolls no container: the
  // current version is the one to be on.
  if (input.app === null || input.instances === null) return waiting("rollout: not read yet");
  if ("error" in input.app) return waiting(`rollout: ${input.app.error}`);
  if ("error" in input.instances) return waiting(`rollout: ${input.instances.error}`);
  const app = input.app.value;
  const appVersion = app.version;
  const running = input.instances.value.filter((i) => i.state === "running");
  let rolloutSummary: string;
  if (input.target) {
    const advanced = rolloutAdvanced(app, input.before, input.target);
    if (!advanced.ok) return waiting(advanced.reason);
    rolloutSummary = `rollout complete (${running.length} running instance(s) on version ${appVersion}, ${advanced.from})`;
  } else
    rolloutSummary = `Worker-only deploy — no container change (${running.length} running instance(s) on version ${appVersion})`;

  // Then the instances: every RUNNING one is on the application's version. Other
  // states are ignored — a stopping old instance is on its way out, a stopped or
  // failed one serves nobody, and a provisioning one is not yet placed.
  const stale = running.filter((i) => i.version !== appVersion);
  if (stale.length > 0) {
    const versions = [...new Set(stale.map((i) => (i.version === null ? "?" : String(i.version))))].join("/");
    return waiting(
      `rollout in progress — ${stale.length} of ${running.length} running instance(s) still on version ${versions}, app version ${appVersion}`,
    );
  }

  // The probe: `echo ok` through the gate's own thread. Everything the rollout
  // can cause is `waiting`: a full fleet (capacity, execution.md item 14), a
  // booting container, ANY in-body error — an EMPTY one included, which is
  // what a newer SDK gets from a previous-image container — and a
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
        ? "probe: /exec failed with an EMPTY error — the probe's container may still run the previous image"
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
    summary: `Worker serves ${worker.commit.slice(0, 7)}; ${rolloutSummary}; probe \`${PROBE_COMMAND}\` exit 0 from ${input.probeThreadKey} (version ${appVersion})`,
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

/** The application's `version` and `configuration.image` from `wrangler containers info <id> --json`;
 *  `null` without a numeric version (the image alone identifies nothing to compare instances against). */
export function parseAppState(info: unknown): AppState | null {
  if (!isRecord(info)) return null;
  const version = asVersion(info.version);
  if (version === null) return null;
  const image = isRecord(info.configuration) ? info.configuration.image : undefined;
  return { version, image: typeof image === "string" ? image : null };
}

/** ANSI colour sequences (ESC `[` … `m`), built from the code point so the regex literal carries no control character. */
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
/** The box-drawing gutter wrangler's sections put before every line (`│ `, `├ `, `╰ `). */
const SECTION_GUTTER = /^[\s│├╭╰|]+/;

/**
 * The rollout target in a `wrangler deploy` output. wrangler rebuilds the
 * container image on every deploy and prints a `Container application changes`
 * section: under `EDIT <app>` a line diff of the application's configuration
 * (`+ "image": "…@sha256:…"` when the image changed, other `+` lines for other
 * fields), under `NEW <app>` the whole configuration as a snippet, or `no
 * changes` when the rebuilt image has the same digest and nothing else moved.
 * A change means Cloudflare creates a new application version and rolls it
 * out; `null` — no section, or no change in it — means no rollout is coming.
 */
export function rolloutTargetFromDeployOutput(output: string): RolloutTarget | null {
  const text = output.replace(ANSI_SEQUENCE, "");
  const at = text.indexOf("Container application changes");
  if (at < 0) return null;
  const lines = text
    .slice(at)
    .split("\n")
    .map((l) => l.replace(SECTION_GUTTER, "").trimEnd());
  const imageOn = (candidates: string[]) => {
    for (const l of candidates) {
      const m = /^\+?\s*"image":\s*"([^"]+)"/.exec(l);
      if (m) return m[1];
    }
    return null;
  };
  if (lines.some((l) => /^NEW\s/.test(l))) return { image: imageOn(lines) };
  const added = lines.filter((l) => /^\+\s/.test(l));
  return added.length === 0 ? null : { image: imageOn(added) };
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
