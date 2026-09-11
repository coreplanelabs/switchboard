#!/usr/bin/env node
// The `switchboard` bin: this file hands the process to dist/cli.js, the bundle
// the build writes (build.mts; docs/reference/specs/packaging.md item 1). A
// committed entry rather than the bundle itself, because npm links a bin only
// when its target exists at install time, and the gitignored dist/ does not
// until the build runs: with dist/cli.js as the bin, `npx <the package>` inside
// the checkout — where npx prefers the workspace over the registry — found no
// link and died with `sh: switchboard: command not found`. The published package
// always carries the bundle, so there this is one extra module load; a checkout
// that has not built the package is told what to run.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundle = new URL("../dist/cli.js", import.meta.url);

if (!existsSync(bundle)) {
  console.error(
    `switchboard: ${fileURLToPath(bundle)} is missing — the package is not built. Inside the checkout, npx runs this workspace, not the published package: run \`npm run build -w packages/switchboard\` first, or use the checkout's CLI, \`npm run cli -- <group> <verb> …\`.`,
  );
  process.exit(1);
}

// From here the bundle is the script: its entry claim (src/invokedAsScript.ts)
// and its usage spelling (`programName`, src/cli.ts) read argv[1].
process.argv[1] = fileURLToPath(bundle);
await import(bundle.href);
