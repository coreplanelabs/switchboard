import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import type { AgentDef } from "../agents/registry.js";
import { LocalExecutor, type Executor } from "./executor.js";
import { E2BExecutor } from "./e2b.js";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { ResidentExecutor, ResidentNeedsRefError, type ResidentStatusProbe } from "./resident.js";
import { repoResourceId } from "../core/repoCommands.js";
import { resolveGithubToken } from "./githubApp.js";
import { isServiceable } from "./residentState.js";

export interface ResidentExecutionConfig {
  /** base URL of the resident Worker (deploy/cloudflare-resident/) */
  baseUrl: string;
  /** env var holding the operator bearer (default RESIDENT_OPERATOR_TOKEN) */
  tokenEnv?: string;
  /** env var holding the ADMIN bearer for `repo onboard/offboard/...` chat
   *  commands (default RESIDENT_ADMIN_TOKEN). Unset env = repo-management
   *  commands answer with a named configuration error; runs are unaffected. */
  adminTokenEnv?: string;
  /** /status probe timeout in ms (default 2000); a timed-out probe = not warm */
  probeTimeoutMs?: number;
}

export interface ExecutionConfig {
  /**
   * "local" (default): run tools on the bot host.
   * "e2b": per-thread E2B micro-VM.
   * "cloudflare": per-thread Cloudflare Sandbox via the proxy Worker
   *   (deploy/cloudflare-sandbox/).
   */
  type?: "local" | "e2b" | "cloudflare";
  /** env var holding the sandbox provider API key/token (e2b, cloudflare) */
  apiKeyEnv?: string;
  /** sandbox idle lifetime in minutes (e2b only, default 30) */
  timeoutMinutes?: number;
  /** base URL of the sandbox proxy Worker (cloudflare only) */
  url?: string;
  /**
   * Resident repo environments (deploy/cloudflare-resident/): when set AND
   * the request resolved a target repo (ctx.repo), a warm resident serves the
   * thread; any other resident state falls back to the per-thread backend
   * above with a named note (KTD10). No ctx.repo → per-thread, no probe.
   */
  resident?: ResidentExecutionConfig;
}

export interface ExecutorFactoryOptions {
  execution?: ExecutionConfig;
  workspaceDir: string; // local mode: base dir for per-thread workspaces
  dataDir: string; // e2b mode: where the thread->sandbox map is persisted
}

/** What executor selection knows about the run it is provisioning for.
 *  The agent's resource declarations drive whether anything is provisioned at
 *  all; repo/ref carry resident-repo inference (populated by the dispatcher's
 *  repo resolver — U7; undefined means the per-thread path, no probe). */
export interface ExecutorContext {
  threadKey: string;
  /** the resolved agent (never mutated here) */
  agent: AgentDef;
  /** inferred target repo, e.g. "org/name" */
  repo?: string;
  /** inferred git ref within `repo` */
  ref?: string;
}

/** Executor selection result. `note` is present when resident selection fell
 *  back to the per-thread backend — the NAMED reason (state + reason, KTD10)
 *  the dispatcher surfaces on the status card — or when the resident was
 *  attached in a non-warm but serviceable state (`refreshing`/`degraded`: the
 *  last snapshot serves). Never silent. `resident` is the backend
 *  discriminant: true only when a ResidentExecutor was returned, so the
 *  dispatcher can pick the resident system-prompt variant without an
 *  `instanceof` on the executor implementation. */
export interface ExecutorSelection {
  executor: Executor;
  note?: string;
  resident?: boolean;
}

// Resident lifecycle states the bot attaches in — `isServiceable` in
// residentState.ts (shared with the resident Worker's own state union). The
// resident's contract (features/resident-repos.md items 7/12) is that
// `refreshing` keeps SERVING the last snapshot — the mirror lock serializes an
// attach against a refresh's fetch/rebuild — and that `degraded` does too when
// the failure happened BEFORE the checkout was touched (fetch/bookkeeping
// reasons); a failure inside the rebuild can leave a broken dep cache, so
// those reasons stay cold. Gating on `warm` alone (the original U5 rule) sent
// every run cold for the whole of every refresh window: with an active default
// branch (a dozen merges a day, each a 1–2 min rebuild every 10-min cycle)
// plus each resident deploy's restore, that was most of a working day (live
// 2026-08-29: "resident refreshing — using fresh sandbox" on run after run).
// The engine-owned states stay excluded: `onboarding` (nothing to attach),
// `restoring` (the disk is being rehydrated; attach's own ensureHydrated would
// wait, but a restore is short and the note is more honest), `down` (only a
// rebuild escapes).

