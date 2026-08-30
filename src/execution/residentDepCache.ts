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
