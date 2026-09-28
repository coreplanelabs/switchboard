// Isolate pinned cwd operations from the screenshot generator and its workers.
import { readFileSync } from "node:fs";
import { withPinnedDirectory } from "../src/docs/screenshotOutputPinned.js";

const [operation, root, relativeDirectory, name] = process.argv.slice(2);

function ensureDirectory(): void {
  let parent = "";
  for (const part of relativeDirectory.split("/")) {
    const made = withPinnedDirectory(root, parent, (directory) => {
      directory.ensureChild(part);
      return true;
    });
    if (made !== true) throw new Error(`Screenshot output parent missing: ${parent}`);
    parent = parent ? `${parent}/${part}` : part;
  }
  if (withPinnedDirectory(root, relativeDirectory, () => true) !== true) {
    throw new Error(`Screenshot output directory missing: ${relativeDirectory}`);
  }
}

try {
  if (!operation || !root || !relativeDirectory) throw new Error("Missing screenshot output operation");
  if (operation === "list") {
    const names = withPinnedDirectory(root, relativeDirectory, (directory) => directory.names()) ?? [];
    process.stdout.write(JSON.stringify(names));
  } else if (operation === "read") {
    if (!name) throw new Error("Missing screenshot output name");
    const bytes = withPinnedDirectory(root, relativeDirectory, (directory) => directory.read(name));
    if (bytes === undefined) process.exitCode = 2;
    else process.stdout.write(bytes);
  } else if (operation === "publish") {
    if (!name) throw new Error("Missing screenshot output name");
    ensureDirectory();
    withPinnedDirectory(root, relativeDirectory, (directory) => directory.publish(name, readFileSync(0)));
  } else if (operation === "ensure") {
    ensureDirectory();
  } else if (operation === "cleanup") {
    if (!name || (name !== ".png" && name !== ".json")) throw new Error("Invalid screenshot output suffix");
    const expected = new Set(JSON.parse(readFileSync(0, "utf8")) as string[]);
    const removed =
      withPinnedDirectory(root, relativeDirectory, (directory) => {
        const strays = directory.names().filter((file) => file.endsWith(name) && !expected.has(file));
        for (const stray of strays) directory.remove(stray);
        return strays;
      }) ?? [];
    process.stdout.write(JSON.stringify(removed));
  } else {
    throw new Error(`Unknown screenshot output operation: ${operation}`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
