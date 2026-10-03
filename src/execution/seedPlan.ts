// The seeded sandbox (docs/reference/specs/execution.md item 25). A cold
// per-thread sandbox clones and installs a repository from nothing — minutes
// on a large one, every time a resident refuses a run. A resident already
// holds a stamped snapshot of the same repository in R2: the checkout without
// its dependency view, and one archive per lockfile key holding the view. The
// seed restores both into the sandbox BEFORE the run's first command, fixes
// ownership and origin, moves the view into place and checks the thread's ref
// out, so the run starts where a resident's would. This module is the plan's
// pure half — the handle's shape as the bot forwards it from the resident's
// `/status`, the fix-up script, the classification of a restore whose objects
// are gone — free of node: imports so wrangler bundles it into the sandbox
// Worker like sandboxErrors.ts. The Worker runs it; the bot forwards it.

import { shellQuote } from "./shellQuote.js";
import { depsEntryMaterializeScript } from "./residentDepsStore.js";
import { FIRST_TEST_MAX_MS, SECOND_MS } from "../core/budgets.js";

/** Where the seeded checkout lands: the run's working tree. */
export const SEED_CHECKOUT_DIR = "/workspace/checkout";
/** Where the deps-store entry's archive is extracted before it becomes the checkout's `node_modules`. */
export const SEED_DEPS_STAGING_DIR = "/workspace/.seed-deps";
/** The marker a seeded container carries (its text is `seedMarkerText`): what it was
 *  seeded from AND what was checked out, so a second `/seed` for the same seed answers
 *  at once — never restoring over a live tree — while one that names another ref or
 *  head is a new seed. */
export const SEED_MARKER = "/workspace/.switchboard-seed";

/** Preparation requirements are independent of the coding agent's chosen
 * checks. A legacy startup smoke command may additionally be configured. */
export interface ReadyEnvironmentRequirement {
  testCommand?: string;
  requiredTools: readonly string[];
  dependencyDir: string;
  /** Explicit operator opt-in to executing this bounded baseline before coding. */
  firstAction?: { kind: "baseline_test"; policyVersion: string; timeoutMs: number };
}

export function validateFirstAction(requirement: ReadyEnvironmentRequirement): void {
  const action = requirement.firstAction;
  if (action === undefined) return;
  if (typeof requirement.testCommand !== "string" || !requirement.testCommand.trim())
    throw new Error("ready environment: firstAction requires an explicit testCommand");
  if (
    typeof action !== "object" ||
    action === null ||
    Array.isArray(action) ||
    Object.keys(action).some((key) => !["kind", "policyVersion", "timeoutMs"].includes(key)) ||
    action.kind !== "baseline_test" ||
    typeof action.policyVersion !== "string" ||
    !/^[A-Za-z0-9_.-]{1,64}$/.test(action.policyVersion) ||
    !Number.isInteger(action.timeoutMs) ||
    action.timeoutMs < SECOND_MS ||
    action.timeoutMs > FIRST_TEST_MAX_MS
  )
    throw new Error("ready environment: firstAction must declare baseline_test, policyVersion and a bounded timeoutMs");
}

export type ReadyEnvironmentOutcome =
  | { ready: true }
  | {
      ready: false;
      reason:
        | "dependencies_missing"
        | "dependencies_invalid"
        | "dependencies_stale"
        | "tool_missing"
        | "test_command_invalid"
        | "check_failed";
      tool?: string;
    };

