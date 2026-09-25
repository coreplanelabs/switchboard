import { createHash } from "node:crypto";
import { existsSync, globSync, readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { join, posix, relative } from "node:path";
import ts from "typescript";

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
// never collide on one file. Input discovery reads the local tree; only the
// generator writes manifests and pictures.

export const SCREENSHOTS_DIR = "docs/public/screenshots";
export const MANIFEST_DIR = `${SCREENSHOTS_DIR}/manifest`;

/** The manifest file recording one surface's inputs. */
export function manifestPath(surface: string): string {
  return `${MANIFEST_DIR}/${surface}.json`;
}

/** Each registration owns its preview server/config and page dependency closure.
 * Profiles are literal per-surface data; omitted profiles preserve desktop. */
export const SURFACES = [
  {
    name: "home-empty",
    path: "/threads",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/HomePage.vue",
    what: "the home page's empty state: the mark, the greeting, the composer in the middle, the chips",
  },
  {
    name: "home-conversation",
    path: "/threads/conv-1",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/HomePage.vue",
    what: "a finished conversation: three turns, each a run with its receipt and reply",
  },
  {
    name: "home-live",
    path: "/threads/conv-live",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/HomePage.vue",
    what: "a conversation whose newest run is live: the pending row and the open work",
  },
  {
    name: "runs-index",
    path: "/runs?all=1",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/RunsIndexPage.vue",
    what: "the runs index, live and finished rows",
  },
  {
    name: "runs-index-viewing-as",
    path: "/runs?all=1&viewing=1",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/RunsIndexPage.vue",
    what: "the runs index while an admin views it as a person: the banner, that person's rows, the picker",
  },
  {
    name: "run-page",
    path: "/runs/hist-1",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/RunRoutePage.vue",
    what: "a finished coding run's page and timeline",
  },
  {
    name: "residents",
    path: "/residents?open=acme/web",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/ResidentsIndexPage.vue",
    what: "the residents index, one resident folded open",
  },
  {
    name: "costs",
    path: "/costs",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/CostsPage.vue",
    what: "the spend page",
  },
  {
    name: "plane",
    path: "/plane",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/PlanePage.vue",
    what: "the plane's table — every live and recent run, every unit and every tracked pull request with its owner and health — beside the pinned orchestrator chat",
  },
  {
    name: "costs-users",
    path: "/costs?view=users",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/CostsPage.vue",
    what: "the spend page's By user tab",
  },
  {
    name: "metrics",
    path: "/metrics",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/MetricsPage.vue",
    what: "the run metrics page: the trend tiles, the three day charts and the by-agent table",
  },
  {
    name: "costs-models",
    path: "/costs?view=models",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/CostsPage.vue",
    what: "the spend page's By model tab: turns and LLM dollars per model, no cloud column",
  },
  {
    name: "scheduled",
    path: "/runs/scheduled",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/ScheduledPage.vue",
    what: "the scheduled runs tab",
  },
  {
    name: "unit-page",
    path: "/runs/unit/plan-acme-3:U13?open=unit-c1",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/UnitRoutePage.vue",
    what: "a ship unit through two review rounds, both threads, one run's timeline open",
  },
  {
    name: "unit-page-coding-only",
    path: "/runs/unit/plan-acme-3:U14",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/UnitRoutePage.vue",
    what: "a unit in its first coding round, one thread, nothing reviewed yet",
  },
  {
    name: "unit-search",
    path: "/runs/unit/plan-acme-3:U13?session=coding&q=lockfile",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/UnitRoutePage.vue",
    what: "the unit page's search over the coding thread's log, hits placed in their runs",
  },
  {
    name: "unit-search-landed",
    path: "/runs/unit/plan-acme-3:U13?session=coding&q=lockfile&open=unit-c1&turn=47",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/UnitRoutePage.vue",
    what: "a search hit landed on its step: the run's fold open at the step the turn lives in, drawn as the run page draws it",
  },
  {
    name: "conductor-page",
    path: "/runs/cond-1",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/RunRoutePage.vue",
    what: "a finished conductor's page listing the runs it spawned",
  },
  {
    name: "review-page",
    path: "/runs/hist-4",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/RunRoutePage.vue",
    what: "a finished pull request review: the verdict as the Reply, the pull request and its Findings ledger link in the facts bar",
  },
  {
    name: "settings-mcps",
    path: "/settings/mcps",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/SettingsPage.vue",
    what: "the settings page's MCPs tab: three tiers of servers and the add form",
  },
  {
    name: "settings-channel",
    path: "/settings/channels/slack:CACME0001",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/SettingsPage.vue",
    what: "the settings page's Channels tab with one channel's scope open as a form",
  },
  {
    name: "settings-installation",
    path: "/settings/installation",
    fixture: { server: "scripts/web-preview.ts", inputs: [] },
    page: "web/src/pages/SettingsPage.vue",
    what: "the settings page's Installation tab: the running config's knobs and the capabilities that are on",
  },
] as const satisfies readonly Surface[];

export const THEMES = ["light", "dark"] as const;

/** A laptop viewport at a retina density: 16:10, the landing page's frame shape. */
export const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 } as const;

