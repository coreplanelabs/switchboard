/** The resident's content-addressed dependency store (docs/reference/specs/resident-repos.md
 *  item 59), kept pure and dependency-free so it is unit-testable from
 *  src/ and imported by the resident Worker like residentDepCache — the
 *  tested code IS the shipped code.
 *
 *  Background: dependencies used to be installed IN PLACE and PER
 *  CONSUMER — provisioning into the checkout, the refresh cycle into the
 *  checkout again on every lockfile change, a thread whose branch lockfile
 *  differed from the checkout's into its own gigabyte tree. Three install
 *  sites, three budgets, none aware of the others: a refresh cycle whose
 *  install outlived its budget spiralled (the next cycle's clean raced the
 *  orphaned installer), and an attach could die mid-install; both faults
 *  lived in the seams. A resident ran dozens of installs a day for a dozen
 *  distinct lockfile keys, because "older than the default branch's lockfile"
 *  and "different from it" were the same comparison.
 *
 *  Shape: one entry per lockfile key (the hash of the committed
 *  lockfile — a pure function of the commit) under DEPS_STORE_DIR, holding
 *  the tree's top-level `node_modules` exactly as the install produced it.
 *  An entry is IMMUTABLE once complete (`.complete` written last, inside the
 *  entry so the atomic rename carries it) — Flyweight: every consumer shares
 *  one tree by identity through hardlink views, and nothing ever writes into
 *  a completed entry. One primitive materializes a key (hit → the path;
 *  in-flight → join that promise; miss → install into a private scratch
 *  clone, MOVE its node_modules into a staging dir, rename to the entry,
 *  mark). The installer runs OUTSIDE the mirror lock — it reads the mirror's
 *  objects through a `--shared` clone and touches no consumer's tree — so a
 *  full install no longer holds every attach behind it.
 *
 *  Eviction: the store is a cache. Protected keys (the checkout's,
 *  every live binding's, every install in flight) never go; among the rest,
 *  debris (incomplete, nothing in flight) first, then coldest `.used` first,
 *  keeping at most DEPS_STORE_MAX_UNREFERENCED warm spares. */

import { shellQuote } from "./shellQuote.js";

export const DEPS_STORE_DIR = "/workspace/deps";

/** A lockfile key is the lowercase hex sha256 the resident computes; nothing
 *  else may become a path segment under the store. */
const LOCKFILE_KEY_RE = /^[0-9a-f]{64}$/;

function assertKey(key: string): void {
  if (!LOCKFILE_KEY_RE.test(key)) throw new Error(`deps store: not a lockfile key: ${JSON.stringify(key)}`);
}

export function depsEntryPath(key: string, storeDir: string = DEPS_STORE_DIR): string {
  assertKey(key);
  return `${storeDir}/${key}`;
}

export function depsCompletePath(key: string, storeDir: string = DEPS_STORE_DIR): string {
  return `${depsEntryPath(key, storeDir)}/.complete`;
}

/** mtime of this file = when a consumer last materialized from the entry
 *  (touched on every hit); the LRU clock. */
export function depsUsedPath(key: string, storeDir: string = DEPS_STORE_DIR): string {
  return `${depsEntryPath(key, storeDir)}/.used`;
}

/** Per-attempt private dirs: the scratch clone the install runs in and the
 *  staging dir the finished node_modules moves into. `attempt` is unique per
 *  call (a DO reset mid-install leaves one behind as a named leftover). */
export function depsScratchPath(attempt: string, storeDir: string = DEPS_STORE_DIR): string {
  return `${storeDir}/.scratch-${attempt}`;
}

export function depsStagingPath(key: string, attempt: string, storeDir: string = DEPS_STORE_DIR): string {
  assertKey(key);
  return `${storeDir}/.staging-${key}-${attempt}`;
}

export type DepsMaterializationPlan =
  { action: "hit" } | { action: "join" } | { action: "restore" } | { action: "install" };

/** A complete entry wins over everything (a stale in-flight memo after a DO
 *  reset must never make a caller wait for an install that is not running);
 *  an install already running for the key is joined, never duplicated; a
 *  recorded entry backup (item 61) is restored before anything is
 *  installed — the container downloads a finished tree instead of building
 *  one — and only a key with neither installs. */
