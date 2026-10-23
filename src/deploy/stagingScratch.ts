import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Keep the frozen config path stable for one staging installation and source. */
export function createStagingScratchDirectory(
  runId: string | undefined,
  source: { account: string; configSource: string },
  root = tmpdir(),
): string {
  if (!runId || !/^[1-9][0-9]{0,19}$/.test(runId)) return mkdtempSync(join(root, "switchboard-staging-"));
  const identity = createHash("sha256")
    .update(JSON.stringify([source.account, source.configSource]))
    .digest("hex");
  const directory = join(root, `switchboard-staging-source-${identity}`);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}
