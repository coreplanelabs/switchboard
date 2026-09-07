/** Per-directory mechanism for the resident's dep/build cache (KTD7,
 *  features/resident-repos.md item 18), kept pure and dependency-free so it
 *  is unit-testable from src/ and imported by the resident Worker
 *  (deploy/cloudflare-resident/worker.ts `materializeThreadDeps`) like
 *  residentReadonly / residentHead — the tested code IS the shipped code.
 *
 *  Background (2026-08-30, review of switchboard#315): every cached dir was
 *  hardlink-copied (`cp -al`) from the warm checkout with the FILE inodes
 *  left worker1-owned and stripped of group/world write — right for
 *  node_modules, which a thread only ever reads, and the whole point of the
 *  tamper-proofing (a thread must never mutate bytes the warm checkout or a
 *  peer tree sees). But the review agent is told to RUN the project's build,
 *  and `/op build` runs it too; compilers rewrite `dist/**` in place
 *  (open+truncate through the existing inode), so with a hardlinked `dist/`
 *  the build died with EACCES and the agent reported the tree as read-only.
 *  Build outputs are therefore materialized as plain copies: fresh inodes
 *  fully owned by the thread user, overwritable, and still isolated from the
 *  warm checkout (a copy shares nothing). */

import { shellQuote } from "./shellQuote.js";

export const DEP_CACHE_DIRS = ["node_modules", "dist", "build", "out", ".next"] as const;
export type DepCacheDir = (typeof DEP_CACHE_DIRS)[number];

/** How one cached dir is brought into a thread tree. `hardlink` = `cp -al`
 *  (shared worker1-owned read-only inodes; falls back to `copy` when the
 *  hardlink fails, e.g. cross-device). `copy` = `cp -R` + `chown -R` (fresh
 *  thread-owned inodes). */
export type DepCacheMaterialization = "hardlink" | "copy";

export function depCacheMaterialization(dir: DepCacheDir): DepCacheMaterialization {
  return dir === "node_modules" ? "hardlink" : "copy";
}

/** Inside a HARDLINKED node_modules, the paths tools rewrite in place and so
 *  must be real copies (fresh thread-owned inodes) rather than shared
 *  read-only inodes — the same EACCES class as the build dirs, one level
 *  down. Packages themselves are immutable after install; the mutable parts
 *  are tool-managed: every TOP-LEVEL dot entry of node_modules (`.cache` —
 *  babel-loader/eslint/prettier/webpack; `.vite` + `.vitest` — vite's dep
 *  optimizer and vitest's results file; `.prisma` — the client `prisma
 *  generate` rewrites during a build; `.bin` — shims some installers
 *  regenerate; `.package-lock.json` — npm's hidden lockfile) plus any
 *  `.cache` directory nested deeper (a package's own on-disk cache, e.g.
 *  `node_modules/<loader>/.cache`). Scoped packages (`@scope`) are not dot
 *  entries. Nested dot dirs OTHER than `.cache` (a vendored `.github`, a
 *  package's `.bin`) stay shared: they are package content, not caches.
 *
 *  The ONE top-level dot entry that is package content, not a cache, is
 *  `.pnpm` — pnpm's virtual store, where every installed package's files
 *  actually live (the top-level entries are symlinks into it). It is
 *  immutable after install, exactly like the packages it holds, so it stays
 *  hardlinked; a `.cache` nested inside it is still a cache and still copied.
 *  2026-09-05: swapping it for a plain copy made every thread tree of a pnpm
 *  workspace a full 2.6 GB copy of its dependencies and a fresh attach ~190 s
 *  (nominal), and one thread filled the old 8 GB resident disk (#448).
 *
 *  `mutableCacheFindArgv` is the exact `find` the Worker runs to enumerate
 *  those paths; `mutableCachePaths` turns its output lines into the list to
 *  replace, dropping anything already covered by a listed ancestor (the
 *  ancestor copy brings its subtree along) and anything outside the root. */
export function mutableCacheFindArgv(nodeModulesDir: string): string[] {
  // `-path "<root>/.*"` (find's -path glob does not treat "/" specially)
  // matches every top-level dot entry AND its descendants — the descendants
  // are dropped by mutableCachePaths' ancestor rule. Deliberately not
  // `-maxdepth`: GNU find applies -maxdepth GLOBALLY even inside parentheses
  // (with a warning), which would cap the nested .cache search at depth 1.
  return [
    "find",
    nodeModulesDir,
    "-mindepth",
    "1",
    "(",
    "-path",
    `${nodeModulesDir}/.*`,
    "-o",
    "-type",
    "d",
    "-name",
    ".cache",
    ")",
  ];
}