export function planDepsMaterialization(input: {
  complete: boolean;
  inFlight: boolean;
  /** An entry backup is recorded for the key (`depsBackupStorageKey`). */
  backup?: boolean;
}): DepsMaterializationPlan {
  if (input.complete) return { action: "hit" };
  if (input.inFlight) return { action: "join" };
  if (input.backup) return { action: "restore" };
  return { action: "install" };
}

// ---------------------------------------------------------------------------
// Entry backups (item 61): content-addressed snapshots of the store
// ---------------------------------------------------------------------------

/** The checkout snapshot leaves out its top-level node_modules: since item 59
 *  that directory is a hardlink view of an immutable store entry, and the
 *  entry has its own backup (below). Nested node_modules (a workspace package's
 *  own) stay in — small, and the view mechanism does not cover them. The
 *  pattern is anchored at the archive root (mksquashfs wildcard semantics:
 *  a bare name matches only there; `...`-prefixed patterns match anywhere). */
export const CHECKOUT_SNAPSHOT_EXCLUDES: readonly string[] = ["node_modules"];

/** One backup per lockfile key, taken ONCE right after the entry is committed
 *  (install or adoption) and never again: the entry is immutable, so its
 *  archive is too. Recorded on the DO under this prefix, by key. */
export const DEPS_BACKUP_KEY_PREFIX = "resident:depsBackup:";

export function depsBackupStorageKey(key: string): string {
  assertKey(key);
  return `${DEPS_BACKUP_KEY_PREFIX}${key}`;
}

/** Entry backups are a cache with a long shelf life: a key stays warm for as
 *  long as main keeps its lockfile, and the wake path counts on finding the
 *  warm key's archive. 180 days; an expired archive fails the restore and the
 *  local installer runs, re-recording a fresh backup — never a stranded key.
 *  The snapshot handles keep their own TTL (SNAPSHOT_TTL_S in the Worker). */
export const DEPS_BACKUP_TTL_S = 180 * 24 * 60 * 60;

/** After a store sweep: the backups whose entries the sweep just evicted go
 *  too — a spare nothing references on disk is a spare nothing will wake
 *  into either, and the archive is re-taken on the next install of that key.
 *  Never a key still in the store, and never a key without a record. */
export function depsBackupsToDrop(input: {
  evictedKeys: readonly string[];
  backedUpKeys: readonly string[];
}): string[] {
  const backedUp = new Set(input.backedUpKeys);
  return input.evictedKeys.filter((k) => backedUp.has(k));
}

/** Distinct keys may install in parallel up to the core count — `nproc`
 *  read once per incarnation — never a constant. Two installs on one core
 *  each take twice as long, so on today's 1 vCPU this is 1 by arithmetic.
 *  Anything unreadable is 1: serial is the safe floor. */
