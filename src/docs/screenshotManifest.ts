import { createHash } from "node:crypto";
import { globSync } from "node:fs";
import { join, relative } from "node:path";

// The dashboard screenshots, as pure functions.
//
// The pictures under docs/public/screenshots/ are rendered by a browser from
// the fixture preview (scripts/web-preview.ts) — the README, the landing page
// and the architecture page show them. CI runs no browser, so what CI holds is
// one manifest per surface beside them: a hash of every file that surface is
// rendered from — the shared inputs plus the import closure of its page
// component. A file that changed while the surface's pictures did not is
// drift, and `npm run screenshots:check` names the surface and the file;
// `npm run screenshots:gen` re-renders only the surfaces whose inputs changed
// and rewrites only their manifests, so two branches touching different pages
// never collide on one file. `scripts/screenshots.mts` is the only caller
// that reads or writes files.

export const SCREENSHOTS_DIR = "docs/public/screenshots";
export const MANIFEST_DIR = `${SCREENSHOTS_DIR}/manifest`;

/** The manifest file recording one surface's inputs. */
export function manifestPath(surface: string): string {
  return `${MANIFEST_DIR}/${surface}.json`;
}

/** One picture per surface: its file name, the preview route that renders it,
 *  and the page component whose import closure is the surface's own inputs. */
export const SURFACES = [
  {
    name: "home-empty",
    path: "/threads",
    page: "web/src/pages/HomePage.vue",
    what: "the home page's empty state: the mark, the greeting, the composer in the middle, the chips",
  },
  {
    name: "home-conversation",
    path: "/threads/conv-1",
    page: "web/src/pages/HomePage.vue",
    what: "a finished conversation: three turns, each a run with its receipt and reply",
  },
  {
    name: "home-live",
    path: "/threads/conv-live",
    page: "web/src/pages/HomePage.vue",
    what: "a conversation whose newest run is live: the pending row and the open work",
  },
  {
    name: "runs-index",
    path: "/runs?all=1",
    page: "web/src/pages/RunsIndexPage.vue",
    what: "the runs index, live and finished rows",
  },
  {
    name: "runs-index-viewing-as",
    path: "/runs?all=1&viewing=1",
    page: "web/src/pages/RunsIndexPage.vue",
    what: "the runs index while an admin views it as a person: the banner, that person's rows, the picker",
  },
  {
    name: "run-page",
    path: "/runs/hist-1",
    page: "web/src/pages/RunRoutePage.vue",
    what: "a finished coding run's page and timeline",
  },
  {
    name: "residents",
    path: "/residents?open=acme/web",
    page: "web/src/pages/ResidentsIndexPage.vue",
    what: "the residents index, one resident folded open",
  },
  { name: "costs", path: "/costs", page: "web/src/pages/CostsPage.vue", what: "the spend page" },
  {
    name: "costs-users",
    path: "/costs?view=users",
    page: "web/src/pages/CostsPage.vue",
    what: "the spend page's By user tab",
  },
  {
    name: "costs-models",
    path: "/costs?view=models",
    page: "web/src/pages/CostsPage.vue",
    what: "the spend page's By model tab: turns and LLM dollars per model, no cloud column",
  },
  {
    name: "scheduled",
    path: "/runs/scheduled",
    page: "web/src/pages/ScheduledPage.vue",
    what: "the scheduled runs tab",
  },
  {
    name: "unit-page",
    path: "/runs/unit/plan-acme-3:U13?open=unit-c1",
    page: "web/src/pages/UnitRoutePage.vue",
    what: "a ship unit through two review rounds, both threads, one run's timeline open",
  },
  {
    name: "unit-page-coding-only",
    path: "/runs/unit/plan-acme-3:U14",
    page: "web/src/pages/UnitRoutePage.vue",
    what: "a unit in its first coding round, one thread, nothing reviewed yet",
  },
  {
    name: "unit-search",
    path: "/runs/unit/plan-acme-3:U13?session=coding&q=lockfile",
    page: "web/src/pages/UnitRoutePage.vue",
    what: "the unit page's search over the coding thread's log, hits placed in their runs",
  },
  {
    name: "unit-search-landed",
    path: "/runs/unit/plan-acme-3:U13?session=coding&q=lockfile&open=unit-c1&turn=47",
    page: "web/src/pages/UnitRoutePage.vue",
    what: "a search hit landed on its step: the run's fold open at the step the turn lives in, drawn as the run page draws it",
  },
  {
    name: "conductor-page",
    path: "/runs/cond-1",
    page: "web/src/pages/RunRoutePage.vue",
    what: "a finished conductor's page listing the runs it spawned",
  },
  {
    name: "review-page",
    path: "/runs/hist-4",
    page: "web/src/pages/RunRoutePage.vue",
    what: "a finished pull request review: the verdict as the Reply, the pull request and its Findings ledger link in the facts bar",
  },
  {
    name: "settings-mcps",
    path: "/settings/mcps",
    page: "web/src/pages/SettingsPage.vue",
    what: "the settings page's MCPs tab: three tiers of servers and the add form",
  },
  {
    name: "settings-channel",
    path: "/settings/channels/slack:CACME0001",
    page: "web/src/pages/SettingsPage.vue",
    what: "the settings page's Channels tab with one channel's scope open as a form",
  },
  {
    name: "settings-installation",
    path: "/settings/installation",
    page: "web/src/pages/SettingsPage.vue",
    what: "the settings page's Installation tab: the running config's knobs and the capabilities that are on",
  },
] as const;