/** The instant every picture is rendered at, on the server and in the browser:
 *  a weekday afternoon after the fixture's own timestamps, so "4 hours ago"
 *  reads the same on every machine. Changing it changes every picture — and
 *  the manifest records it, so the check names a manifest rendered at another. */
export const FIXED_NOW = 1_788_877_800_000;

export interface CaptureProfile {
  name: string;
  /** Empty preserves the historical name; otherwise a hyphen-prefixed slug. */
  suffix: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  themes?: readonly (typeof THEMES)[number][];
}

export interface Surface {
  name: string;
  path: string;
  page: string;
  what: string;
  fixture: { server: string; inputs: readonly string[] };
  captures?: readonly CaptureProfile[];
}

export interface Manifest {
  viewport: CaptureProfile["viewport"];
  now: number;
  captures: ReturnType<typeof resolveCaptures>;
  configHash: string;
  /** Repository-relative input → sha256; the registry module hashes mechanics only. */
  inputs: Record<string, string>;
}

const NAMED_INPUTS = [
  "scripts/screenshots.mts",
  "src/channels/webShell.ts",
  "src/docs/screenshotManifest.ts",
  "web/vite.config.ts",
  "package.json",
  "web/package.json",
  "package-lock.json",
];

export function isSharedInput(path: string): boolean {
  if (NAMED_INPUTS.includes(path)) return true;
  if (["web/src/main.ts", "web/src/routes.ts", "web/src/App.vue"].includes(path)) return true;
  return path.startsWith("web/src/assets/");
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function inputPath(path: string): void {
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) || path.split("/").some((p) => p === "." || p === "..")) {
    throw new Error(`Invalid screenshot input path: ${path}`);
  }
}

function onlyKeys(value: object, keys: readonly string[]): void {
  for (const key of Object.keys(value))
    if (!keys.includes(key)) throw new Error(`Unsupported capture configuration: ${key}`);
}

