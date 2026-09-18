// The installed pi registry as the card's catalog (record 0052): the
// Node-side reader of the JSON files `@earendil-works/pi-ai` ships under
// `providers/data/`, read once per process. It lives apart from
// ./modelRegistry.ts on purpose: that module carries the seam's types and is
// reached (through the run events' card type) by the Workers' typechecks,
// which compile without Node built-ins — the file read stays here, in the
// bot's own wiring, and tests hand `resolveModelCard` an in-memory table.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { piWireOf, type ModelRegistry, type RegistryFile } from "./modelRegistry.js";

/** The directory pi's registry files ship in, beside the installed library's
 *  entry point. The library's `exports` map carries only the `import`
 *  condition, so `createRequire(...).resolve` cannot see it — `import.meta
 *  .resolve` can. A runtime that hides `import.meta.resolve` (a bundler, an
 *  older Node) falls back to walking up from this file to the installed copy. */
function registryDir(): string {
  try {
    const entry = import.meta.resolve("@earendil-works/pi-ai");
    return join(dirname(fileURLToPath(entry)), "providers", "data");
  } catch {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const candidate = join(dir, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "data");
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) return candidate;
      dir = parent;
    }
  }
}

let fileCache: Map<string, RegistryFile | undefined> | undefined;

function loadFiles(): Map<string, RegistryFile | undefined> {
  if (fileCache) return fileCache;
  const dir = registryDir();
  const cache = new Map<string, RegistryFile | undefined>();
  let names: string[];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .map((n) => n.slice(0, -".json".length));
  } catch {
    fileCache = cache;
    return cache;
  }
  for (const name of names) {
    try {
      cache.set(name, JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8")) as RegistryFile);
    } catch {
      cache.set(name, undefined);
    }
  }
  fileCache = cache;
  return cache;
}

/** The installed library's registry as a `ModelRegistry`. Files load once per
 *  process; a name the library does not ship reads as no card. */
export const installedModelRegistry: ModelRegistry = {
  file(catalog) {
    return loadFiles().get(catalog);
  },
  names() {
    return [...loadFiles().keys()].sort();
  },
  card(catalog, wire, model) {
    if (!catalog || catalog === "none") return undefined;
    const file = loadFiles().get(catalog);
    if (!file) return undefined;
    const preferred = file[piWireOf(wire)]?.[model];
    if (preferred) return preferred;
    for (const cards of Object.values(file)) {
      const found = cards[model];
      if (found) return found;
    }
    return undefined;
  },
};

/** Whether a catalog name is one the installed library ships (or `none`). The
 *  config validator holds a block's `catalog` to this by name. */
export function catalogExists(name: string): boolean {
  if (name === "none") return true;
  return loadFiles().has(name);
}
