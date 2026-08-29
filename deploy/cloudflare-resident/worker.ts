// Resident Worker: always-warm per-repo environments on Cloudflare Sandbox 1.0
// (@cloudflare/sandbox@next, exact-pinned; the Dockerfile FROM tag must match).
// One ResidentDO — a Sandbox subclass, i.e. a container — per onboarded
// resource, plus one singleton ResidentRegistryDO holding the onboarded set,
// the command table, and the cap.
//
// Residency is a generic resource-typed primitive (KTD1): every route contract
// carries a `resource` id of the form "<type>:<id>"; "repo" is the first (and
// currently only) supported type, with id "<owner>/<name>" (the GitHub slug —
// the clone URL derives from it). The Durable Object name IS the resource id
// ("repo:<owner>/<name>" — the SDK's sanitizeSandboxId accepts ':' and '/';
// note '/' rules the id out of hostname-based preview URLs, use tunnels).
//
// Route surface (JSON in/out; every route below requires a bearer secret):
//   admin scope     POST /onboard /offboard /reconfigure /rebuild /debug (all ops)
//   read scope      GET /residents   POST /debug ops info|schedules|threads only (admin implied)
//   operator scope  POST /attach /detach /exec /read /write /op            GET /status (state, reason, inFlight)
//   unauthenticated GET /healthz (deploy wake ping; touches no DO)
//
// Lifecycle engine: alarm-driven provisioning (clone → install/build →
// stamped snapshot → warm), wake-path rehydration (`restoring` persisted
// BEFORE restore, stamped snapshots refused on mismatch), a self-rescheduling
// refresh alarm, and a cron watchdog (re-arm dead chains + degraded
// (alarm-missed); time out stuck onboarding; auto-rebuild after N consecutive
// down passes on a rehydration-flavored reason). GitHub App tokens are minted
// repo-scoped on WebCrypto. POST /rebuild is the down→onboarding escape hatch
// (discard snapshots, reprovision from scratch); /offboard and /rebuild
// support dryRun (itemized plan, nothing executed); onboard verifies GitHub
// App installation membership when the App is configured and skips the check
// with an honest `warning` when it is not.
//
// Operator data plane: POST /attach (per-thread worktree off the bare mirror
// + sticky ref binding + dep materialization + per-attach credential file),
// POST /exec (privilege-dropped per-thread execution), POST /read and /write
// (thread-user file ops confined to the worktree), an in-DO mirror mutex
// serializing every mirror mutation, and an inactivity sweep that evicts idle
// worktrees while keeping the binding record. All four thread routes take a
// `resource` field alongside `threadKey` — the service hosts many residents,
// and the resource picks the DO exactly as GET /status does.
//
// POST /op is the deterministic modelless path (KTD8): a name from a fixed
// enum {test, build, status} resolves through the onboard-time command table
// only, gated by per-entry `effects` profiles (readonly runs, mutating
// refused by name), executed in a DISPOSABLE per-op checkout under
// /workspace/ops — never a thread's attached worktree — and deleted
// afterwards; `status` touches no checkout at all. /reconfigure accepts the
// `effects` map.
//
// SECURITY (deliberate deviations from the thread-sandbox Worker):
//   1. Bearer comparison is constant-time (timingSafeEqual below), never a
//      plain `!==`.
//   2. Two scopes: the admin token guards onboarding/config/enumeration; the
//      operator token guards per-resident operations. The admin token is a
//      strict superset (valid on operator routes); the operator token is
//      refused on admin routes. Missing/empty secrets grant nothing.
//   3. Caller-supplied `x-env-*` headers are IGNORED on every route — nothing
//      here reads them and no request header is ever forwarded into a
//      resident. The ONLY env the resident itself injects into a command is
//      GIT_TERMINAL_PROMPT=0 (validated through validateEnvNames); GitHub
//      tokens travel via a root-only one-shot credential file, never env and
//      never argv (KTD12).
//   4. The GitHub App PRIVATE KEY exists only in Worker/DO scope. The
//      container sees nothing but 1-hour installation tokens scoped to the
//      resident's own repo, injected per command. Install/build executions
//      (untrusted repo code) run unprivileged (worker1) and token-free (KTD7).
import {
  getSandbox,
  isDurableObjectCodeUpdateReset,
  OperationInterruptedError,
  RPCTransportError,
  RuntimeIdentityInactiveError,
  Sandbox,
  StaleProcessHandleError,
} from "@cloudflare/sandbox";
import type { DirectoryBackup, SandboxCommand } from "@cloudflare/sandbox";
import { createExtensionProcessSandbox } from "@cloudflare/sandbox/extensions";
import { DurableObject } from "cloudflare:workers";
import { busyAfterKillReason, planForceDetach } from "../../src/execution/residentDetach.js";

interface Env {
  RESIDENT: DurableObjectNamespace<ResidentDO>;
  REGISTRY: DurableObjectNamespace<ResidentRegistryDO>;
  BACKUP_BUCKET: R2Bucket;
  RESIDENT_ADMIN_TOKEN: string;
  RESIDENT_OPERATOR_TOKEN: string;
  /** Optional read-only bearer: GET /residents and the read-only /debug ops
   *  (info, schedules, threads) — for dashboards and humans who need to look,
   *  never to change anything. Unset = no read scope exists. */
  RESIDENT_READ_TOKEN?: string;
  // GitHub App identity for minting installation tokens inside residents
  // (provisioned via secrets.txt; when unset, clones/fetches run anonymously —
  // fine for public repos — and any explicit mint attempt is a command-level
  // error that never flips lifecycle state, per KTD12).
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hard cap on onboarded residents, enforced atomically by the registry DO.
 *  Deliberately BELOW wrangler.jsonc's containers max_instances (10) so an
 *  over-cap onboard is always refused by the registry, never by a platform
 *  scheduling failure. Bump the two together. */
const RESIDENT_CAP = 8;

/** Container sleep window, passed to every getSandbox() for ResidentDO.
 *  KTD4 invariant: REFRESH_INTERVAL_S and the watchdog cron (wrangler.jsonc,
 *  every 10 minutes) MUST both stay SHORTER than this window, so a healthy
 *  resident is re-warmed before the platform can sleep it. Bump together. */
const SLEEP_AFTER = "20m";

/** Refresh alarm cadence (seconds). Each resident DO self-reschedules this
 *  alarm (KTD4); it doubles as the keep-warm heartbeat, so it must stay below
 *  SLEEP_AFTER. Matches the watchdog cron so a killed chain is re-armed
 *  within one refresh interval. */
const REFRESH_INTERVAL_S = 600;

/** R2 lifetime of snapshot objects. We delete replaced/offboarded snapshots
 *  explicitly (see deleteBackupObjects); the TTL is a leak backstop, and it
 *  must be long — a quiet repo's current snapshot may go unreplaced for
 *  months and MUST still restore (SDK default is only 3 days). */
const SNAPSHOT_TTL_S = 365 * 24 * 60 * 60;

/** Default deadline for a resident to reach "warm" after onboarding.
 *  Containers take a few minutes to provision on first start. */
const DEFAULT_PROVISIONING_TIMEOUT_MS = 5 * 60_000;
const MIN_PROVISIONING_TIMEOUT_MS = 10_000;
const MAX_PROVISIONING_TIMEOUT_MS = 30 * 60_000;

/** Exec budgets. The DO alarm handler has a ~15-minute platform wall clock;
 *  every schedule callback's step budgets are chosen to fit under it. */
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const GIT_NETWORK_TIMEOUT_MS = 5 * 60_000;
const REFRESH_BUILD_TIMEOUT_MS = 5 * 60_000;

/** On-disk layout inside the resident container (disk is cache, never truth —
 *  KTD3). U4's worktrees hang off the same mirror; keep these paths stable. */
const MIRROR_DIR = "/workspace/mirror"; // bare mirror, owned by root
const CHECKOUT_DIR = "/workspace/checkout"; // default-branch working tree + deps + build, owned by BUILD_USER
const RESIDENT_STATE_DIR = "/workspace/.resident"; // mode 700 root:root — worker users cannot traverse
const CRED_FILE = `${RESIDENT_STATE_DIR}/git-credentials`; // one-shot token file (KTD12), deleted after each git command
const READY_MARKER = `${RESIDENT_STATE_DIR}/ready`; // holds the sha the disk was hydrated to

/** Unprivileged user for default-branch install/build (KTD5: repo code never
 *  runs as root). worker2..worker17 stay free for U4's per-thread users. */
const BUILD_USER = "worker1";

/** Per-thread worktrees (U4) hang here: one 700 thread dir per threadKey
 *  (owned by that thread's OS user — other thread users cannot even
 *  traverse), one worktree per bound ref beneath it. Disk is cache: a slept
 *  container loses these, and the next attach recreates them. */
const THREADS_DIR = "/workspace/threads";

/** Disposable per-op checkouts (U6, KTD8) hang here: one 700 uuid dir per
 *  in-flight op, owned by a transiently-held pool user, DELETED when the op
 *  completes (success or failure). Ops never touch a thread's attached
 *  worktree. An orphan from a mid-op DO restart dies with the container disk
 *  at the latest (disk is cache). */
const OPS_DIR = "/workspace/ops";

/** The thread-user pool (KTD5). worker1 is the engine's build user; each
 *  attach allocates one of these to the thread (persisted in the binding)
 *  and every /exec /read /write for that thread runs privilege-dropped as
 *  that user. The pool is released by the inactivity sweep. */
/** Pool of OS users for thread worktrees (worker1 is the build user). Sized
 *  for SIMULTANEOUS runs, not for every thread ever seen: a run returns its
 *  user via /detach when it ends, so the pool only fills when 16 runs on one
 *  repo are genuinely concurrent. Memory, not this list, is the real ceiling
 *  — see the instance_type note in wrangler.jsonc. Must match the useradd loop
 *  in the Dockerfile. */
const THREAD_USERS = Array.from({ length: 16 }, (_, i) => `worker${i + 2}`);

/** Force-detach (#159): after killing the thread user's processes, how long
 *  to wait for the in-flight op counter to drain (polled every
 *  FORCE_DETACH_DRAIN_POLL_MS). The bot bounds the whole `/detach` at 10 s
 *  (`DETACH_TIMEOUT_MS` in src/execution/resident.ts): the kill is a syscall
 *  (milliseconds — its 2 s bound only matters if `run()` itself wedges, and
 *  then the drain cannot succeed either), so kill + drain leaves ~2 s for the
 *  eviction's rm. The worst case can still overshoot the bot's bound, and that
 *  is tolerated: the bot only logs `[release] … failed`, while this DO method
 *  runs to completion regardless (a dropped fetch does not cancel it), so the
 *  user is freed either way. */
const FORCE_DETACH_DRAIN_MS = 6_000;
const FORCE_DETACH_DRAIN_POLL_MS = 250;
const FORCE_DETACH_KILL_TIMEOUT_MS = 2_000;

/** Inactivity eviction: worktrees whose binding lastAttachAt is older than
 *  this many days are removed and their user returned to the pool; the
 *  binding record is KEPT (KTD6) so the next attach recreates with the same
 *  ref. Overridable per resident via the onboard-time `worktreeTtlDays`. */
const WORKTREE_TTL_DAYS_DEFAULT = 7;
/** The sweep self-reschedules hourly (armed by attach when no sweep pends). */
const SWEEP_INTERVAL_S = 60 * 60; // hourly: the sweep is the backstop for trees a run kept (dirty) or never released
/** A live binding whose last attach is older than this AND whose tree is clean
 *  (no uncommitted/unpushed work) is released by the hourly sweep — runs that
 *  ended before /detach existed, or whose release call was lost. Dirty trees
 *  keep to the TTL. */
const CLEAN_IDLE_RELEASE_S = 60 * 60;
/** Slack over SWEEP_INTERVAL_S before a pending sweep row counts as config
 *  drift (armed by older code with a longer interval). A healthy row is due at
 *  most SWEEP_INTERVAL_S out and only gets closer, so this never trips on one. */
const SWEEP_DRIFT_SLACK_S = 5 * 60;
/** Idle sleep: when no thread has attached within this window and no live
 *  tree is dirty, the refresh alarm skips the fetch and re-arms far out so
 *  the container can actually sleep (SLEEP_AFTER); the next attach refreshes
 *  first if the mirror is stale (refresh-on-attach). */
const IDLE_AFTER_S = 60 * 60;
const IDLE_REFRESH_INTERVAL_S = 6 * 60 * 60;
/** A `refreshing`/`restoring` marker older than this with nothing running is
 *  an orphan from an interrupted cycle; the watchdog normalizes it. Comfortably
 *  above the longest legitimate cycle (REFRESH_BUILD_TIMEOUT_MS-scale installs). */
const STALE_MIDFLIGHT_MS = 30 * 60_000;
/** A resident degraded with the SAME reason for this many consecutive cycles
 *  is chronically broken (e.g. the default branch's build fails); retrying
 *  every 10 min bills the container 24/7 for nothing. After the streak it may
 *  idle-park like a warm one; the next attach still refreshes first. */
const DEGRADED_PARK_AFTER_CYCLES = 3;
const DEGRADED_STREAK_KEY = "resident:degradedStreak";

/** Attach waits on the mirror mutex under this named timeout; expiry answers
 *  503 {state, reason: "mirror-busy"} instead of queueing forever. */
const ATTACH_MUTEX_WAIT_MS = 60_000;

/** Watchdog auto-rebuild (U8): a resident down with a REHYDRATION-flavored
 *  reason (bad/unreadable snapshots — states only a rebuild can escape, since
 *  down chains never retry hydration) accumulates one strike per watchdog
 *  pass; at N strikes the watchdog triggers the same down→onboarding rebuild
 *  an admin would, discarding the unusable snapshots and reprovisioning from
 *  GitHub. Provision-failure downs never auto-rebuild — they would loop
 *  against the same broken build. With the 10-minute cron, N=3 ≈ 30 minutes
 *  down before the automatic escape hatch fires. */
const AUTO_REBUILD_AFTER_STRIKES = 3;
const REHYDRATION_FAILURE_RE = /^(r2-restore-failed|snapshot-stamp-mismatch|no-snapshot)/;

/** /exec budget (5-minute default per the U4 contract; also the ceiling —
 *  longer work belongs in background jobs, and the streamed heartbeat only
 *  protects the HTTP hop, not the DO wall clock). */
const DEFAULT_THREAD_EXEC_TIMEOUT_MS = 5 * 60_000;
const MAX_THREAD_EXEC_TIMEOUT_MS = 5 * 60_000;
const MAX_EXEC_COMMAND_LENGTH = 8_000;
/** Output caps, per stream; truncation is annotated in stderr like the
 *  thread-sandbox Worker annotates its timeout note. */
const EXEC_OUTPUT_CAP = 100_000;
const READ_CONTENT_CAP = 262_144;
const MAX_WRITE_CONTENT = 524_288;

/** Dep/build cache dirs materialized from the warm checkout into a fresh
 *  worktree when the committed-lockfile key matches (KTD7). */
const DEP_CACHE_DIRS = ["node_modules", "dist", "build", "out", ".next"] as const;

/** Files whose COMMITTED content keys the dependency/build cache (KTD7).
 *  The key hashes `git ls-tree <sha> -- <these>` output from the mirror —
 *  never the working directory, because installs GENERATE lockfiles (npm
 *  writes an uncommitted package-lock.json), which would poison a disk-based
 *  key (this broke the first live wake: stamp e3b0c… vs restored 13e42f…).
 *  A repo committing none of these hashes to the sha256-of-empty constant,
 *  which is a fine (deterministic) key. */
const LOCKFILE_CANDIDATES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "go.sum",
  "Cargo.lock",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "Gemfile.lock",
  "composer.lock",
];

