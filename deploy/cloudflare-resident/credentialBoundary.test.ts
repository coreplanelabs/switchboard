import { describe, expect, it } from "vitest";
import { methodOf, readSource } from "./testing/sourceScan";

const source = readSource("worker.ts");
const resident = source.slice(source.indexOf("export class ResidentDO"));
const method = (name: string) => methodOf(resident, name) ?? "";

describe("resident model credential boundary", () => {
  it("refuses a writable attach or command without a run-bound Git door", () => {
    expect(method("attachThreadBody")).toMatch(/if \(!readonly && !githubDoor\)[\s\S]*?status: 403/);
    expect(method("execThreadBody")).toMatch(
      /if \(!binding\.readonly && !binding\.githubDoorHost\)[\s\S]*?status: 403/,
    );
    expect(method("execThreadBody")).toMatch(/env\?\.GH_HOST !== binding\.githubDoorHost/);
  });

  it("scrubs a previous App token file on every door attach and never rewrites one for model use", () => {
    expect(method("attachThreadCreate")).toMatch(/mode\.scrubCredentials \|\| githubDoor/);
    expect(method("attachThreadCreate")).toMatch(/this\.scrubThreadCredentials\(binding\)/);
    expect(method("attachThreadCreate").indexOf("this.scrubThreadCredentials(binding)")).toBeLessThan(
      method("attachThreadCreate").indexOf("this.materializeThreadDeps("),
    );
    expect(method("attachThreadCreate")).not.toMatch(/writeThreadCredentials/);
    expect(source).not.toMatch(/private async writeThreadCredentials\(/);
    expect(method("execThreadBody")).not.toMatch(/mintRepoScopedToken/);
    const scrub = method("scrubThreadCredentialFiles");
    expect(scrub).toContain("legacyCredentialScrubCommand(binding.worktreePath, `/workspace/.stage-${binding.user}`)");
    expect(method("attachThreadCreate").indexOf("this.scrubThreadCredentialFiles(binding)")).toBeLessThan(
      method("attachThreadCreate").indexOf("this.ensureThreadWorktree("),
    );
    expect(method("scrubThreadCredentials").indexOf("this.scrubThreadCredentialFiles(binding)")).toBeLessThan(
      method("scrubThreadCredentials").indexOf("this.threadRunOk("),
    );
  });
});
