import { resolve } from "node:path";
import { oneLine } from "../core/redact.js";
import type { Backend } from "../core/trace/attrs.js";
import type { Span } from "../core/trace/types.js";
import type { ResidentStep } from "./residentStepTrace.js";
import { residentTraceOf, type ResidentTrace } from "./residentTrace.js";
import { mkdirSync } from "node:fs";
import type { AgentDef, Identity } from "../agents/registry.js";
import type { RunProfile } from "../config/profile.js";
import { LocalExecutor, type Executor } from "./executor.js";
import { E2BExecutor } from "./e2b.js";
import { CloudflareSandboxExecutor } from "./cloudflareSandbox.js";
import { ResidentExecutor, ResidentNeedsRefError, type ResidentBinding, type ResidentStatusProbe } from "./resident.js";
import { repoResourceId } from "../core/residentAdmin.js";
import { resolveGithubToken, type GithubTokenScope } from "./githubApp.js";
import { isServiceable } from "./residentState.js";
import { systemClock } from "../core/trace/clock.js";
import { processSecrets, type Secret, type Secrets } from "../secrets.js";

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
   * the request resolved a target repo (ctx.repo) for a `repo-resident` run,
   * a warm resident serves the thread; any other resident state falls back to
   * the per-thread backend above with a named note. No ctx.repo → per-thread,
   * no probe. The `blank` and `repo-cold` classes never consult it.
   */
  resident?: ResidentExecutionConfig;
}

export interface ExecutorFactoryOptions {
  execution?: ExecutionConfig;
  workspaceDir: string; // local mode: base dir for per-thread workspaces
  dataDir: string; // e2b mode: where the thread->sandbox map is persisted
}

/** What executor selection knows about the run it is provisioning for.
 *  The profile's machine class decides what is provisioned and its identity
 *  whom the machine acts as; repo/ref carry resident-repo inference (populated
 *  by the dispatcher's repo resolver; undefined means the per-thread path, no
 *  probe). */
export interface ExecutorContext {
  threadKey: string;
  /** the resolved agent (never mutated here) — named in the null executor's error */
  agent: AgentDef;
  /** The run's EFFECTIVE profile (docs/decisions/0026-capability-profiles-and-request-routing.md):
   *  the class provisioned and the identity minted are read from here and
   *  never from `agent`, so nothing a boundary capped can leak back in. */
  profile: RunProfile;
  /** inferred target repo, e.g. "org/name" */
  repo?: string;
  /** inferred git ref within `repo` */
  ref?: string;
  /** the commit `ref` is expected to be at (a resolved PR head) — the resident
   *  fetches a mirror whose tip lags it (docs/reference/specs/resident-repos.md item 51) */
  headSha?: string;
}

/** Executor selection result. `note` is present when resident selection fell
 *  back to the per-thread backend — the NAMED reason (state + reason)
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
  /** Where the run's commands execute (docs/reference/specs/tracing.md): recorded on its
   *  `exec.*` spans. Every production selection names one; a test double may
   *  leave it out. */
  backend?: Backend;
  /** The resident's step trace for the attach (docs/reference/specs/tracing.md item 19):
   *  the dispatcher grafts it under its attach span. On the resident path, or
   *  on the sandbox fallback after a resident attach failed (the steps that
   *  led to the failure). */
  trace?: ResidentStep[];
  /** The resident's own total for the attach, for the clock-skew attr. */
  attachMs?: number;
  /** The resident's attach answer (ref, sha, worktree path) on the resident
   *  path — the dispatcher names the path to the model and checks the sha
   *  against the PR head before a review runs. Unset on every other path. */
  binding?: ResidentBinding;
}

