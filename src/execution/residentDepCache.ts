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
  return ["find", nodeModulesDir, "-mindepth", "1", "(", "-path", `${nodeModulesDir}/.*`, "-o", "-type", "d", "-name", ".cache", ")"];
}

export function mutableCachePaths(nodeModulesDir: string, findOutputLines: readonly string[]): string[] {
  const root = nodeModulesDir.replace(/\/+$/, "");
  const candidates = findOutputLines
    .map((l) => l.trim())
    .filter((l) => l !== "" && l.startsWith(`${root}/`))
    .filter((l) => {
      const rel = l.slice(root.length + 1);
      const parts = rel.split("/");
      if (parts.length === 1) return parts[0].startsWith(".");
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
