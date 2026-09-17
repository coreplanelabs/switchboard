// The installed `@cloudflare/sandbox` dist, as text, for the tests that pin the
// pinned SDK's own wordings (residentRefresh.test.ts here; threadErr.test.ts
// under deploy/cloudflare-resident). Its exports map hides package.json, and
// the package imports `cloudflare:workers`, so plain Node reads the dist rather
// than loading it. One reader, so the next SDK layout change is met once.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export function installedSdkSource(): string {
  const require = createRequire(import.meta.url);
  const dist = path.dirname(require.resolve("@cloudflare/sandbox"));
  return readdirSync(dist)
    .filter((f) => f.endsWith(".js"))
    .map((f) => readFileSync(path.join(dist, f), "utf8"))
    .join("\n");
}
