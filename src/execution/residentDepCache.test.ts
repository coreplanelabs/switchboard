import { describe, expect, it } from "vitest";
import { DEP_CACHE_DIRS, depCacheMaterialization, foldDepsMechanism, mutableCacheFindArgv, mutableCachePaths } from "./residentDepCache.js";

describe("depCacheMaterialization (KTD7 dep/build cache, per directory)", () => {
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
    expect(mutableCachePaths(ROOT, listing)).toEqual([`${ROOT}/.cache`, `${ROOT}/.vite`, `${ROOT}/.prisma`, `${ROOT}/.bin`, `${ROOT}/.package-lock.json`]);
  });
  it("a .cache directory nested inside a package (recursive) is mutable too", () => {
    expect(mutableCachePaths(ROOT, [`${ROOT}/some-loader/.cache`, `${ROOT}/some-loader/lib`])).toEqual([`${ROOT}/some-loader/.cache`]);
  });
  it("a path under an already-mutable ancestor is dropped — the ancestor copy covers it", () => {
    expect(mutableCachePaths(ROOT, [`${ROOT}/.cache/babel-loader/.cache`, `${ROOT}/.cache`])).toEqual([`${ROOT}/.cache`]);
  });
  it("scoped packages are never mistaken for dot entries; paths outside the root and non-.cache nested dot dirs are ignored", () => {
    expect(mutableCachePaths(ROOT, [`${ROOT}/@scope/pkg`, "/wt/dist/.cache", `${ROOT}/pkg/.bin`, `${ROOT}/pkg/.github`])).toEqual([]);
  });
  it("blank lines from the find output are ignored", () => {
    expect(mutableCachePaths(ROOT, ["", `${ROOT}/.vite`, ""])).toEqual([`${ROOT}/.vite`]);
  });
  it("the find argv names exactly those shapes — top-level dot entries (with descendants, deduped later), .cache dirs at any depth — and never -maxdepth, which GNU find applies globally", () => {
    const argv = mutableCacheFindArgv(ROOT);
    expect(argv).toEqual(["find", ROOT, "-mindepth", "1", "(", "-path", `${ROOT}/.*`, "-o", "-type", "d", "-name", ".cache", ")"]);
    expect(argv).not.toContain("-maxdepth");
  });
});
