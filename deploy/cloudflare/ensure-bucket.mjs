#!/usr/bin/env node
// Create the R2 buckets this Worker's wrangler.jsonc binds, before `wrangler
// deploy` validates the bindings (docs/reference/specs/execution.md item 20,
// record 0033). wrangler refuses a deploy whose `r2_buckets` names a bucket
// that does not exist, and creating one by hand is the step an installation
// forgets; `npm run deploy` runs this after the preflight. Idempotent: a bucket
// that already exists is success (wrangler's own words for it are matched),
// any other refusal is wrangler's, verbatim, and the deploy stops.
//
// Dependency-free Node. `bucketNamesOf()` and `decide()` are pure and
// unit-tested (ensure-bucket.test.mjs); `main()` only does I/O around them.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Every `bucket_name` the rendered config binds — the template renders the
 *  block only when the deployment profile names a bucket, so an installation
 *  without artifacts has none here and this script does nothing. */
export function bucketNamesOf(wranglerJsonc) {
  const names = [];
  for (const m of wranglerJsonc.matchAll(/"bucket_name"\s*:\s*"([^"]+)"/g)) names.push(m[1]);
  return [...new Set(names)];
}

/** Pure: what `wrangler r2 bucket create <name>` meant. Exit 0 → created; a
 *  non-zero exit whose output says the bucket exists → already there (success);
 *  anything else → wrangler's refusal, to print and stop on. */
export function decide(name, code, output) {
  if (code === 0) return { ok: true, kind: "created", name };
  if (/already exists|10004/i.test(output)) return { ok: true, kind: "exists", name };
  return { ok: false, name, reason: output.trim() || `wrangler exited ${code}` };
}

function wrangler(args, cwd) {
  return new Promise((resolve) => {
    execFile("npx", ["wrangler", ...args], { cwd, env: process.env, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const code = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
      resolve({ code, output: `${stdout ?? ""}\n${stderr ?? ""}` });
    });
  });
}

export async function main(dir = dirname(fileURLToPath(import.meta.url))) {
  let rendered;
  try {
    rendered = readFileSync(join(dir, "wrangler.jsonc"), "utf8");
  } catch {
    console.error("[ensure-bucket] wrangler.jsonc is not rendered — run `npm run deploy:gen` first");
    return 2;
  }
  const names = bucketNamesOf(rendered);
  if (names.length === 0) {
    console.log("[ensure-bucket] no R2 buckets bound — nothing to create");
    return 0;
  }
  for (const name of names) {
    const r = await wrangler(["r2", "bucket", "create", name], dir);
    const d = decide(name, r.code, r.output);
    if (!d.ok) {
      console.error(`[ensure-bucket] could not create bucket ${name}:\n${d.reason}`);
      return 1;
    }
    console.log(`[ensure-bucket] bucket ${name} ${d.kind === "created" ? "created" : "already exists"}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