/** Env var names a resident injects must match this before interpolation —
 *  the other half of the x-env hardening above. ALL env injection (today:
 *  only GIT_TERMINAL_PROMPT in gitWithCred) routes through validateEnvNames(). */
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
export function validateEnvNames(vars: Record<string, string>): void {
  for (const name of Object.keys(vars)) {
    if (!ENV_NAME_RE.test(name)) {
      throw new Error(`invalid env var name ${JSON.stringify(name)}: must match ${ENV_NAME_RE}`);
    }
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The resident runtime (the Sandbox SDK's control session to the container)
 *  was replaced while a command was in flight — in practice a `wrangler deploy`
 *  swapping this DO's isolate mid-run (2026-08-29: three deploys aborted a
 *  review run as a fake "OOM"). `phase` says where the SDK failed: `"spawn"`
 *  (the start RPC itself; the SDK never proves the process did NOT start) or
 *  `"collect"` (a `StaleProcessHandleError` on an already-running process). In
 *  both cases the command may have run, so the resident never re-issues it;
 *  the thread routes answer the NAMED `runtime-replaced` error and the client
 *  decides (idempotent read/write retry; exec is handed to the model). */
class RuntimeReplacedError extends Error {
  constructor(
    readonly phase: "spawn" | "collect",
    readonly cause: unknown,
  ) {
    super(
      `runtime-replaced: the resident runtime was replaced (a deploy) while this command was ${
        phase === "spawn" ? "starting" : "running"
      }; its output is lost (${errMsg(cause)})`,
    );
    this.name = "RuntimeReplacedError";
  }
}

/** Every wording the pinned SDK (@cloudflare/sandbox@0.13.0-next.751.1) uses
 *  when the runtime incarnation changed under a call, for the message-based
 *  fallback below. Two of these come from classes the SDK does NOT export
 *  (`SandboxLifetimeChangedError`) or throws raw before its adapter translates
 *  them (`RuntimeIdentityInactiveError` at ~10 process/exec sites), so a typed
 *  check alone would miss them. */
const RUNTIME_REPLACEMENT_WORDING =
  /previous runtime incarnation|interrupted because the runtime changed|runtime identity is no longer active|sandbox lifetime is no longer current|platform was updating the sandbox runtime|no longer identifies pid/i;

/** `err` and its `cause` chain, bounded like the SDK's own `selfAndCauses`
 *  walker: the SDK wraps platform errors, so the telling message can sit one or
 *  two links down. */
function* selfAndCauses(err: unknown): Generator<unknown> {
  let current = err;
  for (let depth = 0; depth < 8 && current != null; depth++) {
    yield current;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
}

/** `OperationInterruptedError` reasons that mean the runtime under the call is
 *  gone and a new one serves the thread: a deploy swapped the isolate
 *  (`runtime_replaced`), the sandbox's lifetime epoch moved
 *  (`sandbox_lifetime_changed`), or the container itself stopped/restarted
 *  under the command (`container_stopped`). Deliberately NOT `transport_disposed`
 *  / `sandbox_destroyed` / `recovery_exhausted` — those are not "try the new
 *  runtime", they are real failures the ordinary error path should report — and
 *  NOT `unknown`, the union's catch-all: with no evidence of a replacement the
 *  classifier stays conservative and lets the ordinary path report it. Note the
 *  SDK's process control-plane wrapper (`processCapabilityLifecycle`) collapses
 *  ANY interruption it sees into a `StaleProcessHandleError`, so on that path
 *  the first `instanceof` below fires before this reason set is consulted; the
 *  set matters for the routes that reach the SDK without that wrapper. */
const RUNTIME_REPLACED_REASONS = new Set(["runtime_replaced", "sandbox_lifetime_changed", "container_stopped"]);

/** `RPCTransportError` kinds that mean the capnweb session to the container
 *  died under a live call. The SDK raises these RAW (not as an interruption)
 *  while collecting a process's output — `FencedSubscriptionTarget.next()`
 *  translates with `translateTransportErrorsAsInterruptions: false` — which is
 *  exactly how a container stop/restart mid-command surfaces: the socket dies
 *  before the container can send a structured error. Treating them as a
 *  replacement is safe even for a mere network blip: the consequence is the same
 *  legible outcome (re-attach once to prove the runtime serves the thread; the
 *  command is never re-run; the model re-checks effects). Excluded:
 *  `invalid_frame` / `protocol_error` (wire-format bugs, not a lost runtime) and
 *  `unknown` (no evidence). */
const RPC_TRANSPORT_LOSS_KINDS = new Set(["peer_closed", "connection_failed", "upgrade_failed", "session_disposed"]);

/** Does this SDK error mean the runtime incarnation changed under us? Typed
 *  checks first (`StaleProcessHandleError`, `RuntimeIdentityInactiveError`, an
 *  `OperationInterruptedError` with one of `RUNTIME_REPLACED_REASONS`, an
 *  `RPCTransportError` with one of `RPC_TRANSPORT_LOSS_KINDS`, the platform's
 *  superseded-isolate reset), then the SDK's message wording — on the error AND
 *  its cause chain — as a belt-and-braces fallback. Anything else (a real spawn
 *  failure, a timeout, a wire-format error) is NOT a runtime replacement. */
function isRuntimeReplacement(err: unknown): boolean {
  if (err instanceof StaleProcessHandleError) return true;
  if (err instanceof RuntimeIdentityInactiveError) return true;
  if (err instanceof OperationInterruptedError && RUNTIME_REPLACED_REASONS.has(err.reason)) return true;
  if (err instanceof RPCTransportError && RPC_TRANSPORT_LOSS_KINDS.has(err.kind)) return true;
  if (isDurableObjectCodeUpdateReset(err)) return true;
  for (const link of selfAndCauses(err)) if (RUNTIME_REPLACEMENT_WORDING.test(errMsg(link))) return true;
  return false;
}

/** The named ThreadErr every thread route (exec/read/write) answers for a
 *  runtime replacement, so the client can classify it (409 like the other
 *  recoverable thread states; `reason` is the discriminator). */
function runtimeReplacedErr(err: RuntimeReplacedError): ThreadErr {
  return { error: err.message, status: 409, reason: "runtime-replaced" };
}
/** Trailing slice of command output for error reasons — enough to diagnose,
 *  small enough to live in a lifecycle `reason`. */
const tail = (s: string, n = 400): string => s.trim().slice(-n);

// ---------------------------------------------------------------------------
// GitHub App auth (KTD12) — Worker/DO scope only; the private key never
// enters the container. RS256 App JWT on WebCrypto (node:crypto is not
// available here), then POST /app/installations/:id/access_tokens with
// `repositories: [<own repo name>]` so a minted token never grants more than
// the resident's one repo. Cache per slug until 5 minutes before expiry.
// ---------------------------------------------------------------------------

export function githubAppConfigured(env: Env): boolean {
  return Boolean(env.GITHUB_APP_ID && env.GITHUB_APP_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY);
}

interface MintedToken {
  token: string;
  expiresAtMs: number;
}
const githubTokenCache = new Map<string, MintedToken>(); // key: repo slug ("owner/name")

/** Mint a 1-hour installation token scoped to exactly `slug`'s repository.
 *  Throws a command-level Error on any failure — callers MUST NOT translate
 *  that into a lifecycle transition (KTD12). */
export async function mintRepoScopedToken(env: Env, slug: string): Promise<string> {
  if (!githubAppConfigured(env)) {
    throw new Error(
      "github-app-not-configured: GITHUB_APP_ID / GITHUB_APP_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY secrets are unset; cannot mint an installation token",
    );
  }
  const cached = githubTokenCache.get(slug);
  if (cached && Date.now() < cached.expiresAtMs - 5 * 60_000) return cached.token;

  const jwt = await githubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  // The installation-token API scopes by repo NAME within the installation's
  // owner — the owner half of the slug is fixed by the installation itself.
  const repoName = slug.includes("/") ? slug.slice(slug.indexOf("/") + 1) : slug;
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "switchboard-resident",
      },
      body: JSON.stringify({ repositories: [repoName] }),
      // A slow GitHub must not hang attach/refresh. The 10s abort surfaces as a
      // command-level Error (below), never a lifecycle transition (KTD12).
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    // AbortSignal.timeout aborts with a "TimeoutError" DOMException; any other
    // fetch throw (network/DNS) lands here too. Both are command-level per KTD12.
    const aborted = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new Error(`github-token-mint-failed: ${aborted ? "timed out after 10s contacting api.github.com" : errMsg(err)}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`github-token-mint-failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  githubTokenCache.set(slug, { token: data.token, expiresAtMs: Date.parse(data.expires_at) });
  return data.token;
}

/** Short-lived RS256 JWT proving we are the app (max 10 min per GitHub docs).
 *  iat is backdated 60s to absorb clock drift. */
async function githubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = strToB64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = strToB64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const key = await importGithubAppKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${bytesToB64url(new Uint8Array(signature))}`;
}

let cachedAppKey: CryptoKey | null = null;
let cachedAppKeyPem = "";
/** Import the App private key. GitHub serves PKCS#1 ("BEGIN RSA PRIVATE KEY")
 *  PEMs; WebCrypto only imports PKCS#8, so PKCS#1 bodies are wrapped in a
 *  PrivateKeyInfo envelope first. Literal "\n" sequences are unescaped (the
 *  usual single-line secret encoding). */
async function importGithubAppKey(pemRaw: string): Promise<CryptoKey> {
  if (cachedAppKey && cachedAppKeyPem === pemRaw) return cachedAppKey;
  const pem = pemRaw.replace(/\\n/g, "\n");
  const der = pemToDer(pem);
  const pkcs8 = /BEGIN RSA PRIVATE KEY/.test(pem) ? pkcs1ToPkcs8(der) : der;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8 as unknown as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedAppKey = key;
  cachedAppKeyPem = pemRaw;
  return key;
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END)[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** DER definite-length encoding. */
function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/** Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo:
 *  SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING pkcs1 } */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = [0x02, 0x01, 0x00];
  const algId = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const octetHeader = [0x04, ...derLength(pkcs1.length)];
  const innerLength = version.length + algId.length + octetHeader.length + pkcs1.length;
  const header = [0x30, ...derLength(innerLength), ...version, ...algId, ...octetHeader];
  const out = new Uint8Array(header.length + pkcs1.length);
  out.set(header);
  out.set(pkcs1, header.length);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const strToB64url = (s: string): string => bytesToB64url(new TextEncoder().encode(s));

// ---------------------------------------------------------------------------
// Lifecycle model (persisted in each ResidentDO)
// ---------------------------------------------------------------------------

type ResidentState = "onboarding" | "warm" | "refreshing" | "restoring" | "degraded" | "down";
interface ResidentStatus {
  state: ResidentState;
  reason: string; // non-empty whenever state is degraded or down
}

/** Registry record: the onboarded set + command table (KTD9: writable only via
 *  the admin routes onboard/reconfigure). */
interface ResidentRecord {
  resource: string;
  /** Command table. Always contains "test" and "build"; extra named commands
   *  are allowed ("install" is honored by the provisioning/refresh engine).
   *  Commands execute inside the resident as BUILD_USER — never on the
   *  Worker, never as root, never with a GitHub token in env (KTD5/KTD7). */
  commands: Record<string, string>;
  /** Execution profile per command-table entry (U6, KTD8): the modelless /op
   *  path executes "readonly" entries and refuses "mutating" ones BY NAME.
   *  An absent entry means readonly — test/build/status are readonly by
   *  construction; the refusal is the guard rail for future mutating entries.
   *  Admin-writable only, like `commands` (set via /reconfigure; replaced
   *  whole, never merged). */
  effects?: Record<string, "readonly" | "mutating">;
  defaultRef: string;
  diskBudgetMb?: number;
  provisioningTimeoutMs: number;
  /** Inactivity window (days) before the sweep evicts a thread's worktree
   *  and releases its user; the binding record survives (KTD6). */
  worktreeTtlDays?: number;
  onboardedAt: string;
  updatedAt: string;
}

/** Per-thread binding (KTD6): persisted in the resident DO keyed by
 *  threadKey; survives restarts and eviction. `user`/`evicted` describe the
 *  current allocation; `ref` is sticky for the thread's whole life. */
interface ThreadBinding {
  threadKey: string;
  ref: string;
  /** Allocated OS user (worker2..worker17); "" once evicted (pool released). */
  user: string;
  worktreePath: string;
  boundAt: string;
  lastAttachAt: string;
  evicted?: boolean;
  evictedAt?: string;
  /** How deps were last materialized (evidence for KTD7). */
  deps?: ThreadDepsMechanism;
  /** Commit the worktree was last attached at (the ref's tip in the mirror
   *  at that moment). Display only — the tree itself is authoritative. */
  sha?: string;
}

type ThreadDepsMechanism = "hardlink" | "copy" | "install" | "none";

/** Named, RPC-cloneable error shape for the thread data plane. The Worker
 *  maps `status` to the HTTP status; extra fields (`needs`, `state`,
 *  `reason`) ride along into the body. */
interface ThreadErr {
  error: string;
  status: number;
  needs?: string;
  state?: ResidentState;
  reason?: string;
}

interface AttachOk {
  workspace: string;
  ref: string;
  sha: string;
  user: string;
  /** True only when a scoped install had to run (lockfile key differed). */
  reconciled: boolean;
  /** True when a dirty/stale/missing worktree was wiped and recreated. */
  recreated: boolean;
  deps: ThreadDepsMechanism;
  credentials: "ok" | "unavailable";
  credentialsError?: string;
  mutexWaitMs: number;
  attachMs: number;
}

/** Result of one /op test/build execution (U6, KTD8). `ok` is the command's
 *  verdict — a failing test run is a RESULT with ok:false, never an error. */
interface OpRunOk {
  ok: boolean;
  op: string;
  resource: string;
  ref: string;
  sha: string;
  summary: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  /** dep materialization evidence (KTD7) — shared with the attach mechanism */
  deps: ThreadDepsMechanism;
  reconciled: boolean;
  durationMs: number;
}

/** DO-recorded repo facts — the truth the disk is rehydrated against (KTD3). */
interface RepoFacts {
  defaultRef: string; // resolved default branch (configured ref if it exists, else the mirror's HEAD)
  sha: string; // last-fetched default-branch commit
  lockfileHash: string; // dependency/build cache key (KTD7)
  provisionedAt: string;
  lastRefreshAt: string;
  lastRefreshError?: string; // command-level failures (e.g. token mint) that did NOT flip lifecycle
  lastRestore?: { at: string; ms: number }; // proof of restore-not-reclone on the wake path
  /** Set while the resident is in idle mode (refresh alarm parked far out so the container may sleep). */
  idleSince?: string;
}

/** Stamped snapshot record (KTD3/KTD7): handles into R2 plus the {ref, sha,
 *  lockfileHash} stamp. Snapshots are written ONLY by onboarding provisioning
 *  and default-branch refresh; restore refuses a mismatched stamp. */
interface SnapshotRecord {
  ref: string;
  sha: string;
  lockfileHash: string;
  createdAt: string;
  mirror: DirectoryBackup; // SDK handle; objects live under backups/<id>/ in BACKUP_BUCKET
  checkout: DirectoryBackup;
}

// ---------------------------------------------------------------------------
// Registry DO (singleton): onboarded set + config, atomic cap enforcement
// ---------------------------------------------------------------------------

const REGISTRY_KEY_PREFIX = "resident:";
const registryKey = (resource: string) => `${REGISTRY_KEY_PREFIX}${resource}`;

type OnboardResult = { ok: true; record: ResidentRecord } | { ok: false; status: number; error: string };

export class ResidentRegistryDO extends DurableObject<Env> {
  /** Atomic cap check + insert. Durable Objects deliver events through input
   *  gates: while a storage operation is in flight no other event is delivered
   *  to this object, and nothing below awaits anything except this object's
   *  own storage — so the exists-check, the count, and the insert cannot
   *  interleave with a concurrent onboard. */
  async onboard(record: ResidentRecord): Promise<OnboardResult> {
    const key = registryKey(record.resource);
    if (await this.ctx.storage.get(key)) {
      return { ok: false, status: 409, error: `${record.resource} is already onboarded` };
    }
    const existing = await this.ctx.storage.list({ prefix: REGISTRY_KEY_PREFIX });
    if (existing.size >= RESIDENT_CAP) {
      return {
        ok: false,
        status: 429,
        error: `resident cap reached (${existing.size}/${RESIDENT_CAP}); offboard a resident first`,
      };
    }
    await this.ctx.storage.put(key, record);
    return { ok: true, record };
  }

  async getRecord(resource: string): Promise<ResidentRecord | null> {
    return (await this.ctx.storage.get<ResidentRecord>(registryKey(resource))) ?? null;
  }

  async list(): Promise<ResidentRecord[]> {
    const all = await this.ctx.storage.list<ResidentRecord>({ prefix: REGISTRY_KEY_PREFIX });
    return [...all.values()].sort((a, b) => a.resource.localeCompare(b.resource));
  }

  /** Admin-only by construction: reachable exclusively through /reconfigure.
   *  `commands`, when present, REPLACES the whole command table. */
  async updateConfig(
    resource: string,
    patch: Partial<Pick<ResidentRecord, "commands" | "effects" | "defaultRef" | "diskBudgetMb" | "provisioningTimeoutMs" | "worktreeTtlDays">>,
  ): Promise<ResidentRecord | null> {
    const key = registryKey(resource);
    const record = await this.ctx.storage.get<ResidentRecord>(key);
    if (!record) return null;
    const updated: ResidentRecord = { ...record, updatedAt: new Date().toISOString() };
    if (patch.commands !== undefined) updated.commands = patch.commands;
    if (patch.effects !== undefined) updated.effects = patch.effects;
    if (patch.defaultRef !== undefined) updated.defaultRef = patch.defaultRef;
    if (patch.diskBudgetMb !== undefined) updated.diskBudgetMb = patch.diskBudgetMb;
    if (patch.provisioningTimeoutMs !== undefined) updated.provisioningTimeoutMs = patch.provisioningTimeoutMs;
    if (patch.worktreeTtlDays !== undefined) updated.worktreeTtlDays = patch.worktreeTtlDays;
    await this.ctx.storage.put(key, updated);
    return updated;
  }

  async remove(resource: string): Promise<boolean> {
    return this.ctx.storage.delete(registryKey(resource));
  }
}

// ---------------------------------------------------------------------------
// Resident DO: one per resource; Sandbox subclass = one container per resource
// ---------------------------------------------------------------------------

const PROVISIONING_CALLBACK = "onProvisioningDeadline"; // fail-closed deadline
const PROVISION_RUN_CALLBACK = "runProvisioning"; // the actual provisioning work
const REFRESH_CALLBACK = "onRefreshAlarm"; // self-rescheduling freshness chain
const SWEEP_CALLBACK = "onWorktreeSweep"; // hourly worktree inactivity eviction (U4)

const STATE_KEY = "resident:state";
const REASON_KEY = "resident:reason";
const RESOURCE_KEY = "resident:resource";
const UPDATED_KEY = "resident:updatedAt";
const FACTS_KEY = "resident:facts";
const SNAPSHOT_KEY = "resident:snapshot";
const DEADLINE_AT_KEY = "resident:provisionDeadlineAt";
const REBUILD_STRIKES_KEY = "resident:rebuildStrikes"; // watchdog auto-rebuild counter (U8)

/** Thread bindings live under their own prefix, keyed by threadKey (KTD6). */
const THREAD_KEY_PREFIX = "thread:";
const threadBindingKey = (threadKey: string) => `${THREAD_KEY_PREFIX}${threadKey}`;

const parentDir = (p: string): string => p.slice(0, p.lastIndexOf("/"));

/** Deterministic per-thread+ref worktree path. Slugs replace anything outside
 *  [A-Za-z0-9._-]; a threadKey-derived hash suffix keeps two keys that slug
 *  identically (e.g. "a:b" vs "a-b") from colliding on disk. */
async function threadWorktreePath(threadKey: string, ref: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(threadKey));
  const hash8 = [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const slug = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 60);
  return `${THREADS_DIR}/${slug(threadKey)}-${hash8}/${slug(ref)}`;
}

/** Path confinement for /read and /write: conservative charset, no `..`
 *  segments, and the resolved absolute path must stay under the worktree
 *  root. Symlink tricks past this point are bounded by the OS layer — the
 *  file op itself runs as the thread's unprivileged user. */
export function confineThreadPath(root: string, path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) return null;
  const joined = path.startsWith("/") ? path : `${root}/${path}`;
  const segments = joined.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return null;
  const resolved = `/${segments.join("/")}`;
  return resolved.startsWith(`${root}/`) ? resolved : null;
}

/** Named mirror-mutex timeout — attach maps this to 503 {reason:"mirror-busy"}. */
class MirrorBusyError extends Error {}

/** Named failure of one engine step; becomes "<step>-flavored" reasons. */
class StepError extends Error {
  constructor(
    public step: string,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown after the resident has ALREADY been transitioned to `down` (reason
 *  persisted); signals callers to stop the refresh chain without re-flipping. */
class ResidentDownError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

export class ResidentDO extends Sandbox<Env> {
  // TIMER RULE: never call ctx.storage.setAlarm/deleteAlarm from lifecycle
  // code — the Container base class owns the DO alarm slot (its sleepAfter
  // machinery and schedule multiplexing live there). All resident timers go
  // through this.schedule()/this.deleteSchedules(), which multiplex onto that
  // alarm safely. (Checked against @cloudflare/containers 0.3.7: the SDK
  // registers no schedule callback names, so ours cannot collide.)

  /** Serializes concurrent hydration attempts within one DO lifetime. Never
   *  used as a "hydrated" flag — the container can sleep while the DO object
   *  survives, so hydration state is always probed from disk. */
  private hydration: Promise<void> | null = null;

  /** Mirror mutex (KTD5): a DO yields at every await, so two in-flight
   *  requests CAN interleave mid-handler — every mirror mutation (fetch,
   *  worktree add/remove) runs under this explicit promise-chain lock. The
   *  chain lives in DO memory only; that is sufficient because all mirror
   *  work happens through this one DO instance, and a DO restart also drops
   *  any in-flight work the lock was guarding. */
  private mirrorLockTail: Promise<void> = Promise.resolve();

  /** Run `fn` holding the mirror mutex. With waitTimeoutMs > 0, gives up
   *  waiting after that long (throws MirrorBusyError) — the queued slot is
   *  released so later waiters are not stuck behind a ghost. */
  private async withMirrorLock<T>(fn: () => Promise<T>, waitTimeoutMs = 0): Promise<{ value: T; waitedMs: number }> {
    const prev = this.mirrorLockTail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => (release = resolve));
    // Chain synchronously (no await between read and write) so queue order is
    // exactly arrival order within the DO's single-threaded event loop.
    this.mirrorLockTail = prev.then(
      () => slot,
      () => slot,
    );
    const started = Date.now();
    if (waitTimeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        prev.then(
          () => false,
          () => false,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), waitTimeoutMs);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) {
        release(); // our slot becomes a no-op; the queue keeps moving
        throw new MirrorBusyError(`mirror-busy: mutex not acquired within ${waitTimeoutMs}ms`);
      }
    } else {
      await prev.catch(() => {});
    }
    const waitedMs = Date.now() - started;
    try {
      return { value: await fn(), waitedMs };
    } finally {
      release();
    }
  }

  private registry() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName("registry"));
  }

  // -- exec plumbing ---------------------------------------------------------

  /** Server-side exec-and-collect. Inside the DO, Sandbox.exec() returns a raw
   *  RPC descriptor; createExtensionProcessSandbox wraps it back into the
   *  waitable SandboxProcess surface (output/waitForExit). */
  private async run(
    argv: readonly string[],
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    const timeout = opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    const launch = {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      timeout,
    };
    // Two phases, because a runtime replacement (a deploy mid-command) means
    // different things in each. Spawn: the start RPC failed. The SDK marks the
    // interruption `retryable` only when it vouches the process never started
    // (e.g. the container was still starting) — then, and only then, one retry
    // on a fresh process sandbox is safe. Collect: the process handle is stale,
    // so the command DID start and its output is gone — never re-run it. Both
    // unsafe cases surface as RuntimeReplacedError for the routes to name.
    let proc: Awaited<ReturnType<ReturnType<typeof createExtensionProcessSandbox>["exec"]>>;
    try {
      proc = await createExtensionProcessSandbox(this).exec(argv as unknown as SandboxCommand, launch);
    } catch (err) {
      if (!isRuntimeReplacement(err)) throw err;
      // Forward-looking gate, structurally unreachable today: in the pinned SDK
      // (@cloudflare/sandbox@0.13.0-next.751.1) every `reason:"runtime_replaced"`
      // site hardcodes `retryable:false`, so a replacement currently always
      // takes the throw below. It exists so that if a future SDK vouches "never
      // started" we retry then — and only then — without a change here.
      if (!(err instanceof OperationInterruptedError && err.retryable === true)) throw new RuntimeReplacedError("spawn", err);
      console.log(`exec: runtime replaced before the process started (SDK says retryable) — retrying once: ${errMsg(err)}`);
      proc = await createExtensionProcessSandbox(this).exec(argv as unknown as SandboxCommand, launch);
    }
    try {
      const out = await proc.output({ encoding: "utf8", timeout: timeout + 30_000 });
      return { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode, timedOut: out.timedOut };
    } catch (err) {
      if (isRuntimeReplacement(err)) throw new RuntimeReplacedError("collect", err);
      throw err;
    }
  }

  /** Shared success gate for run/threadRun results: a non-zero exit or a
   *  timeout becomes the step's named StepError; success hands back stdout. */
  private assertOk(
    r: { stdout: string; stderr: string; exitCode: number; timedOut: boolean },
    step: string,
  ): string {
    if (r.exitCode !== 0 || r.timedOut) {
      throw new StepError(step, `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}: ${tail(r.stderr || r.stdout)}`);
    }
    return r.stdout;
  }

  private async runOk(
    argv: readonly string[],
    step: string,
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<string> {
    return this.assertOk(await this.run(argv, opts), step);
  }

  /** Run one command-table entry as the unprivileged build user in the warm
   *  checkout. KTD5: never root. KTD7/KTD12: never a GitHub token — the env
   *  is whatever `su` grants the target user, nothing injected. */
  private async buildUserRun(command: string, step: string, timeoutMs: number): Promise<string> {
    return this.runOk(["su", "-s", "/bin/bash", BUILD_USER, "-c", `cd ${CHECKOUT_DIR} && ${command}`], step, {
      timeoutMs,
    });
  }

  /** Run a git command with an optional repo-scoped token, injected via a
   *  one-shot credential file under the root-only state dir — never
   *  process-wide env, never argv (which every user could read from the
   *  shared process list), per KTD12. The leading `credential.helper=`
   *  clears inherited helpers (the image configures gh's). */
  private async gitWithCred(token: string | null, gitArgs: readonly string[], step: string, timeoutMs: number): Promise<string> {
    const injected = { GIT_TERMINAL_PROMPT: "0" }; // fail fast instead of prompting
    validateEnvNames(injected);
    if (!token) {
      return this.runOk(["git", "-c", "credential.helper=", ...gitArgs], step, { timeoutMs, env: injected });
    }
    await this.writeFile(CRED_FILE, `https://x-access-token:${token}@github.com\n`);
    try {
      return await this.runOk(
        ["git", "-c", "credential.helper=", "-c", `credential.helper=store --file=${CRED_FILE}`, ...gitArgs],
        step,
        { timeoutMs, env: injected },
      );
    } finally {
      try {
        await this.deleteFile(CRED_FILE);
      } catch {
        // one-shot file inside the 700 root-only dir; deletion is best-effort
      }
    }
  }

  // -- repo helpers ----------------------------------------------------------

  /** Idempotent container-local setup that must survive every fresh disk:
   *  the root-only state dir, and a scoped safe.directory entry so worker
   *  users can fetch from the root-owned mirror without git's
   *  dubious-ownership refusal (scoped to the mirror — NOT '*'). */
  private async ensureGitSetup(): Promise<void> {
    await this.runOk(["install", "-d", "-m", "700", "-o", "root", "-g", "root", RESIDENT_STATE_DIR], "state-dir");
    await this.runOk(["git", "config", "--system", "safe.directory", MIRROR_DIR], "git-config");
    // U4 isolation: thread users must not read the mirror directly (its
    // config/refs are engine plumbing; repo content reaches threads only
    // through their own worktrees). worker1 still needs read access — the
    // warm checkout fetches from the mirror during refresh — so the mirror
    // top dir is root:worker1 750, denying worker2..worker17 at traversal.
    // Conditional: the dir does not exist before provisioning's clone
    // creates it (runProvisioning re-runs this right after the clone).
    await this.runOk(
      ["sh", "-c", `if [ -d ${MIRROR_DIR} ]; then chown root:${BUILD_USER} ${MIRROR_DIR} && chmod 750 ${MIRROR_DIR}; fi`],
      "mirror-perms",
    );
  }

  private async refExists(ref: string): Promise<boolean> {
    const r = await this.run(["git", "-C", MIRROR_DIR, "show-ref", "--verify", "--quiet", `refs/heads/${ref}`]);
    return r.exitCode === 0;
  }

  private async readMirrorSha(ref: string): Promise<string> {
    return (await this.runOk(["git", "-C", MIRROR_DIR, "rev-parse", "--verify", `refs/heads/${ref}`], "rev-parse")).trim();
  }

  /** Dependency/build cache key (KTD7): sha256 over the ls-tree lines (mode,
   *  blob oid, name) of the lockfile candidates AS COMMITTED at `sha` in the
   *  bare mirror. Fully determined by the commit — generated/uncommitted
   *  lockfiles on disk can never shift it. */
  private async lockfileKey(sha: string): Promise<string> {
    const script = `git -C ${MIRROR_DIR} ls-tree ${sha} -- ${LOCKFILE_CANDIDATES.join(" ")} | sha256sum | cut -d" " -f1`;
    return (await this.runOk(["sh", "-c", script], "lockfile-key")).trim();
  }

  /** True when the disk already holds exactly what the snapshot stamp says. */
  private async diskMatches(sha: string): Promise<boolean> {
    const r = await this.run([
      "sh",
      "-c",
      `test -d ${MIRROR_DIR}/objects && test -d ${CHECKOUT_DIR}/.git && cat ${READY_MARKER} 2>/dev/null || echo __absent__`,
    ]);
    return r.exitCode === 0 && r.stdout.trim() === sha;
  }

  /** Snapshot mirror + checkout to R2 (localBucket: the SDK resolves the
   *  BACKUP_BUCKET binding from this DO's env; objects land under
   *  backups/<uuid>/). gitignore stays false: node_modules and build output
   *  in the checkout ARE the cache being persisted (KTD3). */
  private async takeSnapshot(resource: string, ref: string, sha: string, lockfileHash: string): Promise<SnapshotRecord> {
    try {
      const mirror = await this.createBackup({
        dir: MIRROR_DIR,
        localBucket: true,
        ttl: SNAPSHOT_TTL_S,
        name: `${resource} mirror`,
      });
      const checkout = await this.createBackup({
        dir: CHECKOUT_DIR,
        localBucket: true,
        ttl: SNAPSHOT_TTL_S,
        name: `${resource} checkout`,
      });
      return { ref, sha, lockfileHash, createdAt: new Date().toISOString(), mirror, checkout };
    } catch (err) {
      throw new StepError("snapshot", errMsg(err));
    }
  }

  /** Delete the R2 objects behind SDK backup handles (backups/<id>/ lives
   *  OUTSIDE the resident/<resource>/ prefix, so offboard's prefix sweep
   *  cannot reach it — this is the only cleanup path). */
  private async deleteBackupObjects(ids: string[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) deleted += await deleteR2Prefix(this.env.BACKUP_BUCKET, `backups/${id}/`);
    return deleted;
  }

  /** Count (never delete) the R2 objects behind SDK backup handles — the
   *  read-only twin of deleteBackupObjects, for the dry-run itemizations. */
  private async countBackupObjects(ids: string[]): Promise<number> {
    let count = 0;
    for (const id of ids) count += await countR2Prefix(this.env.BACKUP_BUCKET, `backups/${id}/`);
    return count;
  }

  private async armRefresh(resource: string, intervalS = REFRESH_INTERVAL_S): Promise<void> {
    this.deleteSchedules(REFRESH_CALLBACK); // at most one pending refresh
    await this.schedule(intervalS, REFRESH_CALLBACK, resource);
  }

  /** Persist `down` with a reason, stop the refresh chain, and hand back the
   *  error that tells callers the transition already happened. */
  private async goDown(reason: string): Promise<ResidentDownError> {
    await this.setResidentState("down", reason);
    this.deleteSchedules(REFRESH_CALLBACK);
    return new ResidentDownError(reason);
  }

  private async recordRefreshError(message: string): Promise<void> {
    const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    if (facts) await this.ctx.storage.put(FACTS_KEY, { ...facts, lastRefreshError: message });
  }

  // -- onboarding ------------------------------------------------------------

  /** Called once per onboard: persist the initial lifecycle state and arm BOTH
   *  the provisioning work and its fail-closed deadline. Does NOT start the
   *  container — onboard must return immediately; the container first starts
   *  when runProvisioning's schedule fires (~1s later). */
  async initResident(resource: string, provisioningTimeoutMs: number): Promise<ResidentStatus> {
    await this.ctx.storage.put({
      [RESOURCE_KEY]: resource,
      [STATE_KEY]: "onboarding" satisfies ResidentState,
      [REASON_KEY]: "",
      [UPDATED_KEY]: new Date().toISOString(),
      [DEADLINE_AT_KEY]: Date.now() + provisioningTimeoutMs,
    });
    await this.ctx.storage.delete([FACTS_KEY, SNAPSHOT_KEY]); // defensive: no stale facts from a past life
    this.deleteSchedules(PROVISIONING_CALLBACK);
    this.deleteSchedules(PROVISION_RUN_CALLBACK);
    this.deleteSchedules(REFRESH_CALLBACK);
    await this.schedule(Math.max(1, Math.ceil(provisioningTimeoutMs / 1000)), PROVISIONING_CALLBACK, resource);
    await this.schedule(1, PROVISION_RUN_CALLBACK, resource);
    return { state: "onboarding", reason: "" };
  }

  /** The provisioning engine (alarm-driven): clone bare mirror → resolve the
   *  default branch → full install + build in a working checkout using the
   *  onboard-time command table → stamped snapshot → record facts → warm.
   *  On failure: down(provision-failed at <step>) — the registry slot is
   *  deliberately KEPT so /status shows the named reason (only a stuck
   *  onboarding releases the slot, via the deadline/watchdog — KTD4). */
  async runProvisioning(payload: string): Promise<void> {
    const resource = payload || ((await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "");
    if ((await this.ctx.storage.get<ResidentState>(STATE_KEY)) !== "onboarding") return; // stale schedule
    try {
      const record = await this.registry().getRecord(resource);
      if (!record) throw new StepError("registry", "registry record missing (offboarded mid-onboard?)");
      const slug = resource.slice("repo:".length);
      const stepBudget = record.provisioningTimeoutMs;

      // KTD12: a mint failure is command-level — fall back to an anonymous
      // clone (works for public repos); a private repo then fails AT CLONE
      // with the real, named signal.
      let token: string | null = null;
      if (githubAppConfigured(this.env)) {
        try {
          token = await mintRepoScopedToken(this.env, slug);
        } catch (err) {
          console.log(`provisioning ${resource}: token mint failed (command-level), trying anonymous clone: ${errMsg(err)}`);
        }
      }

      await this.runOk(["rm", "-rf", MIRROR_DIR, CHECKOUT_DIR, READY_MARKER], "clean-workspace");
      await this.ensureGitSetup();
      await this.withMirrorLock(() =>
        this.gitWithCred(token, ["clone", "--mirror", `https://github.com/${slug}.git`, MIRROR_DIR], "clone", stepBudget),
      );
      await this.ensureGitSetup(); // the clone just created MIRROR_DIR — lock its perms down

      // Resolve the default branch: the configured ref when it exists, else
      // the mirror's HEAD (what GitHub reports as the default branch).
      let ref = record.defaultRef;
      if (!(await this.refExists(ref))) {
        ref = (await this.runOk(["git", "-C", MIRROR_DIR, "symbolic-ref", "--short", "HEAD"], "detect-default-branch")).trim();
        if (!(await this.refExists(ref))) {
          throw new StepError("detect-default-branch", `neither configured ref "${record.defaultRef}" nor detected HEAD "${ref}" exists in the mirror`);
        }
      }
      const sha = await this.readMirrorSha(ref);
      const lockfileHash = await this.lockfileKey(sha);

      await this.runOk(["git", "clone", "--branch", ref, MIRROR_DIR, CHECKOUT_DIR], "checkout-clone", { timeoutMs: stepBudget });
      await this.runOk(["chown", "-R", `${BUILD_USER}:${BUILD_USER}`, CHECKOUT_DIR], "chown");

      // Full install + build, unprivileged and token-free (KTD5/KTD7).
      if (record.commands.install) await this.buildUserRun(record.commands.install, "install", stepBudget);
      await this.buildUserRun(record.commands.build, "build", stepBudget);

      const snap = await this.takeSnapshot(resource, ref, sha, lockfileHash);

      // The deadline may have fired mid-provision (down + slot released);
      // never flip a non-onboarding resident to warm from here.
      if ((await this.ctx.storage.get<ResidentState>(STATE_KEY)) !== "onboarding") {
        await this.deleteBackupObjects([snap.mirror.id, snap.checkout.id]).catch(() => {});
        return;
      }
      const now = new Date().toISOString();
      const facts: RepoFacts = { defaultRef: ref, sha, lockfileHash, provisionedAt: now, lastRefreshAt: now };
      await this.ctx.storage.put({ [FACTS_KEY]: facts, [SNAPSHOT_KEY]: snap });
      await this.writeFile(READY_MARKER, `${sha}\n`);
      this.deleteSchedules(PROVISIONING_CALLBACK);
      await this.setResidentState("warm");
      await this.armRefresh(resource);
    } catch (err) {
      if ((await this.ctx.storage.get<ResidentState>(STATE_KEY)) !== "onboarding") return;
      this.deleteSchedules(PROVISIONING_CALLBACK);
      const reason =
        err instanceof StepError ? `provision-failed at ${err.step}: ${err.message}` : `provision-failed: ${errMsg(err)}`;
      await this.setResidentState("down", reason);
    }
  }

  /** Fail-closed deadline (armed at onboard): a resident still `onboarding`
   *  when this fires is stuck → down(provision-timeout) and the cap slot is
   *  released (KTD4). The watchdog is the backstop when this schedule itself
   *  died. */
  async onProvisioningDeadline(_payload: string): Promise<void> {
    const state = await this.ctx.storage.get<ResidentState>(STATE_KEY);
    if (state !== "onboarding") return;
    await this.provisionTimedOut("provision-timeout: provisioning did not reach warm within its budget");
  }

  private async provisionTimedOut(reason: string): Promise<void> {
    await this.setResidentState("down", reason);
    this.deleteSchedules(PROVISIONING_CALLBACK);
    this.deleteSchedules(PROVISION_RUN_CALLBACK);
    this.deleteSchedules(REFRESH_CALLBACK);
    const resource = await this.ctx.storage.get<string>(RESOURCE_KEY);
    if (resource) {
      try {
        await this.registry().remove(resource); // release the cap slot
      } catch {
        // the Worker-side watchdog also removes on "provision-timed-out"
      }
    }
  }

  // -- wake path (rehydration, KTD3/KTD10) ------------------------------------

  /** Ensure the container disk holds the stamped snapshot state. `restoring`
   *  is persisted BEFORE any restore work (KTD10) — DO storage would
   *  otherwise still say warm while the R2 restore runs. Refuses mismatched
   *  stamps → down(snapshot-stamp-mismatch); restore failures →
   *  down(r2-restore-failed). Throws ResidentDownError after those
   *  transitions. Called by the refresh alarm (and U4's attach path). */
  async ensureHydrated(): Promise<void> {
    if (this.hydration) return this.hydration;
    const p = this.doHydrate().finally(() => {
      if (this.hydration === p) this.hydration = null;
    });
    this.hydration = p;
    return p;
  }

  private async doHydrate(): Promise<void> {
    const state = await this.ctx.storage.get<ResidentState>(STATE_KEY);
    if (!state || state === "onboarding") throw new Error("resident is not provisioned yet — nothing to hydrate");
    const snap = await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY);
    const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    if (!snap || !facts) {
      throw await this.goDown("no-snapshot: resident has no recorded snapshot to rehydrate from");
    }
    // DO-side stamp consistency (KTD3: storage is truth) — checked before any
    // container work.
    if (snap.ref !== facts.defaultRef || snap.sha !== facts.sha || snap.lockfileHash !== facts.lockfileHash) {
      throw await this.goDown(
        `snapshot-stamp-mismatch: DO facts {ref:${facts.defaultRef}, sha:${facts.sha}, lockfileHash:${facts.lockfileHash}} != snapshot stamp {ref:${snap.ref}, sha:${snap.sha}, lockfileHash:${snap.lockfileHash}}`,
      );
    }

    // Cheap short-circuit only when the runtime is already up AND the disk
    // matches; a dead runtime goes straight to `restoring` so /status never
    // says warm while the wake actually runs (KTD10).
    const active = await this.isRuntimeActive().catch(() => false);
    if (active && (await this.diskMatches(snap.sha))) return;

    await this.setResidentState("restoring", "rehydrating");
    if (await this.diskMatches(snap.sha)) {
      // Raced a container start that already had the right disk.
      await this.setResidentState("warm");
      return;
    }

    const t0 = Date.now();
    await this.runOk(["rm", "-rf", MIRROR_DIR, CHECKOUT_DIR, READY_MARKER], "clean-before-restore");
    try {
      await this.restoreBackup(snap.mirror);
      await this.restoreBackup(snap.checkout);
    } catch (err) {
      throw await this.goDown(`r2-restore-failed: ${errMsg(err)}`);
    }
    await this.ensureGitSetup();

    // Verify the restored disk against the stamp — a snapshot that does not
    // prove its own {ref, sha, lockfileHash} is refused (KTD7). Both values
    // derive from the restored MIRROR (the source of truth the checkout was
    // built from); the checkout's presence was proven by restoreBackup + the
    // chown below failing loudly if it is missing.
    const shaRes = await this.run(["git", "-C", MIRROR_DIR, "rev-parse", "--verify", `refs/heads/${snap.ref}`]);
    const diskSha = shaRes.exitCode === 0 ? shaRes.stdout.trim() : `unreadable(${tail(shaRes.stderr, 120)})`;
    const diskLock = await this.lockfileKey(snap.sha).catch((err) => `unreadable(${errMsg(err)})`);
    if (diskSha !== snap.sha || diskLock !== snap.lockfileHash) {
      throw await this.goDown(
        `snapshot-stamp-mismatch: restored disk {sha:${diskSha}, lockfileHash:${diskLock}} != stamp {sha:${snap.sha}, lockfileHash:${snap.lockfileHash}}`,
      );
    }

    await this.runOk(["chown", "-R", `${BUILD_USER}:${BUILD_USER}`, CHECKOUT_DIR], "chown");
    await this.writeFile(READY_MARKER, `${snap.sha}\n`);
    await this.ctx.storage.put(FACTS_KEY, {
      ...facts,
      lastRestore: { at: new Date().toISOString(), ms: Date.now() - t0 },
    } satisfies RepoFacts);
    await this.setResidentState("warm");
  }

  // -- freshness (refresh alarm, KTD4/KTD7/KTD12) ------------------------------

  /** Self-rescheduling refresh: rehydrate if the container slept → mint a
   *  repo-scoped token (mint failure is command-level: recorded, never a
   *  lifecycle flip) → fetch into the bare mirror → when the default branch
   *  moved: update the checkout, reinstall ONLY if the lockfile hash changed,
   *  rebuild, write a new stamped snapshot, delete the replaced backup
   *  objects. Transitions: refreshing → warm, or degraded(reason) with the
   *  last snapshot still serving. */
  async onRefreshAlarm(payload: string): Promise<void> {
    const resource = payload || ((await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "");
    let refreshCounted = false;
    const before = await this.getStatus();
    // down chains stay down (U8's rebuild is the escape hatch); onboarding is
    // owned by provisioning, which arms the first refresh itself.
    if (before.state === "onboarding" || before.state === "down") return;
    try {
      await this.ensureHydrated();
      const record = await this.registry().getRecord(resource);
      if (!record) return; // offboarded mid-flight: let the chain die quietly
      const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
      if (!facts) throw new StepError("facts", "no repo facts recorded despite hydration");

      // Deploy-ordering hazard: `wrangler deploy` swaps the app's image but a
      // RUNNING container keeps the old one, so new Worker code can name pool
      // users the image lacks. Reconcile here (every cycle, cheap) — see
      // reconcileImage — so a rollout self-applies within one refresh.
      if (await this.reconcileImage("refresh")) return; // container stopping; finally re-arms

      // Idle sleep: nobody has attached for IDLE_AFTER_S and no live tree is
      // dirty → skip this fetch and park the alarm far out so SLEEP_AFTER can
      // elapse. Staleness is repaid at the next attach (refreshIfStale). A
      // dirty live tree pins the container awake: sleep destroys the disk and
      // uncommitted work is not snapshotted.
      // Only a SETTLED resident may park: a cycle that finds `refreshing`/
      // `restoring` at entry is looking at a marker left by a cycle that died
      // mid-flight (a deploy evicting the DO, live 2026-08-29: stuck
      // `refreshing` + parked → every run fell back cold because the bot's
      // warm-gate probe never saw `warm` again). Run the full cycle instead; it
      // ends warm or degraded, and the next one may park.
      // Decide off a FRESH state read — `before` predates several awaits
      // (hydration, registry, facts, reconcile) — same re-read discipline as
      // every other state decision in this file.
      const entry = await this.getStatus();
      let settled = entry.state === "warm";
      if (entry.state === "degraded") {
        // Count consecutive cycles that found the same degraded reason; a
        // stable streak means retrying is not going to help and parking is
        // the right cost behavior. Any other state resets the streak (below).
        const prev = await this.ctx.storage.get<{ reason: string; count: number }>(DEGRADED_STREAK_KEY);
        const streak = prev && prev.reason === entry.reason ? { reason: entry.reason, count: prev.count + 1 } : { reason: entry.reason, count: 1 };
        await this.ctx.storage.put(DEGRADED_STREAK_KEY, streak);
        settled = streak.count >= DEGRADED_PARK_AFTER_CYCLES;
      } else {
        await this.ctx.storage.delete(DEGRADED_STREAK_KEY);
      }
      if (settled && (await this.isIdle())) {
        // isIdle awaited (git status per live tree) — re-read before writing.
        const now = (await this.ctx.storage.get<RepoFacts>(FACTS_KEY)) ?? facts;
        if (!now.idleSince) await this.ctx.storage.put(FACTS_KEY, { ...now, idleSince: new Date().toISOString() } satisfies RepoFacts);
        this.idleRearm = true;
        return; // finally re-arms at IDLE_REFRESH_INTERVAL_S
      }
      if (facts.idleSince) {
        const now = (await this.ctx.storage.get<RepoFacts>(FACTS_KEY)) ?? facts;
        const { idleSince: _woke, ...awake } = now;
        await this.ctx.storage.put(FACTS_KEY, awake satisfies RepoFacts);
      }
      // From here the cycle mutates the mirror/checkout: count it as in flight
      // so an attach-path reconcileImage never stops the container under it.
      this.refreshesInFlight++;
      refreshCounted = true;

      // KTD12: token-mint failure is a command-level error — the resident
      // keeps serving the last snapshot and lifecycle state is NOT flipped by
      // it. It is recorded, and the cycle then CONTINUES with an anonymous
      // fetch (exactly what an unconfigured App does): a public repo outside
      // the installation stays fresh, and a private one fails at the fetch
      // below into a visible `degraded(github-unreachable: …)`. Returning here
      // instead (the pre-#171 behavior) froze whatever state the resident was
      // in — live 2026-08-29: `repo:jshttp/vary` sat in the watchdog's
      // `degraded(alarm-missed)` forever with a 24h-stale mirror, because the
      // App cannot mint for a repo it is not installed on.
      let token: string | null = null;
      // This cycle's mint error, kept so it survives the warm facts write below
      // (which clears errors from PRIOR cycles) and prefixes a fetch failure's
      // reason — the observable for "App configured, repo outside the
      // installation" is a warm-but-anonymous resident with the mint named.
      let mintError: string | undefined;
      if (githubAppConfigured(this.env)) {
        try {
          token = await mintRepoScopedToken(this.env, resource.slice("repo:".length));
        } catch (err) {
          mintError = `token-mint-failed (command-level, fetching anonymously): ${errMsg(err)}`;
          await this.recordRefreshError(mintError);
        }
      }

      await this.setResidentState("refreshing");
      try {
        // Same mirror mutex as attach's fetch/worktree work (KTD5): the
        // refresh alarm and an in-flight attach serialize instead of racing
        // a prune against a worktree clone.
        await this.withMirrorLock(() =>
          this.gitWithCred(token, ["-C", MIRROR_DIR, "fetch", "--prune", "origin"], "fetch", GIT_NETWORK_TIMEOUT_MS),
        );
      } catch (err) {
        // A private repo whose mint failed lands here (the anonymous fetch is
        // refused): say so, rather than blaming GitHub reachability alone.
        const cause = mintError ? `${mintError}; then ` : "";
        await this.setResidentState("degraded", `github-unreachable: ${cause}${errMsg(err)}`);
        return;
      }

      const sha = await this.readMirrorSha(facts.defaultRef);
      let lockfileHash = facts.lockfileHash;
      let snap: SnapshotRecord | null = null;
      let previous: SnapshotRecord | undefined;
      if (sha !== facts.sha) {
        // Serialize the CHECKOUT_DIR mutation on the mirror mutex (FIX 2):
        // materializeThreadDeps reads CHECKOUT_DIR via `cp -al` under the same
        // lock, so an attach/op dep-copy can no longer hardlink a half-rebuilt
        // checkout into a thread tree (torn cache → false ❌ from `repo test`).
        // No wait timeout, exactly like the fetch lock above: the background
        // refresh queues behind an in-flight attach instead of flipping to
        // degraded on transient lock contention.
        await this.withMirrorLock(async () => {
          // Token-free from here on: repo code runs during install/build (KTD7).
          //
          // Isolation invariant (review 1b): attach hardlink-copies (cp -al)
          // CHECKOUT_DIR's node_modules/build dirs into already-attached,
          // sha-pinned thread worktrees, so those FILE inodes are shared and
          // worker1-owned. A rebuild that writes THROUGH an existing inode —
          // many bundlers do (e.g. .next incremental manifests open+truncate
          // rather than recreate) — would silently mutate an attached thread's
          // pinned artifacts, breaking the sha pin the whole cache keys on.
          // `git clean -fdq` (no -x) leaves these gitignored dirs in place, so
          // the rebuild would reuse the very inodes threads still hold. `-x`
          // removes them, so install/build allocate FRESH inodes; a thread's
          // outstanding hardlink just keeps the old inode (link count drops).
          // Cost: a full reinstall per default-branch advance (background, only
          // when the sha actually moved) — accepted for the invariant. It also
          // purges deps a later lockfile dropped (the -fdq staleness gap).
          await this.buildUserRun(
            `git fetch --quiet origin && git reset --hard --quiet ${sha} && git clean -fdx`,
            "checkout-update",
            GIT_NETWORK_TIMEOUT_MS,
          );
          lockfileHash = await this.lockfileKey(sha);
          // `-x` just removed node_modules, so install unconditionally — the
          // old lockfile-hash gate assumed the cache survived the clean.
          if (record.commands.install) {
            await this.buildUserRun(record.commands.install, "install", REFRESH_BUILD_TIMEOUT_MS);
          }
          await this.buildUserRun(record.commands.build, "build", REFRESH_BUILD_TIMEOUT_MS);
          previous = await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY);
          snap = await this.takeSnapshot(resource, facts.defaultRef, sha, lockfileHash);
        });
      }

      // Facts and snapshot move together so the stamp check never sees a
      // half-updated pair.
      const updatedFacts: RepoFacts = { ...facts, sha, lockfileHash, lastRefreshAt: new Date().toISOString() };
      // Clear a PRIOR cycle's error; keep THIS cycle's mint error visible (#171).
      delete updatedFacts.lastRefreshError;
      if (mintError) updatedFacts.lastRefreshError = mintError;
      // A wake cycle cleared idleSince above; `facts` was read at alarm entry and
      // still carries it — never resurrect it here (the dash would show a stale
      // "idle since" and every attach would take the wake-fetch path).
      delete updatedFacts.idleSince;
      if (snap) {
        await this.ctx.storage.put({ [FACTS_KEY]: updatedFacts, [SNAPSHOT_KEY]: snap });
        await this.writeFile(READY_MARKER, `${sha}\n`);
        if (previous) await this.deleteBackupObjects([previous.mirror.id, previous.checkout.id]).catch(() => {});
      } else {
        await this.ctx.storage.put(FACTS_KEY, updatedFacts);
      }
      await this.setResidentState("warm");
    } catch (err) {
      if (err instanceof ResidentDownError) return; // already down with reason; chain stops below
      const reason = err instanceof StepError ? `${err.step}-failed: ${err.message}` : `refresh-failed: ${errMsg(err)}`;
      await this.setResidentState("degraded", reason); // last snapshot keeps serving
    } finally {
      if (refreshCounted) this.refreshesInFlight--;
      const state = await this.ctx.storage.get<ResidentState>(STATE_KEY);
      const interval = this.idleRearm ? IDLE_REFRESH_INTERVAL_S : REFRESH_INTERVAL_S;
      this.idleRearm = false;
      if (state && state !== "down" && state !== "onboarding") await this.armRefresh(resource, interval);
    }
  }

  /** Set by the idle gate for the duration of one alarm so `finally` re-arms far out. */
  private idleRearm = false;

  /** Idle = no live binding attached within IDLE_AFTER_S AND (when the
   *  runtime is up) no live tree is dirty. Bindings are storage; dirtiness
   *  needs the container — if it is already asleep there is nothing to lose. */
  private async isIdle(): Promise<boolean> {
    const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    const live = [...all.values()].filter((b) => !b.evicted && b.user);
    const recent = Date.now() - IDLE_AFTER_S * 1000;
    if (live.some((b) => Date.parse(b.lastAttachAt) >= recent)) return false;
    if (this.inFlightCount() > 0) return false;
    if (!(await this.isRuntimeActive().catch(() => false))) return true;
    for (const b of live) {
      const c = await this.worktreeCleanliness(b);
      if (!c.clean) return false; // dirty or unknown → stay awake
    }
    return true;
  }

  /** Refresh-on-attach, BOUNDED: if the resident was idle (or the last
   *  refresh is older than the active cadence), fetch the mirror now — seconds,
   *  under the mirror lock — so the ref this thread binds is current, clear
   *  idle mode, and pull the full refresh cycle (checkout rebuild if main
   *  moved: minutes) to +1s in the BACKGROUND. The attach never waits on an
   *  install/build, so a wake cannot become a cold-fallback generator. */
  private async refreshIfStale(resource: string): Promise<void> {
    const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    if (!facts) return;
    const age = Date.now() - Date.parse(facts.lastRefreshAt);
    if (!facts.idleSince && age < REFRESH_INTERVAL_S * 1000) return;
    let token: string | null = null;
    if (githubAppConfigured(this.env)) {
      token = await mintRepoScopedToken(this.env, resource.slice("repo:".length)).catch(() => null);
    }
    try {
      // Bounded like attach's own clone section: a full checkout rebuild
      // holding the mutex must not stall a wake attach for minutes — on
      // expiry (MirrorBusyError) proceed on the last mirror, same as a failed
      // fetch. The background full cycle armed below repays the staleness.
      await this.withMirrorLock(
        () => this.gitWithCred(token, ["-C", MIRROR_DIR, "fetch", "--prune", "origin"], "wake-fetch", GIT_NETWORK_TIMEOUT_MS),
        ATTACH_MUTEX_WAIT_MS,
      );
    } catch (err) {
      console.log(`wake-fetch ${err instanceof MirrorBusyError ? "skipped (mirror busy)" : "failed"} — attach proceeds on the last mirror: ${errMsg(err)}`);
    }
    // Re-read before writing: the awaits above yielded, and a concurrent
    // refresh cycle may have advanced facts (sha/lastRefreshAt) meanwhile —
    // never write a stale snapshot back over it.
    const fresh = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    if (fresh?.idleSince) {
      const { idleSince: _woke, ...awake } = fresh;
      await this.ctx.storage.put(FACTS_KEY, awake satisfies RepoFacts);
    }
    await this.armRefresh(resource, 1); // full cycle now, in the background; it re-arms at the active cadence
  }

  /** Pool users live in the IMAGE (Dockerfile useradd loop) while THREAD_USERS
   *  lives in the Worker. After a deploy that grows the pool, a still-running
   *  container lacks the new users and `install -o workerN` fails. Check the
   *  last pool user exists; if not and nothing is in flight, stop the container
   *  so it restarts on the current image (state is DO storage + R2, KTD3 — the
   *  disk is a cache). Returns true when a stop was issued. */
  private async reconcileImage(where: string): Promise<boolean> {
    if (!(await this.isRuntimeActive().catch(() => false))) return false;
    const last = THREAD_USERS[THREAD_USERS.length - 1];
    const probe = await this.run(["id", "-u", last]);
    if (probe.exitCode === 0) return false;
    const busy = this.inFlightCount();
    if (busy > 0) {
      console.log(`image-stale (${where}): ${last} missing but ${busy} operation(s)/attach(es) in flight — deferring restart`);
      return false;
    }
    console.log(`image-stale (${where}): ${last} missing in the running container — stopping so it restarts on the current image`);
    await this.stop().catch((err) => console.log(`image-stale: stop failed: ${errMsg(err)}`));
    return true;
  }

  // -- watchdog (KTD4) ---------------------------------------------------------

  /** One watchdog pass over this resident (invoked by the Worker cron):
   *  re-arm a dead refresh chain and mark degraded(alarm-missed); time out an
   *  onboarding stuck past its budget → down(provision-timeout) + cap slot
   *  release; auto-rebuild a resident stuck down on unusable snapshots (U8:
   *  one strike per pass, rebuild at AUTO_REBUILD_AFTER_STRIKES). Storage/
   *  schedule reads (plus the strike counter) only — containers start via the
   *  re-armed alarms, never in this pass. */
  async watchdogCheck(): Promise<{ resource: string; state: ResidentState; reason: string; action: "none" | "rearmed" | "provision-timed-out" | "auto-rebuilt" }> {
    const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
    const status = await this.getStatus();
    if (status.state === "onboarding") {
      const deadlineAt = await this.ctx.storage.get<number>(DEADLINE_AT_KEY);
      if (deadlineAt !== undefined && Date.now() > deadlineAt + 30_000) {
        const reason = "provision-timeout: onboarding stuck past its budget (watchdog)";
        await this.provisionTimedOut(reason);
        return { resource, state: "down", reason, action: "provision-timed-out" };
      }
      return { resource, ...status, action: "none" };
    }
    if (status.state === "down") {
      // Auto-rebuild escape hatch (U8): only rehydration-flavored downs — the
      // snapshots themselves are the problem, and down chains never retry, so
      // without this the resident would stay down forever.
      if (REHYDRATION_FAILURE_RE.test(status.reason)) {
        const strikes = ((await this.ctx.storage.get<number>(REBUILD_STRIKES_KEY)) ?? 0) + 1;
        if (strikes >= AUTO_REBUILD_AFTER_STRIKES) {
          const record = await this.registry()
            .getRecord(resource)
            .catch(() => null);
          if (record) {
            const reason = `auto-rebuild: down for ${strikes} watchdog passes (${status.reason})`;
            await this.rebuild(resource, record.defaultRef, record.provisioningTimeoutMs, false);
            return { resource, state: "onboarding", reason, action: "auto-rebuilt" };
          }
        }
        await this.ctx.storage.put(REBUILD_STRIKES_KEY, strikes);
      }
      return { resource, ...status, action: "none" };
    }
    // Any serving state clears accumulated strikes (a recovery must reset the
    // counter, or an unrelated later down inherits stale strikes).
    await this.ctx.storage.delete(REBUILD_STRIKES_KEY);

    // The sweep chain has the same failure mode as the refresh chain (a DO
    // eviction mid-callback kills the self-rescheduling), but nothing re-armed
    // it: only an attach did, so a resident with live bindings and no traffic
    // never swept again (live 2026-08-29: seven idle bindings, >1h, no sweep).
    // Re-arm at +5s whenever live bindings exist and none is pending. Not a
    // lifecycle event — the sweep is housekeeping, no state flip. Runs BEFORE
    // the stale-mid-flight check so that branch's early return never skips it.
    const bindings = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    const liveBindings = [...bindings.values()].some((b) => !b.evicted && b.user);
    // `sweepInFlight` is the explicit guard against arming a second chain while
    // a sweep is executing (its schedule row also stays listed until the callback
    // resolves, but that is a library detail we do not lean on).
    if (liveBindings && !this.sweepInFlight) {
      const pendingSweeps = await this.listSchedules(SWEEP_CALLBACK);
      // Config drift: a row armed by OLDER code (e.g. the pre-#130 daily sweep,
      // seen live 2026-08-29 due 24h out) is still honored by the runtime, so a
      // shorter SWEEP_INTERVAL_S never takes effect until it fires. Treat a row
      // due further out than the current interval (+ slack) as stale and
      // replace it, so a deploy that shortens the cadence applies within one
      // watchdog pass rather than after the old delay elapses.
      const nowS = Math.floor(Date.now() / 1000);
      const drifted = pendingSweeps.some((row) => (row.time ?? 0) - nowS > SWEEP_INTERVAL_S + SWEEP_DRIFT_SLACK_S);
      // Re-check the guard: listSchedules yielded, and a sweep that started
      // meanwhile owns the row its own `finally` is about to arm.
      if ((pendingSweeps.length === 0 || drifted) && !this.sweepInFlight) {
        this.deleteSchedules(SWEEP_CALLBACK);
        await this.schedule(5, SWEEP_CALLBACK, resource);
        // Disjoint by construction: inside this branch, a non-empty list implies `drifted`.
        console.log(`watchdog ${resource}: sweep ${pendingSweeps.length === 0 ? "chain was dead" : "row was due beyond the current interval (config drift)"} with live bindings — re-armed`);
      }
    }

    // A mid-flight state older than STALE_MIDFLIGHT_MS with no cycle or restore
    // actually running is a marker orphaned by an interrupted cycle (DO evicted
    // by a deploy, platform restart). Left alone it is permanent — the idle gate
    // above only parks from `warm`, but nothing else would ever rewrite it, and
    // the bot's warm-gate keeps sending runs cold. Mark it degraded (visible,
    // KTD10) and pull the next cycle to +5s so it normalizes.
    if (status.state === "refreshing" || status.state === "restoring") {
      const updatedAt = Date.parse((await this.ctx.storage.get<string>(UPDATED_KEY)) ?? "") || 0;
      const inFlight = this.refreshesInFlight > 0 || this.hydration !== null;
      if (!inFlight && Date.now() - updatedAt > STALE_MIDFLIGHT_MS) {
        // The reads above yielded; a cycle that started meanwhile owns the
        // state now — leave it alone rather than stamp `degraded` over it.
        const again = await this.getStatus();
        if (again.state !== status.state || this.refreshesInFlight > 0 || this.hydration !== null) {
          return { resource, ...again, action: "none" };
        }
        const reason = `stale-mid-flight: ${status.state} since ${new Date(updatedAt).toISOString()} with no cycle running; re-armed by watchdog`;
        await this.setResidentState("degraded", reason);
        this.deleteSchedules(REFRESH_CALLBACK);
        await this.schedule(5, REFRESH_CALLBACK, resource);
        return { resource, state: "degraded", reason, action: "rearmed" };
      }
    }

    const pending = await this.listSchedules(REFRESH_CALLBACK);
    if (pending.length === 0) {
      await this.schedule(5, REFRESH_CALLBACK, resource);
      const reason = "alarm-missed: refresh chain was dead; re-armed by watchdog";
      // An in-flight restore owns its own state; everything else is visibly
      // degraded until the re-armed refresh succeeds.
      if (status.state !== "restoring") await this.setResidentState("degraded", reason);
      return { resource, state: "degraded", reason, action: "rearmed" };
    }
    return { resource, ...status, action: "none" };
  }

  // -- thread data plane (U4: attach / exec / read / write / sweep) ------------

  /** Run a shell string privilege-dropped as the thread's OS user with the
   *  worktree as cwd (KTD5). Never root, never a token in env or argv — the
   *  only injected env var is GIT_TERMINAL_PROMPT, validated like every
   *  injection. The worktree path is built from slugged components, so
   *  embedding it in the -c string is shell-safe. */
  private async threadRun(
    user: string,
    worktreePath: string,
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
    const injected = { GIT_TERMINAL_PROMPT: "0" };
    validateEnvNames(injected);
    return this.run(["su", "-s", "/bin/bash", user, "-c", `cd ${worktreePath} && ${command}`], {
      timeoutMs,
      env: injected,
    });
  }

  private async threadRunOk(user: string, worktreePath: string, command: string, step: string, timeoutMs: number): Promise<string> {
    return this.assertOk(await this.threadRun(user, worktreePath, command, timeoutMs), step);
  }

  /** The user-pool scan shared by both allocators: live bindings (optionally
   *  ignoring one threadKey's own binding) plus users transiently held by
   *  in-flight ops mark the pool as used — an attach must never share an OS
   *  user with a running op, and vice versa. Storage reads + set reads only,
   *  so callers stay atomic under the DO input gate. */
  private async findFreePoolUser(excludeThreadKey?: string): Promise<string | undefined> {
    const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    const used = new Set(
      [...all.values()].filter((b) => !b.evicted && b.user && b.threadKey !== excludeThreadKey).map((b) => b.user),
    );
    for (const u of this.opUsersInUse) used.add(u);
    return THREAD_USERS.find((u) => !used.has(u));
  }

  /** Storage-only allocation (atomic under the DO input gate: get → list →
   *  put touches nothing but this object's storage, so two concurrent
   *  attaches cannot both claim the same user). Sticky: an existing live
   *  binding is reused as-is; an evicted binding keeps its ref (KTD6) and
   *  gets a fresh user from the pool. */
  private async allocateThreadUser(
    threadKey: string,
    ref: string,
    worktreePath: string,
  ): Promise<{ binding: ThreadBinding; wrote: boolean } | ThreadErr> {
    const key = threadBindingKey(threadKey);
    const existing = await this.ctx.storage.get<ThreadBinding>(key);
    if (existing && !existing.evicted && existing.user) return { binding: existing, wrote: false };
    const user = await this.findFreePoolUser(threadKey);
    if (!user) {
      return {
        error: `user-pool-exhausted: all ${THREAD_USERS.length} thread users are allocated; wait for the inactivity sweep or evict a thread`,
        status: 429,
      };
    }
    const now = new Date().toISOString();
    const binding: ThreadBinding = {
      threadKey,
      ref: existing?.ref ?? ref, // sticky across eviction (KTD6)
      user,
      worktreePath: existing?.worktreePath ?? worktreePath,
      boundAt: existing?.boundAt ?? now,
      lastAttachAt: now,
      evicted: false,
    };
    await this.ctx.storage.put(key, binding);
    return { binding, wrote: true };
  }

  /** POST /attach: idempotent per-thread workspace materialization.
   *  Validated inputs only (the Worker enforces the patterns before this is
   *  ever called). Flow: hydrate → resolve/blind the ref binding → allocate
   *  a pool user → (mirror mutex) verify ref, wipe dirty/stale trees,
   *  clone → materialize deps (KTD7) → per-attach credential file (KTD12). */
  async attachThread(threadKey: string, refHint: string | null): Promise<AttachOk | ThreadErr> {
    const t0 = Date.now();
    try {
      await this.ensureHydrated();
      const resourceId = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
      if (await this.reconcileImage("attach")) {
        return { error: "image-stale: the container predates the current pool and is restarting; retry shortly", status: 503, state: "restoring", reason: "image-stale" };
      }
      // From here the attach may hold the mirror lock through clone/install:
      // count it so a concurrent refresh-cycle reconcileImage never stops the
      // container under it (and isIdle never parks the alarm mid-attach).
      this.attachesInFlight++;
      try {
        return await this.attachThreadBody(threadKey, refHint, resourceId, t0);
      } finally {
        this.attachesInFlight--;
      }
    } catch (err) {
      return { error: `attach-failed: ${errMsg(err)}`, status: 500 };
    }
  }

  private async attachThreadBody(threadKey: string, refHint: string | null, resourceId: string, t0: number): Promise<AttachOk | ThreadErr> {
    try {
      await this.refreshIfStale(resourceId);
    } catch (err) {
      const s = await this.getStatus();
      return { error: `not-serviceable: ${errMsg(err)}`, status: 503, state: s.state, reason: s.reason };
    }
    const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
    const slug = resource.slice("repo:".length);
    const record = await this.registry().getRecord(resource);
    const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    if (!record || !facts) return { error: "not-serviceable: registry record or repo facts missing", status: 503 };

    const prior = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    const ref = prior?.ref ?? refHint; // KTD6: the binding's ref wins for the thread's whole life
    if (!ref) {
      return { error: "needs-ref: this thread has no ref binding yet — supply refHint", status: 409, needs: "ref" };
    }
    const worktreePath = prior?.worktreePath ?? (await threadWorktreePath(threadKey, ref));

    const alloc = await this.allocateThreadUser(threadKey, ref, worktreePath);
    if ("error" in alloc) return alloc;
    const binding = alloc.binding;
    // "Nothing created" on failure: a FRESH allocation (new binding or a
    // re-allocation after eviction) is rolled back if the attach fails below,
    // so a bogus refHint can neither bind sticky garbage nor leak a pool user.
    const rollback = async (): Promise<void> => {
      if (!alloc.wrote) return;
      if (prior) await this.ctx.storage.put(threadBindingKey(threadKey), prior);
      else await this.ctx.storage.delete(threadBindingKey(threadKey));
    };

    // Command-level token mint (KTD12) — before the lock so mint latency
    // never holds the mutex, and failure never blocks the attach.
    let token: string | null = null;
    let credentialsError: string | undefined;
    if (githubAppConfigured(this.env)) {
      try {
        token = await mintRepoScopedToken(this.env, slug);
      } catch (err) {
        credentialsError = errMsg(err);
      }
    } else {
      credentialsError = "github-app-not-configured: GITHUB_APP_* secrets are unset";
    }

    let locked: { value: { sha: string; threadLockKey: string; recreated: boolean }; waitedMs: number };
    try {
      locked = await this.withMirrorLock(async () => {
        await this.ensureGitSetup();
        if (!(await this.refExists(binding.ref))) {
          await this.gitWithCred(token, ["-C", MIRROR_DIR, "fetch", "--prune", "origin"], "fetch", GIT_NETWORK_TIMEOUT_MS);
          if (!(await this.refExists(binding.ref))) {
            throw new StepError("unknown-ref", `ref ${JSON.stringify(binding.ref)} does not resolve in the mirror (even after a fetch)`);
          }
        }
        const sha = await this.readMirrorSha(binding.ref);
        const threadLockKey = await this.lockfileKey(sha);
        const recreated = await this.ensureThreadWorktree(binding, sha, slug);
        return { sha, threadLockKey, recreated };
      }, ATTACH_MUTEX_WAIT_MS);
    } catch (err) {
      await rollback();
      if (err instanceof MirrorBusyError) {
        const s = await this.getStatus();
        return { error: errMsg(err), status: 503, state: s.state, reason: "mirror-busy" };
      }
      if (err instanceof StepError && err.step === "unknown-ref") {
        return { error: `unknown-ref: ${err.message}`, status: 400 };
      }
      const step = err instanceof StepError ? ` at ${err.step}` : "";
      return { error: `attach-failed${step}: ${errMsg(err)}`, status: 500 };
    }

    let deps: { deps: ThreadDepsMechanism; reconciled: boolean };
    let credentials: "ok" | "unavailable" = "unavailable";
    try {
      const installCmd = record.commands.install ?? "npm install --no-audit --no-fund";
      deps = await this.materializeThreadDeps(binding, locked.value.threadLockKey, facts.lockfileHash, installCmd);
      if (token) {
        await this.writeThreadCredentials(binding, token);
        credentials = "ok";
      }
    } catch (err) {
      await rollback();
      // The deps hardlink-copy now waits on the mirror mutex (FIX 2): a
      // timed-out acquire surfaces as 503 mirror-busy, same as the fetch/
      // worktree lock above, so the bot-side fallback can retry.
      if (err instanceof MirrorBusyError) {
        const s = await this.getStatus();
        return { error: errMsg(err), status: 503, state: s.state, reason: "mirror-busy" };
      }
      const step = err instanceof StepError ? ` at ${err.step}` : "";
      return { error: `attach-failed${step}: ${errMsg(err)}`, status: 500 };
    }

    await this.ctx.storage.put(threadBindingKey(threadKey), {
      ...binding,
      lastAttachAt: new Date().toISOString(),
      deps: deps.deps,
      sha: locked.value.sha,
    } satisfies ThreadBinding);
    if ((await this.listSchedules(SWEEP_CALLBACK)).length === 0) {
      await this.schedule(SWEEP_INTERVAL_S, SWEEP_CALLBACK, resource);
    }

    return {
      workspace: binding.worktreePath,
      ref: binding.ref,
      sha: locked.value.sha,
      user: binding.user,
      reconciled: deps.reconciled,
      recreated: locked.value.recreated,
      deps: deps.deps,
      credentials,
      ...(credentialsError ? { credentialsError } : {}),
      mutexWaitMs: locked.waitedMs,
      attachMs: Date.now() - t0,
    };
  }

  /** Ensure the worktree exists, wiping dirty/stale trees (KTD5). Returns
   *  true when the tree was (re)created. MUST be called holding the mirror
   *  mutex — the clone reads the mirror.
   *
   *  "Dirty" is tracked-file dirt (`status --porcelain -uno`): untracked
   *  scratch files are the thread's own state and survive re-attach.
   *  "Stale" is a HEAD that is neither the mirror's current ref tip nor a
   *  local descendant of it (thread commits on top of the tip are kept).
   *
   *  Mechanism note: per-thread trees are LOCAL CLONES of the mirror with
   *  --no-hardlinks, not `git worktree` checkouts. A worktree checkout keeps
   *  its index/objects inside the root-owned mirror (thread commits would
   *  need write access there), and hardlinked objects would let a chown-ed
   *  owner chmod shared inodes under every other tree. A no-hardlink clone
   *  gives the thread user a fully-owned repo whose writes stay in its own
   *  .git; `origin` is repointed at GitHub so fetch/push use the per-attach
   *  credential file rather than the (deliberately unreadable) mirror. */
  private async ensureThreadWorktree(binding: ThreadBinding, sha: string, slug: string): Promise<boolean> {
    const wt = binding.worktreePath;
    const threadDir = parentDir(wt);
    await this.runOk(["install", "-d", "-m", "755", "-o", "root", "-g", "root", THREADS_DIR], "threads-dir");
    // 700 + thread-user ownership: other thread users cannot traverse in.
    await this.runOk(["install", "-d", "-m", "700", "-o", binding.user, "-g", binding.user, threadDir], "thread-dir");

    let recreate = false;
    const exists = (await this.run(["test", "-d", `${wt}/.git`])).exitCode === 0;
    if (exists) {
      const status = await this.threadRun(binding.user, wt, "git status --porcelain -uno", DEFAULT_EXEC_TIMEOUT_MS);
      const head = await this.threadRun(binding.user, wt, "git rev-parse HEAD", DEFAULT_EXEC_TIMEOUT_MS);
      if (status.exitCode !== 0 || head.exitCode !== 0) {
        recreate = true; // unreadable/corrupt (or owned by a previous pool user)
      } else if (status.stdout.trim() !== "") {
        recreate = true; // dirty tracked files
      } else {
        const headSha = head.stdout.trim();
        if (headSha !== sha) {
          const anc = await this.threadRun(binding.user, wt, `git merge-base --is-ancestor ${sha} HEAD`, DEFAULT_EXEC_TIMEOUT_MS);
          if (anc.exitCode !== 0) recreate = true; // stale: behind/diverged from the mirror tip
        }
      }
      if (!recreate) return false;
    }

    await this.runOk(["rm", "-rf", wt], "worktree-clean");
    await this.runOk(
      ["git", "clone", "--no-hardlinks", "--branch", binding.ref, MIRROR_DIR, wt],
      "worktree-clone",
      { timeoutMs: GIT_NETWORK_TIMEOUT_MS },
    );
    await this.runOk(["chown", "-R", `${binding.user}:${binding.user}`, wt], "worktree-chown");
    await this.threadRunOk(
      binding.user,
      wt,
      `git remote set-url origin https://github.com/${slug}.git`,
      "worktree-remote",
      DEFAULT_EXEC_TIMEOUT_MS,
    );
    return true;
  }

  /** Materialize the dep/build cache (KTD7). Same committed-lockfile key as
   *  the warm checkout → hardlink-copy (cp -al) node_modules/build dirs from
   *  it, chowning only DIRECTORIES to the thread user: file inodes stay
   *  worker1-owned and read-only to the thread, so a thread can delete or
   *  replace entries in its own tree but can never mutate the inodes shared
   *  with the warm checkout. cp -al failing (e.g. cross-device) falls back
   *  to a plain copy (fresh inodes, fully chowned). A differing key runs the
   *  repo's install command in the worktree, token-free, as the thread user. */
  private async materializeThreadDeps(
    binding: { user: string; worktreePath: string }, // a ThreadBinding, or U6's per-op checkout
    threadLockKey: string,
    warmLockKey: string,
    installCmd: string,
  ): Promise<{ deps: ThreadDepsMechanism; reconciled: boolean }> {
    const wt = binding.worktreePath;
    const hasDeps = (await this.run(["test", "-d", `${wt}/node_modules`])).exitCode === 0;
    if (hasDeps) return { deps: "none", reconciled: false }; // reused tree, cache already in place

    if (threadLockKey === warmLockKey) {
      let mech: ThreadDepsMechanism = "none";
      // Serialize the hardlink-copy on the mirror mutex (FIX 2): `cp -al` reads
      // CHECKOUT_DIR, which the refresh alarm rebuilds under the same lock, so
      // this can never hardlink a half-rebuilt checkout into the thread tree.
      // Bounded by ATTACH_MUTEX_WAIT_MS — an attach waits out an in-flight
      // rebuild, else MirrorBusyError → 503 mirror-busy (the bot-side fallback
      // retries). Callers invoke materializeThreadDeps OUTSIDE their own mirror
      // lock, so this fresh acquire is not a re-entrant double-lock.
      await this.withMirrorLock(async () => {
        for (const dir of DEP_CACHE_DIRS) {
          const src = `${CHECKOUT_DIR}/${dir}`;
          const dst = `${wt}/${dir}`;
          if ((await this.run(["test", "-d", src])).exitCode !== 0) continue;
          if ((await this.run(["test", "-e", dst])).exitCode === 0) continue;
          const hard = await this.run(["cp", "-al", src, dst], { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
          if (hard.exitCode === 0) {
            await this.runOk(
              ["sh", "-c", `find ${dst} -type d -exec chown ${binding.user}:${binding.user} {} +`],
              "deps-chown",
            );
            // The hardlinked FILE inodes stay owned by the warm-checkout user
            // and are shared with the warm checkout and every peer worktree.
            // Dirs-only chown lets the thread delete/replace entries in its own
            // tree, but an unusual world/group-writable file (an odd dependency
            // file or a permissively-emitted build artifact under node_modules/
            // dist/build/.next) would still be mutable THROUGH the shared inode
            // → cross-thread tamper / cache poisoning the next snapshot could
            // capture. Strip group/world write from the shared file inodes
            // (read stays intact, so the thread can still consume the cache).
            await this.runOk(
              ["sh", "-c", `find ${dst} -type f \\( -perm -g+w -o -perm -o+w \\) -exec chmod go-w {} +`],
              "deps-harden",
            );
            if (mech === "none") mech = "hardlink";
          } else {
            await this.run(["rm", "-rf", dst]);
            await this.runOk(["cp", "-R", src, dst], "deps-copy", { timeoutMs: GIT_NETWORK_TIMEOUT_MS });
            await this.runOk(["chown", "-R", `${binding.user}:${binding.user}`, dst], "deps-copy-chown");
            mech = "copy";
          }
        }
      }, ATTACH_MUTEX_WAIT_MS);
      return { deps: mech, reconciled: false };
    }

    // Committed lockfile differs from the warm checkout: scoped, token-free
    // incremental install as the thread user (KTD7).
    await this.threadRunOk(binding.user, wt, installCmd, "thread-install", REFRESH_BUILD_TIMEOUT_MS);
    return { deps: "install", reconciled: true };
  }

  /** Per-attach credential file (KTD12): the minted token reaches the
   *  worktree via the SDK file API into a 700 per-user staging dir, then a
   *  privilege-dropped `cat` into `.git/github-credentials` (0600, owned by
   *  the thread user). The token never appears in argv or process-wide env —
   *  `ps` from another thread user sees file PATHS at most. The worktree's
   *  git credential helper points at the file. */
  private async writeThreadCredentials(binding: ThreadBinding, token: string): Promise<void> {
    const stageDir = `/workspace/.stage-${binding.user}`;
    const stage = `${stageDir}/cred`;
    await this.runOk(["install", "-d", "-m", "700", "-o", binding.user, "-g", binding.user, stageDir], "stage-dir");
    await this.writeFile(stage, `https://x-access-token:${token}@github.com\n`);
    await this.runOk(["chown", `${binding.user}:${binding.user}`, stage], "stage-chown");
    await this.runOk(["chmod", "600", stage], "stage-chmod");
    const cred = `${binding.worktreePath}/.git/github-credentials`;
    await this.threadRunOk(
      binding.user,
      binding.worktreePath,
      `umask 077 && cat ${stage} > ${cred} && rm -f ${stage} && chmod 600 ${cred} && git config credential.helper 'store --file=${cred}'`,
      "thread-cred",
      DEFAULT_EXEC_TIMEOUT_MS,
    );
  }

  /** Shared entry checks for exec/read/write: hydrated resident, live
   *  binding, worktree actually on disk (the container may have slept since
   *  the last attach — disk is cache, re-attach recreates). */
  private async threadPreflight(threadKey: string): Promise<{ binding: ThreadBinding } | ThreadErr> {
    try {
      await this.ensureHydrated();
    } catch (err) {
      const s = await this.getStatus();
      return { error: `not-serviceable: ${errMsg(err)}`, status: 503, state: s.state, reason: s.reason };
    }
    const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (!binding) {
      return { error: "not-attached: no binding for this threadKey — POST /attach first", status: 409, needs: "attach" };
    }
    if (binding.evicted || !binding.user) {
      return { error: "evicted: this thread's worktree was evicted after inactivity — POST /attach to recreate", status: 409, needs: "attach" };
    }
    if ((await this.run(["test", "-d", `${binding.worktreePath}/.git`])).exitCode !== 0) {
      return { error: "worktree-missing: the container disk was recycled since the last attach — POST /attach to recreate", status: 409, needs: "attach" };
    }
    return { binding };
  }

  /** POST /exec: run one shell command in the thread's worktree as the
   *  thread's user. Output mirrors the thread-sandbox Worker's shape
   *  ({stdout, stderr, exitCode}, notes appended to stderr, timeout as exit
   *  124); streams/caps are the Worker's job, truncation happens here. */
  /** In-flight thread operations (exec/read/write) per threadKey — DO memory
   *  only. /detach refuses (keeps, reason "busy") while any is running so a
   *  run's release can never yank a worktree out from under a concurrent
   *  command on the same thread (a queued follow-up message, two runs racing). */
  private threadOpsInFlight = new Map<string, number>();

  private async withThreadBusy<T>(threadKey: string, fn: () => Promise<T>): Promise<T> {
    this.threadOpsInFlight.set(threadKey, (this.threadOpsInFlight.get(threadKey) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const n = (this.threadOpsInFlight.get(threadKey) ?? 1) - 1;
      if (n <= 0) this.threadOpsInFlight.delete(threadKey);
      else this.threadOpsInFlight.set(threadKey, n);
    }
  }

  async execThread(
    threadKey: string,
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean } | ThreadErr> {
    return this.withThreadBusy(threadKey, () => this.execThreadImpl(threadKey, command, timeoutMs));
  }

  private async execThreadImpl(
    threadKey: string,
    command: string,
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean } | ThreadErr> {
    const pre = await this.threadPreflight(threadKey);
    if ("error" in pre) return pre;
    const { binding } = pre;
    await this.ctx.storage.put(threadBindingKey(threadKey), {
      ...binding,
      lastAttachAt: new Date().toISOString(), // exec counts as activity for the sweep
    } satisfies ThreadBinding);

    let r: Awaited<ReturnType<ResidentDO["threadRun"]>>;
    try {
      r = await this.threadRun(binding.user, binding.worktreePath, command, timeoutMs);
    } catch (err) {
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      throw err;
    }
    const truncated = r.stdout.length > EXEC_OUTPUT_CAP || r.stderr.length > EXEC_OUTPUT_CAP;
    const notes: string[] = [];
    if (r.timedOut) notes.push(`command timed out after ${timeoutMs}ms; re-run as smaller steps or background it`);
    if (truncated) notes.push(`output truncated to ${EXEC_OUTPUT_CAP} chars per stream`);
    const stderr = [r.stderr.slice(0, EXEC_OUTPUT_CAP), ...notes].filter(Boolean).join("\n");
    return {
      stdout: r.stdout.slice(0, EXEC_OUTPUT_CAP),
      stderr,
      exitCode: r.timedOut ? 124 : r.exitCode,
      truncated,
    };
  }

  /** POST /read: cat the file AS THE THREAD USER — the OS layer (not just
   *  the prefix check) is what confines a symlink pointing outside. */
  async readThreadFile(threadKey: string, path: string): Promise<{ content: string; truncated: boolean } | ThreadErr> {
    return this.withThreadBusy(threadKey, () => this.readThreadFileImpl(threadKey, path));
  }

  private async readThreadFileImpl(threadKey: string, path: string): Promise<{ content: string; truncated: boolean } | ThreadErr> {
    const pre = await this.threadPreflight(threadKey);
    if ("error" in pre) return pre;
    const resolved = confineThreadPath(pre.binding.worktreePath, path);
    if (!resolved) return { error: `path-escape: ${JSON.stringify(path)} does not stay inside the thread worktree`, status: 400 };
    let r: Awaited<ReturnType<ResidentDO["threadRun"]>>;
    try {
      r = await this.threadRun(pre.binding.user, pre.binding.worktreePath, `cat -- ${resolved}`, DEFAULT_EXEC_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      throw err;
    }
    if (r.exitCode !== 0 || r.timedOut) return { error: `read-failed: ${tail(r.stderr || r.stdout)}`, status: 404 };
    const truncated = r.stdout.length > READ_CONTENT_CAP;
    return { content: truncated ? r.stdout.slice(0, READ_CONTENT_CAP) : r.stdout, truncated };
  }

  /** POST /write: content travels via the SDK file API into the thread's
   *  700 staging dir (never argv — another thread's `ps` must not see it),
   *  then a privilege-dropped `cat` moves it into the worktree. Writing as
   *  the user (not root) means a planted symlink cannot escalate the write
   *  beyond what the user could touch anyway. */
  async writeThreadFile(threadKey: string, path: string, content: string): Promise<{ ok: true; bytes: number } | ThreadErr> {
    return this.withThreadBusy(threadKey, () => this.writeThreadFileImpl(threadKey, path, content));
  }

  private async writeThreadFileImpl(threadKey: string, path: string, content: string): Promise<{ ok: true; bytes: number } | ThreadErr> {
    const pre = await this.threadPreflight(threadKey);
    if ("error" in pre) return pre;
    const { binding } = pre;
    const resolved = confineThreadPath(binding.worktreePath, path);
    if (!resolved) return { error: `path-escape: ${JSON.stringify(path)} does not stay inside the thread worktree`, status: 400 };
    const stageDir = `/workspace/.stage-${binding.user}`;
    const stage = `${stageDir}/put`;
    try {
      await this.runOk(["install", "-d", "-m", "700", "-o", binding.user, "-g", binding.user, stageDir], "stage-dir");
      await this.writeFile(stage, content);
      await this.runOk(["chown", `${binding.user}:${binding.user}`, stage], "stage-chown");
      await this.runOk(["chmod", "600", stage], "stage-chmod");
      await this.threadRunOk(
        binding.user,
        binding.worktreePath,
        `mkdir -p ${parentDir(resolved)} && cat ${stage} > ${resolved} && rm -f ${stage}`,
        "thread-write",
        DEFAULT_EXEC_TIMEOUT_MS,
      );
    } catch (err) {
      if (err instanceof RuntimeReplacedError) return runtimeReplacedErr(err);
      const step = err instanceof StepError ? ` at ${err.step}` : "";
      return { error: `write-failed${step}: ${errMsg(err)}`, status: 400 };
    }
    return { ok: true, bytes: content.length };
  }

  /** Remove a thread's worktree (when the runtime is up — a slept container
   *  already lost it) and release its pool user; the binding is KEPT, marked
   *  evicted, so the ref stays sticky and the next attach recreates the tree
   *  (KTD6). Shared by the inactivity sweep and /detach. */
  private async evictBinding(binding: ThreadBinding, runtimeActive: boolean, logCtx: string): Promise<boolean> {
    const threadDir = parentDir(binding.worktreePath);
    if (runtimeActive && threadDir.startsWith(`${THREADS_DIR}/`)) {
      try {
        // Worktree removal counts as a mirror-adjacent mutation — same mutex (KTD5).
        await this.withMirrorLock(() => this.runOk(["rm", "-rf", threadDir], "evict"));
      } catch (err) {
        console.log(`${logCtx}: rm failed for ${binding.threadKey}: ${errMsg(err)}`);
      }
    }
    // The rm above awaited the mirror lock; a re-attach that STARTED in that
    // window has since bumped lastAttachAt (and will recreate the tree under
    // the same lock). Writing `user:""` over it would free a user the
    // re-attach is still holding — so re-read and give way instead.
    const now = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey));
    if (!now || now.evicted || now.lastAttachAt !== binding.lastAttachAt) {
      const why = !now ? "binding deleted" : now.evicted ? "already evicted (concurrent eviction)" : "re-attached";
      console.log(`${logCtx}: ${binding.threadKey} ${why} during eviction — binding left as is`);
      return false;
    }
    await this.ctx.storage.put(threadBindingKey(binding.threadKey), {
      ...now,
      user: "",
      evicted: true,
      evictedAt: new Date().toISOString(),
    } satisfies ThreadBinding);
    return true;
  }

  /** POST /detach: a run has ended — give the thread's pool user back now
   *  instead of holding it until the TTL sweep (the pool is sized for
   *  simultaneous runs). `force` releases unconditionally (read-only agents,
   *  hard stops): an op still in flight is KILLED first (#159 — the bot has
   *  already dropped its fetch, the command would otherwise run on and hold
   *  the user until the sweep); otherwise a busy thread, or a worktree with
   *  uncommitted or unpushed work, is KEPT and the caller learns why. No
   *  binding → 404-shaped error; already evicted → a no-op success. Never
   *  flips lifecycle state. */
  async detachThread(threadKey: string, force: boolean): Promise<{ released: boolean; reason?: string; user?: string } | ThreadErr> {
    const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (!binding) return { error: `no-binding: ${threadKey} has never attached to this resident`, status: 404 };
    if (binding.evicted || !binding.user) return { released: false, reason: "already-evicted" };
    const plan = planForceDetach({
      force,
      inFlight: this.threadOpsInFlight.get(threadKey) ?? 0,
      user: binding.user,
      poolUsers: THREAD_USERS,
    });
    if (plan.action === "refuse") return { released: false, reason: plan.reason, user: binding.user };
    if (plan.action === "kill") {
      await this.killThreadUserProcesses(plan.user);
      console.log(`detach: force — killed ${plan.user}'s processes for ${threadKey} (${plan.inFlight} op(s) were in flight)`);
      const left = await this.waitForThreadDrain(threadKey);
      if (left > 0) return { released: false, reason: busyAfterKillReason(left), user: binding.user };
    }
    const active = await this.isRuntimeActive().catch(() => false);
    if (!force && active) {
      const c = await this.worktreeCleanliness(binding);
      if (!c.clean) return { released: false, reason: `${c.reason} — kept`, user: binding.user };
    }
    // Re-check right before removal: the clean check above awaited (the DO
    // yields at each await), so an exec that arrived mid-detach would otherwise
    // have its tree removed under it.
    const busyNow = this.threadOpsInFlight.get(threadKey) ?? 0;
    if (busyNow > 0) return { released: false, reason: `busy: ${busyNow} operation(s) started during detach — kept`, user: binding.user };
    // Same re-read as the sweep: a re-attach during the clean check means a
    // fresh tree we must not remove from a stale snapshot.
    const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (!current || current.evicted) return { released: false, reason: "already-evicted" };
    if (current.lastAttachAt !== binding.lastAttachAt) return { released: false, reason: "re-attached during the clean check — kept", user: current.user };
    const user = current.user;
    // Same as the sweep: `active` was read before the clean check's awaits; a
    // container that woke meanwhile must get the rm, not an orphaned tree.
    const activeNow = await this.isRuntimeActive().catch(() => false);
    if (!(await this.evictBinding(current, activeNow, `detach`))) {
      return { released: false, reason: "re-attached during eviction — kept", user };
    }
    return { released: true, user };
  }

  /** Force-detach's kill (#159): end every process owned by the pool user —
   *  `kill -9 -1` sent AS THAT USER reaches exactly its own processes (the
   *  thread's `su … bash -c` shell, the command, anything it backgrounded),
   *  nothing else in the container, and needs no procps. The shell kills
   *  itself too, so su exits 137 — any exit code is fine, and a throw
   *  (runtime replaced mid-kill) is fine as well: the drain wait after it is
   *  what decides, and it is bounded. Only ever called with a plan from
   *  `planForceDetach`, which refuses anything but a `THREAD_USERS` member. */
  private async killThreadUserProcesses(user: string): Promise<void> {
    try {
      await this.run(["su", "-s", "/bin/bash", user, "-c", "kill -9 -1"], { timeoutMs: FORCE_DETACH_KILL_TIMEOUT_MS });
    } catch (err) {
      console.log(`detach: force — kill as ${user} threw (continuing to the drain wait): ${errMsg(err)}`);
    }
  }

  /** Wait (bounded, see FORCE_DETACH_DRAIN_MS) for this thread's in-flight op
   *  counter to reach zero after a kill. The counter drops inside
   *  `withThreadBusy`'s finally, i.e. only after `run()` has collected the
   *  killed process's exit — so a zero here means every process the op ran
   *  is already dead, and the eviction's `rm -rf` of the worktree (the op's
   *  cwd) cannot race a live command. The killed op itself completes
   *  normally through `execThreadImpl` → `streamThreadExec` (exit 137 to a
   *  client that has usually already hung up). Returns the count still in
   *  flight when the bound expires (0 = drained). */
  private async waitForThreadDrain(threadKey: string): Promise<number> {
    const deadline = Date.now() + FORCE_DETACH_DRAIN_MS;
    for (;;) {
      const left = this.threadOpsInFlight.get(threadKey) ?? 0;
      if (left === 0 || Date.now() >= deadline) return left;
      await new Promise((r) => setTimeout(r, FORCE_DETACH_DRAIN_POLL_MS));
    }
  }

  /** Is this thread's tree safe to destroy? Runs AS THE THREAD USER (threadRun
   *  → su), never as root: the worktree is thread-owned, so root git in it
   *  would be refused by safe.directory and would be the exact repo-local-
   *  config execution vector safe.directory exists to block. Unknown (git
   *  failed) counts as NOT clean — never destroy work on a guess. */
  private async worktreeCleanliness(binding: ThreadBinding): Promise<{ clean: boolean; reason?: string }> {
    // A tree that no longer exists (disk recycled by a sleep/wake) has nothing
    // to preserve: releasable, so a post-wake binding does not hold a pool
    // user for 7 days on behalf of files that are already gone.
    const present = await this.run(["test", "-d", `${binding.worktreePath}/.git`]);
    if (present.exitCode !== 0) return { clean: true, reason: "worktree missing (disk recycled)" };
    const status = await this.threadRun(binding.user, binding.worktreePath, "git status --porcelain", DEFAULT_EXEC_TIMEOUT_MS);
    const ahead = await this.threadRun(binding.user, binding.worktreePath, "git rev-list --count HEAD --not --remotes", DEFAULT_EXEC_TIMEOUT_MS);
    if (status.exitCode !== 0 || ahead.exitCode !== 0) {
      const why = (status.stderr || ahead.stderr || "git exited non-zero").trim().split("\n")[0];
      return { clean: false, reason: `clean-check failed: ${why}` };
    }
    const changes = status.stdout.trim() ? status.stdout.trim().split("\n").length : 0;
    const unpushed = Number(ahead.stdout.trim()) || 0;
    if (changes > 0 || unpushed > 0) return { clean: false, reason: `dirty: ${changes} uncommitted change(s), ${unpushed} unpushed commit(s)` };
    return { clean: true };
  }

  /** Anything that must not be interrupted by a container stop or counted
   *  as idle: thread exec/read/write, disposable /op runs, and attaches past
   *  their own image check (mid clone/install under the mirror lock). */
  private inFlightCount(): number {
    const threadOps = [...this.threadOpsInFlight.values()].reduce((a, n) => a + n, 0);
    return threadOps + this.opUsersInUse.size + this.attachesInFlight + this.refreshesInFlight;
  }
  /** In-flight activity for the deploy preflight (GET /status, GET /residents).
   *  In-memory by nature: a fresh isolate answers 0, which is correct — nothing
   *  survived to be interrupted. */
  async getInFlightCount(): Promise<number> {
    return this.inFlightCount();
  }
  private attachesInFlight = 0;
  /** A refresh cycle past its idle/reconcile gates (fetching, rebuilding, snapshotting). */
  private refreshesInFlight = 0;

  /** Hourly inactivity sweep (schedule: onWorktreeSweep). Removes worktrees
   *  whose binding is idle past the TTL, releases the user to the pool, and
   *  KEEPS the binding record marked evicted (KTD6). Never wakes a slept
   *  container just to delete files a sleep already destroyed. */
  /** True while onWorktreeSweep is executing (DO memory; a restart clears it
   *  together with the in-flight sweep). The watchdog's re-arm checks it so
   *  two sweep chains can never be armed by construction. */
  private sweepInFlight = false;

  async onWorktreeSweep(payload: string): Promise<{ evicted: string[]; kept: number }> {
    const resource = payload || ((await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "");
    const evicted: string[] = [];
    let kept = 0;
    this.sweepInFlight = true;
    try {
      const record = await this.registry()
        .getRecord(resource)
        .catch(() => null);
      const ttlDays = record?.worktreeTtlDays ?? WORKTREE_TTL_DAYS_DEFAULT;
      const cutoff = Date.now() - ttlDays * 86_400_000;
      const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
      const active = await this.isRuntimeActive().catch(() => false);
      const idleCutoff = Date.now() - CLEAN_IDLE_RELEASE_S * 1000;
      for (const binding of all.values()) {
        if (binding.evicted || !binding.user) continue;
        const last = Date.parse(binding.lastAttachAt);
        if (last >= cutoff) {
          // Not past the TTL. Still release it if it has been idle for an hour,
          // nothing is running on it, and the tree is provably clean — the run
          // that used it is over and there is nothing to preserve. A slept
          // container has NO tree any more (sleep destroys the disk), so an
          // idle binding on an inactive runtime is releasable outright: there is
          // nothing left to protect, only a pool user to give back. (Live
          // 2026-08-29: seven idle bindings sat on a sleeping resident until the
          // 7-day TTL because this path kept them.)
          const busy = this.threadOpsInFlight.get(binding.threadKey) ?? 0;
          const cleanIdle =
            last < idleCutoff && busy === 0 && (!active || (await this.worktreeCleanliness(binding)).clean);
          // Re-read right before removal: the clean check awaited (the DO
          // yields), so an exec that arrived meanwhile would otherwise have
          // its tree removed under it — same guard as detachThread.
          const busyNow = this.threadOpsInFlight.get(binding.threadKey) ?? 0;
          if (!cleanIdle || busyNow > 0) {
            kept++;
            continue;
          }
        }
        // Re-read the binding too: a re-attach that completed inside the
        // clean-check await bumped lastAttachAt and rebuilt the tree — evicting
        // from this loop's stale snapshot would rm the fresh tree.
        const current = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(binding.threadKey));
        if (!current || current.evicted || current.lastAttachAt !== binding.lastAttachAt) {
          kept++;
          continue;
        }
        // `active` is re-read per binding: the container can wake mid-sweep (an
        // attach), and an eviction decided on a stale "inactive" would skip the
        // rm and orphan a real tree.
        const activeNow = await this.isRuntimeActive().catch(() => false);
        if (await this.evictBinding(current, activeNow, `worktree-sweep ${resource}`)) evicted.push(binding.threadKey);
        else kept++;
      }
    } finally {
      const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
      const live = [...all.values()].some((b) => !b.evicted && b.user);
      this.deleteSchedules(SWEEP_CALLBACK);
      if (live) await this.schedule(SWEEP_INTERVAL_S, SWEEP_CALLBACK, resource);
      this.sweepInFlight = false;
    }
    return { evicted, kept };
  }

  // -- deterministic ops (U6, KTD8: /op — disposable per-op checkouts) ---------

  /** Pool users transiently held by in-flight ops. DO memory only: an op is
   *  bounded by one request, and a DO restart kills the in-flight op anyway
   *  (its orphaned OPS_DIR entry dies with the container disk at the latest).
   *  Both this allocator and allocateThreadUser exclude the set, so an op
   *  never shares an OS user with a thread or another op. */
  private opUsersInUse = new Set<string>();

  /** Transient allocation: storage reads + a synchronous set-add in the same
   *  microtask (atomic under the DO input gate, like allocateThreadUser).
   *  Returns null when threads + ops have the whole pool busy. */
  private async allocateOpUser(): Promise<string | null> {
    const user = await this.findFreePoolUser();
    if (user) this.opUsersInUse.add(user);
    return user ?? null;
  }

  /** POST /op work half (U6, KTD8): run ONE readonly command-table entry in a
   *  disposable checkout under OPS_DIR — never a thread's attached worktree —
   *  privilege-dropped as a transiently-held pool user, then delete the
   *  checkout whatever happened. The command STRING comes exclusively from
   *  the admin-written table; the ref was pattern-validated by the Worker and
   *  must additionally resolve in the mirror (fetching once if unknown);
   *  request text is never interpolated into a shell command. Deps
   *  materialize through the exact thread mechanism (KTD7): the shared
   *  lockfile-keyed cache, scoped token-free install only when the committed
   *  key differs. No snapshot is ever written here (KTD3). */
  async runOp(op: "test" | "build", refArg: string | null): Promise<OpRunOk | ThreadErr> {
    const t0 = Date.now();
    try {
      await this.ensureHydrated();
    } catch (err) {
      const s = await this.getStatus();
      return { error: `not-serviceable: ${errMsg(err)}`, status: 503, state: s.state, reason: s.reason };
    }
    const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
    const record = await this.registry().getRecord(resource);
    const facts = await this.ctx.storage.get<RepoFacts>(FACTS_KEY);
    if (!record || !facts) return { error: "not-serviceable: registry record or repo facts missing", status: 503 };
    const command = record.commands[op];
    if (!command) return { error: `op-unavailable: the command table has no "${op}" entry`, status: 400 };

    const user = await this.allocateOpUser();
    if (!user) {
      return {
        error: `user-pool-exhausted: all ${THREAD_USERS.length} pool users are busy (threads or in-flight ops); try again shortly`,
        status: 429,
      };
    }
    const opDir = `${OPS_DIR}/${crypto.randomUUID()}`;
    const checkout = `${opDir}/checkout`;
    try {
      // Command-level token mint, attach's discipline (KTD12): only a mirror
      // fetch for an unknown ref would use it; failure never blocks the op.
      let token: string | null = null;
      if (githubAppConfigured(this.env)) {
        token = await mintRepoScopedToken(this.env, resource.slice("repo:".length)).catch(() => null);
      }
      const locked = await this.withMirrorLock(async () => {
        await this.ensureGitSetup();
        const ref = refArg ?? facts.defaultRef;
        if (!(await this.refExists(ref))) {
          await this.gitWithCred(token, ["-C", MIRROR_DIR, "fetch", "--prune", "origin"], "fetch", GIT_NETWORK_TIMEOUT_MS);
          if (!(await this.refExists(ref))) {
            throw new StepError("unknown-ref", `ref ${JSON.stringify(ref)} does not resolve in the mirror (even after a fetch)`);
          }
        }
        const sha = await this.readMirrorSha(ref);
        const lockKey = await this.lockfileKey(sha);
        await this.runOk(["install", "-d", "-m", "755", "-o", "root", "-g", "root", OPS_DIR], "ops-dir");
        // 700 op dir first, clone beneath it: the tree is unreadable to peer
        // users for its whole life, exactly like a thread dir (KTD5).
        await this.runOk(["install", "-d", "-m", "700", "-o", user, "-g", user, opDir], "op-dir");
        await this.runOk(["git", "clone", "--no-hardlinks", "--branch", ref, MIRROR_DIR, checkout], "op-clone", {
          timeoutMs: GIT_NETWORK_TIMEOUT_MS,
        });
        await this.runOk(["chown", "-R", `${user}:${user}`, checkout], "op-chown");
        return { ref, sha, lockKey };
      }, ATTACH_MUTEX_WAIT_MS);

      const deps = await this.materializeThreadDeps(
        { user, worktreePath: checkout },
        locked.value.lockKey,
        facts.lockfileHash,
        record.commands.install ?? "npm install --no-audit --no-fund",
      );

      const r = await this.threadRun(user, checkout, command, MAX_THREAD_EXEC_TIMEOUT_MS);
      const ok = r.exitCode === 0 && !r.timedOut;
      const truncated = r.stdout.length > EXEC_OUTPUT_CAP || r.stderr.length > EXEC_OUTPUT_CAP;
      const notes: string[] = [];
      if (r.timedOut) notes.push(`command timed out after ${MAX_THREAD_EXEC_TIMEOUT_MS}ms`);
      if (truncated) notes.push(`output truncated to ${EXEC_OUTPUT_CAP} chars per stream`);
      const durationMs = Date.now() - t0;
      const sha8 = locked.value.sha.slice(0, 8);
      const exitCode = r.timedOut ? 124 : r.exitCode;
      return {
        ok,
        op,
        resource,
        ref: locked.value.ref,
        sha: locked.value.sha,
        summary: ok
          ? `${op} passed on ${resource} @ ${locked.value.ref} (${sha8}) in ${Math.round(durationMs / 1000)}s`
          : `${op} failed (exit ${exitCode}${r.timedOut ? ", timed out" : ""}) on ${resource} @ ${locked.value.ref} (${sha8})`,
        stdout: r.stdout.slice(0, EXEC_OUTPUT_CAP),
        stderr: [r.stderr.slice(0, EXEC_OUTPUT_CAP), ...notes].filter(Boolean).join("\n"),
        exitCode,
        truncated,
        deps: deps.deps,
        reconciled: deps.reconciled,
        durationMs,
      };
    } catch (err) {
      if (err instanceof MirrorBusyError) {
        const s = await this.getStatus();
        return { error: errMsg(err), status: 503, state: s.state, reason: "mirror-busy" };
      }
      if (err instanceof StepError && err.step === "unknown-ref") {
        return { error: `unknown-ref: ${err.message}`, status: 400 };
      }
      const step = err instanceof StepError ? ` at ${err.step}` : "";
      return { error: `op-failed${step}: ${errMsg(err)}`, status: 500 };
    } finally {
      // Disposable means disposable: the checkout dies with the op, pass or
      // fail (best effort — a slept container already destroyed it anyway).
      await this.run(["rm", "-rf", opDir]).catch(() => {});
      this.opUsersInUse.delete(user);
    }
  }

  /** Debug: enumerate thread bindings (read scope). No secrets live in a
   *  binding; worktreePath is omitted like getResidentInfo does — internal
   *  disk layout is not part of the lower-trust read surface. */
  async debugThreads(): Promise<{ threads: Array<Omit<ThreadBinding, "worktreePath">> }> {
    const all = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    return { threads: [...all.values()].map(({ worktreePath: _internal, ...rest }) => rest) };
  }

  /** Debug fault injection: age a binding so the sweep's TTL path can be
   *  exercised without waiting N days. */
  async debugBackdateThread(threadKey: string, days: number): Promise<{ ok: boolean; lastAttachAt?: string }> {
    const binding = await this.ctx.storage.get<ThreadBinding>(threadBindingKey(threadKey));
    if (!binding) return { ok: false };
    const lastAttachAt = new Date(Date.now() - days * 86_400_000).toISOString();
    await this.ctx.storage.put(threadBindingKey(threadKey), { ...binding, lastAttachAt } satisfies ThreadBinding);
    return { ok: true, lastAttachAt };
  }

  /** Debug: run the sweep pass now (the exact scheduled function). */
  async debugSweepNow(): Promise<{ evicted: string[]; kept: number }> {
    return this.onWorktreeSweep("");
  }

  // -- state + introspection ---------------------------------------------------

  /** Persist a lifecycle transition. degraded/down always carry a reason. */
  async setResidentState(state: ResidentState, reason = ""): Promise<void> {
    if ((state === "degraded" || state === "down") && !reason) {
      throw new Error(`state "${state}" requires a reason`);
    }
    await this.ctx.storage.put({
      [STATE_KEY]: state,
      [REASON_KEY]: reason,
      [UPDATED_KEY]: new Date().toISOString(),
    });
  }

  async getStatus(): Promise<ResidentStatus> {
    const map = await this.ctx.storage.get<string>([STATE_KEY, REASON_KEY]);
    const state = map.get(STATE_KEY) as ResidentState | undefined;
    if (!state) {
      return { state: "down", reason: "no resident state persisted (never onboarded, or already offboarded)" };
    }
    return { state, reason: map.get(REASON_KEY) ?? "" };
  }

  /** Full admin-facing view (surfaced via GET /residents and /debug info):
   *  lifecycle + recorded sha/cache keys/snapshot stamp/refresh telemetry.
   *  Backup handles are reduced to ids — never the raw handle internals. */
  async getResidentInfo(): Promise<Record<string, unknown>> {
    const map = await this.ctx.storage.get<unknown>([RESOURCE_KEY, STATE_KEY, REASON_KEY, UPDATED_KEY, FACTS_KEY, SNAPSHOT_KEY]);
    const facts = map.get(FACTS_KEY) as RepoFacts | undefined;
    const snap = map.get(SNAPSHOT_KEY) as SnapshotRecord | undefined;
    const [refresh, provisionRun, provisionDeadline, bindings] = await Promise.all([
      this.listSchedules(REFRESH_CALLBACK),
      this.listSchedules(PROVISION_RUN_CALLBACK),
      this.listSchedules(PROVISIONING_CALLBACK),
      this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX }),
    ]);
    // Thread worktree bindings (U4/KTD6) for the admin view: which refs are
    // live on this resident. worktreePath is an internal layout detail and is
    // left out; nothing here is secret (credential files are never persisted).
    const threads = [...bindings.values()]
      .sort((a, b) => b.lastAttachAt.localeCompare(a.lastAttachAt))
      .map(({ threadKey, ref, sha, user, deps, boundAt, lastAttachAt, evicted, evictedAt }) => ({
        threadKey, ref, sha: sha ?? null, user, deps: deps ?? null, boundAt, lastAttachAt, evicted: evicted ?? false, evictedAt: evictedAt ?? null,
      }));
    return {
      resource: map.get(RESOURCE_KEY) ?? null,
      state: map.get(STATE_KEY) ?? "down",
      reason: map.get(REASON_KEY) ?? "",
      updatedAt: map.get(UPDATED_KEY) ?? null,
      defaultRef: facts?.defaultRef ?? null,
      sha: facts?.sha ?? null,
      lockfileHash: facts?.lockfileHash ?? null,
      provisionedAt: facts?.provisionedAt ?? null,
      lastRefreshAt: facts?.lastRefreshAt ?? null,
      lastRefreshError: facts?.lastRefreshError ?? null,
      lastRestore: facts?.lastRestore ?? null,
      idleSince: facts?.idleSince ?? null,
      snapshot: snap
        ? {
            ref: snap.ref,
            sha: snap.sha,
            lockfileHash: snap.lockfileHash,
            createdAt: snap.createdAt,
            mirrorBackupId: snap.mirror.id,
            checkoutBackupId: snap.checkout.id,
          }
        : null,
      schedules: { refresh: refresh.length, provisionRun: provisionRun.length, provisionDeadline: provisionDeadline.length },
      inFlight: this.inFlightCount(),
      threads,
    };
  }

  // -- debug surface (admin-scoped via POST /debug; used by live validation) ---

  async debugSchedules(): Promise<Record<string, unknown>> {
    const [refresh, provisionRun, provisionDeadline, sweep] = await Promise.all([
      this.listSchedules(REFRESH_CALLBACK),
      this.listSchedules(PROVISION_RUN_CALLBACK),
      this.listSchedules(PROVISIONING_CALLBACK),
      this.listSchedules(SWEEP_CALLBACK),
    ]);
    return { refresh, provisionRun, provisionDeadline, sweep };
  }

  /** Kill the refresh chain (simulates a dead alarm chain for watchdog tests). */
  async debugKillRefresh(): Promise<{ killed: boolean; remaining: number }> {
    this.deleteSchedules(REFRESH_CALLBACK);
    return { killed: true, remaining: (await this.listSchedules(REFRESH_CALLBACK)).length };
  }

  /** Pull the next refresh forward to ~1s from now. */
  async debugRefreshNow(): Promise<{ scheduled: boolean }> {
    const resource = (await this.ctx.storage.get<string>(RESOURCE_KEY)) ?? "";
    this.deleteSchedules(REFRESH_CALLBACK);
    await this.schedule(1, REFRESH_CALLBACK, resource);
    return { scheduled: true };
  }

  /** Fault injection for the watchdog's stuck-onboarding path: re-persist
   *  `onboarding` WITHOUT arming any schedule. With the recorded provisioning
   *  deadline in the past, the next watchdog pass must take this resident to
   *  down(provision-timeout) and release its cap slot. Test-only semantics;
   *  admin scope. */
  async debugForceOnboarding(): Promise<ResidentStatus> {
    await this.setResidentState("onboarding");
    return this.getStatus();
  }

  /** Stop the container (simulates a platform sleep: disk is ephemeral, so the
   *  next refresh must take the restoring→warm wake path). */
  async debugStopContainer(): Promise<{ stopped: boolean; error?: string }> {
    try {
      await this.stop();
      return { stopped: true };
    } catch (err) {
      return { stopped: false, error: errMsg(err) };
    }
  }

  /** Fault injection for the watchdog's auto-rebuild path (U8): persist
   *  `down` with a rehydration-flavored reason and stop the refresh chain
   *  (mirroring what a real goDown does), so repeated watchdog passes can
   *  strike it up to the auto-rebuild without corrupting real R2 objects.
   *  Test-only semantics; admin scope. */
  async debugForceDown(reason: string): Promise<ResidentStatus> {
    await this.setResidentState("down", reason);
    this.deleteSchedules(REFRESH_CALLBACK);
    return this.getStatus();
  }

  /** Rebuild (U8): the down→onboarding escape hatch — discard the recorded
   *  snapshots (R2 objects included) and reprovision from scratch through the
   *  ordinary alarm-driven pipeline, reusing the registry record's command
   *  table/ref/budget. `dryRun` returns the same itemized plan WITHOUT
   *  executing: nothing deleted, no state change, schedules untouched.
   *  Refused while the engine owns the state (onboarding/refreshing/
   *  restoring) — two engine chains must never race the same disk. */
  async rebuild(
    resource: string,
    defaultRef: string,
    provisioningTimeoutMs: number,
    dryRun: boolean,
  ): Promise<
    | {
        resource: string;
        dryRun: boolean;
        from: ResidentStatus;
        discards: {
          snapshot: {
            ref: string;
            sha: string;
            lockfileHash: string;
            createdAt: string;
            mirrorBackupId: string;
            checkoutBackupId: string;
          } | null;
          backupObjects: number;
        };
        reprovision: { defaultRef: string; provisioningTimeoutMs: number };
        keeps: { registryRecord: true; threadBindings: number };
        backupObjectsDeleted?: number;
        state?: ResidentState;
      }
    | { error: string; status: number }
  > {
    const from = await this.getStatus();
    if (from.state === "onboarding" || from.state === "refreshing" || from.state === "restoring") {
      return {
        error: `rebuild-refused: the engine is mid-flight (state ${from.state}) — retry once it settles (warm/degraded/down)`,
        status: 409,
      };
    }
    const snap = await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY);
    const bindings = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    const plan = {
      resource,
      dryRun,
      from,
      discards: {
        snapshot: snap
          ? {
              ref: snap.ref,
              sha: snap.sha,
              lockfileHash: snap.lockfileHash,
              createdAt: snap.createdAt,
              mirrorBackupId: snap.mirror.id,
              checkoutBackupId: snap.checkout.id,
            }
          : null,
        backupObjects: snap ? await this.countBackupObjects([snap.mirror.id, snap.checkout.id]) : 0,
      },
      reprovision: { defaultRef, provisioningTimeoutMs },
      keeps: { registryRecord: true as const, threadBindings: bindings.size },
    };
    if (dryRun) return plan;

    // Old snapshot objects go FIRST: initResident wipes the stored handles,
    // and backups/<id>/ lives outside the resident/<resource>/ prefix — this
    // is the only path that can still reach them (same ordering as teardown).
    let backupObjectsDeleted = 0;
    if (snap) {
      try {
        backupObjectsDeleted = await this.deleteBackupObjects([snap.mirror.id, snap.checkout.id]);
      } catch {
        // best effort — the 1-year R2 TTL is the leak backstop
      }
    }
    await this.ctx.storage.delete(REBUILD_STRIKES_KEY);
    await this.initResident(resource, provisioningTimeoutMs);
    return { ...plan, backupObjectsDeleted, state: "onboarding" as const };
  }

  /** Dry-run itemization for offboard (U8): everything the real teardown
   *  below would remove, computed READ-ONLY — no schedule, storage,
   *  container, or R2 mutation. */
  async teardownPlan(): Promise<{
    state: ResidentState;
    reason: string;
    schedules: number;
    snapshotBackupIds: string[];
    backupObjects: number;
    threadBindings: number;
  }> {
    const status = await this.getStatus();
    const [prov, run, refresh, sweep] = await Promise.all([
      this.listSchedules(PROVISIONING_CALLBACK),
      this.listSchedules(PROVISION_RUN_CALLBACK),
      this.listSchedules(REFRESH_CALLBACK),
      this.listSchedules(SWEEP_CALLBACK),
    ]);
    const snap = await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY);
    const ids = snap ? [snap.mirror.id, snap.checkout.id] : [];
    const bindings = await this.ctx.storage.list<ThreadBinding>({ prefix: THREAD_KEY_PREFIX });
    return {
      ...status,
      schedules: prov.length + run.length + refresh.length + sweep.length,
      snapshotBackupIds: ids,
      backupObjects: await this.countBackupObjects(ids),
      threadBindings: bindings.size,
    };
  }

  /** Offboard teardown: cancel timers, delete the R2 objects behind the SDK
   *  backup handles (they live under backups/<uuid>/, OUTSIDE the
   *  resident/<resource>/ prefix, and the handles die with deleteAll — so
   *  this must happen first), stop the container (best effort), wipe DO
   *  storage. resident/<resource>/ objects are deleted by the Worker. */
  async teardown(): Promise<{
    schedulesCancelled: boolean;
    containerStopped: boolean;
    storageCleared: boolean;
    backupObjectsDeleted: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let containerStopped = false;
    let backupObjectsDeleted = 0;
    this.deleteSchedules(PROVISIONING_CALLBACK);
    this.deleteSchedules(PROVISION_RUN_CALLBACK);
    this.deleteSchedules(REFRESH_CALLBACK);
    this.deleteSchedules(SWEEP_CALLBACK);
    const snap = await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY);
    if (snap) {
      try {
        backupObjectsDeleted = await this.deleteBackupObjects([snap.mirror.id, snap.checkout.id]);
      } catch (err) {
        errors.push(`backup object deletion failed: ${errMsg(err)}`);
      }
    }
    try {
      await this.destroy();
      containerStopped = true;
    } catch (err) {
      errors.push(`destroy failed: ${errMsg(err)}`);
    }
    // Retired DO: clear the alarm the Container base may have armed for its
    // schedules, then wipe storage so nothing ever wakes this object again.
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { schedulesCancelled: true, containerStopped, storageCleared: true, backupObjectsDeleted, errors };
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

