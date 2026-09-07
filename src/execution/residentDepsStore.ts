/** The resident's content-addressed dependency store (features/resident-repos.md
 *  item 59, #555), kept pure and dependency-free so it is unit-testable from
 *  src/ and imported by the resident Worker like residentDepCache — the
 *  tested code IS the shipped code.
 *
 *  Background (2026-09-07): dependencies were installed IN PLACE and PER
 *  CONSUMER — provisioning into the checkout, the refresh cycle into the
 *  checkout again on every lockfile change, a thread whose branch lockfile
 *  differed from the checkout's into its own 1.9 GiB tree. Three install
 *  sites, three budgets, none aware of the others: the refresh spiral (#529)
 *  and the ship attach that died mid-install (#552) both lived in the seams.
 *  The switchboard resident ran 32 installs that day for ~14 distinct
 *  lockfile keys, because "older than main's lockfile" and "different from
 *  main's lockfile" were the same comparison.
 *
 *  Shape: one entry per lockfile key (the KTD7 hash of the committed
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
 *  full install no longer holds every attach behind it (#170).
 *
 *  Eviction: the store is a cache (KTD3). Protected keys (the checkout's,
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

export type DepsMaterializationPlan = { action: "hit" } | { action: "join" } | { action: "install" };

/** A complete entry wins over everything (a stale in-flight memo after a DO
 *  reset must never make a caller wait for an install that is not running);
 *  an install already running for the key is joined, never duplicated. */
export function planDepsMaterialization(input: { complete: boolean; inFlight: boolean }): DepsMaterializationPlan {
  if (input.complete) return { action: "hit" };
  if (input.inFlight) return { action: "join" };
  return { action: "install" };
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

/** Commit an install to the store, as root, in the order that makes the entry
 *  either absent or complete and never half-there:
 *   1. the scratch tree must actually hold a node_modules (an install that
 *      produced nothing is a failure, not an empty entry);
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