const READY_TOOL = /^[A-Za-z_][A-Za-z0-9_.+-]*$/;
const READY_DEPENDENCY_DIR = new RegExp("^[A-Za-z0-9_./-]+$");
/** The root lockfiles the resident keys its dependency archive on. */
const READY_LOCKFILES = [
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

/** Inspect the installed Node view using the runtime supplied by both images.
 * Read manifests and executable links only: never load repository code, run
 * package scripts, install dependencies, or select a test. This checks direct
 * required dependencies of the root and declared workspaces, not the entire
 * transitive graph. Optional packages may legitimately be absent. */
export function dependencyLayoutCommand(workspace: string): string {
  return `node -e ${shellQuote(String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[1]);
const invalid = () => { throw new Error('invalid dependency view'); };
const exists = p => fs.existsSync(p);
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const modules = path.join(root, 'node_modules');
try {
  if (!fs.statSync(modules).isDirectory() || exists(path.join(modules, 'node_modules'))) invalid();
  const manifestPath = path.join(root, 'package.json');
  if (!exists(manifestPath)) process.exit(0);
  const manifest = read(manifestPath);
  const workspaces = manifest.workspaces?.packages ?? manifest.workspaces ?? [];
  if (!Array.isArray(workspaces)) invalid();
  const directories = new Set([root]);
  for (const pattern of workspaces) {
    if (typeof pattern !== 'string' || path.isAbsolute(pattern) || pattern.split('/').includes('..') || pattern.includes('\\')) invalid();
    for (const rel of fs.globSync(pattern, { cwd: root, exclude: ['**/node_modules/**', '**/.git/**'] })) {
      const dir = path.resolve(root, rel);
      const relative = path.relative(root, dir);
      if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) invalid();
      if (!exists(path.join(dir, 'package.json'))) continue;
      const real = path.relative(fs.realpathSync(root), fs.realpathSync(dir));
      if (real === '..' || real.startsWith('../') || path.isAbsolute(real)) invalid();
      directories.add(dir);
    }
  }
  const parents = dir => {
    const result = [];
    for (;;) {
      result.push(path.join(dir, 'node_modules'));
      if (dir === root) return result;
      dir = path.dirname(dir);
    }
  };
  for (const dir of directories) {
    const pkg = dir === root ? manifest : read(path.join(dir, 'package.json'));
    const required = { ...pkg.dependencies, ...pkg.devDependencies };
    const search = parents(dir);
    for (const name of Object.keys(required)) {
      if (Object.hasOwn(pkg.optionalDependencies ?? {}, name)) continue;
      if (!/^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') invalid();
      const base = search.find(p => exists(path.join(p, name, 'package.json')));
      if (!base) invalid();
      const installed = path.join(base, name);
      const meta = read(path.join(installed, 'package.json'));
      const local = path.relative(fs.realpathSync(root), fs.realpathSync(installed));
      // Workspace source packages can declare bins generated by their build.
      // Those artifacts are task outputs, not installed environment tools.
      if (local !== '..' && !local.startsWith('../') && !path.isAbsolute(local) && !local.split(path.sep).includes('node_modules')) continue;
      const bins = typeof meta.bin === 'string' ? { [String(meta.name ?? name).split('/').pop()]: meta.bin } : meta.bin ?? {};
      for (const [bin, target] of Object.entries(bins)) {
        if (typeof target !== 'string' || !bin || bin.includes('/') || bin === '.' || bin === '..') invalid();
        const executable = path.resolve(installed, target);
        if (!fs.statSync(executable).isFile()) invalid();
        fs.accessSync(executable, fs.constants.R_OK);
        if (!search.some(p => {
          const link = path.join(p, '.bin', bin);
          if (!exists(link) || !fs.statSync(link).isFile()) return false;
          fs.accessSync(link, fs.constants.X_OK);
          // npm uses links; pnpm can generate executable shell wrappers.
          // Multiple packages may provide the same bin: the installer chooses
          // one entry, so requiring each package to own that link is invalid.
          return true;
        })) invalid();
      }
    }
  }
} catch { process.exit(2); }
`)} ${shellQuote(workspace)}`;
}

/** Model-free, fixed-output probe on the bound checkout. `bash -n` parses the
 * declared test command but does not run the suite or install packages. */
export function readyEnvironmentCommand(
  workspace: string,
  requirement: ReadyEnvironmentRequirement,
  seededFromSha?: string,
): string {
  validateFirstAction(requirement);
  const command = requirement.testCommand;
  const program = typeof command === "string" ? /^([A-Za-z_][A-Za-z0-9_.+-]*)(?:\s|$)/.exec(command)?.[1] : undefined;
  if (
    command !== undefined &&
    (typeof command !== "string" ||
      !program ||
      command.length > 512 ||
      [...command].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))
  )
    throw new Error("ready environment: declared test command is missing or unsupported");
  if (
    !READY_DEPENDENCY_DIR.test(requirement.dependencyDir) ||
    requirement.dependencyDir.startsWith("/") ||
    requirement.dependencyDir === "." ||
    requirement.dependencyDir.split("/").some((part) => part === "." || part === ".." || part === "")
  )
    throw new Error("ready environment: dependency directory is invalid");
  if (
    !Array.isArray(requirement.requiredTools) ||
    requirement.requiredTools.some((tool) => typeof tool !== "string" || !READY_TOOL.test(tool))
  )
    throw new Error("ready environment: required tool is invalid");
  if (seededFromSha !== undefined && !/^[0-9a-f]{40}$/.test(seededFromSha))
    throw new Error("ready environment: snapshot head is invalid");
  const tools = [
    ...new Set([
      "bash",
      ...(requirement.dependencyDir === "node_modules" ? ["node"] : []),
      ...(seededFromSha ? ["git"] : []),
      ...(program ? [program] : []),
      ...requirement.requiredTools,
    ]),
  ];
  return [
    "set -eu",
    `cd ${shellQuote(workspace)}`,
    `if ! test -d ${shellQuote(requirement.dependencyDir)}; then printf MISSING_DEPENDENCIES; exit 2; fi`,
    ...tools.map(
      (tool) =>
        `if ! command -v ${shellQuote(tool)} >/dev/null 2>&1; then printf ${shellQuote(`MISSING_TOOL:${tool}`)}; exit 2; fi`,
    ),
    ...(requirement.dependencyDir === "node_modules"
      ? [`if ! ${dependencyLayoutCommand(workspace)}; then printf INVALID_DEPENDENCIES; exit 2; fi`]
      : []),
    ...(seededFromSha
      ? [
          `if ! git diff --quiet ${shellQuote(seededFromSha)} HEAD -- ${READY_LOCKFILES.map(shellQuote).join(" ")}; then printf LOCKFILE_MISMATCH; exit 0; fi`,
        ]
      : []),
    ...(command !== undefined
      ? [`if ! bash -n -c ${shellQuote(command)} >/dev/null 2>&1; then printf INVALID_TEST_COMMAND; exit 2; fi`]
      : []),
    "printf READY",
  ].join("\n");
}

/** The shell emits fixed markers only. An infra/error body is not repeated in
 * the user-facing failure; it may contain material from a dirty workspace. */
export function readyEnvironmentOutcome(output: string): ReadyEnvironmentOutcome {
  const text = output.trim();
  if (text === "READY") return { ready: true };
  if (/(?:^|\n)MISSING_DEPENDENCIES$/.test(text)) return { ready: false, reason: "dependencies_missing" };
  if (/(?:^|\n)INVALID_DEPENDENCIES$/.test(text)) return { ready: false, reason: "dependencies_invalid" };
  if (/(?:^|\n)LOCKFILE_MISMATCH$/.test(text)) return { ready: false, reason: "dependencies_stale" };
  const missingTool = /(?:^|\n)MISSING_TOOL:([A-Za-z_][A-Za-z0-9_.+-]*)$/.exec(text);
  if (missingTool) return { ready: false, reason: "tool_missing", tool: missingTool[1] };
  if (/(?:^|\n)INVALID_TEST_COMMAND$/.test(text)) return { ready: false, reason: "test_command_invalid" };
  return { ready: false, reason: "check_failed" };
}

/** The marker names both restored archives and the checkout target. A changed
 * dependency archive cannot reuse a tree holding the old dependency view. */
export function seedMarkerText(
  seed: Pick<SandboxSeed, "checkoutBackupId" | "depsBackupId" | "ref" | "fetchRef" | "fetchSha">,
): string {
  return `${seed.checkoutBackupId} ${seed.depsBackupId ?? "-"} ${seed.fetchRef ?? seed.ref} ${seed.fetchSha ?? "-"}`;
}

/** One cap shared by both restores, judged by bytes arriving (the SDK's
 *  restore takes no timeout): the checkout and the deps view together. */
export const SEED_RESTORE_MAX_MS = 8 * 60_000;
/** How long a failure sweep waits for a restore the judge gave up on to settle before it
 *  removes the restore's directory: the SDK's call cannot be cancelled, and a stalled
 *  transfer often finishes soon after the stall window. */
export const SEED_ABANDONED_RESTORE_WAIT_MS = 60_000;
/** The fix-up script's own limit: a `chown -R` over a large tree, a fetch, a checkout. */
export const SEED_FIXUP_TIMEOUT_MS = 3 * 60_000;
/** The client's per-send budget for `POST /seed`: both caps plus the answer. */
export const SEED_BUDGET_MS = SEED_RESTORE_MAX_MS + SEED_FIXUP_TIMEOUT_MS + 60_000;

/** Why a seed did not happen, as the machine tokens the refusal carries:
 *  the handle's objects are gone (the bot re-reads `/status` once and retries),
 *  a step failed (the run goes cold with the note), or the Worker has no
 *  presigned transfer configured (a gigabyte restore never goes through the
 *  isolate — resident-repos.md item 61). */
export const SEED_REASONS = ["seed-missing", "seed-failed", "seed-unconfigured", "seed-incompatible"] as const;
export type SeedReason = (typeof SEED_REASONS)[number];

/** The handle the bot forwards: the resident's snapshot as `/status` publishes
 *  it, plus the thread's own ref and head when they differ from the snapshot's. */
export interface SandboxSeed {
  /** `owner/name`: where the checkout's origin points after the fix-up. */
  slug: string;
  /** The snapshot's checkout archive (resident-repos.md item 7). */
  checkoutBackupId: string;
  /** The deps-store entry archive for the snapshot's lockfile key, when the resident has one (item 61). */
  depsBackupId?: string;
  /** The snapshot's stamp: the branch the checkout is on and its head. */
  ref: string;
  sha: string;
  /** The thread's ref to fetch and check out; absent → the checkout stays on the snapshot's branch. */
  fetchRef?: string;
  /** The thread's resolved head, preferred over the fetched tip when the fetch already holds it. */
  fetchSha?: string;
}

export type SeedStep = "restore" | "deps" | "fixup";

/** One restore's two phases, in milliseconds: the SDK's presigned download of
 *  the archive (judged by bytes arriving), then the extraction onto the disk. */
export interface RestorePhases {
  download: number;
  extract: number;
}

export interface SeedPhases {
  checkout: RestorePhases;
  /** Null when no deps entry rode along. */
  deps: RestorePhases | null;
}

export type SeedAnswer =
  | {
      seeded: true;
      /** The Worker-bound birth container for a claimed seed; absent for legacy unclaimed callers. */
      preservationContainer?: string;
      /** The container already carried this handle's tree: nothing was restored. */
      cached: boolean;
      slug: string;
      /** What the checkout is on after the fix-up. */
      ref: string;
      sha: string;
      from: { ref: string; sha: string; checkoutBackupId: string; depsBackupId?: string };
      /** Milliseconds per step; `deps` null when no entry rode along; all zero when cached. */
      steps: { restore: number; deps: number | null; fixup: number };
      /** Each restore split into its two phases — the archive's download to the
       *  container and its extraction onto the disk — so the gate's reading says
       *  which one owns a slow seed. Absent when cached. */
      phases?: SeedPhases;
      ms: number;
    }
  | { seeded: false; reason: SeedReason; detail: string; step?: SeedStep };

/** A backup id as the SDK mints it (a UUID: hex and hyphens) — it becomes a
 *  path and a glob on the container, so nothing else may. */
const BACKUP_ID_RE = /^(?=.*[0-9a-fA-F])[0-9a-fA-F-]{8,64}$/;
const SLUG_RE = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
/** A branch name git accepts (`check-ref-format --branch`, in the shape a
 *  Slack thread binds): printable, no leading `-`/`/`/`.`, no `..`, no
 *  `//`, none of git's reserved characters, no trailing `.` or `.lock`. */
