import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerKind } from "./profile.js";
import { TEST_PROFILE, TEST_PUBLISHED_IMAGES, TEST_REGISTRY_PROFILE } from "./testing/profile.js";
import { renderTemplate, templateView } from "./wranglerTemplate.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureWorkArea,
  imageBuiltOutsideDir,
  parseWorkAreaStamp,
  planWorkArea,
  readWorkAreaState,
  WORK_AREA_STAMP,
  type WorkAreaDeps,
} from "./workArea.js";

// Feature: docs/reference/specs/release-and-deploy.md item 24, packaging.md item 7 —
// from the published package the Worker directories are materialised from the
// shipped assets under the operator's directory: copied once per CLI version,
// each Worker installed once, never a directory the CLI did not stamp.

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** A fixture asset tree the shape the package ships: the marker, the root manifests, two Worker directories, a source file. */
function fixture() {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "swb-work-")));
  const assets = join(dir, "pkg", "dist", "assets");
  const put = (rel: string, text: string) => {
    mkdirSync(join(assets, rel, ".."), { recursive: true });
    writeFileSync(join(assets, rel), text);
  };
  put("project.json", '{ "name": "switchboard" }\n');
  put("package.json", '{ "name": "root", "workspaces": ["deploy/cloudflare", "deploy/cloudflare-memory"] }\n');
  put("package-lock.json", '{ "lockfileVersion": 3 }\n');
  put("deploy/cloudflare/package.json", '{ "name": "bot" }\n');
  put("deploy/cloudflare/wrangler.template.jsonc", '{ "name": "{{script}}" }\n');
  put("deploy/cloudflare-memory/package.json", '{ "name": "memory" }\n');
  put("deploy/bin/build-stamp.mjs", "// stamp\n");
  put("src/core/schedules.ts", "export const x = 1;\n");
  const root = join(dir, "op");
  mkdirSync(root);
  return { assets, root, workArea: join(root, ".switchboard") };
}

function recording(
  code = 0,
): WorkAreaDeps & { installs: { cwd: string; workspaces: readonly string[] }[]; lines: string[] } {
  const installs: { cwd: string; workspaces: readonly string[] }[] = [];
  const lines: string[] = [];
  return {
    installs,
    lines,
    install: async (cwd, workspaces) => {
      installs.push({ cwd, workspaces });
      return { code, output: code === 0 ? "added 100 packages" : "npm ERR! code E404\nnpm ERR! not found: nope" };
    },
    log: (l) => lines.push(l),
  };
}

const stamp = (workArea: string) => JSON.parse(readFileSync(join(workArea, WORK_AREA_STAMP), "utf8")) as unknown;

describe("planWorkArea", () => {
  it("nothing on disk: copy, and install every requested Worker", () => {
    expect(planWorkArea({ kind: "absent" }, "1.2.0", ["deploy/cloudflare-memory", "deploy/cloudflare"], "/x")).toEqual({
      kind: "proceed",
      copy: true,
      install: ["deploy/cloudflare", "deploy/cloudflare-memory"],
      stamp: { version: "1.2.0", installed: ["deploy/cloudflare", "deploy/cloudflare-memory"] },
    });
  });

  it("stamped at this version with the Workers installed: nothing to do; a new Worker installs the union (npm ci starts from an empty node_modules)", () => {
    const stamped = { kind: "stamped" as const, stamp: { version: "1.2.0", installed: ["deploy/cloudflare-memory"] } };
    expect(planWorkArea(stamped, "1.2.0", ["deploy/cloudflare-memory"], "/x")).toEqual({
      kind: "proceed",
      copy: false,
      install: [],
      stamp: { version: "1.2.0", installed: ["deploy/cloudflare-memory"] },
    });
    expect(planWorkArea(stamped, "1.2.0", [], "/x")).toMatchObject({ copy: false, install: [] });
    expect(planWorkArea(stamped, "1.2.0", ["deploy/cloudflare"], "/x")).toEqual({
      kind: "proceed",
      copy: false,
      install: ["deploy/cloudflare", "deploy/cloudflare-memory"],
      stamp: { version: "1.2.0", installed: ["deploy/cloudflare", "deploy/cloudflare-memory"] },
    });
  });

  it("another CLI version starts over: copy again, and every requested Worker installs afresh", () => {
    const stamped = { kind: "stamped" as const, stamp: { version: "1.1.0", installed: ["deploy/cloudflare-memory"] } };
    expect(planWorkArea(stamped, "1.2.0", ["deploy/cloudflare-memory"], "/x")).toEqual({
      kind: "proceed",
      copy: true,
      install: ["deploy/cloudflare-memory"],
      stamp: { version: "1.2.0", installed: ["deploy/cloudflare-memory"] },
    });
  });

  it("a directory that is not a stamped work area is refused naming it and the stamp — never deleted", () => {
    const plan = planWorkArea({ kind: "foreign" }, "1.2.0", [], "/srv/op/.switchboard");
    expect(plan).toEqual({
      kind: "refuse",
      problem: `/srv/op/.switchboard exists but is not a work area this CLI made (no ${WORK_AREA_STAMP}) — move it aside; the deploy commands own that directory`,
    });
  });
});