/** Validate the entire registry before any artifact is written or removed. */
export function resolveCaptures(surfaces: readonly Surface[] = SURFACES) {
  const names = new Set<string>();
  const outputs = new Set<string>();
  return surfaces.flatMap((surface) => {
    onlyKeys(surface, ["name", "path", "page", "what", "fixture", "captures"]);
    if (!SLUG.test(surface.name) || names.has(surface.name))
      throw new Error(`Invalid or duplicate surface: ${surface.name}`);
    names.add(surface.name);
    const route = decodeURIComponent(surface.path);
    if (
      !route.startsWith("/") ||
      route.startsWith("//") ||
      /[\\#\s]/.test(route) ||
      route.split(/[/?]/).some((p) => p === "." || p === "..")
    ) {
      throw new Error(`Invalid local preview route: ${surface.path}`);
    }
    inputPath(surface.page);
    onlyKeys(surface.fixture, ["server", "inputs"]);
    inputPath(surface.fixture.server);
    if (!/^scripts\/.+\.m?ts$/.test(surface.fixture.server))
      throw new Error(`Unsupported fixture server: ${surface.fixture.server}`);
    surface.fixture.inputs.forEach(inputPath);
    if (new Set(surface.fixture.inputs).size !== surface.fixture.inputs.length)
      throw new Error("Duplicate fixture input");
    const profiles: readonly CaptureProfile[] = surface.captures ?? [
      { name: "desktop", suffix: "", viewport: VIEWPORT },
    ];
    if (!profiles.length) throw new Error(`No capture profiles: ${surface.name}`);
    const profileNames = new Set<string>();
    const suffixes = new Set<string>();
    return [...profiles]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .flatMap((profile) => {
        onlyKeys(profile, ["name", "suffix", "viewport", "themes"]);
        if (!SLUG.test(profile.name) || profileNames.has(profile.name))
          throw new Error(`Invalid or duplicate profile: ${profile.name}`);
        profileNames.add(profile.name);
        if (profile.suffix !== "" && (!profile.suffix.startsWith("-") || !SLUG.test(profile.suffix.slice(1))))
          throw new Error(`Invalid output suffix: ${profile.suffix}`);
        if (suffixes.has(profile.suffix)) throw new Error(`Duplicate output suffix: ${profile.suffix}`);
        suffixes.add(profile.suffix);
        onlyKeys(profile.viewport, ["width", "height", "deviceScaleFactor"]);
        const { width, height, deviceScaleFactor } = profile.viewport;
        if (
          ![width, height].every((v) => Number.isSafeInteger(v) && v > 0) ||
          !Number.isFinite(deviceScaleFactor) ||
          deviceScaleFactor <= 0
        )
          throw new Error(`Invalid viewport: ${profile.name}`);
        const themes = profile.themes ?? THEMES;
        if (!themes.length || new Set(themes).size !== themes.length || themes.some((t) => !THEMES.includes(t)))
          throw new Error(`Unsupported or duplicate theme: ${profile.name}`);
        return THEMES.filter((t) => themes.includes(t)).map((theme) => {
          const file = `${surface.name}${profile.suffix}-${theme}.png`;
          if (outputs.has(file)) throw new Error(`Duplicate screenshot output: ${file}`);
          outputs.add(file);
          return {
            profile: profile.name,
            suffix: profile.suffix,
            theme,
            file,
            context: {
              viewport: { width, height },
              deviceScaleFactor,
              colorScheme: theme,
              reducedMotion: "reduce" as const,
              timezoneId: "UTC",
              locale: "en-US",
            },
            screenshot: {
              type: "png" as const,
              fullPage: false,
              scale: "device" as const,
              animations: "disabled" as const,
              caret: "hide" as const,
            },
          };
        });
      });
  });
}

/** Preserve the historical warm context across a theme's pages; cold font
 * loading can otherwise race a page's initial scroll-to-result behavior. */
export function captureBatches(surfaces: readonly Surface[]) {
  resolveCaptures(surfaces);
  type Capture = ReturnType<typeof resolveCaptures>[number];
  const batches = new Map<
    string,
    { server: string; context: Capture["context"]; tasks: { surface: Surface; capture: Capture }[] }
  >();
  for (const surface of surfaces)
    for (const capture of resolveCaptures([surface])) {
      const key = JSON.stringify([surface.fixture.server, capture.context]);
      let batch = batches.get(key);
      if (!batch) {
        batch = { server: surface.fixture.server, context: capture.context, tasks: [] };
        batches.set(key, batch);
      }
      batch.tasks.push({ surface, capture });
    }
  return [...batches.values()];
}

/** Only literal registration data is omitted from the shared mechanics hash.
 * Calls, spreads, accessors and computed properties cannot hide executable code.
 * Each surface's resolved data is hashed separately by renderManifest. */
export function captureMechanicsSource(text: string): string {
  const source = ts.createSourceFile("registry.ts", text, ts.ScriptTarget.Latest, true);
  const literal = (node: ts.Node): boolean => {
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) return literal(node.expression);
    if (ts.isArrayLiteralExpression(node)) return node.elements.every(literal);
    if (ts.isObjectLiteralExpression(node))
      return node.properties.every(
        (p) =>
          ts.isPropertyAssignment(p) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
          literal(p.initializer),
      );
    return (
      ts.isStringLiteral(node) ||
      ts.isNumericLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword
    );
  };
  let found = false;
  const parts = source.statements.map((statement) => {
    if (!ts.isVariableStatement(statement)) return statement.getFullText(source);
    const registrations = statement.declarationList.declarations.filter(
      (d) => ts.isIdentifier(d.name) && d.name.text === "SURFACES",
    );
    if (!registrations.length) return statement.getFullText(source);
    const initializer = registrations[0].initializer;
    if (found || statement.declarationList.declarations.length !== 1 || !initializer || !literal(initializer))
      throw new Error("SURFACES must be one literal registration array");
    found = true;
    // Keep the declaration, type annotation and surrounding comments, not its data.
    return text.slice(statement.pos, initializer.pos) + " []" + text.slice(initializer.end, statement.end);
  });
  if (!found) throw new Error("Missing literal SURFACES registration");
  return parts.join("") + text.slice(source.endOfFileToken.pos);
}

