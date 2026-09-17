import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedFiles,
  FIXED_NOW,
  hashInputs,
  importSpecifiers,
  isScreenshotInput,
  isSharedInput,
  listInputs,
  manifestPath,
  manifestProblems,
  renderManifest,
  SCREENSHOTS_DIR,
  strayFiles,
  SURFACES,
  resolveSpecifier,
  surfaceInputs,
  THEMES,
  type Manifest,
} from "./screenshotManifest.js";

// The dashboard screenshots (docs/reference/specs/docs-site.md item 20) are
// rendered from the fixture preview by a browser nobody runs in CI. What CI
// can hold is one manifest per surface beside them: the hash of every input
// that surface is rendered from. A changed input with unchanged pictures is
// drift, and `screenshots:check` names the surface and the file — and a change
// to one page's inputs never touches another surface's manifest, so two
// branches editing different pages do not collide.

const root = fileURLToPath(new URL("../..", import.meta.url));

describe("isScreenshotInput", () => {
  it("covers the fixture, the renderer and every source file of the dashboard", () => {
    for (const p of [
      "scripts/web-preview.ts",
      "scripts/screenshots.mts",
      "src/channels/webShell.ts",
      "src/docs/screenshotManifest.ts",
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

describe("isSharedInput", () => {
  it("covers what every surface is rendered from and nothing page-specific", () => {
    for (const p of [
      "scripts/web-preview.ts",
      "src/docs/screenshotManifest.ts",
      "web/src/main.ts",
      "web/src/routes.ts",
      "web/src/App.vue",
      "web/src/assets/main.css",
    ]) {
      expect(isSharedInput(p), p).toBe(true);
    }
    for (const p of ["web/src/pages/RunPage.vue", "web/src/components/AppShell.vue", "web/src/lib/format.ts"]) {
      expect(isSharedInput(p), p).toBe(false);
    }
  });
});

describe("importSpecifiers", () => {
  it("finds static and dynamic relative imports and skips packages", () => {
    const text = `import A from "./a.vue";\nimport { b } from "../lib/b";\nconst c = () => import("./c");\nimport { ref } from "vue";\nimport type { X } from "@core/core/x.js";`;
    expect(importSpecifiers(text)).toEqual(["./a.vue", "../lib/b", "./c"]);
  });
});

describe("surfaceInputs", () => {
  const files = [
    { path: "scripts/web-preview.ts", text: "" },
    { path: "web/src/assets/main.css", text: "" },
    { path: "web/src/pages/APage.vue", text: `import S from "../components/Shared.vue";` },
    { path: "web/src/pages/BPage.vue", text: `import O from "../components/OnlyB.vue";` },
    { path: "web/src/components/Shared.vue", text: `import { f } from "../lib/f";` },
    { path: "web/src/components/OnlyB.vue", text: "" },
    { path: "web/src/lib/f.ts", text: "" },
  ];

  it("is the shared inputs plus the page's import closure, sorted", () => {
    expect(surfaceInputs("web/src/pages/APage.vue", files)).toEqual([
      "scripts/web-preview.ts",
      "web/src/assets/main.css",
      "web/src/components/Shared.vue",
      "web/src/lib/f.ts",
      "web/src/pages/APage.vue",
    ]);
  });

  it("leaves another page's own components out, so editing them never touches this surface", () => {
    expect(surfaceInputs("web/src/pages/APage.vue", files)).not.toContain("web/src/components/OnlyB.vue");
    expect(surfaceInputs("web/src/pages/BPage.vue", files)).toContain("web/src/components/OnlyB.vue");
  });

  it("resolves a NodeNext `.js`-suffixed import to its source and a directory import to its index.vue", () => {
    const extra = [
      ...files,
      { path: "web/src/pages/CPage.vue", text: `import { f } from "../lib/f.js";\nimport W from "../widgets";` },
      { path: "web/src/widgets/index.vue", text: "" },
    ];
    const inputs = surfaceInputs("web/src/pages/CPage.vue", extra);
    expect(inputs).toContain("web/src/lib/f.ts");
    expect(inputs).toContain("web/src/widgets/index.vue");
  });

  it("resolves every relative import in this tree's inputs, so no dependency silently drops out of a closure", () => {
    const sources = listInputs(root).map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
    const known = new Set(sources.map((f) => f.path));
    for (const f of sources.filter((s) => s.path.startsWith("web/src/"))) {
      for (const spec of importSpecifiers(f.text)) {
        expect(resolveSpecifier(f.path, spec, known), `${f.path} → ${spec}`).toBeDefined();
      }
    }
  });

  it("resolves every surface's page in this tree to a closure well past the shared set", () => {
    const sources = listInputs(root).map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
    for (const s of SURFACES) {
      const inputs = surfaceInputs(s.page, sources);
      expect(inputs, s.name).toContain(s.page);
      expect(inputs.length, s.name).toBeGreaterThan(6);
      expect(inputs.length, s.name).toBeLessThan(sources.length);
    }
  });
});

describe("manifestProblems", () => {
  const inputs = {
    "scripts/web-preview.ts": "a".repeat(64),
    "src/docs/screenshotManifest.ts": "m".repeat(64),
    "web/src/App.vue": "b".repeat(64),
  };
  const recorded: Manifest = renderManifest(inputs);
  const pngs = expectedFiles();

  it("is silent when every recorded hash equals the tree's and both pictures exist", () => {
    expect(manifestProblems("costs", inputs, recorded, pngs)).toEqual([]);
  });

  it("names a changed input, a new one, and one that was removed — each prefixed with the surface", () => {
    const changed = { ...inputs, "web/src/App.vue": "c".repeat(64) };
    expect(manifestProblems("costs", changed, recorded, pngs)).toEqual([
      "costs: web/src/App.vue changed since it was rendered",
    ]);
    const added = { ...inputs, "web/src/pages/New.vue": "d".repeat(64) };
    expect(manifestProblems("costs", added, recorded, pngs)).toEqual([
      "costs: web/src/pages/New.vue is new since it was rendered",
    ]);
    const { "web/src/App.vue": _gone, ...removed } = inputs;
    expect(manifestProblems("costs", removed, recorded, pngs)).toEqual([
      "costs: web/src/App.vue was removed since it was rendered",
    ]);
  });

  it("names this module when it changed — the surfaces, the viewport and the clock live here, so a change to any of them is drift", () => {
    const changed = { ...inputs, "src/docs/screenshotManifest.ts": "n".repeat(64) };
    expect(manifestProblems("costs", changed, recorded, pngs)).toEqual([
      "costs: src/docs/screenshotManifest.ts changed since it was rendered",
    ]);
  });

  it("names a manifest rendered at another viewport or clock than this module pins", () => {
    const otherClock = { ...recorded, now: FIXED_NOW + 1 };
    expect(manifestProblems("costs", inputs, otherClock, pngs)).toEqual([
      `costs: rendered at clock ${FIXED_NOW + 1}; the fixed clock is now ${FIXED_NOW}`,
    ]);
    const otherViewport = { ...recorded, viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } as never };
    expect(manifestProblems("costs", inputs, otherViewport, pngs)).toEqual([
      "costs: rendered at 1280×800 at 1×; the viewport is now 1440×900 at 2×",
    ]);
  });

  it("names a missing picture and a missing manifest", () => {
    expect(
      manifestProblems(
        "costs",
        inputs,
        recorded,
        pngs.filter((f) => f !== "costs-light.png"),
      ),
    ).toEqual(["costs: costs-light.png is missing"]);
    expect(manifestProblems("costs", inputs, undefined, pngs)).toEqual([
      "costs: no manifest — run `npm run screenshots:gen`",
    ]);
  });

  it("refuses a manifest of another shape rather than passing on it", () => {
    expect(manifestProblems("costs", inputs, { inputs } as unknown as Manifest, pngs)).toEqual([
      "costs: the manifest does not carry the viewport and the fixed clock the pictures were rendered with",
    ]);
  });
});

describe("strayFiles", () => {
  it("names a picture no surface expects and a manifest of a surface that no longer exists", () => {
    expect(strayFiles(expectedFiles(), SURFACES.map((s) => `${s.name}.json`) as string[])).toEqual([]);
    expect(strayFiles(["stray.png"], ["gone.json"])).toEqual([
      "stray.png is not a screenshot any surface expects",
      "gone.json is not a manifest any surface expects",
    ]);
  });
});

describe("renderManifest", () => {
  it("records the inputs, the viewport and the fixed clock, and nothing that varies between two renders of the same tree", () => {
    const m = renderManifest({ x: "0".repeat(64) });
    expect(m).toEqual({
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      now: FIXED_NOW,
      inputs: { x: "0".repeat(64) },
    });
  });
});

describe("the repository's screenshots", () => {
  // The same rule `npm run screenshots:check` applies, so `npm test` says
  // before CI does that a dashboard change needs `npm run screenshots:gen`.
  it("each surface's manifest inputs equal the tree's, and every picture is present", () => {
    const sources = listInputs(root).map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
    const present = expectedFiles().filter((f) => existsSync(join(root, SCREENSHOTS_DIR, f)));
    for (const s of SURFACES) {
      const path = join(root, manifestPath(s.name));
      const recorded = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Manifest) : undefined;
      const paths = new Set(surfaceInputs(s.page, sources));
      const current = hashInputs(sources.filter((f) => paths.has(f.path)));
      expect(manifestProblems(s.name, current, recorded, present), "run `npm run screenshots:gen`").toEqual([]);
    }
  });
});
