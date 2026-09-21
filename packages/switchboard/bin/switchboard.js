#!/usr/bin/env node
// The published `switchboard` bin hands the process to the bundle beside it.
// In a repository checkout npm resolves the package name to this workspace too,
// but an ignored dist/ may be older than source. The checkout therefore never
// trusts dist: operators run the root source script, while a tarball runs only
// the bundle that its build packed.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundle = new URL("../dist/cli.js", import.meta.url);
const checkoutRoot = new URL("../../../", import.meta.url);
const runsFromCheckout =
  existsSync(new URL("project.json", checkoutRoot)) && existsSync(new URL("src/cli.ts", checkoutRoot));

if (runsFromCheckout) {
  console.error(
    "switchboard: npx resolved the package name to this checkout; its ignored dist/ is not authoritative. Run `npm run --silent cli -- <group> <verb> …` from the checkout root instead.",
  );
  process.exit(1);
}

if (!existsSync(bundle)) {
  console.error(`switchboard: ${fileURLToPath(bundle)} is missing — the published package is incomplete.`);
  process.exit(1);
}

// From here the bundle is the script: its entry claim (src/invokedAsScript.ts)
// and its usage spelling (`programName`, src/cli.ts) read argv[1].
process.argv[1] = fileURLToPath(bundle);
await import(bundle.href);