/** Constant-time byte comparison. The early length return leaks only the
 *  length, which any comparison leaks; per-byte timing never varies with
 *  content. Deliberate deviation from the thread-sandbox Worker's plain !==. */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

type Scope = "admin" | "operator" | "read";

/** Which token a bearer is, or null. Constant-time per comparison; fail closed
 *  on unset/empty secrets. */
function tokenScope(env: Env, token: string | null): Scope | null {
  if (!token) return null;
  if (env.RESIDENT_ADMIN_TOKEN && timingSafeEqual(token, env.RESIDENT_ADMIN_TOKEN)) return "admin";
  if (env.RESIDENT_OPERATOR_TOKEN && timingSafeEqual(token, env.RESIDENT_OPERATOR_TOKEN)) return "operator";
  if (env.RESIDENT_READ_TOKEN && timingSafeEqual(token, env.RESIDENT_READ_TOKEN)) return "read";
  return null;
}

/** Admin is a strict superset of everything. Operator opens operator routes
 *  only; read opens read routes only — neither ever reaches an admin route. */
function hasScope(env: Env, token: string | null, scope: Scope): boolean {
  const have = tokenScope(env, token);
  if (have === null) return false;
  if (have === "admin") return true;
  return have === scope;
}

/** /debug ops a read-scope bearer may run: pure reads of DO storage/schedules. */
const READ_DEBUG_OPS = new Set(["info", "schedules", "threads"]);

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/** KTD1: "<type>:<id>", lowercase. The whole resource doubles as the sandbox
 *  id (≤63 chars, no leading/trailing hyphen; ':' and '/' are accepted by the
 *  SDK's sanitizeSandboxId). */
