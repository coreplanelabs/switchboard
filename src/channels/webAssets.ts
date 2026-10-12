import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ShellAssets } from "./webShell.js";

// Serving for the web app's built assets (web/dist): the Vite manifest names
// the hashed entry files the shell references, and every file under
// dist/assets is loaded into memory at startup and served from the map — no
// filesystem access at request time, so a traversal-shaped path can only miss
// the map and 404. Hashed names make the files immutable-cacheable, which is
// what pays for the HTML being `no-store`.

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  css?: string[];
  imports?: string[];
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot === -1 ? undefined : CONTENT_TYPES[path.slice(dot)]) ?? "application/octet-stream";
}

/** Where the tree keeps the dashboard's built bundle, relative to the package
 *  root: `web/dist` in a checkout (`npm run build -w web`), `/app/web/dist` in
 *  the image (the Dockerfile copies it), `dist/assets/web/dist` in the npm
 *  package (its build copies it — packages/switchboard/build.mts). */
export const WEB_DIST_DIR = "web/dist";

/** The directory the bot loads the bundle from: `SWITCHBOARD_WEB_DIST` when set (a
 *  local build elsewhere), else `web/dist` under the package root (src/packageRoot.ts)
 *  — never the working directory, which from the package is the operator's. */
export function webDistDir(env: Record<string, string | undefined>, packageRoot: string): string {
  return env.SWITCHBOARD_WEB_DIST ?? join(packageRoot, WEB_DIST_DIR);
}

export interface WebAssets {
  /** The entry's hashed js/css paths, for the shell. */
  entry: ShellAssets;
  /** node:http handler for GET/HEAD /assets/*. Returns false for other paths. */
  serve(req: HttpRequest, res: ServerResponse): boolean;
}

/**
 * Load the built web app from `distDir` (web/dist): the manifest picks the
 * entry, and every file under `assets/` is cached in memory. Throws when the
 * manifest is missing — the server must not start half-blind: run
 * `npm run build` in web/ first (the Docker build does).
 */
export function loadWebAssets(distDir: string, entryKey = "green/main.ts"): WebAssets {
  let manifest: Record<string, ManifestChunk>;
  try {
    manifest = JSON.parse(readFileSync(join(distDir, ".vite", "manifest.json"), "utf8")) as Record<
      string,
      ManifestChunk
    >;
  } catch (err) {
    throw new Error(
      `web app manifest not found under ${distDir} — build it first (npm run build in web/): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const entryChunk = manifest[entryKey];
  if (!entryChunk?.isEntry) throw new Error(`web app manifest under ${distDir} has no entry ${entryKey}`);
  const css = new Set<string>();
  const visited = new Set<string>();
  function collectStyles(key: string): void {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) throw new Error(`web app manifest under ${distDir} has no imported chunk ${key}`);
    for (const dependency of chunk.imports ?? []) collectStyles(dependency);
    for (const path of chunk.css ?? []) css.add(`/${path}`);
  }
  collectStyles(entryKey);
  const entry: ShellAssets = {
    js: `/${entryChunk.file}`,
    css: [...css],
  };

  // Every built file, keyed by its URL path. readdirSync at startup only.
  const files = new Map<string, Buffer>();
  const assetsDir = join(distDir, "assets");
  for (const name of readdirSync(assetsDir)) {
    const full = join(assetsDir, name);
    // Inspect and read one no-follow descriptor. A replacement of its pathname
    // cannot substitute another file after validation; non-files stay uncached.
    const descriptor = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      if (fstatSync(descriptor).isFile()) files.set(`/assets/${name}`, readFileSync(descriptor));
    } finally {
      closeSync(descriptor);
    }
  }

  const serve = (req: HttpRequest, res: ServerResponse): boolean => {
    const path = (req.url ?? "/").split("?")[0];
    if (!path.startsWith("/assets/")) return false;
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      res.end("method not allowed");
      return true;
    }
    const body = files.get(path);
    if (!body) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return true;
    }
    res.writeHead(200, {
      "content-type": contentTypeFor(path),
      "content-length": String(body.byteLength),
      "cache-control": "public, max-age=31536000, immutable",
    });
    if (method === "HEAD") res.end();
    else res.end(body);
    return true;
  };

  return { entry, serve };
}
