// A `.env` in the working directory, loaded at startup when it exists.
//
// Switchboard reads every credential from the environment (`apiKeyEnv`,
// `tokenEnv`, the Slack tokens) and never from a config file, so on a laptop
// the file that holds them has to reach the environment somehow. Node's own
// loader does it — the same parser as `node --env-file` — and, like that flag,
// it never overrides a variable the shell already set: an exported value wins
// over the file's. In a container there is no file and nothing happens; the
// platform's secrets are the environment.

import { loadEnvFile } from "node:process";

/** Load `path` — resolved against the working directory, like every relative
 *  path Node opens — into the environment when it exists. Returns whether a file was
 *  loaded. A missing file is the normal case everywhere but a laptop and is not
 *  an error; any other failure (unreadable, a directory) is raised as-is. */
export function loadEnvFileIfPresent(path = ".env"): boolean {
  try {
    loadEnvFile(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
