import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const NVMRC_MAJOR = read(".nvmrc").trim();
const BOT = "Dockerfile";
const EXECUTION_IMAGES = ["deploy/cloudflare-resident/Dockerfile", "deploy/cloudflare-sandbox/Dockerfile"] as const;
const IMAGES = [BOT, ...EXECUTION_IMAGES] as const;

// Feature: docs/reference/specs/execution.md item 10 — every image ships the
// Node line the repository builds and tests on. The cloudflare/sandbox bases
// the execution images build FROM ship their own Node (22, on the 0.12.9 and
// the 0.13.0-next lines alike — measured by running them), so a run inside a
// sandbox read a different `verify` than CI did: a fresh clone's `npm ci`
// warned on the CLI package's `engines: >=24`, and tests that pass in CI failed
// there. Node now comes from one exact `node:<version>-slim` stage in each of
// the three Dockerfiles, copied over the base's own, and this fence holds the
// three tags equal to each other and their major equal to `.nvmrc`'s — the
// version the install script requires and CI's setup-node resolves.

/** The instruction lines of a Dockerfile, continuations joined, comments dropped. */
function instructions(text: string): string[] {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Every `node:<tag>` a Dockerfile builds FROM — a `--platform` flag, `docker.io/library/` and a stage name optional. */
function nodeTags(lines: string[]): string[] {
  return lines.flatMap((l) => {
    const m = /^FROM (?:--platform=\S+ )?(?:docker\.io\/library\/)?node:(\S+)(?: AS \S+)?$/.exec(l);
    return m ? [m[1]] : [];
  });
}

describe("the images' Node", () => {
  const tags = Object.fromEntries(IMAGES.map((path) => [path, nodeTags(instructions(read(path)))]));

  it("each image names Node by an exact `node:<major>.<minor>.<patch>-slim` tag — never a floating major", () => {
    for (const path of IMAGES) {
      expect(tags[path].length, `${path} builds FROM a node image`).toBeGreaterThan(0);
      for (const tag of tags[path]) expect(tag, `${path}: node:${tag}`).toMatch(/^\d+\.\d+\.\d+-slim$/);
    }
  });

  it("the three images name the same tag, so a release ships one Node everywhere", () => {
    expect(new Set(IMAGES.flatMap((path) => tags[path])).size).toBe(1);
  });

  it("its major is the one .nvmrc pins — what CI, the install script and the published CLI's engines require", () => {
    const [major] = tags[BOT][0].split(".");
    expect(major).toBe(NVMRC_MAJOR);
  });
});

describe.each(EXECUTION_IMAGES)("%s", (path) => {
  const lines = instructions(read(path));
  const version = nodeTags(lines)[0]?.replace(/-slim$/, "");
  const copyTree = "COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules";

  it("takes Node from a stage named `node` pinned to linux/amd64 — the one platform the cloudflare/sandbox base publishes — so the copied binary runs in the base whatever the build host is", () => {
    // Without the pin an arm64 host resolves the stage to arm64 while the base
    // (amd64 only) builds under emulation, and the version assertion fails on
    // a binary the base cannot run.
    expect(lines).toContain(`FROM --platform=linux/amd64 docker.io/library/node:${version}-slim AS node`);
  });

  it("copies the binary, npm's tree and the headers from the `node` stage over the base's own, at the base's paths — the base's npm tree removed first", () => {
    const removal = lines.findIndex((l) => /^RUN rm -rf \/usr\/local\/lib\/node_modules\b/.test(l));
    expect(
      removal,
      "the base's npm tree is removed before the copy — no file of the old npm survives under the new",
    ).toBeGreaterThan(-1);
    expect(lines).toContain("COPY --from=node /usr/local/bin/node /usr/local/bin/node");
    expect(lines).toContain(copyTree);
    expect(lines).toContain("COPY --from=node /usr/local/include/node /usr/local/include/node");
    expect(lines.indexOf(copyTree)).toBeGreaterThan(removal);
  });

  it("asserts exactly that version at build time, so a bump that moves Node fails the build, not a run", () => {
    const assertion = lines.find((l) => /^RUN\b.*node --version \| grep -qx 'v[^']+'/.test(l)) ?? "";
    expect(assertion).toContain(`node --version | grep -qx 'v${version}'`);
  });

  it("swaps Node before any global install, so the package managers are installed by that Node's npm into its tree", () => {
    const swap = lines.indexOf(copyTree);
    const firstGlobalInstall = lines.findIndex((l) => /^RUN\b.*\bnpm install -g /.test(l));
    expect(swap).toBeGreaterThan(-1);
    expect(firstGlobalInstall).toBeGreaterThan(swap);
  });
});

// Feature: docs/reference/specs/execution.md item 16 — the 12 GiB instance was
// chosen so one cold thread can typecheck a large monorepo, and a Node heap
// limit can quietly undo that: V8's own default is a quarter of physical
// memory (~3 GiB on this instance), and the resident image once pinned it lower
// still, at 1,536 MB (an eighth, meant as a fair share among its sixteen
// seats) — below what this repository's own two `tsc` passes need: they die
// with "heap out of memory" at 1,536 MB and pass at 3,072 MB with ~2 GB of RSS
// each (measured). A per-process heap limit never shared memory between
// processes (16 × 1,536 MB already exceeded the instance); the cgroup does
// that. So the cap is a runaway guard, sized for the largest legitimate
// command with room to spare, set explicitly in both execution images, and the
// same in both.
const HEAP_CAP_MIB = 8192;

/** The `--max-old-space-size` (MiB) a Dockerfile's `ENV … NODE_OPTIONS=…` sets, or null when it sets none. */
function heapCapMiB(lines: string[]): number | null {
  for (const l of lines) {
    const env = /^ENV\b.*\bNODE_OPTIONS=(\S+)/.exec(l);
    if (!env) continue;
    const size = /--max-old-space-size=(\d+)/.exec(env[1]);
    return size ? Number(size[1]) : null;
  }
  return null;
}

describe("the execution images' Node heap", () => {
  const caps = Object.fromEntries(EXECUTION_IMAGES.map((path) => [path, heapCapMiB(instructions(read(path)))]));

  it("each execution image sets NODE_OPTIONS=--max-old-space-size explicitly — V8's default would be a quarter of the instance", () => {
    for (const path of EXECUTION_IMAGES) expect(caps[path], `${path} sets a heap cap`).not.toBeNull();
  });

  it("the cap is 8 GiB of the 12 — the largest single command the instance was sized for fits, with room", () => {
    for (const path of EXECUTION_IMAGES) expect(caps[path], path).toBe(HEAP_CAP_MIB);
  });

  it("the two images set the same cap, so a command that fits one cold thread fits a resident thread too", () => {
    expect(new Set(Object.values(caps)).size).toBe(1);
  });
});
