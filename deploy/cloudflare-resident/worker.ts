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
//   admin scope     POST /onboard /offboard /reconfigure /debug   GET /residents
//   operator scope  POST /attach /exec /read /write /op           GET /status
//   unauthenticated GET /healthz (deploy wake ping; touches no DO)
//
// U2 implemented auth, registry storage, onboard/offboard/reconfigure/status/
// residents, and the provisioning deadline. U3 (this unit) adds the lifecycle
// engine: alarm-driven provisioning (clone → install/build → stamped snapshot
// → warm), wake-path rehydration (restoring persisted BEFORE restore, stamped
// snapshots refused on mismatch), the self-rescheduling refresh alarm, the
// watchdog (re-arm dead chains + degraded(alarm-missed); time out stuck
// onboarding), and repo-scoped GitHub App token minting on WebCrypto.
// /attach /exec /read /write remain 501 stubs (U4); /op is a 501 stub (U6).
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
import { getSandbox, Sandbox } from "@cloudflare/sandbox";
import type { DirectoryBackup, SandboxCommand } from "@cloudflare/sandbox";
import { createExtensionProcessSandbox } from "@cloudflare/sandbox/extensions";
import { DurableObject } from "cloudflare:workers";

interface Env {
  RESIDENT: DurableObjectNamespace<ResidentDO>;
  REGISTRY: DurableObjectNamespace<ResidentRegistryDO>;
  BACKUP_BUCKET: R2Bucket;
  RESIDENT_ADMIN_TOKEN: string;
  RESIDENT_OPERATOR_TOKEN: string;
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
 *  runs as root). worker2..worker8 stay free for U4's per-thread users. */