// Negative cache (circuit breaker) for resident /status probe TRANSPORT
// failures only: a resident-service outage costs one probe timeout, not one
// per concurrent dispatch. Not-warm lifecycle states are definite answers and
// are NEVER cached (the next dispatch must see a recovery immediately).
// In-process only — deliberately not persisted (restart-survival invariant).
const PROBE_OUTAGE_WINDOW_MS = 30_000;
let probeOutage: { until: number; error: string } | undefined;

/** Test seam: clears the module-level probe circuit breaker. */
export function resetResidentProbeCache(): void {
  probeOutage = undefined;
}

export async function makeExecutor(
  opts: ExecutorFactoryOptions,
  ctx: ExecutorContext,
): Promise<ExecutorSelection> {
  // Agents declare the resources they need (KD2). No repo declared → nothing
  // to provision: no workspace dir, no sandbox created or reconnected, no
  // credential required. The general agent (toolset "none") lands here.
  if (ctx.agent.resources?.repo !== "required") {
    return { executor: new NullExecutor(ctx.agent.name) };
  }

  // Resident selection (KTD11): only when a target repo was resolved AND the
  // resident backend is configured. A SERVICEABLE state → ResidentExecutor;
  // anything else (engine-owned state, probe timeout, outage) → the per-thread
  // backend below, with the reason carried in `note` (KTD10 — never a silent
  // stall). A repo that is simply not onboarded also runs per-thread, but
  // carries a note so the cold fall-through is visible (with the onboarding fix).
  let note: string | undefined;
  if (ctx.repo && opts.execution?.resident) {
    const resident = opts.execution.resident;
    const tokenEnv = resident.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN";
    const token = process.env[tokenEnv];
    if (!token) throw new Error(`execution.resident is configured but ${tokenEnv} is not set`);
    const resource = repoResourceId(ctx.repo);
    const probe = await probeResident(resident, token, resource);
    if (probe.kind === "status" && isServiceable(probe.state, probe.reason)) {
      // The resident can degrade between the /status probe and /attach: 503
      // (mirror-busy) or 429 (pool-exhausted) surface only at attach time.
      // ResidentNeedsRefError must still propagate (the dispatcher's ask-once
      // flow depends on it); any OTHER attach failure falls back to the
      // per-thread backend with a named note (KTD10 / AE6 — never a silent
      // stall or a raw ⚠️ for this window).
      try {
        const executor = await ResidentExecutor.open({
          baseUrl: resident.baseUrl,
          token,
          resource,
          threadKey: ctx.threadKey,
          refHint: ctx.ref,
        });
        // Non-warm but serviceable: say so on the card (KTD10), while the run
        // still gets the warm worktree it came for.
        const nonWarm =
          probe.state === "warm" ? undefined : `resident ${probe.state}${probe.reason ? ` (${probe.reason})` : ""} — attached to the last snapshot`;
        return { executor, resident: true, ...(nonWarm ? { note: nonWarm } : {}) };
      } catch (err) {
        if (err instanceof ResidentNeedsRefError) throw err;
        note = `resident attach failed (${err instanceof Error ? err.message : String(err)}) — using fresh sandbox`;
      }
    } else if (probe.kind === "unreachable") {
      note = `resident unreachable (${probe.error}) — using fresh sandbox`;
    } else if (probe.state !== "not-onboarded") {
      note = `resident ${probe.state}${probe.reason ? ` (${probe.reason})` : ""} — using fresh sandbox`;
    } else {
      // not-onboarded is the ordinary per-thread case — but still make the cold
      // fall-through visible (KTD10): the user needs to know coding ran cold in a
      // per-thread sandbox instead of on a warm, deps-ready resident, and how to
      // fix it. Routing is unchanged; only the note is added.
      note =
        `repo not onboarded as a resident — running in a cold per-thread sandbox; ` +
        `onboard it (\`repo onboard ${ctx.repo}\`) for a warm, deps-ready environment`;
    }
  }

  return { executor: await makePerThreadExecutor(opts, ctx), note };
}

/** /status probe through the negative cache: inside an outage window the
 *  cached transport failure answers without a fetch. */
