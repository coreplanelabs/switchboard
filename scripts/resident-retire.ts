#!/usr/bin/env node
import { runResidentRetire } from "../src/residentRetireCli.js";
import { processSecrets } from "../src/secrets.js";

runResidentRetire(process.argv.slice(2), {
  fetcher: fetch,
  readToken: processSecrets.named("RESIDENT_READ_TOKEN")?.reveal() ?? "",
  adminToken: processSecrets.named("RESIDENT_ADMIN_TOKEN")?.reveal(),
  write: (line) => process.stdout.write(`${line}\n`),
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "resident retirement failed"}\n`);
  process.exitCode = 1;
});