/** Top-level dot entries of node_modules that hold PACKAGE CONTENT rather than
 *  a tool's cache — shared like any package, never copied per thread. */
const PACKAGE_STORE_ENTRIES: ReadonlySet<string> = new Set([".pnpm"]);

export function mutableCachePaths(nodeModulesDir: string, findOutputLines: readonly string[]): string[] {
  const root = nodeModulesDir.replace(/\/+$/, "");
  const candidates = findOutputLines
    .map((l) => l.trim())
    .filter((l) => l !== "" && l.startsWith(`${root}/`))
    .filter((l) => {
      const rel = l.slice(root.length + 1);
      const parts = rel.split("/");
      if (parts.length === 1) return parts[0].startsWith(".") && !PACKAGE_STORE_ENTRIES.has(parts[0]);
      return parts[parts.length - 1] === ".cache";
    })
    .sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const c of candidates) {
    if (kept.some((k) => c.startsWith(`${k}/`))) continue;
    kept.push(c);
  }
  // Preserve the find's own order among the kept paths for readable logs.
  const order = new Map(findOutputLines.map((l, i) => [l.trim(), i] as const));
  return kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/** What the attach answer's `deps` field reports after each dir is
 *  materialized. `node_modules` is the dependency cache the field exists to
 *  describe (`hardlink` = warm shared cache, `copy` = cp -al fell back), so
 *  it decides whenever the warm checkout has one; build-dir copies are the
 *  norm and must not mask that signal — they only fill in when nothing else
 *  has. `none` in = nothing materialized yet. */
export function foldDepsMechanism(
  prev: DepCacheMaterialization | "none",
  dir: DepCacheDir,
  used: DepCacheMaterialization | "none",
): DepCacheMaterialization | "none" {
  if (dir === "node_modules") return used;
  return prev === "none" ? used : prev;
}

// ---------------------------------------------------------------------------
// One-fork materialization (#356 item 4)
// ---------------------------------------------------------------------------
//
// materializeThreadDeps used to spawn per dir: `test -d`, `test -e`, the
// `cp -al`/`cp -R`, a full `find -type d -exec chown` walk, a SECOND full
// `find -type f -exec chmod` walk, the mutable-cache `find` listing, then
// rm/cp/chown per mutable path — ~25 container round-trips for five dirs,
// all while holding the mirror mutex (which every concurrent attach and the
// refresh cycle queue behind). The same work now runs as TWO forks:
// `depCacheScript` handles all five dirs (per-dir gating, mechanism,
// permissions in ONE combined find walk, the mutable-cache listing) and
// emits one tagged line per materialized dir plus the raw listing; the DO
// parses with `parseDepCacheScriptOutput`, filters the listing through the
// unchanged `mutableCachePaths`, and `mutableCacheSwapScript` performs every
// swap in the second fork. The resulting ownership/permission state is
// byte-identical to the per-spawn version (KTD5-adjacent — see each block's
// comment); only the fork count changed.

/** What the DO reads back from one script run. `failedStep` carries the
 *  `err=` tag a failing block emitted (the old per-spawn StepError names:
 *  deps-perms — the combined chown+harden walk, formerly deps-chown +
 *  deps-harden — deps-mutable-list, deps-copy, deps-copy-chown, and the swap
 *  script's deps-mutable-rm/copy/chown). */
export interface DepCacheScriptParse {
  mech: DepCacheMaterialization | "none";
  /** Raw `find` output for the hardlinked node_modules (the exact
   *  `mutableCacheFindArgv` shape), for `mutableCachePaths`. */
  mutableListing: string[];
  failedStep: string | null;
}

/** Build the one-fork materialization script over every DEP_CACHE_DIRS entry.
 *  Per dir, exactly the old per-spawn behavior:
 *   - src missing or dst present → skip (no line emitted, mechanism unfolded);
 *   - hardlink dirs (node_modules): `cp -al`, then ONE find walk chowning
 *     DIRECTORIES to the thread user and stripping group/world write from the
 *     shared FILE inodes (`( -type d -exec chown … + ) -o ( -type f ( -perm
 *     -g+w -o -perm -o+w ) -exec chmod go-w … + )` — the -o short-circuits on
 *     the first alternative's always-true `-exec +`, so dirs get the chown and
 *     only files reach the perm test: the union of the two old walks, one
 *     traversal); then the mutable-cache listing (`mutableCacheFindArgv`,
 *     emitted as `mutable=` lines). `cp -al` failure → rm + plain-copy
 *     fallback, same as before;
 *   - copy dirs: `cp -R` + `chown -Rh` (never dereference a planted symlink). */