// Resident lifecycle states the bot attaches in — `isServiceable` in
// residentState.ts (shared with the resident Worker's own state union). The
// resident's contract (docs/reference/specs/resident-repos.md items 7/12) is that
// `refreshing` keeps SERVING the last snapshot — the mirror lock serializes an
// attach against a refresh's fetch/rebuild — and that `degraded` does too when
// the failure happened BEFORE the checkout was touched (fetch/bookkeeping
// reasons); a failure inside the rebuild can leave a broken dep cache, so
// those reasons stay cold. Gating on `warm` alone would send every run cold
// for the whole of every refresh window: with an active default branch (a
// dozen merges a day, each a 1–2 min rebuild every 10-min cycle) plus each
// resident deploy's restore, that is most of a working day of "resident
// refreshing — using fresh sandbox" on run after run.
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
  /** The caller's span (the dispatcher's `dispatch.workspace.attach`): the
   *  probe and the attach become its `http.client` children (tracing.md item 21). */
  span?: Span,
): Promise<ExecutorSelection> {
  // The profile's machine class decides what is provisioned
  // (docs/reference/specs/execution.md item 18). `none` → nothing: no workspace
  // dir, no sandbox created or reconnected, no credential required. The
  // general and research agents land here.
  const machine = ctx.profile.machine;
  if (machine === "none") {
    return { executor: new NullExecutor(ctx.agent.name), backend: "local" };
  }
  // `blank` → the per-thread backend with an empty workspace: no repository,
  // whatever the context carries (a blank run never resolves one), and no
  // credential (nothing says this run acts as anyone). No resident probe.
  if (machine === "blank") {
    return {
      executor: await makePerThreadExecutor(opts, { threadKey: ctx.threadKey, resolveEnvs: async () => ({}) }),
      backend: perThreadBackend(opts),
    };
  }
  // `repo-cold` → the per-thread backend with the checkout and the run's
  // credential, even when the repository has a serviceable resident: the
  // resident registry and Worker are never consulted, so an outage there can
  // neither refuse nor delay the run. Cold is the class, not a fallback, so
  // there is no note.
  if (machine === "repo-cold") {
    return { executor: await makePerThreadExecutor(opts, perThreadCheckout(ctx)), backend: perThreadBackend(opts) };
  }

  // `repo-resident`. Resident selection: only when a target repo was resolved
  // AND the resident backend is configured. A SERVICEABLE state → ResidentExecutor;
  // anything else (engine-owned state, probe timeout, outage) → the per-thread
  // backend below, with the reason carried in `note` (never a silent
  // stall). A repo that is simply not onboarded also runs per-thread, but
  // carries a note so the cold fall-through is visible (with the onboarding fix).
  let note: string | undefined;
  /** The steps of a resident attach that failed before the sandbox fallback. */
  let failedAttach: ResidentTrace | undefined;
  if (ctx.repo && opts.execution?.resident) {
    const resident = opts.execution.resident;
    const tokenEnv = resident.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN";
    const token = processSecrets.named(tokenEnv);
    if (!token) throw new Error(`execution.resident is configured but ${tokenEnv} is not set`);
    const resource = repoResourceId(ctx.repo);
    const probe = await probeResident(resident, token, resource, span);
    if (probe.kind === "status" && isServiceable(probe.state, probe.reason)) {
      // The resident can degrade between the /status probe and /attach: 503
      // (mirror-busy) or 429 (pool-exhausted) surface only at attach time.
      // ResidentNeedsRefError must still propagate (the dispatcher's ask-once
      // flow depends on it); any OTHER attach failure falls back to the
      // per-thread backend with a named note (never a silent stall or a raw
      // ⚠️ for this window).
      try {
        // Non-warm but serviceable: the note says so while the run
        // still gets the worktree it came for; openResident adds ref@sha.
        const nonWarm =
          probe.state === "warm" ? undefined : oneLine(`${probe.state}${probe.reason ? ` (${probe.reason})` : ""}`);
        // A `read` identity gets a read-only worktree — decided from the
        // run's profile, never from the prompt
        // (docs/reference/specs/resident-repos.md item 50).
        const readonly = ctx.profile.identity === "read" ? true : undefined;
        // The resolved PR head rides along so the resident fetches a mirror
        // whose ref tip lags it (item 51) instead of cloning a stale tip.
        return await openResident(
          {
            baseUrl: resident.baseUrl,
            token: token.reveal(),
            resource,
            threadKey: ctx.threadKey,
            refHint: ctx.ref,
            readonly,
            sha: ctx.headSha,
          },
          nonWarm,
          span,
        );
      } catch (err) {
        if (err instanceof ResidentNeedsRefError) throw err;
        failedAttach = residentTraceOf(err);
        note = oneLine(
          `resident attach failed (${err instanceof Error ? err.message : String(err)}) — using fresh sandbox`,
        );
      }
    } else if (probe.kind === "unreachable") {
      note = oneLine(`resident unreachable (${probe.error}) — using fresh sandbox`);
    } else if (probe.state !== "not-onboarded") {
      note = oneLine(`resident ${probe.state}${probe.reason ? ` (${probe.reason})` : ""} — using fresh sandbox`);
    } else {
      // not-onboarded is the ordinary per-thread case — but still make the cold
      // fall-through visible: the user needs to know coding ran cold in a
      // per-thread sandbox instead of on a warm, deps-ready resident, and how to
      // fix it. Routing is unchanged; only the note is added.
      note =
        `repo not onboarded as a resident — running in a cold per-thread sandbox; ` +
        `onboard it (\`repo onboard ${ctx.repo}\`) for a warm, deps-ready environment`;
    }
  }

  return {
    executor: await makePerThreadExecutor(opts, perThreadCheckout(ctx)),
    note,
    backend: perThreadBackend(opts),
    ...(failedAttach ? { trace: failedAttach.steps } : {}),
  };
}

