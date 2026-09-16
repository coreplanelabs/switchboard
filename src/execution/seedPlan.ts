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

/** Where the seeded checkout lands: the run's working tree. */
export const SEED_CHECKOUT_DIR = "/workspace/checkout";
/** Where the deps-store entry's archive is extracted before it becomes the checkout's `node_modules`. */
export const SEED_DEPS_STAGING_DIR = "/workspace/.seed-deps";
/** The marker a seeded container carries (its text is `seedMarkerText`): what it was
 *  seeded from AND what was checked out, so a second `/seed` for the same seed answers
 *  at once — never restoring over a live tree — while one that names another ref or
 *  head is a new seed. */
export const SEED_MARKER = "/workspace/.switchboard-seed";

/** The marker's one line: the checkout handle, the ref the tree is on, the head asked
 *  for (or `-`). Two seeds are the same seed exactly when these agree; a retry carries
 *  the identical seed, a re-attach on another branch does not. */
export function seedMarkerText(seed: Pick<SandboxSeed, "checkoutBackupId" | "ref" | "fetchRef" | "fetchSha">): string {
  return `${seed.checkoutBackupId} ${seed.fetchRef ?? seed.ref} ${seed.fetchSha ?? "-"}`;
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
export const SEED_REASONS = ["seed-missing", "seed-failed", "seed-unconfigured"] as const;
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

export type SeedAnswer =
  | {
      seeded: true;
      /** The container already carried this handle's tree: nothing was restored. */
      cached: boolean;
      slug: string;
      /** What the checkout is on after the fix-up. */
      ref: string;
      sha: string;
      from: { ref: string; sha: string; checkoutBackupId: string; depsBackupId?: string };
      /** Milliseconds per step; `deps` null when no entry rode along; all zero when cached. */
      steps: { restore: number; deps: number | null; fixup: number };
      ms: number;
    }
  | { seeded: false; reason: SeedReason; detail: string; step?: SeedStep };

/** A backup id as the SDK mints it (a UUID: hex and hyphens) — it becomes a
 *  path and a glob on the container, so nothing else may. */
const BACKUP_ID_RE = /^(?=.*[0-9a-fA-F])[0-9a-fA-F-]{8,64}$/;
const SLUG_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
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
 *   2. origin points at GitHub — the resident's checkout fetched from its
 *      local mirror;
 *   3. the deps view, when one was restored, replaces whatever `node_modules`
 *      the checkout carries (older snapshots still hold one);
 *   4. the thread's ref is fetched from origin (the credential is the exec
 *      env's `GH_TOKEN`, through the image's `gh` credential helper — never a
 *      token in this text) and checked out, at its resolved head when the
 *      fetch holds it, else at the fetched tip; without a thread ref the
 *      checkout stays on the snapshot's branch;
 *   5. the head is printed last: the answer's `sha`. */
export function seedFixupScript(input: {
  slug: string;
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
    `git remote set-url origin ${shellQuote(`https://github.com/${input.slug}.git`)}`,
  ];
  if (input.depsDir) {
    lines.push("rm -rf node_modules", `mv ${shellQuote(input.depsDir)} node_modules`);
  }
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
  slug: string;
  ref: string;
  sha: string;
  /** The checkout's path inside the sandbox — the run's working tree. */
  workspace: string;
  /** The container already carried this seed: nothing was restored. */
  cached: boolean;
  ms: number;
}

/** After a refused seed: retry once with a fresh handle when the handle's
 *  objects were gone and the resident has since published another (a rotation
 *  took the first); otherwise the run goes cold, and the reason says why. */
export type SeedRetry = { action: "retry"; seed: SandboxSeed } | { action: "cold"; why: string };

export function seedRetryDecision(input: {
  answer: Extract<SeedAnswer, { seeded: false }>;
  attempted: SandboxSeed;
  fresh: SeedHandle | undefined;
  alreadyRetried: boolean;
}): SeedRetry {
  const { answer, attempted, fresh } = input;
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
