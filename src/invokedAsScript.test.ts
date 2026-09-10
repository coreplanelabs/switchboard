import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimEntry, invokedAsScript, releaseEntryForTests } from "./invokedAsScript.js";

// Feature: docs/reference/specs/packaging.md item 8 — the entry points run their
// main() only when Node was started on them, and only one of them per process,
// so the CLI's `start` can import the bot's entry — inlined into the same bundle
// file, with the same import.meta.url — without a second bot booting.

let dir: string | undefined;
beforeEach(() => releaseEntryForTests());
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function files() {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "swb-entry-")));
  const target = join(dir, "cli.js");
  const other = join(dir, "index.js");
  writeFileSync(target, "");
  writeFileSync(other, "");
  const link = join(dir, "switchboard");
  symlinkSync(target, link);
  return { target, other, link, url: pathToFileURL(target).href };
}

describe("invokedAsScript", () => {
  it("is true for the file Node was started on, and through a symlink to it (the npm bin); false for another file, a missing one, or no entry at all", () => {
    const { target, other, link, url } = files();
    expect(invokedAsScript(url, target)).toBe(true);
    expect(invokedAsScript(url, link)).toBe(true);
    expect(invokedAsScript(url, other)).toBe(false);
    expect(invokedAsScript(url, join(dir!, "missing.js"))).toBe(false);
    expect(invokedAsScript(url, undefined)).toBe(false);
  });
});

describe("claimEntry", () => {
  it("the first module that is the script claims the process; a second ask with the SAME url (the bot's entry inlined into the CLI's bundle) is refused, so one process boots one main", () => {
    const { target, url } = files();
    expect(claimEntry(url, target)).toBe(true);
    expect(claimEntry(url, target)).toBe(false);
  });

  it("a module that is not the script claims nothing, and leaves the claim for the one that is", () => {
    const { target, other, url } = files();
    expect(claimEntry(pathToFileURL(other).href, target)).toBe(false);
    expect(claimEntry(url, target)).toBe(true);
  });
});
