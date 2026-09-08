import { describe, expect, it } from "vitest";
import {
  DEP_CACHE_DIRS,
  depCacheMaterialization,
  depCacheScript,
  foldDepsMechanism,
  mutableCacheFindArgv,
  mutableCachePaths,
  mutableCacheSwapScript,
  parseDepCacheScriptOutput,
  planThreadDeps,
  threadDepsMechanism,
} from "./residentDepCache.js";

describe("depCacheMaterialization (dep/build cache, per directory)", () => {
  it("node_modules is hardlinked: shared read-only inodes, consumed never rewritten", () => {
    expect(depCacheMaterialization("node_modules")).toBe("hardlink");
  });
  it("build outputs are copied: a rebuild in the tree overwrites them in place (tsc/esbuild open+truncate), which a worker1-owned shared inode refuses with EACCES", () => {
    for (const dir of ["dist", "build", "out", ".next"] as const) {
      expect(depCacheMaterialization(dir)).toBe("copy");
    }
  });
  it("covers every cached dir exactly once — a new entry must pick a mechanism here", () => {
    expect([...DEP_CACHE_DIRS].sort()).toEqual([".next", "build", "dist", "node_modules", "out"].sort());
    for (const dir of DEP_CACHE_DIRS) expect(["hardlink", "copy"]).toContain(depCacheMaterialization(dir));
  });
});

describe("foldDepsMechanism (the `deps` field on the attach answer)", () => {
  it("node_modules decides: hardlink stays hardlink even after build dirs are copied", () => {
    let m = foldDepsMechanism("none", "node_modules", "hardlink");
    m = foldDepsMechanism(m, "dist", "copy");
    m = foldDepsMechanism(m, ".next", "copy");
    expect(m).toBe("hardlink");
  });
  it("a cp -al fallback on node_modules reports copy", () => {
    expect(foldDepsMechanism("none", "node_modules", "copy")).toBe("copy");
  });
  it("a repo with no node_modules in the warm checkout reports what its build dirs got", () => {
    expect(foldDepsMechanism("none", "dist", "copy")).toBe("copy");
  });
  it("nothing materialized stays none", () => {
    expect(foldDepsMechanism("none", "dist", "none")).toBe("none");
  });
});

describe("mutableCachePaths (tool-managed paths inside a hardlinked node_modules that must be real copies)", () => {
  const ROOT = "/wt/node_modules";
  it("every top-level dot entry of node_modules is mutable: .cache, .vite, .vitest, .prisma, .bin, .package-lock.json", () => {
    const listing = [
      `${ROOT}/.cache`,
      `${ROOT}/.vite`,
      `${ROOT}/.prisma`,
      `${ROOT}/.bin`,
      `${ROOT}/.package-lock.json`,
      `${ROOT}/react`,
      `${ROOT}/@types`,
    ];
    expect(mutableCachePaths(ROOT, listing)).toEqual([
      `${ROOT}/.cache`,
      `${ROOT}/.vite`,
      `${ROOT}/.prisma`,
      `${ROOT}/.bin`,
      `${ROOT}/.package-lock.json`,
    ]);
  });
  // A pnpm workspace's resident took minutes per fresh attach and every thread
  // tree cost gigabytes of real disk — `.pnpm`, pnpm's virtual store holding
  // ALL package content, is a top-level dot entry and was being swapped for a
  // plain copy, undoing the hardlink sharing for 100% of the dependency bytes
  // (one thread could fill the disk).
  it("pnpm's `.pnpm` store is package content, never a cache: it stays hardlinked, while a `.cache` nested inside it is still copied", () => {
    const listing = [
      `${ROOT}/.pnpm`,
      `${ROOT}/.pnpm/lodash@4.17.21/node_modules/lodash`,
      `${ROOT}/.pnpm/node_modules/.bin`,
      `${ROOT}/.pnpm/some-loader@1.0.0/node_modules/some-loader/.cache`,
      `${ROOT}/.modules.yaml`,
      `${ROOT}/.bin`,
    ];
    expect(mutableCachePaths(ROOT, listing)).toEqual([
      `${ROOT}/.pnpm/some-loader@1.0.0/node_modules/some-loader/.cache`,
      `${ROOT}/.modules.yaml`,
      `${ROOT}/.bin`,
    ]);
  });
  it("a .cache directory nested inside a package (recursive) is mutable too", () => {
    expect(mutableCachePaths(ROOT, [`${ROOT}/some-loader/.cache`, `${ROOT}/some-loader/lib`])).toEqual([
      `${ROOT}/some-loader/.cache`,
    ]);
  });
  it("a path under an already-mutable ancestor is dropped — the ancestor copy covers it", () => {
    expect(mutableCachePaths(ROOT, [`${ROOT}/.cache/babel-loader/.cache`, `${ROOT}/.cache`])).toEqual([
      `${ROOT}/.cache`,
    ]);
  });
  it("scoped packages are never mistaken for dot entries; paths outside the root and non-.cache nested dot dirs are ignored", () => {
    expect(
      mutableCachePaths(ROOT, [`${ROOT}/@scope/pkg`, "/wt/dist/.cache", `${ROOT}/pkg/.bin`, `${ROOT}/pkg/.github`]),
    ).toEqual([]);
  });
  it("blank lines from the find output are ignored", () => {
    expect(mutableCachePaths(ROOT, ["", `${ROOT}/.vite`, ""])).toEqual([`${ROOT}/.vite`]);
  });
  it("the find argv names exactly those shapes — top-level dot entries (with descendants, deduped later), .cache dirs at any depth — and never -maxdepth, which GNU find applies globally", () => {
    const argv = mutableCacheFindArgv(ROOT);
    expect(argv).toEqual([
      "find",
      ROOT,
      "-mindepth",
      "1",
      "(",
      "-path",
      `${ROOT}/.*`,
      "-o",
      "-type",
      "d",
      "-name",
      ".cache",
      ")",
    ]);
    expect(argv).not.toContain("-maxdepth");
  });
});

