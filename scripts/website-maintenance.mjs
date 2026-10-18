// One switch keeps site builds, publication and screenshot upkeep paused together.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const websiteMaintenanceEnabled =
  JSON.parse(readFileSync(new URL("../project.json", import.meta.url), "utf8")).websiteMaintenance === true;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!websiteMaintenanceEnabled) {
    console.log("Website maintenance paused; skipped. See CONTRIBUTING.md to enable and refresh it.");
  } else {
    const [command, ...args] = process.argv.slice(2);
    if (!command) {
      console.error("Website maintenance requires a command.");
      process.exit(1);
    }
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
}