export function depsInstallSemaphoreSize(nprocStdout: string | null): number {
  const n = Number.parseInt((nprocStdout ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** The scratch tree the install runs in: a `--shared` clone (objects via
 *  alternates into the mirror — no second copy of history, seconds not
 *  minutes) checked out detached at the key's sha. Root creates it; the
 *  caller chowns it to the build user before the install. */
export function depsScratchCloneArgv(input: { mirrorDir: string; scratchDir: string; sha: string }): string[] {
  const { mirrorDir, scratchDir, sha } = input;
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`deps store: not a sha: ${JSON.stringify(sha)}`);
  const script = [
    `git clone --shared --no-checkout --quiet ${shellQuote(mirrorDir)} ${shellQuote(scratchDir)}`,
    `git -C ${shellQuote(scratchDir)} checkout --detach --quiet ${sha}`,
  ].join(" && ");
  return ["sh", "-c", script];
}

/** The key of a commit with NO lockfile: `git ls-tree <sha> -- <candidates>`
 *  prints nothing, and sha256 of no input is this constant. */
export const NO_LOCKFILE_KEY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Harden the scratch tree's node_modules before it becomes an entry, as
 *  root: every file loses owner write, so a consumer's build fails EACCES on
 *  a write through a shared inode instead of mutating every other consumer's
 *  tree (item 59). A tree with no node_modules after the install is a failed
 *  install when the commit HAS a lockfile (there was something to install)
 *  and an empty entry when it has none — a repo whose install command is a
 *  no-op (`true`, a terraform tree) keys to NO_LOCKFILE_KEY and gets an empty
 *  node_modules, owned by the build user like an installed one, so every
 *  consumer's view links an empty directory and nothing else changes. Without
 *  the empty case, such a repo's rebuild fails at this step (`find:
 *  '…/node_modules': No such file or directory`). */
export function depsHardenScript(input: {
  scratchDir: string;
  /** chown spec for the created empty directory (`user:group`) — the build user's. */
  owner: string;
  emptyOk: boolean;
}): string {
  const nm = shellQuote(`${input.scratchDir}/node_modules`);
  const absent = input.emptyOk
    ? `mkdir ${nm} && chown ${input.owner} ${nm}`
    : `echo "install produced no node_modules in ${input.scratchDir}" >&2; exit 1`;
  return [`set -e`, `test -d ${nm} || { ${absent}; }`, `find ${nm} -type f -perm -u+w -exec chmod u-w {} +`].join("\n");
}

/** Commit an install to the store, as root, in the order that makes the entry
 *  either absent or complete and never half-there:
 *   1. the scratch tree must hold a node_modules — depsHardenScript ran first
 *      and either found one, created the empty one a lockfile-less commit is
 *      allowed, or failed; a tree without one here is a caller bug;
 *   2. MOVE it into the staging dir (same filesystem: a rename, not a copy);
 *   3. rename staging → entry — atomic; a racer that finds the entry already
 *      complete (another attempt won, or a DO reset re-ran the install) drops
 *      its own staging and keeps the winner;
 *   4. write `.complete` LAST, and `.used` so the LRU clock starts;
 *   5. remove the scratch clone. */
export function depsStoreCommitScript(input: {
  scratchDir: string;
  stagingDir: string;
  entryDir: string;
  completePath: string;
  /** Adoption (the scratch IS the warm checkout — a pre-store disk or a
   *  fresh restore): move its node_modules in, but leave the tree itself. */
  keepScratch?: boolean;
}): string {
  const scratchNm = shellQuote(`${input.scratchDir}/node_modules`);
  const staging = shellQuote(input.stagingDir);
  const stagingNm = shellQuote(`${input.stagingDir}/node_modules`);
  const entry = shellQuote(input.entryDir);
  const complete = shellQuote(input.completePath);
  const used = shellQuote(`${input.entryDir}/.used`);
  return [
    `set -e`,
    `test -d ${scratchNm} || { echo "install produced no node_modules in ${input.scratchDir}" >&2; exit 1; }`,
    `rm -rf ${staging}`,
    `mkdir ${staging}`,
    `mv ${scratchNm} ${stagingNm}`,
    // An entry dir WITHOUT its marker is crash debris (the shell died between
    // the rename and the touch): remove it, or the rename below would nest
    // the new staging inside it and the touch would mark the pair complete.
    `if test -f ${complete}; then rm -rf ${staging}; else rm -rf ${entry}; mv ${staging} ${entry}; fi`,
    `touch ${complete} ${used}`,
    ...(input.keepScratch ? [] : [`rm -rf ${shellQuote(input.scratchDir)}`]),
  ].join("\n");
}

export interface DepsStoreEntry {
  key: string;
  complete: boolean;
  kib: number;
  /** `.used` mtime, epoch seconds; 0 when absent. */
  usedAtS: number;
}

export interface DepsStoreListing {
  entries: DepsStoreEntry[];
  /** `.scratch-*` / `.staging-*` dirs: attempts a DO reset or a failure left behind. */
  leftovers: string[];
}

/** One fork: every entry (a 64-hex dir) as a tagged line with its complete
 *  flag, `du -sk` size and `.used` mtime; every dot-dir as a leftover line.
 *  A missing store dir is an empty listing, never an error. */
export function depsStoreListScript(storeDir: string = DEPS_STORE_DIR): string {
  const dir = shellQuote(storeDir);
  return [
    `test -d ${dir} || exit 0`,
    `cd ${dir}`,
    `for e in *; do`,
    `  [ -d "$e" ] || continue`,
    `  case "$e" in *[!0-9a-f]*) continue;; esac`,
    `  [ ${"${#e}"} -eq 64 ] || continue`,
    `  c=0; [ -f "$e/.complete" ] && c=1`,
    `  k=$(du -sk "$e" 2>/dev/null | cut -f1); [ -n "$k" ] || k=0`,
    `  u=$(stat -c %Y "$e/.used" 2>/dev/null); [ -n "$u" ] || u=0`,
    `  echo "entry=$e complete=$c kib=$k used=$u"`,
    `done`,
    `for l in .scratch-* .staging-*; do [ -e "$l" ] && echo "leftover=${storeDir}/$l"; done`,
    `exit 0`,
  ].join("\n");
}

export function parseDepsStoreListing(stdout: string): DepsStoreListing {
  const entries: DepsStoreEntry[] = [];
  const leftovers: string[] = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^entry=([0-9a-f]{64}) complete=([01]) kib=(\d+) used=(\d+)$/.exec(line))) {
      entries.push({ key: m[1], complete: m[2] === "1", kib: Number(m[3]), usedAtS: Number(m[4]) });
    } else if ((m = /^leftover=(.+)$/.exec(line))) {
      leftovers.push(m[1]);
    }
  }
  return { entries, leftovers };
}

/** Complete unreferenced entries kept as warm spares beyond the protected
 *  set. 1: the item-55 sizing (10 hardlinked + 1 installing trees with the
 *  reserve on the 16 GB instance) leaves room for about one ~2 GiB entry
 *  beyond the checkout's own; a second spare would be paid for in refused
 *  attaches. Raise with the instance, never by feel. */
export const DEPS_STORE_MAX_UNREFERENCED = 1;

/** Eviction candidates coldest first. Never a protected key (the checkout's,
 *  a live binding's, an install in flight). Debris — an incomplete entry
 *  with nothing in flight for it — is always first: it is half an install
 *  nobody will finish. */
export function orderDepsEviction(input: {
  entries: readonly DepsStoreEntry[];
  protectedKeys: ReadonlySet<string>;
}): DepsStoreEntry[] {
  const candidates = input.entries.filter((e) => !input.protectedKeys.has(e.key));
  const debris = candidates.filter((e) => !e.complete);
  const complete = candidates.filter((e) => e.complete).sort((a, b) => a.usedAtS - b.usedAtS);
  return [...debris, ...complete];
}

export interface DepsEvictionPlan {
  /** Absolute paths to `rm -rf`, in order. Empty → nothing to fork for. */
  remove: string[];
  /** Keys that stay, for the log. */
  keep: string[];
}

export function planDepsEviction(input: {
  entries: readonly DepsStoreEntry[];
  leftovers: readonly string[];
  protectedKeys: ReadonlySet<string>;
  maxUnreferenced?: number;
  storeDir?: string;
}): DepsEvictionPlan {
  const max = input.maxUnreferenced ?? DEPS_STORE_MAX_UNREFERENCED;
  const storeDir = input.storeDir ?? DEPS_STORE_DIR;
  const ordered = orderDepsEviction({ entries: input.entries, protectedKeys: input.protectedKeys });
  const debris = ordered.filter((e) => !e.complete);
  const spares = ordered.filter((e) => e.complete);
  // Coldest first in `spares`; keep the warmest `max`.
  const evictSpares = spares.slice(0, Math.max(0, spares.length - max));
  const remove = [...debris, ...evictSpares].map((e) => depsEntryPath(e.key, storeDir));
  remove.push(...input.leftovers);
  const removed = new Set([...debris, ...evictSpares].map((e) => e.key));
  const keep = input.entries.filter((e) => !removed.has(e.key)).map((e) => e.key);
  return { remove, keep };
}