export const THEMES = ["light", "dark"] as const;

/** A laptop viewport at a retina density: 16:10, the landing page's frame shape. */
export const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 } as const;

/** The instant every picture is rendered at, on the server and in the browser:
 *  a weekday afternoon after the fixture's own timestamps, so "4 hours ago"
 *  reads the same on every machine. Changing it changes every picture — and
 *  the manifest records it, so the check names a manifest rendered at another. */
export const FIXED_NOW = 1_788_877_800_000;

export interface Manifest {
  viewport: typeof VIEWPORT;
  /** The epoch millisecond the preview and the browser were both held at. */
  now: number;
  /** Repository-relative path → sha256 of the file's bytes. */
  inputs: Record<string, string>;
}

/** The inputs that are not under `web/src/`: the fixture, the shell, the
 *  renderer, this module (the surfaces, the viewport and the clock live here)
 *  and the bundler's config. */
const NAMED_INPUTS = [
  "scripts/web-preview.ts",
  "scripts/screenshots.mts",
  "src/channels/webShell.ts",
  "src/docs/screenshotManifest.ts",
  "web/vite.config.ts",
];

/** The inputs every surface is rendered from regardless of its page: the
 *  named inputs, the app entry and shell, the router, and the stylesheets. */
export function isSharedInput(path: string): boolean {
  if (NAMED_INPUTS.includes(path)) return true;
  if (["web/src/main.ts", "web/src/routes.ts", "web/src/App.vue"].includes(path)) return true;
  return path.startsWith("web/src/assets/");
}

/** The relative-import specifiers of one dashboard source file, both static
 *  (`import … from "./x"`) and dynamic (`import("./x")`). Package imports
 *  never resolve to a screenshot input, so only `./` and `../` count. */
export function importSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)["'](\.\.?\/[^"']+)["']/g)) {
    out.push(m[1]);
  }
  return [...new Set(out)];
}

/** Resolves one specifier against the set of known input paths, the way the
 *  bundler would: as written, a NodeNext `.js` suffix mapped back to its
 *  source, then with `.ts`/`.mts`/`.vue`, then as a directory index.
 *  Unresolvable (a package, a type-only alias) → undefined. */
export function resolveSpecifier(from: string, spec: string, known: ReadonlySet<string>): string | undefined {
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === ".") continue;
    else if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const base = parts.join("/");
  const candidates = [base, `${base}.ts`, `${base}.mts`, `${base}.vue`, `${base}/index.ts`, `${base}/index.vue`];
  if (base.endsWith(".js")) {
    const stem = base.slice(0, -".js".length);
    candidates.push(`${stem}.ts`, `${stem}.mts`, `${stem}.vue`);
  }
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

/** Pure: one surface's inputs — the shared inputs plus the import closure of
 *  its page component over the given sources — sorted. */
export function surfaceInputs(page: string, files: readonly { path: string; text: string }[]): string[] {
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const known = new Set(byPath.keys());
  const inputs = new Set([...known].filter(isSharedInput));
  const queue = [page];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (inputs.has(path)) continue;
    inputs.add(path);
    const text = byPath.get(path);
    if (text === undefined) continue;
    for (const spec of importSpecifiers(text)) {
      const resolved = resolveSpecifier(path, spec, known);
      if (resolved !== undefined && !inputs.has(resolved)) queue.push(resolved);
    }
  }
  return [...inputs].sort();
}

