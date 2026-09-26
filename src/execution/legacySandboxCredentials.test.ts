import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { legacySandboxCredentialScrub } from "./legacySandboxCredentials.js";

describe("legacy cold sandbox credential cleanup", () => {
  it("removes the old token file and resets the persisted Git helper before a reused sandbox runs", () => {
    const home = mkdtempSync(join(tmpdir(), "swb-legacy-"));
    const file = join(home, ".git-credentials");
    writeFileSync(file, "old-token");
    const env = { ...process.env, HOME: home };
    execFileSync("git", ["config", "--global", "credential.helper", `store --file=${file}`], { env });
    execFileSync("sh", ["-c", legacySandboxCredentialScrub(file)], { env });
    expect(existsSync(file)).toBe(false);
    expect(
      execFileSync("git", ["config", "--global", "--get-all", "credential.helper"], { env, encoding: "utf8" }),
    ).toBe("\n");
  });

  it("unlinks a credential-file symlink without reading or changing its target", () => {
    const home = mkdtempSync(join(tmpdir(), "swb-legacy-"));
    const outside = join(dirname(home), "swb-legacy-target-" + home.split("-").at(-1));
    writeFileSync(outside, "outside-token");
    const file = join(home, ".git-credentials");
    symlinkSync(outside, file);
    execFileSync("sh", ["-c", legacySandboxCredentialScrub(file)], { env: { ...process.env, HOME: home } });
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("outside-token");
  });

  it("refuses a symlinked parent and leaves the target file untouched", () => {
    const home = mkdtempSync(join(tmpdir(), "swb-legacy-"));
    const outside = mkdtempSync(join(tmpdir(), "swb-legacy-outside-"));
    const file = join(outside, ".git-credentials");
    writeFileSync(file, "outside-token");
    const link = join(home, "workspace");
    symlinkSync(outside, link);
    expect(() =>
      execFileSync("sh", ["-c", legacySandboxCredentialScrub(join(link, ".git-credentials"))], {
        env: { ...process.env, HOME: home },
      }),
    ).toThrow();
    expect(readFileSync(file, "utf8")).toBe("outside-token");
  });
});
