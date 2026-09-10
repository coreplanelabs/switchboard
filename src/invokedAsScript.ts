import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * True when the module at `moduleUrl` is the script Node was started with —
 * through a symlink too (the `switchboard` bin npm links to `dist/cli.js`:
 * `argv[1]` is the link, `import.meta.url` the target) — never when merely
 * imported. Pure over its arguments; `claimEntry` is what the entry points use.
 */
export function invokedAsScript(moduleUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

let claimed = false;

/**
 * One process, one entry. The two entry points (src/index.ts, src/cli.ts) run
 * their `main()` only when this answers true: the module is the script Node was
 * started with AND no module has claimed the process before it. The second
 * condition is what a bundle needs — esbuild inlines the bot's entry into the
 * CLI's one file, so inside `dist/cli.js` both modules see the SAME
 * `import.meta.url`, the bin's; the CLI evaluates first and claims the process,
 * and the bot's module, imported later by `start`, finds it taken and exports
 * `runBot` instead of starting a second bot on the same port. A module that is
 * not the script never claims anything, so a later one still can.
 */
export function claimEntry(moduleUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (claimed || !invokedAsScript(moduleUrl, entry)) return false;
  claimed = true;
  return true;
}

/** Test seam: forget the claim, so one test file can play several processes. */
export function releaseEntryForTests(): void {
  claimed = false;
}
