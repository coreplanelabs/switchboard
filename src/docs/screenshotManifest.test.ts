import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  expectedFiles,
  resolveCaptures,
  captureBatches,
  currentSurfaceInputs,
  captureMechanicsSource,
  samePngPixels,
  type Surface,
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

const costsSurface = SURFACES.find((s) => s.name === "costs")!;

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
      "web/package.json",
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
      "scripts/screenshots.mts",
      "src/docs/screenshotManifest.ts",
      "web/src/main.ts",
      "web/src/routes.ts",
      "web/src/App.vue",
      "web/src/assets/main.css",
    ]) {
      expect(isSharedInput(p), p).toBe(true);
    }
    for (const p of [
      "scripts/web-preview.ts",
      "web/src/pages/RunPage.vue",
      "web/src/components/AppShell.vue",
      "web/src/lib/format.ts",
    ]) {
      expect(isSharedInput(p), p).toBe(false);
    }
  });
});

describe("importSpecifiers", () => {
  it("finds static and dynamic relative imports and skips packages", () => {
    const text = `import A from "./a.vue";\nimport { b } from "../lib/b";\nconst c = () => import("./c");\nimport { ref } from "vue";\nimport type { X } from "@core/core/x.js";`;
    expect(importSpecifiers(text)).toEqual(["./a.vue", "../lib/b", "./c"]);
  });

  it("selects runtime packages and CSS plugins without comments or type-only imports", () => {
    const text = `import type { A } from "types-only";
      import { type B } from "inline-types";
      export { type C } from "exported-types";
      import R from "renderer/subpath";
      export { value } from "re-export";
      const lazy = () => import("lazy-package");
      // import "commented";
      /* @import "commented-css"; */
      @import "@fonts/sans/font.css";
      @plugin "css-plugin";`;
    expect(importSpecifiers(text, true, true)).toEqual([
      "renderer/subpath",
      "re-export",
      "lazy-package",
      "@fonts/sans/font.css",
      "css-plugin",
    ]);
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
  const recorded: Manifest = renderManifest(inputs, costsSurface);
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

  it("names this module when its shared capture mechanics change", () => {
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
    const m = renderManifest({ x: "0".repeat(64) }, costsSurface);
    expect(m).toEqual({
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      now: FIXED_NOW,
      inputs: { x: "0".repeat(64) },
      captures: resolveCaptures([costsSurface]),
      configHash: expect.stringMatching(/^[a-f0-9]{64}$/),
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
      const current = currentSurfaceInputs(s, sources);
      expect(manifestProblems(s.name, current, recorded, present), "run `npm run screenshots:gen`").toEqual([]);
    }
  });
});

const fixture = { server: "scripts/web-preview.ts", inputs: [] };
const desktop = { name: "desktop", suffix: "", viewport: { width: 1440, height: 900, deviceScaleFactor: 2 } };
const phone = { name: "phone", suffix: "-phone", viewport: { width: 390, height: 844, deviceScaleFactor: 2 } };
const sample: Surface = { name: "sample", path: "/sample", page: "web/src/pages/Sample.vue", what: "fixture", fixture };

describe("capture profiles", () => {
  it("preserves all existing desktop outputs and themes", () => {
    expect(SURFACES.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        "conductor-page",
        "costs-models",
        "costs-users",
        "costs",
        "home-conversation",
        "home-empty",
        "home-live",
        "metrics",
        "plane",
        "residents",
        "review-page",
        "run-page",
        "runs-index-viewing-as",
        "runs-index",
        "scheduled",
        "settings-channel",
        "settings-installation",
        "settings-mcps",
        "unit-page-coding-only",
        "unit-page",
        "unit-search-landed",
        "unit-search",
      ]),
    );
    for (const surface of SURFACES) {
      expect(resolveCaptures([surface])).toEqual(
        THEMES.map((theme) =>
          expect.objectContaining({
            profile: "desktop",
            theme,
            file: `${surface.name}-${theme}.png`,
            context: expect.objectContaining({
              viewport: { width: 1440, height: 900 },
              deviceScaleFactor: 2,
              colorScheme: theme,
            }),
          }),
        ),
      );
    }
    expect(expectedFiles()).toEqual(SURFACES.flatMap((s) => THEMES.map((t) => `${s.name}-${t}.png`)));
  });

  it("resolves desktop and phone into the browser and output options used by generation", () => {
    const captures = resolveCaptures([{ ...sample, captures: [desktop, phone] }]);
    expect(captures.map((c) => c.file)).toEqual([
      "sample-light.png",
      "sample-dark.png",
      "sample-phone-light.png",
      "sample-phone-dark.png",
    ]);
    expect(captures.map((c) => c.context.viewport)).toEqual([
      { width: 1440, height: 900 },
      { width: 1440, height: 900 },
      { width: 390, height: 844 },
      { width: 390, height: 844 },
    ]);
    for (const c of captures) {
      expect(c.context).toMatchObject({ locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
      expect(c.screenshot).toEqual({
        type: "png",
        fullPage: false,
        scale: "device",
        animations: "disabled",
        caret: "hide",
      });
    }
  });

  it("reuses one context per fixture and resolved browser profile in historical theme order", () => {
    const other = { ...sample, name: "other" };
    const batches = captureBatches([sample, other]);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.context.colorScheme)).toEqual(["light", "dark"]);
    expect(batches.map((b) => b.tasks.map((t) => t.capture.file))).toEqual([
      ["sample-light.png", "other-light.png"],
      ["sample-dark.png", "other-dark.png"],
    ]);
    expect(captureBatches([sample, { ...other, captures: [phone] }])).toHaveLength(4);
    expect(captureBatches([sample, { ...other, fixture: { server: "scripts/other.ts", inputs: [] } }])).toHaveLength(4);
  });

  it("rejects ambiguous profiles and outputs", () => {
    for (const captures of [
      [desktop, desktop],
      [desktop, { ...phone, suffix: "" }],
      [
        { ...desktop, themes: ["light" as const] },
        { ...phone, suffix: "", themes: ["dark" as const] },
      ],
      [],
    ]) {
      expect(() => resolveCaptures([{ ...sample, captures }])).toThrow();
    }
    expect(() => resolveCaptures([sample, sample])).toThrow();
    expect(() =>
      resolveCaptures([
        { ...sample, captures: [phone] },
        { ...sample, name: "sample-phone" },
      ]),
    ).toThrow(/output/);
  });

  it("rejects unsafe paths and unsupported configuration", () => {
    for (const name of ["../escape", "Upper", "a/b", "a.png", ""])
      expect(() => resolveCaptures([{ ...sample, name }])).toThrow();
    for (const path of ["https://example.test", "//example.test", "/../x", "/x#fragment", "/%2e%2e/x", "/a\\b"])
      expect(() => resolveCaptures([{ ...sample, path }])).toThrow();
    for (const server of ["../escape.ts", "/tmp/file.ts", "scripts/../other.ts", "scripts/fixture.js"])
      expect(() => resolveCaptures([{ ...sample, fixture: { server, inputs: [] } }])).toThrow();
    expect(() => resolveCaptures([{ ...sample, fixture: { ...fixture, inputs: ["../escape.json"] } }])).toThrow();
    for (const capture of [
      { ...phone, suffix: "phone" },
      { ...phone, suffix: "-../x" },
      { ...phone, themes: ["sepia"] },
      { ...phone, themes: [] },
      { ...phone, themes: ["light", "light"] },
      { ...phone, fullPage: true },
      { ...phone, viewport: { ...phone.viewport, width: 0 } },
      { ...phone, viewport: { ...phone.viewport, height: 1.5 } },
      { ...phone, viewport: { ...phone.viewport, deviceScaleFactor: Infinity } },
    ]) {
      expect(() => resolveCaptures([{ ...sample, captures: [capture] } as Surface])).toThrow();
    }
  });

  it("hashes every resolved capture setting deterministically", () => {
    const surface = { ...sample, captures: [phone, desktop] };
    const before = renderManifest({ b: "b", a: "a" }, surface);
    expect(before).toEqual(renderManifest({ a: "a", b: "b" }, { ...surface, captures: [desktop, phone] }));
    for (const change of [
      { ...sample, path: "/different" },
      { ...sample, captures: [{ ...desktop, name: "wide" }] },
      { ...sample, captures: [{ ...desktop, suffix: "-wide" }] },
      { ...sample, captures: [{ ...desktop, themes: ["light" as const] }] },
      { ...sample, captures: [{ ...desktop, viewport: { ...desktop.viewport, width: 1280 } }] },
      { ...sample, captures: [{ ...desktop, viewport: { ...desktop.viewport, height: 800 } }] },
      { ...sample, captures: [{ ...desktop, viewport: { ...desktop.viewport, deviceScaleFactor: 1 } }] },
      { ...sample, fixture: { ...fixture, inputs: ["scripts/config.json"] } },
    ])
      expect(renderManifest({}, change).configHash).not.toBe(renderManifest({}, sample).configHash);
    expect(before.captures).toHaveLength(4);
    expect(before.configHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("records every output and uses the same drift predicate for generation and check", () => {
    const surface = { ...sample, captures: [desktop, phone] };
    const m = renderManifest({}, surface);
    const outputs = expectedFiles([surface]);
    expect(m.captures.map((c) => c.file)).toEqual(outputs);
    expect(manifestProblems(surface, {}, JSON.parse(JSON.stringify(m)), outputs)).toEqual([]);
    for (const file of outputs)
      expect(
        manifestProblems(
          surface,
          {},
          m,
          outputs.filter((f) => f !== file),
        ),
      ).toContain(`sample: ${file} is missing`);
    expect(manifestProblems(surface, {}, renderManifest({}, sample), outputs).join(" ")).toMatch(
      /capture configuration/,
    );
    expect(strayFiles([...outputs, "stray.png"], ["sample.json"], [surface])).toEqual([
      "stray.png is not a screenshot any surface expects",
    ]);
    const tampered = structuredClone(m);
    tampered.captures[0].screenshot.fullPage = true as never;
    expect(manifestProblems(surface, {}, tampered, outputs).length).toBeGreaterThan(0);
  });
});

describe("surface isolation", () => {
  const a = { ...sample, name: "a", fixture: { server: "scripts/a.ts", inputs: ["scripts/a.json"] } };
  const b = { ...sample, name: "b", fixture: { server: "scripts/b.ts", inputs: [] } };
  const sources = [
    {
      path: "src/docs/screenshotManifest.ts",
      text: 'export const SURFACES = [] as const;\nexport const mechanic = "same";',
    },
    { path: "scripts/screenshots.mts", text: "capture mechanics" },
    { path: "scripts/a.ts", text: 'import { value } from "./a-data.js";' },
    { path: "scripts/a-data.ts", text: "export const value = 1;" },
    { path: "scripts/a.json", text: "{}" },
    { path: "scripts/b.ts", text: "" },
    { path: sample.page, text: "" },
    { path: "web/src/assets/main.css", text: "tokens" },
    { path: "src/channels/webShell.ts", text: 'import { escape } from "./escape.js";' },
    { path: "src/channels/escape.ts", text: "renderer" },
  ];

  it("adding an isolated fixture and profile registration leaves existing hashes unchanged", () => {
    const extra = {
      ...sample,
      name: "isolated",
      fixture: { server: "scripts/isolated.ts", inputs: ["scripts/isolated.json"] },
      captures: [phone],
    };
    const registered = sources
      .map((f) =>
        f.path === "src/docs/screenshotManifest.ts" ? { ...f, text: f.text.replace("[]", JSON.stringify([extra])) } : f,
      )
      .concat([
        { path: "scripts/isolated.ts", text: "isolated server" },
        { path: "scripts/isolated.json", text: "{}" },
      ]);
    resolveCaptures([a, b, extra]);
    for (const surface of [a, b])
      expect(currentSurfaceInputs(surface, registered)).toEqual(currentSurfaceInputs(surface, sources));
  });

  it("does not exclude executable registration code or capture mechanics", () => {
    expect(() => captureMechanicsSource("export const SURFACES = buildSurfaces();")).toThrow(/literal/);
    expect(() => captureMechanicsSource("export const SURFACES = [{ ...defaults }];")).toThrow(/literal/);
    expect(() => captureMechanicsSource("export const SURFACES = [{ path: doWork() }];")).toThrow(/literal/);
    const modified = sources.map((f) =>
      f.path === "src/docs/screenshotManifest.ts" ? { ...f, text: f.text.replace('"same"', '"changed"') } : f,
    );
    expect(currentSurfaceInputs(a, modified)).not.toEqual(currentSurfaceInputs(a, sources));
  });

  it("invalidates only consumers of a surface-local dependency", () => {
    for (const path of ["scripts/a.ts", "scripts/a-data.ts", "scripts/a.json"]) {
      const changed = sources.map((f) => (f.path === path ? { ...f, text: f.text + "\n// changed" } : f));
      expect(currentSurfaceInputs(a, changed)).not.toEqual(currentSurfaceInputs(a, sources));
      expect(currentSurfaceInputs(b, changed)).toEqual(currentSurfaceInputs(b, sources));
    }
  });

  it("invalidates all consumers of shared rendering inputs", () => {
    for (const path of [
      "scripts/screenshots.mts",
      "src/channels/webShell.ts",
      "src/channels/escape.ts",
      "web/src/assets/main.css",
    ]) {
      const changed = sources.map((f) => (f.path === path ? { ...f, text: f.text + "\n// changed" } : f));
      for (const surface of [a, b])
        expect(currentSurfaceInputs(surface, changed)).not.toEqual(currentSurfaceInputs(surface, sources));
    }
  });

  it("hashes binary local inputs by bytes rather than lossy text decoding", () => {
    const surface = { ...a, fixture: { ...a.fixture, inputs: ["scripts/image.bin"] } };
    const before = [...sources, { path: "scripts/image.bin", text: "�", bytes: new Uint8Array([255]) }];
    const after = [...sources, { path: "scripts/image.bin", text: "�", bytes: new Uint8Array([254]) }];
    expect(currentSurfaceInputs(surface, before)).not.toEqual(currentSurfaceInputs(surface, after));
  });

  it("tracks dependency versions without making a package release invalidate pictures", () => {
    const manifest = { name: "fixture", version: "1.0.0", dependencies: { vue: "3.0.0" } };
    const lock = {
      version: "1.0.0",
      packages: {
        "": manifest,
        "packages/cli": { version: "1.0.0" },
        "node_modules/vue": { version: "3.0.0", integrity: "original" },
      },
    };
    const files = [
      ...sources.map((f) => (f.path === a.page ? { ...f, text: 'import { ref } from "vue";' } : f)),
      { path: "package.json", text: JSON.stringify(manifest) },
      { path: "package-lock.json", text: JSON.stringify(lock) },
    ];
    const released = files.map((f) => ({ ...f, text: f.text.replaceAll("1.0.0", "1.0.1") }));
    expect(currentSurfaceInputs(a, released)).toEqual(currentSurfaceInputs(a, files));
    for (const path of ["package.json", "package-lock.json"]) {
      const changed = files.map((f) => (f.path === path ? { ...f, text: f.text.replaceAll("3.0.0", "3.0.1") } : f));
      expect(currentSurfaceInputs(a, changed)).not.toEqual(currentSurfaceInputs(a, files));
    }
  });

  it("tracks fixture and shared runtime import closures and fails on missing inputs", () => {
    expect(Object.keys(currentSurfaceInputs(a, sources))).toEqual(
      expect.arrayContaining(["scripts/a-data.ts", "scripts/a.json", "src/channels/escape.ts"]),
    );
    expect(() =>
      currentSurfaceInputs(
        a,
        sources.filter((f) => f.path !== "scripts/a-data.ts"),
      ),
    ).toThrow(/a-data/);
    expect(() =>
      currentSurfaceInputs(
        a,
        sources.filter((f) => f.path !== "scripts/a.json"),
      ),
    ).toThrow(/a.json/);
    expect(() =>
      currentSurfaceInputs(
        a,
        sources.filter((f) => f.path !== a.page),
      ),
    ).toThrow(/Sample.vue/);
  });
});

describe("capture dependency graph", () => {
  const pkg = {
    version: "1.0.0",
    type: "module",
    dependencies: { renderer: "1.0.0", cli: "1.0.0" },
    scripts: { cli: "cli", "screenshots:gen": "tsx scripts/screenshots.mts" },
  };
  const web = {
    dependencies: { "@fonts/sans": "1.0.0" },
    devDependencies: { vite: "1.0.0", "playwright-core": "1.0.0" },
    scripts: { build: "vite build", test: "vitest" },
  };
  const packages: Record<string, Record<string, unknown>> = {
    "": pkg,
    web,
    "node_modules/renderer": {
      version: "1.0.0",
      integrity: "renderer",
      dependencies: { shared: "1.0.0" },
      peerDependencies: { peer: "1.0.0", absent: "*" },
      peerDependenciesMeta: { absent: { optional: true } },
      optionalDependencies: { native: "1.0.0" },
    },
    "node_modules/renderer/node_modules/shared": {
      version: "1.0.0",
      integrity: "nested",
      dependencies: { renderer: "1.0.0" },
    },
    "node_modules/shared": { version: "2.0.0", integrity: "cli-only" },
    "node_modules/peer": { version: "1.0.0", integrity: "peer" },
    "node_modules/native": { version: "1.0.0", integrity: "native", os: ["linux"] },
    "node_modules/cli": { version: "1.0.0", dependencies: { shared: "2.0.0" } },
    "node_modules/@fonts/sans": { version: "1.0.0", integrity: "font" },
    "node_modules/css-plugin": { version: "1.0.0", integrity: "css" },
    "node_modules/vite": { version: "1.0.0", integrity: "build" },
    "node_modules/tsx": { version: "1.0.0", integrity: "launcher" },
    "node_modules/playwright-core": { version: "1.0.0", integrity: "capture" },
    "node_modules/@iconify-json/lucide": { version: "1.0.0", integrity: "icons" },
  };
  function inputs() {
    return [
      { path: "package.json", text: JSON.stringify({ ...pkg, devDependencies: { tsx: "1.0.0" } }) },
      {
        path: "web/package.json",
        text: JSON.stringify({ ...web, devDependencies: { ...web.devDependencies, "@iconify-json/lucide": "1.0.0" } }),
      },
      { path: "package-lock.json", text: JSON.stringify({ lockfileVersion: 3, packages }) },
      { path: sample.page, text: 'import R from "renderer/component"; import type { Cli } from "cli";' },
      { path: sample.fixture.server, text: "" },
      { path: "scripts/screenshots.mts", text: 'const capture = () => import("playwright-core");' },
      { path: "web/vite.config.ts", text: 'import { defineConfig } from "vite";' },
      { path: "web/src/assets/main.css", text: '@import "@fonts/sans/font.css"; @plugin "css-plugin";' },
    ];
  }
  function changeJson(path: string, edit: (value: any) => void) {
    return inputs().map((f) => {
      if (f.path !== path) return f;
      const value = JSON.parse(f.text);
      edit(value);
      return { ...f, text: JSON.stringify(value) };
    });
  }

  it("ignores unrelated dependencies, scripts and lockfile entries", () => {
    const before = currentSurfaceInputs(sample, inputs());
    for (const path of ["package.json", "web/package.json"]) {
      expect(
        currentSurfaceInputs(
          sample,
          changeJson(path, (p) => {
            p.version = "2.0.0";
            p.scripts.cli = "changed command";
            p.scripts.test = "different test runner";
            p.dependencies.cli = "2.0.0";
            p.devDependencies.linter = "2.0.0";
          }),
        ),
      ).toEqual(before);
    }
    expect(
      currentSurfaceInputs(
        sample,
        changeJson("package-lock.json", (p) => {
          p.version = "2.0.0";
          p.packages[""].dependencies.cli = "2.0.0";
          delete p.packages["node_modules/cli"];
          p.packages["node_modules/shared"].integrity = "unrelated";
          p.packages["node_modules/new-cli"] = { version: "3.0.0" };
          p.packages["node_modules/renderer"].dev = false;
        }),
      ),
    ).toEqual(before);
  });

  it("tracks renderer, build, capture, styles, icons and resolved transitive dependencies", () => {
    const before = currentSurfaceInputs(sample, inputs());
    for (const path of Object.keys(packages).filter(
      (p) => p.includes("node_modules") && !["node_modules/cli", "node_modules/shared"].includes(p),
    )) {
      expect(
        currentSurfaceInputs(
          sample,
          changeJson("package-lock.json", (p) => {
            p.packages[path].integrity = "changed";
          }),
        ),
        path,
      ).not.toEqual(before);
    }
    expect(
      currentSurfaceInputs(
        sample,
        changeJson("web/package.json", (p) => {
          p.scripts.build = "vite build --mode screenshot";
        }),
      ),
    ).not.toEqual(before);
    expect(
      currentSurfaceInputs(
        sample,
        changeJson("package.json", (p) => {
          p.scripts["screenshots:gen"] = "tsx scripts/other.mts";
        }),
      ),
    ).not.toEqual(before);
    expect(
      currentSurfaceInputs(
        sample,
        changeJson("web/package.json", (p) => {
          p.dependencies["@fonts/sans"] = "2.0.0";
        }),
      ),
    ).not.toEqual(before);
  });

  it("tracks only the surfaces importing a local package", () => {
    const other = { ...sample, name: "other", page: "web/src/pages/Other.vue" };
    const withOther = (files: ReturnType<typeof inputs>) => [...files, { path: other.page, text: "" }];
    const changed = withOther(
      changeJson("package-lock.json", (p) => {
        p.packages["node_modules/renderer"].version = "2.0.0";
      }),
    );
    expect(currentSurfaceInputs(other, changed)).toEqual(currentSurfaceInputs(other, withOther(inputs())));
    expect(currentSurfaceInputs(sample, changed)).not.toEqual(currentSurfaceInputs(sample, withOther(inputs())));
  });

  it("fails closed on missing required packages but allows absent optional edges", () => {
    for (const path of ["node_modules/renderer", "node_modules/renderer/node_modules/shared", "node_modules/peer"]) {
      const changed = changeJson("package-lock.json", (p) => {
        delete p.packages[path];
        if (path.endsWith("/shared")) delete p.packages["node_modules/shared"];
      });
      expect(() => currentSurfaceInputs(sample, changed), path).toThrow(/Missing screenshot package/);
    }
    expect(() =>
      currentSurfaceInputs(
        sample,
        changeJson("package-lock.json", (p) => {
          delete p.packages["node_modules/native"];
        }),
      ),
    ).not.toThrow();
  });

  it("tracks bundled packages through the owning tarball instead of a hoisted namesake", () => {
    const bundled = changeJson("package-lock.json", (p) => {
      p.packages["node_modules/renderer"].bundleDependencies = ["shared"];
      delete p.packages["node_modules/renderer/node_modules/shared"];
    });
    const changed = bundled.map((f) => {
      if (f.path !== "package-lock.json") return f;
      const lock = JSON.parse(f.text);
      lock.packages["node_modules/shared"].integrity = "unrelated";
      return { ...f, text: JSON.stringify(lock) };
    });
    expect(currentSurfaceInputs(sample, bundled)).toEqual(currentSurfaceInputs(sample, changed));
    expect(currentSurfaceInputs(sample, bundled)).not.toEqual(currentSurfaceInputs(sample, inputs()));
  });

  it("follows workspace links without hashing their release labels", () => {
    const linked = changeJson("package-lock.json", (p) => {
      p.packages["node_modules/renderer"] = { link: true, resolved: "packages/renderer" };
      p.packages["packages/renderer"] = { version: "1.0.0", dependencies: { peer: "1.0.0" } };
    });
    const released = linked.map((f) => {
      if (f.path !== "package-lock.json") return f;
      const lock = JSON.parse(f.text);
      lock.packages["packages/renderer"].version = "2.0.0";
      return { ...f, text: JSON.stringify(lock) };
    });
    expect(currentSurfaceInputs(sample, released)).toEqual(currentSurfaceInputs(sample, linked));
    const changed = released.map((f) => ({
      ...f,
      text: f.text.replace('"integrity":"peer"', '"integrity":"changed"'),
    }));
    expect(currentSurfaceInputs(sample, changed)).not.toEqual(currentSurfaceInputs(sample, linked));
  });

  it("canonicalizes dependency metadata instead of hashing JSON key order", () => {
    const reversed = inputs().map((f) =>
      f.path.endsWith(".json")
        ? {
            ...f,
            text: JSON.stringify(JSON.parse(f.text), (_, value) =>
              value && typeof value === "object" && !Array.isArray(value)
                ? Object.fromEntries(Object.entries(value).reverse())
                : value,
            ),
          }
        : f,
    );
    expect(currentSurfaceInputs(sample, reversed)).toEqual(currentSurfaceInputs(sample, inputs()));
  });

  it("leaves every registered surface current after an unrelated CLI dependency or script changes", () => {
    const files = listInputs(root).map((path) => ({ path, text: readFileSync(join(root, path), "utf8") }));
    const changed = files.map((f) => {
      if (!["package.json", "web/package.json", "package-lock.json"].includes(f.path)) return f;
      const pkg = JSON.parse(f.text);
      if (f.path === "package-lock.json") {
        pkg.packages["node_modules/@opencode/cli"].version = "99.0.0";
        pkg.packages["node_modules/@opencode/cli"].integrity = "unrelated";
        pkg.packages[""].devDependencies["@opencode/cli"] = "99.0.0";
      } else {
        pkg.scripts.cli = "unrelated command";
        pkg.scripts.test = "unrelated test runner";
        pkg.devDependencies["@opencode/cli"] = "99.0.0";
      }
      return { ...f, text: JSON.stringify(pkg) };
    });
    for (const surface of SURFACES)
      expect(currentSurfaceInputs(surface, changed), surface.name).toEqual(currentSurfaceInputs(surface, files));
  });
});

describe("PNG preservation", () => {
  it("retains original bytes only when decoded dimensions and pixels match", async () => {
    const images: Record<string, { width: number; height: number; data: number[] }> = {
      original: { width: 2, height: 1, data: [0, 1, 2, 255, 4, 5, 6, 255] },
      reencoded: { width: 2, height: 1, data: [0, 1, 2, 255, 4, 5, 6, 255] },
      changed: { width: 2, height: 1, data: [0, 1, 3, 255, 4, 5, 6, 255] },
      resized: { width: 1, height: 2, data: [0, 1, 2, 255, 4, 5, 6, 255] },
    };
    class DecodedImage {
      src = "";
      get pixels() {
        return images[this.src.split(",")[1]];
      }
      get naturalWidth() {
        return this.pixels.width;
      }
      get naturalHeight() {
        return this.pixels.height;
      }
      async decode() {
        if (!this.pixels) throw new Error("Invalid PNG");
      }
    }
    vi.stubGlobal("Image", DecodedImage);
    vi.stubGlobal("document", {
      createElement: () => {
        let pixels: number[];
        return {
          getContext: () => ({
            drawImage: (image: DecodedImage) => {
              pixels = image.pixels.data;
            },
            getImageData: () => ({ data: new Uint8ClampedArray(pixels) }),
          }),
        };
      },
    });
    try {
      expect(await samePngPixels(["original", "reencoded"])).toBe(true);
      expect(await samePngPixels(["original", "changed"])).toBe(false);
      expect(await samePngPixels(["original", "resized"])).toBe(false);
      await expect(samePngPixels(["original", "invalid"])).rejects.toThrow("Invalid PNG");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