describe("imageBuiltOutsideDir", () => {
  it("names a Dockerfile above the Worker's directory — the bot's root Dockerfile — and nothing else", () => {
    expect(imageBuiltOutsideDir('{ "containers": [{ "image": "../../Dockerfile", "max_instances": 1 }] }')).toBe(
      "../../Dockerfile",
    );
    expect(imageBuiltOutsideDir('{ "containers": [{ "image": "./Dockerfile" }] }')).toBeUndefined();
    expect(
      imageBuiltOutsideDir('{ "containers": [{ "image": "registry.cloudflare.com/abc/switchboard:1.2.0" }] }'),
    ).toBeUndefined();
    expect(imageBuiltOutsideDir('{ "name": "memory" }')).toBeUndefined();
    // A comment that mentions an image is prose, not a config.
    expect(
      imageBuiltOutsideDir('// "image": "../../Dockerfile" used to be here\n{ "image": "./Dockerfile" }'),
    ).toBeUndefined();
  });

  it("finds the bot's template, rendered in `build` mode, as building from the repository and the resident's and sandbox's as their own; rendered in `registry` mode none builds anything — the images are registry references", () => {
    const rendered = (kind: WorkerKind, profile = TEST_PROFILE) => {
      const template = readFileSync(
        join(import.meta.dirname, "../../deploy", dirs[kind], "wrangler.template.jsonc"),
        "utf8",
      );
      const r = renderTemplate(template, templateView(profile, kind, TEST_PUBLISHED_IMAGES)!);
      if (!r.ok) throw new Error(r.problems.join("; "));
      return r.text;
    };
    const dirs = {
      bot: "cloudflare",
      resident: "cloudflare-resident",
      sandbox: "cloudflare-sandbox",
      memory: "cloudflare-memory",
    };
    expect(imageBuiltOutsideDir(rendered("bot"))).toBe("../../Dockerfile");
    expect(imageBuiltOutsideDir(rendered("resident"))).toBeUndefined();
    expect(imageBuiltOutsideDir(rendered("sandbox"))).toBeUndefined();
    expect(imageBuiltOutsideDir(rendered("memory"))).toBeUndefined();
    for (const kind of ["bot", "resident", "sandbox"] as const)
      expect(imageBuiltOutsideDir(rendered(kind, TEST_REGISTRY_PROFILE)), kind).toBeUndefined();
  });
});

describe("parseWorkAreaStamp", () => {
  it("reads a stamp and rejects anything else", () => {
    expect(parseWorkAreaStamp('{"version":"1.2.0","installed":["deploy/cloudflare"]}')).toEqual({
      version: "1.2.0",
      installed: ["deploy/cloudflare"],
    });
    for (const bad of [
      undefined,
      "",
      "not json",
      "{}",
      '{"version":1,"installed":[]}',
      '{"version":"1","installed":[1]}',
    ])
      expect(parseWorkAreaStamp(bad)).toBeUndefined();
  });
});