const BUILD_USER = "worker1";

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
  const res = await fetch(`https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${jwt}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "switchboard-resident",
    },
    body: JSON.stringify({ repositories: [repoName] }),
  });
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
  defaultRef: string;
  diskBudgetMb?: number;
  provisioningTimeoutMs: number;
  onboardedAt: string;
  updatedAt: string;
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
    patch: Partial<Pick<ResidentRecord, "commands" | "defaultRef" | "diskBudgetMb" | "provisioningTimeoutMs">>,
  ): Promise<ResidentRecord | null> {
    const key = registryKey(resource);
    const record = await this.ctx.storage.get<ResidentRecord>(key);
    if (!record) return null;
    const updated: ResidentRecord = { ...record, updatedAt: new Date().toISOString() };
    if (patch.commands !== undefined) updated.commands = patch.commands;
    if (patch.defaultRef !== undefined) updated.defaultRef = patch.defaultRef;
    if (patch.diskBudgetMb !== undefined) updated.diskBudgetMb = patch.diskBudgetMb;
    if (patch.provisioningTimeoutMs !== undefined) updated.provisioningTimeoutMs = patch.provisioningTimeoutMs;
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

const STATE_KEY = "resident:state";
const REASON_KEY = "resident:reason";
const RESOURCE_KEY = "resident:resource";
const UPDATED_KEY = "resident:updatedAt";
const FACTS_KEY = "resident:facts";
const SNAPSHOT_KEY = "resident:snapshot";
const DEADLINE_AT_KEY = "resident:provisionDeadlineAt";

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
    const procs = createExtensionProcessSandbox(this);
    const proc = await procs.exec(argv as unknown as SandboxCommand, {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      timeout,
    });
    const out = await proc.output({ encoding: "utf8", timeout: timeout + 30_000 });
    return { stdout: out.stdout, stderr: out.stderr, exitCode: out.exitCode, timedOut: out.timedOut };
  }

  private async runOk(
    argv: readonly string[],
    step: string,
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<string> {
    const r = await this.run(argv, opts);
    if (r.exitCode !== 0 || r.timedOut) {
      throw new StepError(step, `exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}: ${tail(r.stderr || r.stdout)}`);
    }
    return r.stdout;
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

  private async armRefresh(resource: string): Promise<void> {
    this.deleteSchedules(REFRESH_CALLBACK); // at most one pending refresh
    await this.schedule(REFRESH_INTERVAL_S, REFRESH_CALLBACK, resource);
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
      await this.gitWithCred(token, ["clone", "--mirror", `https://github.com/${slug}.git`, MIRROR_DIR], "clone", stepBudget);

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

      // KTD12: token-mint failure is a command-level error — the resident
      // keeps serving the last snapshot and lifecycle state is NOT flipped.
      let token: string | null = null;
      if (githubAppConfigured(this.env)) {
        try {
          token = await mintRepoScopedToken(this.env, resource.slice("repo:".length));
        } catch (err) {
          await this.recordRefreshError(`token-mint-failed (command-level, still serving): ${errMsg(err)}`);
          return; // finally re-arms the chain
        }
      }

      await this.setResidentState("refreshing");
      try {
        await this.gitWithCred(token, ["-C", MIRROR_DIR, "fetch", "--prune", "origin"], "fetch", GIT_NETWORK_TIMEOUT_MS);
      } catch (err) {
        await this.setResidentState("degraded", `github-unreachable: ${errMsg(err)}`);
        return;
      }

      const sha = await this.readMirrorSha(facts.defaultRef);
      let lockfileHash = facts.lockfileHash;
      let snap: SnapshotRecord | null = null;
      let previous: SnapshotRecord | undefined;
      if (sha !== facts.sha) {
        // Token-free from here on: repo code runs during install/build (KTD7).
        await this.buildUserRun(
          `git fetch --quiet origin && git reset --hard --quiet ${sha} && git clean -fdq`,
          "checkout-update",
          GIT_NETWORK_TIMEOUT_MS,
        );
        lockfileHash = await this.lockfileKey(sha);
        if (lockfileHash !== facts.lockfileHash && record.commands.install) {
          await this.buildUserRun(record.commands.install, "install", REFRESH_BUILD_TIMEOUT_MS);
        }
        await this.buildUserRun(record.commands.build, "build", REFRESH_BUILD_TIMEOUT_MS);
        previous = await this.ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY);
        snap = await this.takeSnapshot(resource, facts.defaultRef, sha, lockfileHash);
      }

      // Facts and snapshot move together so the stamp check never sees a
      // half-updated pair.
      const updatedFacts: RepoFacts = { ...facts, sha, lockfileHash, lastRefreshAt: new Date().toISOString() };
      delete updatedFacts.lastRefreshError;
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
      const state = await this.ctx.storage.get<ResidentState>(STATE_KEY);
      if (state && state !== "down" && state !== "onboarding") await this.armRefresh(resource);
    }
  }

  // -- watchdog (KTD4) ---------------------------------------------------------

  /** One watchdog pass over this resident (invoked by the Worker cron):
   *  re-arm a dead refresh chain and mark degraded(alarm-missed); time out an
   *  onboarding stuck past its budget → down(provision-timeout) + cap slot
   *  release. Storage/schedule reads only — never starts the container. */
  async watchdogCheck(): Promise<{ resource: string; state: ResidentState; reason: string; action: "none" | "rearmed" | "provision-timed-out" }> {
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
    if (status.state === "down") return { resource, ...status, action: "none" };

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
    const [refresh, provisionRun, provisionDeadline] = await Promise.all([
      this.listSchedules(REFRESH_CALLBACK),
      this.listSchedules(PROVISION_RUN_CALLBACK),
      this.listSchedules(PROVISIONING_CALLBACK),
    ]);
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
    };
  }

  // -- debug surface (admin-scoped via POST /debug; used by live validation) ---

  async debugSchedules(): Promise<Record<string, unknown>> {
    return {
      refresh: await this.listSchedules(REFRESH_CALLBACK),
      provisionRun: await this.listSchedules(PROVISION_RUN_CALLBACK),
      provisionDeadline: await this.listSchedules(PROVISIONING_CALLBACK),
    };
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

type Scope = "admin" | "operator";

/** Fail closed: unset/empty secrets grant nothing. The admin token is a strict
 *  superset (valid on operator routes); the operator token never opens an
 *  admin route. */
function hasScope(env: Env, token: string | null, scope: Scope): boolean {
  if (!token) return false;
  if (env.RESIDENT_ADMIN_TOKEN && timingSafeEqual(token, env.RESIDENT_ADMIN_TOKEN)) return true;
  if (scope === "operator" && env.RESIDENT_OPERATOR_TOKEN && timingSafeEqual(token, env.RESIDENT_OPERATOR_TOKEN)) {
    return true;
  }
  return false;
}

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

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function parseDefaultRef(value: unknown): { defaultRef: string } | { error: string } {
  if (typeof value !== "string" || !REF_RE.test(value) || value.includes("..")) {
    return { error: 'defaultRef must be a plausible git ref (e.g. "main")' };
  }
  return { defaultRef: value };
}

function parsePositiveInt(value: unknown, field: string, min: number, max: number): { value: number } | { error: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return { error: `${field} must be an integer between ${min} and ${max}` };
  }
  return { value };
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const ROUTES: Record<string, { scope: Scope; method: string }> = {
  "/onboard": { scope: "admin", method: "POST" },
  "/offboard": { scope: "admin", method: "POST" },
  "/reconfigure": { scope: "admin", method: "POST" },
  "/residents": { scope: "admin", method: "GET" },
  "/debug": { scope: "admin", method: "POST" },
  "/status": { scope: "operator", method: "GET" },
  "/attach": { scope: "operator", method: "POST" },
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

async function deleteR2Prefix(bucket: R2Bucket, prefix: string): Promise<number> {
  let deleted = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
      deleted += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return deleted;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Unauthenticated wake ping for `npm run deploy` — touches no DO, no data.
    if (url.pathname === "/healthz" && request.method === "GET") return json({ ok: true });

    // Auth precedes existence: unknown paths demand admin before revealing
    // 404 vs 401, so an unauthenticated scanner learns nothing.
    const route = ROUTES[url.pathname];
    if (!hasScope(env, bearerToken(request), route?.scope ?? "admin")) {
      return json({ error: "unauthorized" }, 401);
    }
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
        case "/residents":
          return await handleResidents(env);
        case "/debug":
          return await handleDebug(env, body);
        case "/status":
          return await handleStatus(env, url);
        case "/attach":
        case "/exec":
        case "/read":
        case "/write":
          return json({ error: "not implemented", lands_in: "U4" }, 501);
        case "/op":
          return json({ error: "not implemented", lands_in: "U6" }, 501);
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

  let diskBudgetMb: number | undefined;
  if (body.diskBudgetMb !== undefined) {
    const parsed = parsePositiveInt(body.diskBudgetMb, "diskBudgetMb", 1, 100_000);
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    diskBudgetMb = parsed.value;
  }
  let provisioningTimeoutMs = DEFAULT_PROVISIONING_TIMEOUT_MS;
  if (body.provisioningTimeoutMs !== undefined) {
    const parsed = parsePositiveInt(
      body.provisioningTimeoutMs,
      "provisioningTimeoutMs",
      MIN_PROVISIONING_TIMEOUT_MS,
      MAX_PROVISIONING_TIMEOUT_MS,
    );
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    provisioningTimeoutMs = parsed.value;
  }

  const now = new Date().toISOString();
  const record: ResidentRecord = {
    resource: resource.resource,
    commands: commands.commands,
    defaultRef: defaultRef.defaultRef,
    ...(diskBudgetMb !== undefined ? { diskBudgetMb } : {}),
    provisioningTimeoutMs,
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

  return json({ resource: resource.resource, state: "onboarding" satisfies ResidentState }, 202);
}

async function handleOffboard(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);

  const registry = registryStub(env);
  const record = await registry.getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  // Registry first: the slot frees atomically and no new work routes here.
  const registryRemoved = await registry.remove(resource.resource);

  let teardown: Awaited<ReturnType<ResidentDO["teardown"]>>;
  try {
    teardown = await residentStub(env, resource.resource).teardown();
  } catch (err) {
    teardown = {
      schedulesCancelled: false,
      containerStopped: false,
      storageCleared: false,
      backupObjectsDeleted: 0,
      errors: [`teardown failed: ${errMsg(err)}`],
    };
  }

  const r2ObjectsDeleted = await deleteR2Prefix(env.BACKUP_BUCKET, r2Prefix(resource.resource));

  return json({
    resource: resource.resource,
    registryRemoved,
    schedulesCancelled: teardown.schedulesCancelled,
    containerStopped: teardown.containerStopped,
    storageCleared: teardown.storageCleared,
    backupObjectsDeleted: teardown.backupObjectsDeleted,
    r2ObjectsDeleted,
    errors: teardown.errors,
  });
}

async function handleReconfigure(env: Env, body: Record<string, unknown>): Promise<Response> {
  const resource = parseResource(body.resource);
  if ("error" in resource) return json({ error: resource.error }, 400);

  const patch: Partial<Pick<ResidentRecord, "commands" | "defaultRef" | "diskBudgetMb" | "provisioningTimeoutMs">> = {};
  if (body.commands !== undefined) {
    const commands = parseCommands(body.commands);
    if ("error" in commands) return json({ error: commands.error }, 400);
    patch.commands = commands.commands;
  }
  if (body.defaultRef !== undefined) {
    const defaultRef = parseDefaultRef(body.defaultRef);
    if ("error" in defaultRef) return json({ error: defaultRef.error }, 400);
    patch.defaultRef = defaultRef.defaultRef;
  }
  if (body.diskBudgetMb !== undefined) {
    const parsed = parsePositiveInt(body.diskBudgetMb, "diskBudgetMb", 1, 100_000);
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    patch.diskBudgetMb = parsed.value;
  }
  if (body.provisioningTimeoutMs !== undefined) {
    const parsed = parsePositiveInt(
      body.provisioningTimeoutMs,
      "provisioningTimeoutMs",
      MIN_PROVISIONING_TIMEOUT_MS,
      MAX_PROVISIONING_TIMEOUT_MS,
    );
    if ("error" in parsed) return json({ error: parsed.error }, 400);
    patch.provisioningTimeoutMs = parsed.value;
  }
  if (Object.keys(patch).length === 0) {
    return json({ error: "nothing to reconfigure (accepted: commands, defaultRef, diskBudgetMb, provisioningTimeoutMs)" }, 400);
  }

  const updated = await registryStub(env).updateConfig(resource.resource, patch);
  if (!updated) return json({ error: `${resource.resource} is not onboarded` }, 404);
  return json({ resource: updated.resource, record: updated });
}

/** Admin enumeration: registry config + each resident's live engine view
 *  (state, sha, cache keys, snapshot stamp, refresh telemetry). */
async function handleResidents(env: Env): Promise<Response> {
  const residents = await registryStub(env).list();
  const enriched: unknown[] = [];
  for (const record of residents) {
    let live: unknown;
    try {
      live = await residentStub(env, record.resource).getResidentInfo();
    } catch (err) {
      live = { error: errMsg(err) };
    }
    enriched.push({ ...record, live });
  }
  return json({ cap: RESIDENT_CAP, count: residents.length, residents: enriched });
}

async function handleStatus(env: Env, url: URL): Promise<Response> {
  const resource = parseResource(url.searchParams.get("resource"));
  if ("error" in resource) return json({ error: resource.error }, 400);

  const record = await registryStub(env).getRecord(resource.resource);
  if (!record) return json({ error: `${resource.resource} is not onboarded` }, 404);

  // Body deliberately limited to { state, reason } — operator scope sees
  // lifecycle, not config.
  const status = await residentStub(env, resource.resource).getStatus();
  return json({ state: status.state, reason: status.reason });
}

/** Admin diagnostic surface, used by U3's live validation (kill-refresh /
 *  stop-container simulate dead chains and platform sleeps; mint-token proves
 *  the command-level mint failure shape without exposing token material).
 *  Deliberately admin-scope-only and side-effect-explicit. */
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
    default:
      return json(
        { error: `unknown op ${JSON.stringify(op)} (ops: info, schedules, kill-refresh, refresh-now, stop-container, force-onboarding, mint-token, run-watchdog)` },
        400,
      );
  }
}

/** One watchdog pass over every registered resident. Shared by the cron
 *  handler and the /debug run-watchdog op. */
async function runWatchdog(env: Env): Promise<Record<string, unknown>> {
  const registry = registryStub(env);
  const residents = await registry.list();
  const results: unknown[] = [];
  for (const record of residents) {
    try {
      const check = await residentStub(env, record.resource).watchdogCheck();
      if (check.action === "provision-timed-out") {
        // The DO already tried to release its own slot; this is the backstop.
        await registry.remove(record.resource);
      }
      results.push({ resource: record.resource, state: check.state, reason: check.reason, action: check.action });
    } catch (err) {
      results.push({ resource: record.resource, error: errMsg(err) });
    }
  }
  return { cap: RESIDENT_CAP, count: residents.length, results };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