const RESOURCE_RE = /^([a-z][a-z0-9-]*):([a-z0-9][a-z0-9._/-]{0,61})$/;
/** repo ids are GitHub "<owner>/<name>" slugs (lowercased): the clone URL
 *  https://github.com/<owner>/<name>.git derives from the id, and the mint
 *  scope (KTD12) uses the <name> half. */
const REPO_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
const SUPPORTED_RESOURCE_TYPES = new Set(["repo"]);

function parseResource(value: unknown): { resource: string } | { error: string } {
  if (typeof value !== "string") return { error: 'resource must be a string like "repo:<owner>/<name>"' };
  if (value.length > 63) return { error: "resource must be at most 63 characters (it doubles as the sandbox id)" };
  const match = RESOURCE_RE.exec(value);
  if (!match) return { error: `resource must match ${String(RESOURCE_RE)}` };
  if (!SUPPORTED_RESOURCE_TYPES.has(match[1])) {
    return { error: `unsupported resource type "${match[1]}" (supported: ${[...SUPPORTED_RESOURCE_TYPES].join(", ")})` };
  }
  if (match[1] === "repo" && !REPO_ID_RE.test(match[2])) {
    return { error: 'repo resource id must be a lowercase GitHub "<owner>/<name>" slug (e.g. "repo:coreplanelabs/switchboard")' };
  }
  return { resource: value };
}