/** Attach to a serviceable resident and name the result POSITIVELY: the note
 *  reads `resident · <owner/name> · <ref>@<sha7>` (warm) or `resident <state>
 *  (<reason>) · <owner/name> · <ref>@<sha7> — attached to the last snapshot` (refreshing/degraded)
 *  so a reader can tell the resident path from Slack alone, never only from
 *  the absence of a fallback note (named in both directions). Needs-ref (no binding for this thread, no branch named): when
 *  the resident's 409 names its default branch, bind to it ONCE here and say
 *  so in the note — the cold path already works on the default branch without
 *  asking, and a coding run branches off it anyway. A 409 without a
 *  defaultRef (an older Worker) still propagates to the dispatcher's ask-once
 *  flow; a second needs-ref after binding by default is a resident bug and
 *  becomes a plain Error — the caller's named `resident attach failed` fallback
 *  note — never a loop. */
async function openResident(
  opts: {
    baseUrl: string;
    token: string;
    resource: string;
    threadKey: string;
    refHint?: string;
    readonly?: boolean;
    sha?: string;
  },
  /** `<state>[ (<reason>)]` of a serviceable non-warm resident; undefined when warm. */
  nonWarm?: string,
  span?: Span,
): Promise<ExecutorSelection> {
  let executor = new ResidentExecutor(opts);
  let binding: ResidentBinding;
  let byDefault = false;
  try {
    binding = await executor.attach(span);
  } catch (err) {
    if (!(err instanceof ResidentNeedsRefError) || !err.defaultRef) throw err;
    byDefault = true;
    executor = new ResidentExecutor({ ...opts, refHint: err.defaultRef });
    try {
      binding = await executor.attach(span);
    } catch (again) {
      if (again instanceof ResidentNeedsRefError) {
        throw new Error(
          `resident attach: ${opts.resource} refused its own default ref "${err.defaultRef}" (${again.message})`,
          { cause: again },
        );
      }
      throw again;
    }
  }
  // The note is the binding at open time — the worktree the run STARTS on. A
  // mid-run re-attach (evicted worktree) may move to a newer sha; that later
  // state is `executor.binding`, not the card's opening line. It NAMES the
  // repo: a run that bound the wrong repo (a request about one repo landing on
  // another repo's resident) must be readable from the card, not only from a
  // sha nobody recognizes.
  const where = `${opts.resource.replace(/^repo:/, "")} · ${binding.ref}@${binding.sha.slice(0, 7)}`;
  const why = byDefault ? " (repo default — no branch named)" : "";
  return {
    executor,
    resident: true,
    backend: "resident",
    ...(binding.trace ? { trace: binding.trace } : {}),
    ...(binding.attachMs !== undefined ? { attachMs: binding.attachMs } : {}),
    binding,
    note: nonWarm
      ? `resident ${nonWarm} · ${where}${why} — attached to the last snapshot`
      : `resident · ${where}${why}`,
  };
}

/** The repo resolver's "is this slug an onboarded resident?" probe (the
 *  prose-slug guard): one operator `GET /status` per candidate,
 *  through the same negative cache as executor selection. `true` for any
 *  lifecycle state of an onboarded resource — even `down` is a real repo;
 *  `not-onboarded` (and a non-transport HTTP error) is `false`; a registry
 *  that did not ANSWER — transport failure, timeout, outage window — is
 *  `"unreachable"`, so the resolver can refuse an explicit address loudly
 *  instead of treating silence as a refusal (both are fail-closed: neither
 *  ever binds a repo). Undefined when the resident is not configured or its
 *  bearer is unset — the resolver then binds weak tokens unvetted, as in
 *  local/dev. */