const REF_RE = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*\.$)(?!.*@\{)[\x21-\x7e]{1,255}$/;
const REF_FORBIDDEN = /[~^:?*[\\]/;

const isRef = (v: unknown): v is string => typeof v === "string" && REF_RE.test(v) && !REF_FORBIDDEN.test(v);
const isId = (v: unknown): v is string => typeof v === "string" && BACKUP_ID_RE.test(v);
const isSha = (v: unknown): v is string => typeof v === "string" && SHA_RE.test(v);

/** The body's `seed`, checked field by field; every refusal names the field. */
export function parseSeed(v: unknown): { ok: true; seed: SandboxSeed } | { ok: false; error: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return { ok: false, error: "seed: not an object" };
  const o = v as Record<string, unknown>;
  const fail = (error: string) => ({ ok: false as const, error: `seed: ${error}` });
  if (!isId(o.checkoutBackupId)) return fail("checkoutBackupId is not a backup id");
  if (o.depsBackupId !== undefined && !isId(o.depsBackupId)) return fail("depsBackupId is not a backup id");
  if (typeof o.slug !== "string" || !SLUG_RE.test(o.slug)) return fail("slug is not owner/name");
  if (!isRef(o.ref)) return fail("ref is not a branch name");
  if (o.fetchRef !== undefined && !isRef(o.fetchRef)) return fail("fetchRef is not a branch name");
  if (!isSha(o.sha)) return fail("sha is not a commit sha");
  if (o.fetchSha !== undefined && !isSha(o.fetchSha)) return fail("fetchSha is not a commit sha");
  return {
    ok: true,
    seed: {
      slug: o.slug,
      checkoutBackupId: o.checkoutBackupId,
      ...(o.depsBackupId !== undefined ? { depsBackupId: o.depsBackupId } : {}),
      ref: o.ref,
      sha: o.sha,
      ...(o.fetchRef !== undefined ? { fetchRef: o.fetchRef } : {}),
      ...(o.fetchSha !== undefined ? { fetchSha: o.fetchSha } : {}),
    },
  };
}

/** The fix-up after the restores, as root inside the sandbox, failing fast:
 *   1. the tree becomes root's — the archive came from the resident's build
 *      user, and a sandbox runs everything as root, so git would otherwise
 *      refuse the "dubious ownership" and every write would need a chown;
 *   2. origin points at this run's exact repository on the Git door — the
 *      resident's checkout fetched from its local mirror;
 *   3. the deps view, when one was restored, replaces whatever `node_modules`
 *      the checkout carries (older snapshots still hold one);
 *   4. the thread's ref is fetched from origin (the credential is the exec
 *      run bearer through the Git door and per-command env — never a token
 *      in this text) and checked out, at its resolved head when the
 *      fetch holds it, else at the fetched tip; without a thread ref the
 *      checkout stays on the snapshot's branch;
 *   5. the head is printed last: the answer's `sha`. */
export function seedDoorRemote(baseUrl: string, slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error("seed door remote needs owner/name");
  const base = new URL(baseUrl);
  if ((base.protocol !== "https:" && base.protocol !== "http:") || base.username || base.password)
    throw new Error("seed door remote needs an HTTP origin");
  return `${base.origin}/git/${slug}.git`;
}

export function seedFixupScript(input: {
  slug: string;
  doorOrigin: string;
  ref: string;
  fetchRef?: string;
  fetchSha?: string;
  checkoutDir: string;
  depsDir?: string;
}): string {
  const lines = [
    "set -e",
    `cd ${shellQuote(input.checkoutDir)}`,
    "chown -R 0:0 .",
    `git remote set-url origin ${shellQuote(seedDoorRemote(input.doorOrigin, input.slug))}`,
  ];
  if (input.fetchRef) {
    const ref = shellQuote(input.fetchRef);
    lines.push(
      `git fetch --no-tags origin ${shellQuote(`+refs/heads/${input.fetchRef}:refs/remotes/origin/${input.fetchRef}`)}`,
    );
    if (input.fetchSha) {
      const sha = shellQuote(input.fetchSha);
      lines.push(
        `if git cat-file -e ${sha}'^{commit}' 2>/dev/null; then git checkout -q -B ${ref} ${sha}; else git checkout -q -B ${ref} ${shellQuote(`origin/${input.fetchRef}`)}; fi`,
      );
    } else {
      lines.push(`git checkout -q -B ${ref} ${shellQuote(`origin/${input.fetchRef}`)}`);
    }
  } else {
    lines.push(`git checkout -q -B ${shellQuote(input.ref)}`);
  }
  if (input.depsDir) {
    lines.push(depsEntryMaterializeScript(input.depsDir, input.checkoutDir));
    lines.push(dependencyLayoutCommand(input.checkoutDir));
  }
  lines.push("git rev-parse HEAD");
  return lines.join("\n");
}

/** The SDK's missing-backup error — the handle's objects are gone (a rotation
 *  or an offboard took them): by name, which survives the RPC boundary, or by
 *  either of its two texts. */
export function isBackupMissing(shape: { name?: string; message?: string }): boolean {
  if (shape.name === "BackupNotFoundError") return true;
  return /Backup (?:archive )?not found/i.test(shape.message ?? "");
}

// -- the bot's half: from the resident's handle to a selection -----------------

/** The seed handle as the resident's `/status` publishes it (the bot's probe
 *  carries it as `seed`, [resident.ts](./resident.ts)). */
export interface SeedHandle {
  checkoutBackupId: string;
  depsBackupId?: string;
  ref: string;
  sha: string;
}

/** The seed for one thread: the resident's handle plus the thread's own ref
 *  and resolved head when it has them — a thread bound to a branch is checked
 *  out on it, a thread with none stays on the snapshot's. */
export function seedForThread(
  handle: SeedHandle,
  thread: { slug: string; ref?: string; headSha?: string },
): SandboxSeed {
  return {
    slug: thread.slug,
    checkoutBackupId: handle.checkoutBackupId,
    ...(handle.depsBackupId ? { depsBackupId: handle.depsBackupId } : {}),
    ref: handle.ref,
    sha: handle.sha,
    ...(thread.ref ? { fetchRef: thread.ref } : {}),
    ...(thread.ref && thread.headSha ? { fetchSha: thread.headSha } : {}),
  };
}

/** What a seeded sandbox is, on the selection: where the checkout is and what
 *  it is on, for the prompt and the card. */
export interface SeededSandbox {
  /** Verified effect receipt kept on the saved workspace binding across resumes. */
  repairReceipt?: import("./installRepairPolicy.js").InstallRepairReceipt;
  slug: string;
  ref: string;
  sha: string;
  /** The snapshot commit whose root lockfiles supplied the dependency view. */
  sourceSha?: string;
  /** The original checkout archive identifier in the preservation owner. */
  seedBackupId?: string;
  /** The actual restored dependency archive, vouched for by the seed response. */
  depsBackupId?: string;
  /** The checkout's path inside the sandbox — the run's working tree. */
  workspace: string;
  /** The Worker's claimed preservation incarnation, recorded on the run's binding. */
  preservationContainer?: string;
  /** The container already carried this seed: nothing was restored. */
  cached: boolean;
  ms: number;
}

/** After a refused seed: retry once with a fresh handle when the handle's
 *  objects were gone and the resident has since published another (a rotation
 *  took the first); otherwise the run goes cold, and the reason says why. */
export type SeedRetry =
  { action: "retry"; seed: SandboxSeed } | { action: "cold"; why: string } | { action: "refuse"; why: string };

export function seedRetryDecision(input: {
  answer: Extract<SeedAnswer, { seeded: false }>;
  attempted: SandboxSeed;
  fresh: SeedHandle | undefined;
  alreadyRetried: boolean;
}): SeedRetry {
  const { answer, attempted, fresh } = input;
  if (answer.reason === "seed-incompatible") return { action: "refuse", why: "cached dependency layout is invalid" };
  if (answer.reason === "seed-missing" && !input.alreadyRetried) {
    if (fresh && fresh.checkoutBackupId !== attempted.checkoutBackupId) {
      return {
        action: "retry",
        seed: seedForThread(fresh, {
          slug: attempted.slug,
          ...(attempted.fetchRef ? { ref: attempted.fetchRef } : {}),
          ...(attempted.fetchSha ? { headSha: attempted.fetchSha } : {}),
        }),
      };
    }
    return { action: "cold", why: `seed missing (${answer.detail}) and the resident published no newer handle` };
  }
  return { action: "cold", why: `${answer.reason.replace("seed-", "seed ")} (${answer.detail})` };
}

/** The card's one line for a seeded sandbox, after the reason the resident
 *  was not used: what it was seeded from, so a reader tells the three paths
 *  — resident, seeded, cold — apart from Slack alone. */
export function seededSandboxNote(
  reason: string,
  seeded: Pick<SeededSandbox, "slug" | "ref" | "sha" | "cached">,
): string {
  return `${reason} — seeded sandbox · from resident snapshot${seeded.cached ? " (already seeded)" : ""} · ${seeded.slug} · ${seeded.ref}@${seeded.sha.slice(0, 7)}`;
}
