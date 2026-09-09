import { createHash } from "node:crypto";
import { globSync } from "node:fs";
import { join, relative } from "node:path";

// The dashboard screenshots, as pure functions.
//
// The pictures under docs/public/screenshots/ are rendered by a browser from
// the fixture preview (scripts/web-preview.ts) — the README, the landing page
// and the architecture page show them. CI runs no browser, so what CI holds is
// the manifest beside them: a hash of every file the pictures were rendered
// from. A dashboard component or a fixture that changed while the pictures did
// not is drift, and `npm run screenshots:check` names the file; `npm run
// screenshots:gen` renders again and rewrites the manifest.
// `scripts/screenshots.mts` is the only caller that reads or writes files.

export const SCREENSHOTS_DIR = "docs/public/screenshots";
export const MANIFEST_PATH = `${SCREENSHOTS_DIR}/manifest.json`;

/** One picture per surface: its file name and the preview route that renders it. */
export const SURFACES = [
  { name: "runs-index", path: "/runs?all=1", what: "the runs index, live and finished rows" },
  { name: "run-page", path: "/runs/hist-1", what: "a finished coding run's page and timeline" },
  { name: "residents", path: "/residents", what: "the residents index" },
  { name: "costs", path: "/costs", what: "the spend page" },
  { name: "scheduled", path: "/runs/scheduled", what: "the scheduled runs tab" },
] as const;

export const THEMES = ["light", "dark"] as const;

/** A laptop viewport at a retina density: 16:10, the landing page's frame shape. */
export const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 2 } as const;

export interface Manifest {
  viewport: typeof VIEWPORT;
  /** The epoch millisecond the preview and the browser were both held at. */
  now: number;
  /** Repository-relative path → sha256 of the file's bytes. */
  inputs: Record<string, string>;
}

/** The files a picture is rendered from: the fixture, the shell, the renderer
 *  and every source file of the dashboard. Tests, test helpers, generated
 *  declarations and builds never reach a pixel. */
export function isScreenshotInput(path: string): boolean {
  if (path === "scripts/web-preview.ts" || path === "scripts/screenshots.mts" || path === "src/channels/webShell.ts")
    return true;
  if (path === "web/vite.config.ts") return true;
  if (!path.startsWith("web/src/")) return false;
  if (path.startsWith("web/src/testing/")) return false;
  return !/\.test\.ts$/.test(path);
}

/** Every input present in the tree, repository-relative and sorted. */
export function listInputs(root: string): string[] {
  const candidates = [
    "scripts/web-preview.ts",
    "scripts/screenshots.mts",
    "src/channels/webShell.ts",
    "web/vite.config.ts",
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

/** The picture files the manifest expects: `<surface>-<theme>.png`. */
export function expectedFiles(): string[] {
  return SURFACES.flatMap((s) => THEMES.map((t) => `${s.name}-${t}.png`));
}

export function renderManifest(inputs: Record<string, string>, now: number): Manifest {
  return { viewport: VIEWPORT, now, inputs };
}

/** Pure: what differs between the tree and the recorded manifest — a changed,
 *  new or removed input, a picture missing or unexpected — one line each. */
export function manifestProblems(current: Record<string, string>, recorded: Manifest, present: string[]): string[] {
  if (typeof recorded?.now !== "number" || typeof recorded.viewport?.width !== "number" || !recorded.inputs) {
    return ["the manifest does not carry the viewport and the fixed clock the pictures were rendered with"];
  }
  const problems: string[] = [];
  const paths = [...new Set([...Object.keys(current), ...Object.keys(recorded.inputs)])].sort();
  for (const path of paths) {
    const now = current[path];
    const was = recorded.inputs[path];
    if (now === undefined) problems.push(`${path} was removed since the screenshots were rendered`);
    else if (was === undefined) problems.push(`${path} is new since the screenshots were rendered`);
    else if (now !== was) problems.push(`${path} changed since the screenshots were rendered`);
  }
  const expected = expectedFiles();
  for (const f of expected) if (!present.includes(f)) problems.push(`${f} is missing`);
  for (const f of present) if (!expected.includes(f)) problems.push(`${f} is not a screenshot the manifest expects`);
  return problems;
}