describe("depCacheScript with a store-backed node_modules source (item 59)", () => {
  const script = depCacheScript("/workspace/checkout", "/wt", "worker4", {
    nodeModulesSrc: "/workspace/deps/" + "a".repeat(64) + "/node_modules",
  });
  it("node_modules comes from the store entry, the build dirs still from the checkout", () => {
    expect(script).toContain(`cp -al '/workspace/deps/${"a".repeat(64)}/node_modules' '/wt/node_modules'`);
    expect(script).toContain(`test -d '/workspace/deps/${"a".repeat(64)}/node_modules'`);
    expect(script).not.toContain("cp -al '/workspace/checkout/node_modules'");
    expect(script).toContain("test -d '/workspace/checkout/dist'");
  });
  it("without the option the checkout stays the node_modules source (the pre-store behavior, byte for byte)", () => {
    expect(depCacheScript("/workspace/checkout", "/wt", "worker4")).toBe(
      depCacheScript("/workspace/checkout", "/wt", "worker4", {}),
    );
  });
});

describe("depCacheScript (all five dirs in ONE fork, tagged output)", () => {
  const script = depCacheScript("/workspace/checkout", "/wt", "worker4");
  it("handles every cached dir, each gated on src-exists and dst-absent exactly like the old per-dir spawns", () => {
    for (const dir of DEP_CACHE_DIRS) {
      expect(script).toContain(`test -d '/workspace/checkout/${dir}'`);
      expect(script).toContain(`test -e '/wt/${dir}'`);
    }
  });
  it("node_modules is hardlink-copied with ONE combined walk: dirs chowned to the thread user, group/world-writable FILES stripped of write — same perm test as the two old walks", () => {
    expect(script).toContain("cp -al '/workspace/checkout/node_modules' '/wt/node_modules'");
    const walks = script.match(/find '\/wt\/node_modules' \\\(/g) ?? [];
    expect(walks.length).toBe(1); // the chown walk and the harden walk are ONE traversal
    expect(script).toContain("-type d -exec chown 'worker4:worker4' {} +");
    expect(script).toContain("-type f \\( -perm -g+w -o -perm -o+w \\) -exec chmod go-w {} +");
  });
  it("emits the mutable-cache find listing as mutable= lines using the exact tested find shape", () => {
    const argv = mutableCacheFindArgv("/wt/node_modules");
    // The same find, shell-quoted per element, feeding the mutable= tag lines.
    expect(script).toContain(argv.map((a) => `'${a}'`).join(" "));
    expect(script).toContain("mutable=");
  });
  it("a cp -al failure falls back to the plain copy in the same fork, reporting copy", () => {
    expect(script).toContain("rm -rf '/wt/node_modules'");
    expect(script).toContain("dir:node_modules=copy");
  });
  it("build dirs are plain-copied and fully chowned (-Rh: never dereference a planted symlink)", () => {
    expect(script).toContain("cp -R '/workspace/checkout/dist' '/wt/dist'");
    expect(script).toContain("chown -Rh 'worker4:worker4' '/wt/dist'");
    expect(script).toContain("dir:dist=copy");
  });
  it("every failure exits non-zero with the step named on an err= tag", () => {
    for (const step of ["deps-perms", "deps-mutable-list", "deps-copy", "deps-copy-chown"]) {
      expect(script).toContain(`err=${step}`);
    }
  });
});

describe("parseDepCacheScriptOutput", () => {
  it("folds the per-dir mechanism lines exactly like the old loop: node_modules decides", () => {
    const out = "dir:node_modules=hardlink\ndir:dist=copy\n";
    expect(parseDepCacheScriptOutput(out)).toEqual({ mech: "hardlink", mutableListing: [], failedStep: null });
  });
  it("a cp -al fallback reports copy; build dirs alone report copy", () => {
    expect(parseDepCacheScriptOutput("dir:node_modules=copy\n").mech).toBe("copy");
    expect(parseDepCacheScriptOutput("dir:out=copy\n").mech).toBe("copy");
  });
  it("no dir materialized is none", () => {
    expect(parseDepCacheScriptOutput("").mech).toBe("none");
  });
  it("collects the mutable= listing lines for mutableCachePaths, dropping empties", () => {
    const out =
      "mutable=/wt/node_modules/.cache\nmutable=/wt/node_modules/x/.cache\nmutable=\ndir:node_modules=hardlink\n";
    expect(parseDepCacheScriptOutput(out).mutableListing).toEqual([
      "/wt/node_modules/.cache",
      "/wt/node_modules/x/.cache",
    ]);
  });
  it("surfaces the first err= tag as the failed step", () => {
    expect(parseDepCacheScriptOutput("dir:node_modules=hardlink\nerr=deps-perms\n").failedStep).toBe("deps-perms");
  });
  it("ignores unknown dirs and stray lines (a banner cannot corrupt the fold)", () => {
    expect(parseDepCacheScriptOutput("hello\ndir:evil=hardlink\ndir:dist=copy\n").mech).toBe("copy");
  });
});

describe("mutableCacheSwapScript (the per-path rm/cp/chown swaps in ONE fork)", () => {
  it("emits rm -rf + cp -R (from the warm checkout's matching subpath) + chown -Rh per path, each failure step-tagged", () => {
    const s = mutableCacheSwapScript("/workspace/checkout/node_modules", "/wt/node_modules", "worker4", [
      "/wt/node_modules/.cache",
      "/wt/node_modules/loader/.cache",
    ]);
    expect(s).toContain("rm -rf '/wt/node_modules/.cache'");
    expect(s).toContain("cp -R '/workspace/checkout/node_modules/.cache' '/wt/node_modules/.cache'");
    expect(s).toContain("cp -R '/workspace/checkout/node_modules/loader/.cache' '/wt/node_modules/loader/.cache'");
    expect(s).toContain("chown -Rh 'worker4:worker4' '/wt/node_modules/.cache'");
    for (const step of ["deps-mutable-rm", "deps-mutable-copy", "deps-mutable-chmod", "deps-mutable-chown"])
      expect(s).toContain(`err=${step}`);
  });

  it("the copy is made writable again (item 57: store entries are owner-read-only, a tool cache must be rewritable in place)", () => {
    const s = mutableCacheSwapScript("/workspace/deps/k/node_modules", "/wt/node_modules", "worker4", [
      "/wt/node_modules/.vite",
    ]);
    const copy = s.indexOf("cp -R '/workspace/deps/k/node_modules/.vite'");
    const chmod = s.indexOf("chmod -R u+w '/wt/node_modules/.vite'");
    const chown = s.indexOf("chown -Rh 'worker4:worker4' '/wt/node_modules/.vite'");
    expect(copy).toBeGreaterThan(-1);
    expect(chmod).toBeGreaterThan(copy);
    expect(chown).toBeGreaterThan(chmod);
  });
});

describe("planThreadDeps (a lockfile-diverged thread reconciles ON TOP of the shared cache, never from an empty tree)", () => {
  // A thread whose committed lockfile differs from the warm checkout's key used
  // to run `npm install` from nothing — gigabytes projected, minutes on the
  // 1 vCPU shared with the refresh cycle — and the bot's /attach died first.
  // Seeding the tree from the checkout's hardlinked node_modules first turns
  // that into a delta install.
  it("a reused tree (node_modules already present) is left alone", () => {
    expect(planThreadDeps({ hasDeps: true, threadLockKey: "a", warmLockKey: "a", installCmd: "npm ci" })).toEqual({
      seed: false,
      install: false,
      why: "reused tree — cache already in place",
    });
  });

  it("same lockfile key → seed from the checkout, no install", () => {
    expect(planThreadDeps({ hasDeps: false, threadLockKey: "a", warmLockKey: "a", installCmd: "npm ci" })).toEqual({
      seed: true,
      install: false,
      why: "lockfile matches the warm checkout — shared cache, nothing to reconcile",
    });
  });

  it("different key WITH an install command → seed from the checkout THEN install (the install reconciles the delta)", () => {
    expect(planThreadDeps({ hasDeps: false, threadLockKey: "b", warmLockKey: "a", installCmd: "npm ci" })).toEqual({
      seed: true,
      install: true,
      why: "lockfile differs from the warm checkout — seeded from the shared cache, install reconciles the delta",
    });
  });

  it("different key WITHOUT an install command → nothing: a stale seed with no way to reconcile would hand the thread the wrong deps", () => {
    expect(planThreadDeps({ hasDeps: false, threadLockKey: "b", warmLockKey: "a", installCmd: undefined })).toEqual({
      seed: false,
      install: false,
      why: "lockfile differs and the command table has no install — nothing to reconcile with",
    });
  });

  it("the attach answer names the mechanism: a seeded-then-installed tree is `reconcile`, whatever the seed's own mechanism was", () => {
    expect(threadDepsMechanism({ seeded: "hardlink", installed: true })).toBe("reconcile");
    expect(threadDepsMechanism({ seeded: "copy", installed: true })).toBe("reconcile");
    expect(threadDepsMechanism({ seeded: "hardlink", installed: false })).toBe("hardlink");
    expect(threadDepsMechanism({ seeded: "copy", installed: false })).toBe("copy");
    expect(threadDepsMechanism({ seeded: "none", installed: false })).toBe("none");
  });
});