const COMMAND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_COMMAND_LENGTH = 2000;

function parseCommands(value: unknown): { commands: Record<string, string> } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: 'commands must be an object like { "test": "npm test", "build": "npm run build" }' };
  }
  const commands: Record<string, string> = {};
  for (const [name, command] of Object.entries(value)) {
    if (!COMMAND_NAME_RE.test(name)) return { error: `invalid command name ${JSON.stringify(name)}` };
    if (typeof command !== "string" || command.length === 0 || command.length > MAX_COMMAND_LENGTH) {
      return { error: `command ${JSON.stringify(name)} must be a non-empty string of at most ${MAX_COMMAND_LENGTH} chars` };
    }
    commands[name] = command;
  }
  for (const required of ["test", "build"]) {
    if (!(required in commands)) return { error: `commands must include "${required}"` };
  }
  return { commands };
}

/** Execution-profile values (U6, KTD8). */
const EFFECTS_VALUES = new Set(["readonly", "mutating"]);

function parseEffects(value: unknown): { effects: Record<string, "readonly" | "mutating"> } | { error: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { error: 'effects must be an object like { "test": "readonly" } (values: readonly | mutating)' };
  }
  const effects: Record<string, "readonly" | "mutating"> = {};
  for (const [name, effect] of Object.entries(value)) {
    if (!COMMAND_NAME_RE.test(name)) return { error: `invalid command name ${JSON.stringify(name)} in effects` };
    if (typeof effect !== "string" || !EFFECTS_VALUES.has(effect)) {
      return { error: `effects[${JSON.stringify(name)}] must be "readonly" or "mutating"` };
    }
    effects[name] = effect as "readonly" | "mutating";
  }
  return { effects };
}

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Strict branch-ref pattern (P1 input validation): leading alnum rules out
 *  `-option` and `/abs` shapes, the charset rules out shell metacharacters
 *  and whitespace, and `..` / `@{` are refused before the value ever derives
 *  a path or a git argument. */