export function residentOnboardedProbe(
  cfg: ResidentExecutionConfig | undefined,
  secrets: Secrets = processSecrets,
): ((slug: string) => Promise<boolean | "unreachable">) | undefined {
  const token = cfg?.baseUrl ? secrets.named(cfg.tokenEnv ?? "RESIDENT_OPERATOR_TOKEN") : undefined;
  if (!cfg?.baseUrl || !token) return undefined;
  return async (slug) => {
    const probe = await probeResident(cfg, token, repoResourceId(slug));
    if (probe.kind === "unreachable" && probe.transport) return "unreachable";
    return probe.kind === "status" && probe.state !== "not-onboarded";
  };
}

/** The repo resolver's registry listing — every onboarded `owner/name` — for
 *  resolving a bare `in <name>` address (resident-repos.md item 29). ONE
 *  `GET /residents` per call, read with the ADMIN bearer (the route is
 *  read-scoped; the operator bearer does not open it) through the same
 *  negative cache as the probes. Any failure — no bearer, an outage window, a
 *  non-2xx, a malformed body — answers undefined: a name then binds nothing,
 *  never a guess. Undefined when the resident is not configured or the admin
 *  bearer is unset (local/dev): names are ignored, slug addressing still works. */
export function residentSlugsLister(
  cfg: ResidentExecutionConfig | undefined,
  secrets: Secrets = processSecrets,
): (() => Promise<string[] | undefined>) | undefined {
  const token = cfg?.baseUrl ? secrets.named(cfg.adminTokenEnv ?? "RESIDENT_ADMIN_TOKEN") : undefined;
  if (!cfg?.baseUrl || !token) return undefined;
  return async () => {
    if (probeOutage && systemClock() < probeOutage.until) return undefined;
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/residents`, {
        headers: { authorization: `Bearer ${token.reveal()}` },
        signal: AbortSignal.timeout(cfg.probeTimeoutMs ?? 2000),
      });
    } catch (err) {
      probeOutage = {
        until: systemClock() + PROBE_OUTAGE_WINDOW_MS,
        error: err instanceof Error ? err.message : String(err),
      };
      return undefined;
    }
    if (!res.ok) return undefined;
    const data = (await res.json().catch(() => ({}))) as { residents?: unknown };
    if (!Array.isArray(data.residents)) return undefined;
    return data.residents
      .map((rec) =>
        typeof rec === "object" && rec !== null ? String((rec as { resource?: unknown }).resource ?? "") : "",
      )
      .filter((resource) => resource.startsWith("repo:"))
      .map((resource) => resource.slice("repo:".length).toLowerCase());
  };
}

/** /status probe through the negative cache: inside an outage window the
 *  cached transport failure answers without a fetch. */
async function probeResident(
  cfg: ResidentExecutionConfig,
  token: Secret,
  resource: string,
  span?: Span,
): Promise<ResidentStatusProbe> {
  if (probeOutage && systemClock() < probeOutage.until) {
    return { kind: "unreachable", error: `${probeOutage.error}; probe skipped during outage window`, transport: true };
  }
  const probe = await ResidentExecutor.probeStatus(
    cfg.baseUrl,
    token.reveal(),
    resource,
    cfg.probeTimeoutMs ?? 2000,
    span,
  );
  if (probe.kind === "unreachable" && probe.transport) {
    probeOutage = { until: systemClock() + PROBE_OUTAGE_WINDOW_MS, error: probe.error };
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

/** What a per-thread backend is built from: the thread, the checkout it
 *  clones (absent = an empty workspace) and the env each command gets. */
interface PerThreadInputs {
  threadKey: string;
  /** the repository to clone and the ref to check out; absent = an empty workspace */
  repo?: string;
  ref?: string;
  /** the sandbox env, resolved per command (docs/reference/specs/execution.md item 5) */
  resolveEnvs: () => Promise<Record<string, string>>;
}

/** The per-thread inputs of a class that carries the checkout: the resolved
 *  repo and ref, and the run's GitHub credential — the profile's identity — in the env. */
function perThreadCheckout(ctx: ExecutorContext): PerThreadInputs {
  return {
    threadKey: ctx.threadKey,
    repo: ctx.repo,
    ref: ctx.ref,
    resolveEnvs: () => githubEnvs(ctx.profile.identity),
  };
}

/** The per-thread backends (the pre-resident selection, unchanged). */
async function makePerThreadExecutor(opts: ExecutorFactoryOptions, input: PerThreadInputs): Promise<Executor> {
  const { threadKey } = input;
  const type = opts.execution?.type ?? "local";

  if (type === "local") {
    const dir = localWorkspaceDir(opts.workspaceDir, threadKey);
    mkdirSync(dir, { recursive: true });
    return new LocalExecutor(dir);
  }

  if (type === "e2b") {
    const apiKeyEnv = opts.execution?.apiKeyEnv ?? "E2B_API_KEY";
    const apiKey = processSecrets.named(apiKeyEnv);
    if (!apiKey) throw new Error(`execution.type is "e2b" but ${apiKeyEnv} is not set`);
    return E2BExecutor.open({
      apiKey: apiKey.reveal(),
      threadKey,
      timeoutMs: (opts.execution?.timeoutMinutes ?? 30) * 60_000,
      statePath: resolve(opts.dataDir, "sandboxes.json"),
      resolveEnvs: input.resolveEnvs,
      repo: input.repo,
      ref: input.ref,
    });
  }

  if (type === "cloudflare") {
    if (!opts.execution?.url) {
      throw new Error(`execution.type is "cloudflare" but execution.url is not set`);
    }
    const apiKeyEnv = opts.execution.apiKeyEnv ?? "SANDBOX_TOKEN";
    const token = processSecrets.named(apiKeyEnv);
    if (!token) throw new Error(`execution.type is "cloudflare" but ${apiKeyEnv} is not set`);
    return new CloudflareSandboxExecutor({
      url: opts.execution.url,
      token: token.reveal(),
      threadKey,
      resolveEnvs: input.resolveEnvs,
      repo: input.repo,
      ref: input.ref,
    });
  }

  throw new Error(`Unknown execution.type "${type}" (valid: local, e2b, cloudflare)`);
}

/** Executor for the `none` machine class. Provisions nothing; a tool call
 *  reaching it is a wiring bug (an agent with workspace tools on a machine-less
 *  class) and surfaces as a legible tool error, not a crash. */
class NullExecutor implements Executor {
  constructor(private agentName: string) {}

  private fail(): never {
    throw new Error(
      `Agent "${this.agentName}" runs on machine class "none", so it has no execution workspace. ` +
        `Declare a machine class that provisions one (\`repo-resident\`, \`repo-cold\` or \`blank\`) if its tools need one.`,
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

/** The scope of the GitHub credential a run holds, decided from its profile's
 *  identity — never from the prompt, never from the toolset name.
 *  Least-privilege: a `read` identity (the review agent) gets a READ-scoped
 *  token, so even though its sandbox has `gh` + the credential helper, it
 *  physically cannot post/review/push from inside — the deterministic review
 *  post is done by the bot process (githubComments.ts) with a write token, so
 *  this doesn't weaken it. A `write` identity (coding) gets the write-scoped
 *  token it needs to push and open PRs. A `none` identity mints nothing. The
 *  sandbox env (`githubEnvs`) and the `repo-cold` repository vet
 *  (`githubRepoProbe`) mint with this scope, so the vet sees what the run will. */
export function githubTokenScopeFor(identity: Identity): GithubTokenScope | undefined {
  return identity === "none" ? undefined : identity;
}

/** GitHub credential for the sandbox env: freshly-minted App installation
 *  token when a GitHub App is configured, else static GH_TOKEN, else none —
 *  and none at all for an identity that mints nothing. */
async function githubEnvs(identity: Identity): Promise<Record<string, string>> {
  const scope = githubTokenScopeFor(identity);
  if (scope === undefined) return {};
  const token = await resolveGithubToken(scope);
  return token ? { GH_TOKEN: token } : {};
}

/** The per-thread executor's backend, from the configured execution type. */
function perThreadBackend(opts: ExecutorFactoryOptions): Backend {
  const type = opts.execution?.type ?? "local";
  return type === "e2b" ? "e2b" : type === "cloudflare" ? "sandbox" : "local";
}