export function depCacheScript(checkoutDir: string, worktree: string, user: string): string {
  const owner = shellQuote(`${user}:${user}`);
  const blocks = DEP_CACHE_DIRS.map((dir) => {
    const src = shellQuote(`${checkoutDir}/${dir}`);
    const dst = shellQuote(`${worktree}/${dir}`);
    const copyFallback = [
      `  cp -R ${src} ${dst} || { echo err=deps-copy; exit 1; }`,
      `  chown -Rh ${owner} ${dst} || { echo err=deps-copy-chown; exit 1; }`,
      `  echo 'dir:${dir}=copy'`,
    ];
    if (depCacheMaterialization(dir) !== "hardlink") {
      return [`if test -d ${src} && ! test -e ${dst}; then`, ...copyFallback, `fi`].join("\n");
    }
    const walk = `find ${dst} \\( -type d -exec chown ${owner} {} + \\) -o \\( -type f \\( -perm -g+w -o -perm -o+w \\) -exec chmod go-w {} + \\)`;
    const listing = mutableCacheFindArgv(`${worktree}/${dir}`).map(shellQuote).join(" ");
    return [
      `if test -d ${src} && ! test -e ${dst}; then`,
      `  if cp -al ${src} ${dst}; then`,
      `    ${walk} || { echo err=deps-perms; exit 1; }`,
      `    if ! mlist=$(${listing}); then echo err=deps-mutable-list; exit 1; fi`,
      `    if [ -n "$mlist" ]; then printf '%s\\n' "$mlist" | sed 's/^/mutable=/'; fi`,
      `    echo 'dir:${dir}=hardlink'`,
      `  else`,
      `    rm -rf ${dst}`,
      ...copyFallback,
      `  fi`,
      `fi`,
    ].join("\n");
  });
  return blocks.join("\n");
}

export function parseDepCacheScriptOutput(stdout: string): DepCacheScriptParse {
  let mech: DepCacheMaterialization | "none" = "none";
  const mutableListing: string[] = [];
  let failedStep: string | null = null;
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^dir:([^=]+)=(hardlink|copy)$/.exec(line))) {
      if ((DEP_CACHE_DIRS as readonly string[]).includes(m[1])) {
        mech = foldDepsMechanism(mech, m[1] as DepCacheDir, m[2] as DepCacheMaterialization);
      }
    } else if ((m = /^mutable=(.+)$/.exec(line))) {
      mutableListing.push(m[1]);
    } else if ((m = /^err=(.+)$/.exec(line))) {
      failedStep ??= m[1];
    }
  }
  return { mech, mutableListing, failedStep };
}

/** The per-path swaps for a hardlinked node_modules' tool-managed entries
 *  (`mutableCachePaths` output), all in one fork: `rm -rf` the shared
 *  subtree, `cp -R` the warm checkout's matching subpath (fresh inodes),
 *  `chown -Rh` to the thread user (-h: a postinstall-planted symlink is
 *  re-owned as a LINK, never followed to an out-of-tree target). Same steps,
 *  same order, same flags as the old per-spawn loop. */
export function mutableCacheSwapScript(
  srcRoot: string,
  dstRoot: string,
  user: string,
  paths: readonly string[],
): string {
  const owner = shellQuote(`${user}:${user}`);
  const root = dstRoot.replace(/\/+$/, "");
  const lines: string[] = [];
  for (const p of paths) {
    const rel = p.slice(root.length);
    lines.push(`rm -rf ${shellQuote(p)} || { echo err=deps-mutable-rm; exit 1; }`);
    lines.push(`cp -R ${shellQuote(`${srcRoot}${rel}`)} ${shellQuote(p)} || { echo err=deps-mutable-copy; exit 1; }`);
    lines.push(`chown -Rh ${owner} ${shellQuote(p)} || { echo err=deps-mutable-chown; exit 1; }`);
  }
  return lines.join("\n");
}