function parseRef(value: unknown, field: string): { ref: string } | { error: string } {
  if (typeof value !== "string" || !REF_RE.test(value) || value.includes("..") || value.includes("@{") || value.endsWith(".lock")) {
    return { error: `${field} must be a plausible git branch ref (e.g. "main")` };
  }
  return { ref: value };
}

function parseDefaultRef(value: unknown): { defaultRef: string } | { error: string } {
  const parsed = parseRef(value, "defaultRef");
  if ("error" in parsed) return parsed;
  return { defaultRef: parsed.ref };
}

/** Platform-namespaced thread id (P1 input validation, deliberately
 *  conservative): "<platform>:<id>" where the id charset excludes anything
 *  that could carry `../`, whitespace, or shell metacharacters. Validated
 *  BEFORE the key derives a storage key or a disk path. */
const THREAD_KEY_RE = /^[a-z]{1,32}:[A-Za-z0-9._:-]{1,128}$/;

function parseThreadKey(value: unknown): { threadKey: string } | { error: string } {
  if (typeof value !== "string" || !THREAD_KEY_RE.test(value)) {
    return { error: `threadKey must be a platform-namespaced id matching ${String(THREAD_KEY_RE)} (e.g. "slack:C0123ABC:1712345.6789")` };
  }
  return { threadKey: value };
}