// A generation checks the same shared sources for every surface. Bound the
// parser cache by count and key it by content, never by mutable path identity.
const importCache = new Map<string, readonly string[]>();

/** Runtime imports, including lazy imports and stylesheet packages/plugins.
 * Local discovery omits packages; dependency hashing asks for them as well. */
export function importSpecifiers(text: string, includeDynamic = true, includePackages = false): string[] {
  const key = `${includeDynamic}\0${text}`;
  const select = (specs: readonly string[]) =>
    specs.filter((spec) => includePackages || /^(\.\.?\/|@core\/|@\/)/.test(spec));
  const cached = importCache.get(key);
  if (cached) return select(cached);
  const out = new Set<string>();
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteral(node)) out.add(node.text);
  };
  const scripts = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  const source = ts.createSourceFile(
    "input.ts",
    scripts.length ? scripts.map((m) => m[1]).join("\n") : text,
    ts.ScriptTarget.Latest,
    true,
  );
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const bindings = node.importClause?.namedBindings;
      const typesOnly =
        !node.importClause?.name &&
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((e) => e.isTypeOnly);
      if (!typesOnly) add(node.moduleSpecifier);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const bindings = node.exportClause;
      const typesOnly =
        bindings &&
        ts.isNamedExports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((e) => e.isTypeOnly);
      if (!typesOnly) add(node.moduleSpecifier);
    }
    if (includeDynamic && ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      add(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const m of text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/@(?:import|plugin)\s+["']([^"']+)["']/g))
    out.add(m[1]);
  if (importCache.size >= 512) importCache.delete(importCache.keys().next().value!);
  importCache.set(key, [...out]);
  return select([...out]);
}

/** Resolves one specifier against the set of known input paths, the way the
 *  bundler would: as written, a NodeNext `.js` suffix mapped back to its
 *  source, then with `.ts`/`.mts`/`.vue`, then as a directory index.
 *  Unresolvable (a package, a type-only alias) → undefined. */
