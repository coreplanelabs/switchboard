import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedFiles,
  hashInputs,
  isScreenshotInput,
  listInputs,
  manifestProblems,
  renderManifest,
  SCREENSHOTS_DIR,
  SURFACES,
  THEMES,
  type Manifest,
} from "./screenshotManifest.js";

// The dashboard screenshots (docs/reference/specs/docs-site.md item 20) are
// rendered from the fixture preview by a browser nobody runs in CI. What CI
// can hold is the manifest beside them: the hash of every input the pictures
// were rendered from. A changed fixture or component with unchanged pictures
// is drift, and `screenshots:check` names the file.

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("isScreenshotInput", () => {
  it("covers the fixture, the renderer and every source file of the dashboard", () => {
    for (const p of [
      "scripts/web-preview.ts",
      "scripts/screenshots.mts",
      "src/channels/webShell.ts",
      "web/src/main.ts",
      "web/src/App.vue",
      "web/src/components/run/Timeline.vue",
      "web/src/pages/RunPage.vue",
      "web/src/lib/format.ts",
      "web/src/assets/main.css",
      "web/vite.config.ts",
    ]) {
      expect(isScreenshotInput(p), p).toBe(true);
    }
  });

  it("leaves out what never reaches a pixel: tests, test helpers, generated declarations, builds", () => {
    for (const p of [
      "web/src/pages/runPage.test.ts",
      "web/src/testing/mount.ts",
      "web/auto-imports.d.ts",
      "web/components.d.ts",
      "web/dist/assets/main.js",
      "web/package.json",
      "src/channels/webSeed.ts",
      "docs/public/screenshots/manifest.json",
    ]) {
      expect(isScreenshotInput(p), p).toBe(false);
    }
  });
});

describe("listInputs", () => {
  it("finds the dashboard's sources in this tree, repository-relative, tests left out", () => {
    const inputs = listInputs(root);
    expect(inputs).toContain("web/src/App.vue");
    expect(inputs).toContain("web/src/pages/RunPage.vue");
    expect(inputs).toContain("scripts/web-preview.ts");
    expect(inputs.filter((p) => p.endsWith(".test.ts") || p.startsWith("web/src/testing/"))).toEqual([]);
    expect(inputs.length).toBeGreaterThan(30);
  });
});

describe("hashInputs", () => {
  it("is a sha256 per path, sorted by path whatever order the files arrive in", () => {
    const a = hashInputs([
      { path: "web/src/b.ts", text: "b" },
      { path: "web/src/a.ts", text: "a" },
    ]);
    expect(Object.keys(a)).toEqual(["web/src/a.ts", "web/src/b.ts"]);
    expect(a["web/src/a.ts"]).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toEqual(
      hashInputs([
        { path: "web/src/a.ts", text: "a" },
        { path: "web/src/b.ts", text: "b" },
      ]),
    );
  });

  it("changes when a byte changes", () => {
    const before = hashInputs([{ path: "x", text: "acme/web" }]);
    const after = hashInputs([{ path: "x", text: "acme/api" }]);
    expect(before.x).not.toBe(after.x);
  });
});

describe("expectedFiles", () => {
  it("is one PNG per surface per theme, named <surface>-<theme>.png", () => {
    const files = expectedFiles();
    expect(files).toHaveLength(SURFACES.length * THEMES.length);
    expect(files).toContain("run-page-light.png");
    expect(files).toContain("residents-dark.png");
    expect(new Set(files).size).toBe(files.length);
  });
});

describe("manifestProblems", () => {
  const inputs = { "scripts/web-preview.ts": "a".repeat(64), "web/src/App.vue": "b".repeat(64) };
  const recorded: Manifest = renderManifest(inputs, 1_700_000_000_000);
  const pngs = expectedFiles();

  it("is silent when every recorded hash equals the tree's and every picture exists", () => {
    expect(manifestProblems(inputs, recorded, pngs)).toEqual([]);
  });

  it("names a changed input, a new one, and one that was removed", () => {
    const changed = { ...inputs, "web/src/App.vue": "c".repeat(64) };
    expect(manifestProblems(changed, recorded, pngs)).toEqual([
      "web/src/App.vue changed since the screenshots were rendered",
    ]);
    const added = { ...inputs, "web/src/pages/New.vue": "d".repeat(64) };
    expect(manifestProblems(added, recorded, pngs)).toEqual([
      "web/src/pages/New.vue is new since the screenshots were rendered",
    ]);
    const { "web/src/App.vue": _gone, ...removed } = inputs;
    expect(manifestProblems(removed, recorded, pngs)).toEqual([
      "web/src/App.vue was removed since the screenshots were rendered",
    ]);
  });

  it("names a missing or unexpected picture", () => {
    expect(manifestProblems(inputs, recorded, pngs.slice(1))).toEqual([`${pngs[0]} is missing`]);
    expect(manifestProblems(inputs, recorded, [...pngs, "stray.png"])).toEqual([
      "stray.png is not a screenshot the manifest expects",
    ]);
  });

  it("refuses a manifest of another shape rather than passing on it", () => {
    expect(manifestProblems(inputs, { inputs } as unknown as Manifest, pngs)).toEqual([
      "the manifest does not carry the viewport and the fixed clock the pictures were rendered with",
    ]);
  });
});

describe("renderManifest", () => {
  it("records the inputs, the viewport and the fixed clock, and nothing that varies between two renders of the same tree", () => {
    const m = renderManifest({ x: "0".repeat(64) }, 1_700_000_000_000);
    expect(m).toEqual({
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      now: 1_700_000_000_000,
      inputs: { x: "0".repeat(64) },
    });
  });
});

describe("the repository's screenshots", () => {
  // The same rule `npm run screenshots:check` applies, so `npm test` says
  // before CI does that a dashboard change needs `npm run screenshots:gen`.
  it("the manifest's inputs equal the tree's, and every picture is present", () => {
    const manifest = JSON.parse(readFileSync(join(root, SCREENSHOTS_DIR, "manifest.json"), "utf8")) as Manifest;
    const present = expectedFiles().filter((f) => existsSync(join(root, SCREENSHOTS_DIR, f)));
    const current = hashInputs(listInputs(root).map((path) => ({ path, text: readFileSync(join(root, path)) })));
    expect(manifestProblems(current, manifest, present), "run `npm run screenshots:gen`").toEqual([]);
  });
});