function parsePositiveInt(value: unknown, field: string, min: number, max: number): { value: number } | { error: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return { error: `${field} must be an integer between ${min} and ${max}` };
  }
  return { value };
}

/** Optional resident limits shared by /onboard and /reconfigure: each field
 *  is validated only when present; an absent field stays undefined (onboard
 *  applies its own provisioningTimeoutMs default). */
function parseResidentLimits(
  body: Record<string, unknown>,
): { diskBudgetMb?: number; provisioningTimeoutMs?: number; worktreeTtlDays?: number } | { error: string } {
  const limits: { diskBudgetMb?: number; provisioningTimeoutMs?: number; worktreeTtlDays?: number } = {};
  if (body.diskBudgetMb !== undefined) {
    const parsed = parsePositiveInt(body.diskBudgetMb, "diskBudgetMb", 1, 100_000);
    if ("error" in parsed) return { error: parsed.error };
    limits.diskBudgetMb = parsed.value;
  }
  if (body.provisioningTimeoutMs !== undefined) {
    const parsed = parsePositiveInt(
      body.provisioningTimeoutMs,
      "provisioningTimeoutMs",
      MIN_PROVISIONING_TIMEOUT_MS,
      MAX_PROVISIONING_TIMEOUT_MS,
    );
    if ("error" in parsed) return { error: parsed.error };
    limits.provisioningTimeoutMs = parsed.value;
  }
  if (body.worktreeTtlDays !== undefined) {
    const parsed = parsePositiveInt(body.worktreeTtlDays, "worktreeTtlDays", 1, 365);
    if ("error" in parsed) return { error: parsed.error };
    limits.worktreeTtlDays = parsed.value;
  }
  return limits;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const ROUTES: Record<string, { scope: Scope; method: string }> = {
  "/onboard": { scope: "admin", method: "POST" },
  "/offboard": { scope: "admin", method: "POST" },
  "/reconfigure": { scope: "admin", method: "POST" },
  "/rebuild": { scope: "admin", method: "POST" },
  "/residents": { scope: "read", method: "GET" }, // admin implied; read-only bearer allowed
  "/debug": { scope: "read", method: "POST" }, // per-op: READ_DEBUG_OPS for read scope, everything for admin
  "/status": { scope: "operator", method: "GET" },
  "/attach": { scope: "operator", method: "POST" },
  "/detach": { scope: "operator", method: "POST" },
  "/exec": { scope: "operator", method: "POST" },
  "/read": { scope: "operator", method: "POST" },
  "/write": { scope: "operator", method: "POST" },
  "/op": { scope: "operator", method: "POST" },
};

function registryStub(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

function residentStub(env: Env, resource: string) {
  return getSandbox(env.RESIDENT, resource, { sleepAfter: SLEEP_AFTER });
}

/** Per-resource R2 prefix for future resident cache objects; offboard deletes
 *  everything beneath it. NOTE: SDK backup snapshots deliberately do NOT live
 *  here — they land under backups/<uuid>/ and are deleted via the stored
 *  handles in ResidentDO.teardown(). */
const r2Prefix = (resource: string) => `resident/${resource}/`;

/** Cursor-pagination walk over every list page under `prefix` — the shared
 *  half of the delete and count sweeps below. Each next page is fetched only
 *  after the caller finishes with the current one. */
async function* r2PrefixPages(bucket: R2Bucket, prefix: string): AsyncGenerator<Awaited<ReturnType<R2Bucket["list"]>>> {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    yield page;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  for await (const page of r2PrefixPages(bucket, prefix)) {
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
      deleted += page.objects.length;
    }
  }
  return deleted;
}

/** Read-only twin of deleteR2Prefix, for the U8 dry-run itemizations. */
async function countR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let count = 0;
  for await (const page of r2PrefixPages(bucket, prefix)) count += page.objects.length;
  return count;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Unauthenticated wake ping for `npm run deploy` — touches no DO, no data.
    // `u` tracks the last shipped unit so a deploy's propagation is provable
    // from the outside without auth.
    if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true, u: "u6" });

    // Auth precedes existence: unknown paths demand admin before revealing
    // 404 vs 401, so an unauthenticated scanner learns nothing.
    const route = ROUTES[url.pathname];
    const bearer = bearerToken(request);
    if (!hasScope(env, bearer, route?.scope ?? "admin")) {
      return json({ error: "unauthorized" }, 401);
    }
    const isAdmin = tokenScope(env, bearer) === "admin";
    if (!route) return json({ error: "unknown route" }, 404);
    if (request.method !== route.method) return json({ error: `${route.method} only` }, 405);

    const body: Record<string, unknown> =
      route.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

    try {
      switch (url.pathname) {
        case "/onboard":
          return await handleOnboard(env, body);
        case "/offboard":
          return await handleOffboard(env, body);
        case "/reconfigure":
          return await handleReconfigure(env, body);
        case "/rebuild":
          return await handleRebuild(env, body);
        case "/residents":
          return await handleResidents(env);
        case "/debug": {
          // Read scope may only run the pure-read ops; the check happens AFTER
          // auth so an unauthenticated caller still learns nothing extra.
          const op = typeof body.op === "string" ? body.op : "";
          // Authenticated but under-scoped → 403 (401 is reserved for "no valid bearer").
          if (!isAdmin && !READ_DEBUG_OPS.has(op)) return json({ error: "forbidden: admin scope required for this op" }, 403);
          return await handleDebug(env, body);
        }
        case "/status":
          return await handleStatus(env, url);
        case "/attach":
          return await handleAttach(env, body);
        case "/detach":
          return await handleDetach(env, body);
        case "/exec":
          return await handleExec(env, body);
        case "/read":
          return await handleRead(env, body);
        case "/write":
          return await handleWrite(env, body);
        case "/op":
          return await handleOp(env, body);
        default:
          return json({ error: "unknown route" }, 404);
      }
    } catch (err) {
      return json({ error: errMsg(err) }, 500);
    }
  },

  /** Watchdog cron (KTD4): one sparse pass that re-arms dead refresh chains
   *  (marking degraded(alarm-missed)) and times out stuck onboarding. Cadence
   *  invariant: this cron (every 10 minutes) stays SHORTER than SLEEP_AFTER
   *  ("20m"). It reads DO storage/schedules only — containers are started by
   *  the re-armed refresh alarms, not by the watchdog itself. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const summary = await runWatchdog(env);
    console.log(`resident-watchdog: ${JSON.stringify(summary)}`);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleOnboard(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const commands = parseCommands(body.commands);
  if ("error" in commands) return json({ error: commands.error }, 400);
  const defaultRef = parseDefaultRef(body.defaultRef);
  if ("error" in defaultRef) return json({ error: defaultRef.error }, 400);

  const limits = parseResidentLimits(body);
  if ("error" in limits) return json({ error: limits.error }, 400);
  const { diskBudgetMb, worktreeTtlDays } = limits;
  const provisioningTimeoutMs = limits.provisioningTimeoutMs ?? DEFAULT_PROVISIONING_TIMEOUT_MS;

  // Installation membership (U8): the GitHub App installation is repository-
  // scoped and that scoping is a real control — onboard requires the repo to
  // already be in the installation's repository list. A repo-scoped mint
  // proves membership (the token API 422s for a repo outside the
  // installation), so the check IS the mechanism it protects. Enforced when
  // the App is configured; SKIPPED WITH AN HONEST WARNING when it is not
  // (anonymous clones still work for public repos). Runs BEFORE the registry
  // insert so a refused onboard never consumes a cap slot.
  let warning: string | undefined;
  if (githubAppConfigured(env)) {
    try {
      await mintRepoScopedToken(env, resource.resource.slice("repo:".length));
    } catch (err) {
      return json(
        {
          error:
            `not-in-installation: the GitHub App cannot mint a token scoped to ${resource.resource} — ` +
            `install the App on the repository first (${errMsg(err)})`,
        },
        403,
      );
    }
  } else {
    warning =
      "github-app-not-configured: installation membership was NOT verified (GITHUB_APP_* secrets unset); " +
      "clones/fetches will be anonymous — public repos only, and thread credentials stay unavailable";
  }

  const now = new Date().toISOString();
  const record: ResidentRecord = {
    resource: resource.resource,
    commands: commands.commands,
    defaultRef: defaultRef.defaultRef,
    ...(diskBudgetMb !== undefined ? { diskBudgetMb } : {}),
    provisioningTimeoutMs,
    ...(worktreeTtlDays !== undefined ? { worktreeTtlDays } : {}),
    onboardedAt: now,
    updatedAt: now,
  };

  const registry = registryStub(env);
  const result = await registry.onboard(record);
  // "in" narrowing: the RPC stub intersects returns with Disposable, which
  // defeats boolean-discriminant narrowing.
  if ("error" in result) return json({ error: result.error }, result.status);

  try {
    await residentStub(env, resource.resource).initResident(resource.resource, provisioningTimeoutMs);
  } catch (err) {
    // Fail closed: no half-onboarded residents. Free the slot and report.
    await registry.remove(resource.resource);
    return json({ error: `onboard failed arming the resident: ${errMsg(err)}` }, 500);
  }

  return json(
    { resource: resource.resource, state: "onboarding" satisfies ResidentState, ...(warning ? { warning } : {}) },
    202,
  );
}

async function handleOffboard(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);

  const registry = registryStub(env);
  const record = await registry.getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  // --dry-run (U8): the itemized plan of what the real teardown below would
  // remove, computed READ-ONLY — the resident stays fully intact (state,
  // schedules, snapshots, registry slot all untouched). The DO plan and the
  // R2 prefix count touch disjoint data, so they run concurrently.
  if (body.dryRun === true) {
    const planPending = residentStub(env, resource.resource).teardownPlan();
    const countPending = countR2Prefix(env.BACKUP_BUCKET, r2Prefix(resource.resource));
    let plan: Awaited<ReturnType<ResidentDO["teardownPlan"]>>;
    try {
      plan = await planPending;
    } catch (err) {
      countPending.catch(() => {}); // the plan's named failure answers; the count is read-only
      return json({ error: `offboard dry-run failed: ${errMsg(err)}` }, 500);
    }
    const r2Objects = await countPending;
    return json({
      resource: resource.resource,
      dryRun: true,
      wouldRemove: {
        registryRecord: true,
        schedules: plan.schedules,
        snapshotBackupIds: plan.snapshotBackupIds,
        backupObjects: plan.backupObjects,
        r2Objects,
        threadBindings: plan.threadBindings,
        container: plan.state,
      },
    });
  }

  // Registry first: the slot frees atomically and no new work routes here.
  const registryRemoved = await registry.remove(resource.resource);

  // The DO teardown and the resident/<resource>/ prefix sweep touch disjoint
  // data (the teardown's backup objects live under backups/<id>/), so both
  // run unconditionally and concurrently.
  const [teardown, r2Sweep] = await Promise.all([
    residentStub(env, resource.resource)
      .teardown()
      .catch(
        (err: unknown): Awaited<ReturnType<ResidentDO["teardown"]>> => ({
          schedulesCancelled: false,
          containerStopped: false,
          storageCleared: false,
          backupObjectsDeleted: 0,
          errors: [`teardown failed: ${errMsg(err)}`],
        }),
      ),
    // The registry is already gone, so the offboard cannot be retried; a
    // transient R2 failure must degrade to a reported partial success (naming
    // the prefix left behind) rather than throw an unretryable 500.
    deleteR2Prefix(env.BACKUP_BUCKET, r2Prefix(resource.resource))
      .then((deleted) => ({ deleted, error: undefined as string | undefined }))
      .catch((err: unknown) => ({
        deleted: 0,
        error: `r2 prefix sweep failed for ${r2Prefix(resource.resource)}: ${errMsg(err)}`,
      })),
  ]);

  const errors = [...teardown.errors];
  if (r2Sweep.error) errors.push(r2Sweep.error);

  return json({
    resource: resource.resource,
    registryRemoved,
    schedulesCancelled: teardown.schedulesCancelled,
    containerStopped: teardown.containerStopped,
    storageCleared: teardown.storageCleared,
    backupObjectsDeleted: teardown.backupObjectsDeleted,
    r2ObjectsDeleted: r2Sweep.deleted,
    errors,
  });
}

async function handleReconfigure(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);

  const patch: Partial<Pick<ResidentRecord, "commands" | "effects" | "defaultRef" | "diskBudgetMb" | "provisioningTimeoutMs" | "worktreeTtlDays">> = {};
  if (body.commands !== undefined) {
    const commands = parseCommands(body.commands);
    if ("error" in commands) return json({ error: commands.error }, 400);
    patch.commands = commands.commands;
  }
  if (body.effects !== undefined) {
    // U6/KTD8 execution profiles. Like `commands`, the map REPLACES the whole
    // stored one (admin-writable only; {} clears every override back to the
    // readonly default).
    const effects = parseEffects(body.effects);
    if ("error" in effects) return json({ error: effects.error }, 400);
    patch.effects = effects.effects;
  }
  if (body.defaultRef !== undefined) {
    const defaultRef = parseDefaultRef(body.defaultRef);
    if ("error" in defaultRef) return json({ error: defaultRef.error }, 400);
    patch.defaultRef = defaultRef.defaultRef;
  }
  const limits = parseResidentLimits(body);
  if ("error" in limits) return json({ error: limits.error }, 400);
  if (limits.diskBudgetMb !== undefined) patch.diskBudgetMb = limits.diskBudgetMb;
  if (limits.provisioningTimeoutMs !== undefined) patch.provisioningTimeoutMs = limits.provisioningTimeoutMs;
  if (limits.worktreeTtlDays !== undefined) patch.worktreeTtlDays = limits.worktreeTtlDays;
  if (Object.keys(patch).length === 0) {
    return json(
      { error: "nothing to reconfigure (accepted: commands, effects, defaultRef, diskBudgetMb, provisioningTimeoutMs, worktreeTtlDays)" },
      400,
    );
  }

  const updated = await registryStub(env).updateConfig(resource.resource, patch);
  if (!updated) return json({ error: `${resource.resource} is not onboarded` }, 404);
  return json({ resource: updated.resource, record: updated });
}

/** U8: down→onboarding rebuild — discard the stamped snapshots and
 *  reprovision from scratch through the ordinary provisioning pipeline,
 *  reusing the registry record (command table, ref, budget) as-is; the cap
 *  slot and thread bindings are untouched. `dryRun:true` answers 200 with the
 *  itemized plan and executes nothing; a real rebuild answers 202 like
 *  onboard (the transition is alarm-driven). */
