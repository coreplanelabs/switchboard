import { dirname } from "node:path";

/** Remove the App token store left by older cold sandbox images before a
 * reused sandbox runs any setup, Git command, or model-controlled command. */
export function legacySandboxCredentialScrub(file: string): string {
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(file) || file.split("/").some((part) => part === ".." || part === "."))
    throw new Error("invalid sandbox credential path");
  const parent = dirname(file);
  return [
    "set -eu",
    `test -d '${parent}' && test ! -L '${parent}'`,
    `rm -f -- '${file}'`,
    `test ! -e '${file}' && test ! -L '${file}'`,
    // A blank helper clears Git's multivalue helper chain, including a
    // persisted legacy store helper. The per-command run bearer then wins.
    "git config --global --replace-all credential.helper ''",
  ].join(" && ");
}