/** The files a picture is rendered from: the named inputs and every source
 *  file of the dashboard. Tests, test helpers, generated declarations and
 *  builds never reach a pixel. */
export function isScreenshotInput(path: string): boolean {
  if (NAMED_INPUTS.includes(path)) return true;
  if (!path.startsWith("web/src/")) return false;
  if (path.startsWith("web/src/testing/")) return false;
  return !/\.test\.ts$/.test(path);
}

/** Every input present in the tree, repository-relative and sorted. */
export function listInputs(root: string): string[] {
  const candidates = [
    ...NAMED_INPUTS,
    ...globSync("web/src/**/*", { cwd: root, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => relative(root, join(d.parentPath, d.name)).split("\\").join("/")),
  ];
  return [...new Set(candidates.filter(isScreenshotInput))].sort();
}

/** Pure: path → sha256, keys sorted so two renders of one tree agree byte for byte. */
export function hashInputs(files: readonly { path: string; text: string | Uint8Array }[]): Record<string, string> {
  return Object.fromEntries(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => [f.path, createHash("sha256").update(f.text).digest("hex")]),
  );
}

/** The picture files the manifests expect: `<surface>-<theme>.png`. */
export function expectedFiles(): string[] {
  return SURFACES.flatMap((s) => THEMES.map((t) => `${s.name}-${t}.png`));
}

/** The manifest for one surface's render: its inputs, and the viewport and clock this module pins. */
export function renderManifest(inputs: Record<string, string>): Manifest {
  return { viewport: VIEWPORT, now: FIXED_NOW, inputs };
}

/** Pure: what differs between one surface's inputs in the tree and its
 *  recorded manifest — a render at another viewport or clock than this module
 *  pins, a changed, new or removed input, a picture missing — one line each,
 *  each naming the surface. */
export function manifestProblems(
  surface: string,
  current: Record<string, string>,
  recorded: Manifest | undefined,
  present: string[],
): string[] {
  if (recorded === undefined) return [`${surface}: no manifest — run \`npm run screenshots:gen\``];
  if (typeof recorded.now !== "number" || typeof recorded.viewport?.width !== "number" || !recorded.inputs) {
    return [`${surface}: the manifest does not carry the viewport and the fixed clock the pictures were rendered with`];
  }
  const problems: string[] = [];
  const viewport = (v: Manifest["viewport"]) => `${v.width}×${v.height} at ${v.deviceScaleFactor}×`;
  if (viewport(recorded.viewport) !== viewport(VIEWPORT)) {
    problems.push(`${surface}: rendered at ${viewport(recorded.viewport)}; the viewport is now ${viewport(VIEWPORT)}`);
  }
  if (recorded.now !== FIXED_NOW) {
    problems.push(`${surface}: rendered at clock ${recorded.now}; the fixed clock is now ${FIXED_NOW}`);
  }
  const paths = [...new Set([...Object.keys(current), ...Object.keys(recorded.inputs)])].sort();
  for (const path of paths) {
    const now = current[path];
    const was = recorded.inputs[path];
    if (now === undefined) problems.push(`${surface}: ${path} was removed since it was rendered`);
    else if (was === undefined) problems.push(`${surface}: ${path} is new since it was rendered`);
    else if (now !== was) problems.push(`${surface}: ${path} changed since it was rendered`);
  }
  for (const t of THEMES) {
    if (!present.includes(`${surface}-${t}.png`)) problems.push(`${surface}: ${surface}-${t}.png is missing`);
  }
  return problems;
}

/** Pure: the files under the screenshots directory nothing expects — a
 *  picture no surface names, a manifest of a surface that no longer exists. */
export function strayFiles(presentPngs: string[], presentManifests: string[]): string[] {
  const expectedPngs = new Set(expectedFiles());
  const expectedManifests = new Set(SURFACES.map((s) => `${s.name}.json`));
  return [
    ...presentPngs.filter((f) => !expectedPngs.has(f)).map((f) => `${f} is not a screenshot any surface expects`),
    ...presentManifests
      .filter((f) => !expectedManifests.has(f))
      .map((f) => `${f} is not a manifest any surface expects`),
  ];
}