describe("ensureWorkArea over a fixture asset tree", () => {
  it("copies the shipped tree under .switchboard/, installs the requested Workers in one npm ci at the work area's root, and stamps the version", async () => {
    const { assets, root, workArea } = fixture();
    const deps = recording();
    const r = await ensureWorkArea({ assets, workArea }, "1.2.0", ["deploy/cloudflare-memory"], deps);
    expect(r).toEqual({ ok: true, copied: true, installed: ["deploy/cloudflare-memory"] });
    // The copy is the whole shipped tree at its tree paths — the Worker directory wrangler runs in, the
    // deploy scripts it calls, the sources its worker.ts imports, the manifests npm ci reads.
    for (const rel of [
      "deploy/cloudflare-memory/package.json",
      "deploy/cloudflare/wrangler.template.jsonc",
      "deploy/bin/build-stamp.mjs",
      "src/core/schedules.ts",
      "package.json",
      "package-lock.json",
    ])
      expect(readFileSync(join(workArea, rel), "utf8")).toBe(readFileSync(join(assets, rel), "utf8"));
    expect(deps.installs).toEqual([{ cwd: workArea, workspaces: ["deploy/cloudflare-memory"] }]);
    expect(stamp(workArea)).toEqual({ version: "1.2.0", installed: ["deploy/cloudflare-memory"] });
    // The operator's own directory holds nothing but the work area; the package's assets are untouched.
    expect(readdirSync(root)).toEqual([".switchboard"]);
    expect(existsSync(join(assets, WORK_AREA_STAMP))).toBe(false);
    expect(deps.lines).toEqual([
      `[deploy] materialised the shipped tree (version 1.2.0) under ${workArea}`,
      `[deploy] npm ci --workspace deploy/cloudflare-memory under ${workArea}`,
    ]);
  });

  it("a second call at the same version copies nothing and installs nothing already installed; a new Worker installs the union; a rendered file in the work area survives", async () => {
    const { assets, workArea } = fixture();
    await ensureWorkArea({ assets, workArea }, "1.2.0", ["deploy/cloudflare-memory"], recording());
    writeFileSync(join(workArea, "deploy/cloudflare-memory/wrangler.jsonc"), "rendered\n");
    const again = recording();
    expect(await ensureWorkArea({ assets, workArea }, "1.2.0", ["deploy/cloudflare-memory"], again)).toEqual({
      ok: true,
      copied: false,
      installed: [],
    });
    expect(again.installs).toEqual([]);
    expect(again.lines).toEqual([]);
    const more = recording();
    expect(await ensureWorkArea({ assets, workArea }, "1.2.0", ["deploy/cloudflare"], more)).toEqual({
      ok: true,
      copied: false,
      installed: ["deploy/cloudflare", "deploy/cloudflare-memory"],
    });
    expect(more.installs).toEqual([{ cwd: workArea, workspaces: ["deploy/cloudflare", "deploy/cloudflare-memory"] }]);
    expect(readFileSync(join(workArea, "deploy/cloudflare-memory/wrangler.jsonc"), "utf8")).toBe("rendered\n");
    expect(stamp(workArea)).toEqual({ version: "1.2.0", installed: ["deploy/cloudflare", "deploy/cloudflare-memory"] });
  });

  it("the copy alone (no Workers — what deploy init needs) stamps with nothing installed and spawns no npm", async () => {
    const { assets, workArea } = fixture();
    const deps = recording();
    expect(await ensureWorkArea({ assets, workArea }, "1.2.0", [], deps)).toEqual({
      ok: true,
      copied: true,
      installed: [],
    });
    expect(deps.installs).toEqual([]);
    expect(stamp(workArea)).toEqual({ version: "1.2.0", installed: [] });
  });

  it("another CLI version replaces the work area — a stale rendered file and the old install are gone — and installs again", async () => {
    const { assets, workArea } = fixture();
    await ensureWorkArea({ assets, workArea }, "1.1.0", ["deploy/cloudflare-memory"], recording());
    writeFileSync(join(workArea, "deploy/cloudflare-memory/wrangler.jsonc"), "old render\n");
    mkdirSync(join(workArea, "node_modules"));
    const deps = recording();
    expect(await ensureWorkArea({ assets, workArea }, "1.2.0", ["deploy/cloudflare-memory"], deps)).toEqual({
      ok: true,
      copied: true,
      installed: ["deploy/cloudflare-memory"],
    });
    expect(existsSync(join(workArea, "deploy/cloudflare-memory/wrangler.jsonc"))).toBe(false);
    expect(existsSync(join(workArea, "node_modules"))).toBe(false);
    expect(deps.installs).toEqual([{ cwd: workArea, workspaces: ["deploy/cloudflare-memory"] }]);
    expect(stamp(workArea)).toEqual({ version: "1.2.0", installed: ["deploy/cloudflare-memory"] });
  });

  it("a failed npm ci is a problem quoting npm's last lines; the copy stays stamped with nothing installed, so the next run installs again", async () => {
    const { assets, workArea } = fixture();
    const deps = recording(1);
    const r = await ensureWorkArea({ assets, workArea }, "1.2.0", ["deploy/cloudflare"], deps);
    expect(r).toEqual({
      ok: false,
      problem: `npm ci for deploy/cloudflare under ${workArea} exited 1: npm ERR! code E404 | npm ERR! not found: nope`,
    });
    expect(stamp(workArea)).toEqual({ version: "1.2.0", installed: [] });
    expect(readWorkAreaState(workArea)).toEqual({ kind: "stamped", stamp: { version: "1.2.0", installed: [] } });
  });

  it("a directory at the work area's path that this CLI did not stamp is refused and left exactly as it was", async () => {
    const { assets, workArea } = fixture();
    mkdirSync(workArea);
    writeFileSync(join(workArea, "notes.txt"), "mine\n");
    const deps = recording();
    const r = await ensureWorkArea({ assets, workArea }, "1.2.0", ["deploy/cloudflare"], deps);
    expect(r).toEqual({
      ok: false,
      problem: `${workArea} exists but is not a work area this CLI made (no ${WORK_AREA_STAMP}) — move it aside; the deploy commands own that directory`,
    });
    expect(readdirSync(workArea)).toEqual(["notes.txt"]);
    expect(deps.installs).toEqual([]);
    // An empty directory is not foreign: it is where the work area goes.
    rmSync(join(workArea, "notes.txt"));
    expect(readWorkAreaState(workArea)).toEqual({ kind: "absent" });
    expect(await ensureWorkArea({ assets, workArea }, "1.2.0", [], recording())).toEqual({
      ok: true,
      copied: true,
      installed: [],
    });
  });
});