async function probeResident(
  cfg: ResidentExecutionConfig,
  token: string,
  resource: string,
): Promise<ResidentStatusProbe> {
  if (probeOutage && Date.now() < probeOutage.until) {
    return { kind: "unreachable", error: `${probeOutage.error}; probe skipped during outage window`, transport: true };
  }
  const probe = await ResidentExecutor.probeStatus(cfg.baseUrl, token, resource, cfg.probeTimeoutMs ?? 2000);
  if (probe.kind === "unreachable" && probe.transport) {
    probeOutage = { until: Date.now() + PROBE_OUTAGE_WINDOW_MS, error: probe.error };
  }
  return probe;
}

/** The thread's local workspace directory under `baseDir`: the threadKey is
 *  sanitized to a filesystem-safe slug before resolving. Shared by the local
 *  executor path here and the dispatcher's local Operations backend. */
export function localWorkspaceDir(baseDir: string, threadKey: string): string {
  const safe = threadKey.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return resolve(baseDir, safe);
}

/** The per-thread backends (the pre-resident selection, unchanged). */
async function makePerThreadExecutor(opts: ExecutorFactoryOptions, ctx: ExecutorContext): Promise<Executor> {
  const { threadKey } = ctx;
  const type = opts.execution?.type ?? "local";

  if (type === "local") {
    const dir = localWorkspaceDir(opts.workspaceDir, threadKey);
    mkdirSync(dir, { recursive: true });
    return new LocalExecutor(dir);
  }

  if (type === "e2b") {
    const apiKeyEnv = opts.execution?.apiKeyEnv ?? "E2B_API_KEY";
    const apiKey = process.env[apiKeyEnv];
    if (!apiKey) throw new Error(`execution.type is "e2b" but ${apiKeyEnv} is not set`);
    const envs = await githubEnvs(ctx.agent);
    return E2BExecutor.open({
      apiKey,
      threadKey,
      timeoutMs: (opts.execution?.timeoutMinutes ?? 30) * 60_000,
      statePath: resolve(opts.dataDir, "sandboxes.json"),
      envs,
      repo: ctx.repo,
      ref: ctx.ref,
    });
  }

  if (type === "cloudflare") {
    if (!opts.execution?.url) {
      throw new Error(`execution.type is "cloudflare" but execution.url is not set`);
    }
    const apiKeyEnv = opts.execution.apiKeyEnv ?? "SANDBOX_TOKEN";
    const token = process.env[apiKeyEnv];
    if (!token) throw new Error(`execution.type is "cloudflare" but ${apiKeyEnv} is not set`);
    const envs = await githubEnvs(ctx.agent);
    return new CloudflareSandboxExecutor({
      url: opts.execution.url,
      token,
      threadKey,
      envs,
      repo: ctx.repo,
      ref: ctx.ref,
    });
  }

  throw new Error(`Unknown execution.type "${type}" (valid: local, e2b, cloudflare)`);
}

/** Executor for agents that declare no repo resource. Provisions nothing; a
 *  tool call reaching it is a wiring bug (an agent with tools but no declared
 *  resources) and surfaces as a legible tool error, not a crash. */
class NullExecutor implements Executor {
  constructor(private agentName: string) {}

  private fail(): never {
    throw new Error(
      `Agent "${this.agentName}" declares no repo resource, so it has no execution workspace. ` +
        `Declare resources: { repo: "required" } on the agent if its tools need one.`,
    );
  }

  async exec(): Promise<string> {
    this.fail();
  }
  async readFile(): Promise<string> {
    this.fail();
  }
  async writeFile(): Promise<string> {
    this.fail();
  }
}

/** GitHub credential for the sandbox env: freshly-minted App installation
 *  token when a GitHub App is configured, else static GH_TOKEN, else none.
 *
 *  Least-privilege by toolset: a `readonly` agent (the review agent) gets a
 *  READ-scoped token, so even though its sandbox has `gh` + the credential
 *  helper, it physically cannot post/review/push from inside — the deterministic
 *  review post is done by the bot process (githubComments.ts) with a write
 *  token, so this doesn't weaken it. A `full` agent (coding) gets the
 *  write-scoped token it needs to push and open PRs. */
async function githubEnvs(agent: AgentDef): Promise<Record<string, string>> {
  const scope = agent.toolset === "readonly" ? "read" : "write";
  const token = await resolveGithubToken(scope);
  return token ? { GH_TOKEN: token } : {};
}
