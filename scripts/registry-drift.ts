// The registry drift gate (docs/reference/specs/model-proxy.md item 12,
// record 0052): every model ref the example configuration names must still
// resolve against the pinned pi registry, so a pi bump that drops a card fails
// `check:consistency` by name instead of surfacing on a run. The decisions are
// `configuredModelRefs` + `registryDrift` in src/core/commands/providers.ts,
// unit-tested there; this file only reads the tree.
//
//   npm run check:registry-drift
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { configuredModelRefs, registryDrift } from "../src/core/commands/providers.js";
import { installedModelRegistry } from "../src/core/installedModelRegistry.js";
import type { ProviderConfig } from "../src/core/provider.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function main(): number {
  const cfg = YAML.parse(readFileSync(join(ROOT, "config", "config.example.yaml"), "utf8")) as {
    providers?: Record<string, ProviderConfig>;
    defaults?: { models?: Record<string, string> };
  };
  const refs = configuredModelRefs(cfg);
  const lines = registryDrift(refs, cfg.providers ?? {}, installedModelRegistry);
  if (lines.length > 0) {
    for (const line of lines) console.error(`check:registry-drift ${line}`);
    return 1;
  }
  console.log(
    `check:registry-drift ok — ${refs.length} model ref(s) from config/config.example.yaml resolve against the pinned registry`,
  );
  return 0;
}

process.exit(main());