export function resolveSpecifier(from: string, spec: string, known: ReadonlySet<string>): string | undefined {
  if (spec.startsWith("@core/")) {
    from = "src/_";
    spec = `./${spec.slice(6)}`;
  } else if (spec.startsWith("@/")) {
    from = "web/src/_";
    spec = `./${spec.slice(2)}`;
  }
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === ".") continue;
    else if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  const base = parts.join("/");
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.mts`,
    `${base}.vue`,
    `${base}/index.ts`,
    `${base}/index.vue`,
    `${base}.json`,
  ];
  if (/\.m?js$/.test(base)) {
    const stem = base.replace(/\.m?js$/, "");
    candidates.push(`${stem}.ts`, `${stem}.mts`, `${stem}.vue`);
  }
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}

/** Pure: one surface's inputs — the shared inputs plus the import closure of
 *  its page component over the given sources — sorted. */
export function surfaceInputs(
  page: string,
  files: readonly { path: string; text: string }[],
  localInputs: readonly string[] = [],
): string[] {
  const byPath = new Map(files.map((f) => [f.path, f.text]));
  const known = new Set(byPath.keys());
  const inputs = new Set<string>();
  const queue = [page, ...localInputs, ...[...known].filter(isSharedInput)];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (inputs.has(path)) continue;
    inputs.add(path);
    const text = byPath.get(path);
    if (text === undefined) throw new Error(`Missing screenshot input: ${path}`);
    // The router registers unrelated lazy pages; its own source stays shared,
    // while the surface selects the page closure, not every possible route.
    for (const spec of path.endsWith(".json") ? [] : importSpecifiers(text, path !== "web/src/routes.ts")) {
      const resolved = resolveSpecifier(path, spec, known);
      if (!resolved) throw new Error(`Missing screenshot dependency: ${path} → ${spec}`);
      queue.push(resolved);
    }
  }
  return [...inputs].sort();
}

export function isScreenshotInput(path: string): boolean {
  if (NAMED_INPUTS.includes(path) || path === "scripts/web-preview.ts") return true;
  if (!path.startsWith("web/src/") || path.startsWith("web/src/testing/")) return false;
  return !/\.(test|d)\.ts$/.test(path);
}

/** Discover actual imports outside web/src too, including fixture and @core
 * dependencies. Files supplied as configuration need not be source modules. */
export function listInputs(root: string, surfaces: readonly Surface[] = SURFACES): string[] {
  resolveCaptures(surfaces);
  const known = new Set([
    ...NAMED_INPUTS,
    ...surfaces.flatMap((s) => [s.page, s.fixture.server, ...s.fixture.inputs]),
    ...globSync("web/src/**/*", { cwd: root, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => relative(root, join(d.parentPath, d.name)).split("\\").join("/"))
      .filter(isScreenshotInput),
  ]);
  // A candidate set lets NodeNext imports resolve without importing/executing fixtures.
  const candidates = new Set([
    ...known,
    ...globSync(["src/**/*.{ts,mts,js,mjs,cjs,json}", "scripts/**/*.{ts,mts,js,mjs,cjs,json}"], { cwd: root }),
  ]);
  for (const path of known) {
    if (!existsSync(join(root, path))) throw new Error(`Missing screenshot input: ${path}`);
    for (const spec of path.endsWith(".json") ? [] : importSpecifiers(readFileSync(join(root, path), "utf8"))) {
      const resolved = resolveSpecifier(path, spec, candidates);
      if (!resolved) throw new Error(`Missing screenshot dependency: ${path} → ${spec}`);
      known.add(resolved);
    }
  }
  return [...known].sort();
}

interface PackageEntry {
  version?: string;
  resolved?: string;
  link?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  bundleDependencies?: string[];
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, entry: unknown) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}

/** Project npm's lock graph from actual imports, not the whole monorepo. Node's
 * ancestor lookup matters: a renderer can use a nested version while an unrelated
 * CLI uses the hoisted one. Optional/peer edges participate when installed. */
function captureDependencyInputs(files: readonly { path: string; text: string }[]): Record<string, string> {
  const json = new Map(
    files
      .filter((f) => ["package.json", "web/package.json", "package-lock.json"].includes(f.path))
      .map((f) => [f.path, JSON.parse(f.text)]),
  );
  if (!json.size) return {};
  const lock = json.get("package-lock.json") as
    { lockfileVersion?: number; packages?: Record<string, PackageEntry> } | undefined;
  if (!lock?.packages) throw new Error("Missing screenshot package lock graph");
  const packages = lock.packages;
  const resolve = (from: string, name: string): string | undefined => {
    for (let dir = from; ; dir = posix.dirname(dir)) {
      const path = posix.join(dir, "node_modules", name);
      if (packages[path]) return path;
      if (!dir || dir === ".") return undefined;
    }
  };
  const selected = new Set<string>();
  const visit = (path: string): void => {
    if (selected.has(path)) return;
    const entry = packages[path];
    if (!entry) throw new Error(`Missing screenshot package: ${path}`);
    selected.add(path);
    if (entry.link) {
      if (!entry.resolved) throw new Error(`Missing screenshot package link target: ${path}`);
      visit(entry.resolved);
      return;
    }
    const names = new Set([
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}),
    ]);
    for (const name of names) {
      // npm can omit bundled children from the lock: the owner's integrity pins
      // their bytes. A hoisted namesake belongs to some other consumer.
      if (entry.bundleDependencies?.includes(name)) continue;
      const dependency = resolve(path, name);
      if (dependency) visit(dependency);
      else if (!(name in (entry.optionalDependencies ?? {})) && !entry.peerDependenciesMeta?.[name]?.optional)
        throw new Error(`Missing screenshot package: ${path} → ${name}`);
    }
  };
  const add = (from: string, name: string): void => {
    const path = resolve(from, name);
    if (!path) throw new Error(`Missing screenshot package: ${from || "root"} → ${name}`);
    visit(path);
  };
  for (const file of files.filter((f) => !f.path.endsWith(".json"))) {
    for (const spec of importSpecifiers(file.text, file.path !== "web/src/routes.ts", true)) {
      if (/^(\.|\/|@core\/|@\/)/.test(spec) || isBuiltin(spec)) continue;
      const name = spec
        .split("/")
        .slice(0, spec.startsWith("@") ? 2 : 1)
        .join("/");
      add(posix.dirname(file.path), name);
    }
  }
  // These inputs are loaded by a command or the icon bundler, not a source import.
  for (const [path, name] of [
    ["package.json", "tsx"],
    ["web/package.json", "vite"],
  ]) {
    const pkg = json.get(path) as PackageEntry | undefined;
    if (pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]) add(posix.dirname(path), name);
  }
  const web = json.get("web/package.json") as PackageEntry | undefined;
  for (const name of Object.keys({ ...web?.dependencies, ...web?.devDependencies }))
    if (name.startsWith("@iconify-json/")) add("web", name);

  const project = (pkg: PackageEntry, from: string, scripts: string[]) => ({
    type: pkg.type,
    scripts: Object.fromEntries(
      scripts.filter((name) => pkg.scripts?.[name]).map((name) => [name, pkg.scripts![name]]),
    ),
    ...Object.fromEntries(
      ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].map((kind) => [
        kind,
        Object.fromEntries(
          Object.entries((pkg[kind] ?? {}) as Record<string, string>).filter(([name]) => {
            const path = resolve(from, name);
            return path !== undefined && selected.has(path);
          }),
        ),
      ]),
    ),
  });
  const inputs: Record<string, string> = {};
  for (const path of ["package.json", "web/package.json"]) {
    const pkg = json.get(path) as PackageEntry | undefined;
    const commands = path === "web/package.json" ? ["build"] : ["screenshots:gen", "screenshots:check"];
    if (pkg)
      inputs[path] = canonicalJson(
        project(
          pkg,
          posix.dirname(path),
          commands.flatMap((name) => [`pre${name}`, name, `post${name}`]),
        ),
      );
  }
  // Install classification (dev/optional) can change solely because an unrelated
  // consumer was added. Keep artifact identity and resolution, not that bookkeeping.
  const fields = [
    "version",
    "resolved",
    "integrity",
    "link",
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
    "bundleDependencies",
    "bin",
    "hasInstallScript",
    "inBundle",
    "os",
    "cpu",
    "libc",
    "engines",
  ];
  inputs["package-lock.json"] = canonicalJson({
    lockfileVersion: lock.lockfileVersion,
    packages: Object.fromEntries(
      [...selected].map((path) => [
        path,
        path.split("/").includes("node_modules")
          ? Object.fromEntries(
              fields.filter((key) => packages[path][key] !== undefined).map((key) => [key, packages[path][key]]),
            )
          : project(packages[path], path, []),
      ]),
    ),
  });
  return inputs;
}

export function currentSurfaceInputs(
  surface: Surface,
  sources: readonly { path: string; text: string; bytes?: Uint8Array }[],
): Record<string, string> {
  const paths = new Set(surfaceInputs(surface.page, sources, [surface.fixture.server, ...surface.fixture.inputs]));
  const files = sources.filter((f) => paths.has(f.path));
  const dependencies = captureDependencyInputs(files);
  return hashInputs(
    files.map((f) => {
      if (f.path === "src/docs/screenshotManifest.ts") return { path: f.path, text: captureMechanicsSource(f.text) };
      return { path: f.path, text: dependencies[f.path] ?? f.bytes ?? f.text };
    }),
  );
}

/** Pure: path → sha256, keys sorted so two renders of one tree agree byte for byte. */
export function hashInputs(files: readonly { path: string; text: string | Uint8Array }[]): Record<string, string> {
  return Object.fromEntries(
    [...files]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((f) => [f.path, createHash("sha256").update(f.text).digest("hex")]),
  );
}

/** Every declared profile/theme output, using the same resolver as generation. */
export function expectedFiles(surfaces: readonly Surface[] = SURFACES): string[] {
  return resolveCaptures(surfaces).map((c) => c.file);
}

/** The resolved capture configuration, hashed independently of other registrations.
 * viewport remains the historical default metadata; captures records each actual viewport. */
export function renderManifest(inputs: Record<string, string>, surface: Surface): Manifest {
  const captures = resolveCaptures([surface]);
  const config = {
    path: surface.path,
    page: surface.page,
    fixture: { server: surface.fixture.server, inputs: [...surface.fixture.inputs].sort() },
    now: FIXED_NOW,
    captures,
  };
  const configHash = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  return {
    viewport: VIEWPORT,
    now: FIXED_NOW,
    captures,
    configHash,
    inputs: Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

/** Pure: what differs between one surface's inputs in the tree and its
 *  recorded manifest — a render at another viewport or clock than this module
 *  pins, a changed, new or removed input, a picture missing — one line each,
 *  each naming the surface. */
export function manifestProblems(
  definition: Surface | string,
  current: Record<string, string>,
  recorded: Manifest | undefined,
  present: string[],
): string[] {
  const selected = typeof definition === "string" ? SURFACES.find((s) => s.name === definition) : definition;
  if (!selected) throw new Error(`Unknown surface: ${definition}`);
  const surface = selected.name;
  const expected = renderManifest(current, selected);
  if (recorded === undefined) return [`${surface}: no manifest — run \`npm run screenshots:gen\``];
  if (typeof recorded.now !== "number" || typeof recorded.viewport?.width !== "number" || !recorded.inputs) {
    return [`${surface}: the manifest does not carry the viewport and the fixed clock the pictures were rendered with`];
  }
  const problems: string[] = [];
  if (
    recorded.configHash !== expected.configHash ||
    JSON.stringify(recorded.captures) !== JSON.stringify(expected.captures)
  ) {
    problems.push(`${surface}: capture configuration changed since it was rendered`);
  }
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
  for (const { file } of expected.captures) {
    if (!present.includes(file)) problems.push(`${surface}: ${file} is missing`);
  }
  return problems;
}

/** Pure: the files under the screenshots directory nothing expects — a
 *  picture no surface names, a manifest of a surface that no longer exists. */
export function strayFiles(
  presentPngs: string[],
  presentManifests: string[],
  surfaces: readonly Surface[] = SURFACES,
): string[] {
  const expectedPngs = new Set(expectedFiles(surfaces));
  const expectedManifests = new Set(surfaces.map((s) => `${s.name}.json`));
  return [
    ...presentPngs.filter((f) => !expectedPngs.has(f)).map((f) => `${f} is not a screenshot any surface expects`),
    ...presentManifests
      .filter((f) => !expectedManifests.has(f))
      .map((f) => `${f} is not a manifest any surface expects`),
  ];
}

/** Runs inside page.evaluate: no closure over Node state and no named nested
 * function (tsx would inject a Node-only naming helper into its source). */
export async function samePngPixels(pngs: [string, string]): Promise<boolean> {
  const [a, b] = await Promise.all(
    pngs.map(async (png) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      return {
        width: canvas.width,
        height: canvas.height,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      };
    }),
  );
  return a.width === b.width && a.height === b.height && a.data.every((value, i) => value === b.data[i]);
}