async function handleRebuild(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const dryRun = body.dryRun === true;

  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  const result = await residentStub(env, resource.resource).rebuild(
    resource.resource,
    record.defaultRef,
    record.provisioningTimeoutMs,
    dryRun,
  );
  // "in" narrowing: the RPC stub intersects returns with Disposable, which
  // defeats boolean-discriminant narrowing (same note as handleOnboard).
  if ("error" in result) return json({ error: result.error }, result.status);
  return json(result, dryRun ? 200 : 202);
}

/** Admin enumeration: registry config + each resident's live engine view
 *  (state, sha, cache keys, snapshot stamp, refresh telemetry). Each probe
 *  targets a different DO, so they run concurrently; a failing one degrades
 *  to {error} without touching its neighbors, and the response order follows
 *  the registry list. */
async function handleResidents(env: Env): Promise<Response> {
  const residents = await registryStub(env).list();
  const settled = await Promise.allSettled(
    residents.map((record) => residentStub(env, record.resource).getResidentInfo()),
  );
  // Fleet-wide in-flight view: one call answers "is anything running anywhere?".
  // `inFlight` is the sum over residents whose live view answered with a count;
  // it is null — not 0 — as soon as any resident is unknown (live view rejected
  // or carried no numeric count), and `inFlightUnknown` says how many. A reader
  // that trusts the aggregate can therefore never mistake "we don't know" for
  // "idle". The deploy preflight walks `residents[].live` itself and refuses on
  // any unknown; this aggregate is for dashboards and humans.
  let known = 0;
  let inFlightUnknown = 0;
  const enriched: unknown[] = residents.map((record, i) => {
    const s = settled[i];
    if (s.status === "fulfilled" && typeof s.value.inFlight === "number") known += s.value.inFlight;
    else inFlightUnknown += 1;
    const live: unknown = s.status === "fulfilled" ? s.value : { error: errMsg(s.reason) };
    return { ...record, live };
  });
  const inFlight: number | null = inFlightUnknown === 0 ? known : null;
  return json({ cap: RESIDENT_CAP, count: residents.length, inFlight, inFlightUnknown, residents: enriched });
}

async function handleStatus(env: Env, url: URL): Promise<Response> {
  const resource = parseResource(url.searchParams.get("resource"));
  if ("error" in resource) return json({ error: resource.error }, 400);

  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  // Body deliberately limited to { state, reason, inFlight } — operator scope
  // sees lifecycle and activity, not config.
  // Two RPCs, not one atomic snapshot: getStatus() awaits storage, and the DO
  // may run other work in that gap, so `state`/`reason` and `inFlight` can be
  // a hair apart (and differ slightly from a /residents sample taken alongside).
  // Both are best-effort current-state reads; the deploy gate reads /residents.
  const stub = residentStub(env, resource.resource);
  const [status, inFlight] = await Promise.all([stub.getStatus(), stub.getInFlightCount()]);
  return json({ state: status.state, reason: status.reason, inFlight });
}

// -- U4 thread data plane handlers --------------------------------------------

/** Shared front half of /attach /exec /read /write: validate resource +
 *  threadKey (P1: BEFORE anything derives a path or a git argument), check
 *  the resource is onboarded (404 like /status), and hand back the stub. */
async function resolveThreadRoute(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ stub: ReturnType<typeof residentStub>; resource: string; threadKey: string } | Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const threadKey = parseThreadKey(body.threadKey);
  if ("error" in threadKey) return json({ error: threadKey.error }, 400);
  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);
  return { stub: residentStub(env, resource.resource), resource: resource.resource, threadKey: threadKey.threadKey };
}

/** Map a ThreadErr union member to its HTTP response (status leaves the body). */
function threadErrResponse(result: ThreadErr): Response {
  const { status, ...rest } = result;
  return json(rest, status);
}

async function handleAttach(env: Env, body: Record<string, unknown>): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  let refHint: string | null = null;
  if (body.refHint !== undefined) {
    const parsed = parseRef(body.refHint, "refHint");
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    refHint = parsed.ref;
  }
  const result = await ctx.stub.attachThread(ctx.threadKey, refHint);
  if ("error" in result) return threadErrResponse(result);
  return json(result);
}

async function handleDetach(env: Env, body: Record<string, unknown>): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  const result = await ctx.stub.detachThread(ctx.threadKey, body.force === true);
  if ("error" in result) return threadErrResponse(result);
  return json(result);
}

async function handleExec(env: Env, body: Record<string, unknown>): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  if (typeof body.command !== "string" || body.command.length === 0 || body.command.length > MAX_EXEC_COMMAND_LENGTH) {
    return json({ error: `command must be a non-empty string of at most ${MAX_EXEC_COMMAND_LENGTH} chars` }, 400);
  }
  let timeoutMs = DEFAULT_THREAD_EXEC_TIMEOUT_MS;
  if (body.timeoutMs !== undefined) {
    const parsed = parsePositiveInt(body.timeoutMs, "timeoutMs", 1000, MAX_THREAD_EXEC_TIMEOUT_MS);
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    timeoutMs = parsed.value;
  }
  return streamThreadExec(ctx.stub.execThread(ctx.threadKey, body.command, timeoutMs));
}

/** Stream one pending result with the thread-sandbox Worker's heartbeat
 *  convention (shared by /exec and /op): headers go out immediately, a
 *  whitespace byte every 15s keeps intermediaries from dropping the idle
 *  connection while a long command runs, then exactly ONE JSON document.
 *  Every post-validation outcome — results AND named errors — arrives
 *  in-body over HTTP 200; the handlers supply only the payload mapping. */
function streamHeartbeatJson<T>(
  pending: Promise<T>,
  toPayload: (result: T) => object,
  toErrorPayload: (err: unknown) => object,
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const beat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode("\n"));
        } catch {
          clearInterval(beat); // client went away; the pending promise still settles
        }
      }, 15_000);
      const finish = (payload: object) => {
        clearInterval(beat);
        try {
          controller.enqueue(encoder.encode(JSON.stringify(payload)));
          controller.close();
        } catch {
          // stream already errored/cancelled — nothing left to deliver to
        }
      };
      pending.then((result) => finish(toPayload(result))).catch((err: unknown) => finish(toErrorPayload(err)));
    },
  });
  return new Response(stream, { headers: { "content-type": "application/json" } });
}

/** /exec's payload mapping: a result as {stdout, stderr, exitCode, truncated},
 *  a named failure as {error, needs?, reason?, stdout:"", stderr:error, exitCode:127}
 *  (`reason:"runtime-replaced"` is how the client tells a deploy from a dead
 *  exec transport). */
function streamThreadExec(pending: Promise<Awaited<ReturnType<ResidentDO["execThread"]>>>): Response {
  return streamHeartbeatJson(
    pending,
    (result) =>
      "error" in result
        ? {
            error: result.error,
            ...(result.needs ? { needs: result.needs } : {}),
            // `reason` must stay independent of `state`: runtimeReplacedErr()
            // sets reason:"runtime-replaced" with NO state, and the client's
            // deploy-vs-dead-transport check reads it. Folding these two spreads
            // back into one silently drops it (no test covers this Worker).
            ...(result.state ? { state: result.state } : {}),
            ...(result.reason ? { reason: result.reason } : {}),
            stdout: "",
            stderr: result.error,
            exitCode: 127,
          }
        : { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode, truncated: result.truncated },
    (err) => {
      const msg = errMsg(err);
      return { error: msg, stdout: "", stderr: msg, exitCode: 127 };
    },
  );
}

async function handleRead(env: Env, body: Record<string, unknown>): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  if (typeof body.path !== "string") return json({ error: "path must be a string relative to the thread worktree" }, 400);
  const result = await ctx.stub.readThreadFile(ctx.threadKey, body.path);
  if ("error" in result) return threadErrResponse(result);
  return json(result);
}

async function handleWrite(env: Env, body: Record<string, unknown>): Promise<Response> {
  const ctx = await resolveThreadRoute(env, body);
  if (ctx instanceof Response) return ctx;
  if (typeof body.path !== "string") return json({ error: "path must be a string relative to the thread worktree" }, 400);
  if (typeof body.content !== "string" || body.content.length > MAX_WRITE_CONTENT) {
    return json({ error: `content must be a string of at most ${MAX_WRITE_CONTENT} chars` }, 400);
  }
  const result = await ctx.stub.writeThreadFile(ctx.threadKey, body.path, body.content);
  if ("error" in result) return threadErrResponse(result);
  return json(result);
}

// -- U6 deterministic ops handler (KTD8) ---------------------------------------

const OP_NAMES = ["test", "build", "status"] as const;

/** POST /op {resource, op, ref?} (operator scope): the deterministic
 *  modelless path. `op` resolves ONLY through this fixed enum into the
 *  onboard-time command table (never request text into a shell); `ref` passes
 *  the same strict pattern as every ref input and must resolve in the mirror.
 *  Every entry's `effects` profile gates execution — readonly runs, mutating
 *  is refused BY NAME (test/build/status are readonly by construction; the
 *  refusal is the guard rail for future entries). test/build run in a
 *  disposable per-op checkout (see ResidentDO.runOp) and stream like /exec;
 *  status touches no checkout at all — DO storage reads only. */
async function handleOp(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const op = body.op;
  if (typeof op !== "string" || !(OP_NAMES as readonly string[]).includes(op)) {
    return json({ error: `op must be one of ${OP_NAMES.join(", ")}` }, 400);
  }
  let ref: string | null = null;
  if (body.ref !== undefined) {
    const parsed = parseRef(body.ref, "ref");
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    ref = parsed.ref;
  }
  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  const effects = record.effects?.[op] ?? "readonly";
  if (effects !== "readonly") {
    return json(
      {
        error: `op-refused: the "${op}" command-table entry is marked effects: ${effects} — the modelless op path executes readonly entries only`,
      },
      409,
    );
  }

  const stub = residentStub(env, resource.resource);
  if (op === "status") {
    const info = await stub.getResidentInfo();
    const state = String(info.state ?? "down");
    const sha = typeof info.sha === "string" ? info.sha : "";
    const summary =
      `${resource.resource} is ${state}` +
      (info.reason ? ` (${String(info.reason)})` : "") +
      (info.defaultRef ? ` on ${String(info.defaultRef)}` : "") +
      (sha ? ` @ ${sha.slice(0, 8)}` : "") +
      (info.lastRefreshAt ? `, last refresh ${String(info.lastRefreshAt)}` : "");
    return json({
      // ok = serviceable: down is the one state nothing can serve from
      // (degraded still serves the last snapshot).
      ok: state !== "down",
      op,
      resource: resource.resource,
      state,
      reason: info.reason ?? "",
      ref: info.defaultRef ?? null,
      sha: info.sha ?? null,
      lastRefreshAt: info.lastRefreshAt ?? null,
      lastRestore: info.lastRestore ?? null,
      summary,
    });
  }
  return streamOp(stub.runOp(op as "test" | "build", ref));
}

/** /op's payload mapping: results pass through; a named error sheds its
 *  transport-only `status` field (the body is the contract, never the code). */
function streamOp(pending: Promise<Awaited<ReturnType<ResidentDO["runOp"]>>>): Response {
  return streamHeartbeatJson(
    pending,
    (result) => {
      if ("error" in result) {
        const { status: _status, ...rest } = result;
        return rest;
      }
      return result;
    },
    (err) => ({ error: errMsg(err) }),
  );
}

/** Admin diagnostic surface, used by U3's live validation (kill-refresh /
 *  stop-container simulate dead chains and platform sleeps; mint-token proves
 *  the command-level mint failure shape without exposing token material).
 *  Side-effect-explicit; every op is admin-scope except the pure reads
 *  info/schedules/threads, which the read scope may also run. */
async function handleDebug(env: Env, body: Record<string, unknown>): Promise<Response> {
  const op = typeof body.op === "string" ? body.op : "";
  if (op === "run-watchdog") return json(await runWatchdog(env));
  if (op === "mint-token") {
    const resource = parseResource(body.resource);
    if ("error" in resource) return json({ error: resource.error }, 400);
    try {
      await mintRepoScopedToken(env, resource.resource.slice("repo:".length));
      return json({ op, ok: true, note: "token minted and cached (value withheld)" });
    } catch (err) {
      // The command-level failure shape (KTD12): an error result, never a
      // lifecycle transition — verify via /status that state is untouched.
      return json({ op, ok: false, error: errMsg(err) });
    }
  }

  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);
  const stub = residentStub(env, resource.resource);
  switch (op) {
    case "info":
      return json(await stub.getResidentInfo());
    case "schedules":
      return json(await stub.debugSchedules());
    case "kill-refresh":
      return json(await stub.debugKillRefresh());
    case "refresh-now":
      return json(await stub.debugRefreshNow());
    case "stop-container":
      return json(await stub.debugStopContainer());
    case "force-onboarding":
      return json(await stub.debugForceOnboarding());
    case "force-down": {
      // Fault injection for the U8 watchdog auto-rebuild path; a
      // rehydration-flavored default reason makes it strike-eligible.
      const reason =
        typeof body.reason === "string" && body.reason ? body.reason : "r2-restore-failed: injected (debug force-down)";
      return json(await stub.debugForceDown(reason));
    }
    case "threads":
      return json(await stub.debugThreads());
    case "sweep-now":
      return json(await stub.debugSweepNow());
    case "backdate-thread": {
      const threadKey = parseThreadKey(body.threadKey);
      if ("error" in threadKey) return json({ error: threadKey.error }, 400);
      const days = parsePositiveInt(body.days, "days", 1, 3650);
      if ("error" in days) return json({ error: days.error }, 400);
      return json(await stub.debugBackdateThread(threadKey.threadKey, days.value));
    }
    default:
      return json(
        { error: `unknown op ${JSON.stringify(op)} (ops: info, schedules, kill-refresh, refresh-now, stop-container, force-onboarding, force-down, mint-token, run-watchdog, threads, sweep-now, backdate-thread)` },
        400,
      );
  }
}

/** One watchdog pass over every registered resident. Shared by the cron
 *  handler and the /debug run-watchdog op. Each check targets a different DO,
 *  so they run concurrently; a failing one becomes its own {error} entry
 *  without touching its neighbors, and the results follow the registry list. */
async function runWatchdog(env: Env): Promise<Record<string, unknown>> {
  const registry = registryStub(env);
  const residents = await registry.list();
  const settled = await Promise.allSettled(
    residents.map(async (record) => {
      const check = await residentStub(env, record.resource).watchdogCheck();
      if (check.action === "provision-timed-out") {
        // The DO already tried to release its own slot; this is the backstop.
        await registry.remove(record.resource);
      }
      return check;
    }),
  );
  const results: unknown[] = residents.map((record, i) => {
    const s = settled[i];
    return s.status === "fulfilled"
      ? { resource: record.resource, state: s.value.state, reason: s.value.reason, action: s.value.action }
      : { resource: record.resource, error: errMsg(s.reason) };
  });
  return { cap: RESIDENT_CAP, count: residents.length, results };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
