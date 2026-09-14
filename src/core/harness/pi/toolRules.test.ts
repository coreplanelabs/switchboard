import { describe, expect, it } from "vitest";
import { CODING_REACH, PI_TOOL_BUNDLES, judgeToolCall } from "./toolRules.js";

// The coding preset's tool rules under pi (docs/reference/specs/harness-pi.md):
// which calls are refused by name, and which name a reach the coding preset
// does not have at all. The load harness previews the spike's calls against
// them; the pi harness's gate refuses with them. The judge never executes
// anything.

const ctx = { checkout: "/work/repo", branch: "load-pi/test-gap-1" };
const bash = (command: string) => judgeToolCall("bash", { command }, ctx);

describe("judgeToolCall — bundles", () => {
  it("maps pi's built-in tools onto the coding preset's reach and allows them", () => {
    for (const tool of ["read", "grep", "find", "ls"]) expect(PI_TOOL_BUNDLES[tool]).toBe("files");
    for (const tool of ["write", "edit"]) expect(PI_TOOL_BUNDLES[tool]).toBe("write-files");
    expect(PI_TOOL_BUNDLES.bash).toBe("shell");
    expect(judgeToolCall("read", { path: "README.md" }, ctx)).toEqual({ verdict: "allowed" });
    expect(judgeToolCall("ls", {}, ctx)).toEqual({ verdict: "allowed" });
    expect(judgeToolCall("submit_pr_description", { title: "x" }, ctx)).toEqual({ verdict: "allowed" });
  });
  it("a tool whose bundle the coding preset lacks, or an unknown tool, is outside the profile", () => {
    expect(CODING_REACH.has("verdict")).toBe(false);
    expect(judgeToolCall("submit_verdict", { verdict: "approve" }, ctx)).toEqual({
      verdict: "outside-profile",
      reason: "submit_verdict is the `verdict` bundle; the coding preset's reach does not include it",
    });
    expect(judgeToolCall("powershell", { command: "dir" }, ctx)).toEqual({
      verdict: "outside-profile",
      reason: "powershell is not in any bundle the coding preset reaches",
    });
  });
});

describe("judgeToolCall — bash", () => {
  it("allows ordinary commands and a push of the run's own branch to origin", () => {
    expect(bash("npx vitest run src/load/reasons.test.ts")).toEqual({ verdict: "allowed" });
    expect(bash("git push -u origin load-pi/test-gap-1")).toEqual({ verdict: "allowed" });
    expect(bash("git push --force-with-lease origin HEAD:load-pi/test-gap-1")).toEqual({ verdict: "allowed" });
    expect(bash("git push")).toEqual({ verdict: "allowed" });
  });
  it("HEAD as the destination is the run's branch — the driver checked it out", () => {
    expect(bash("git push origin HEAD")).toEqual({ verdict: "allowed" });
    expect(bash("git push -u origin HEAD")).toEqual({ verdict: "allowed" });
    expect(bash("git push origin +HEAD")).toEqual({ verdict: "allowed" });
    expect(bash("git push origin HEAD:main")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `main`, not the run's branch load-pi/test-gap-1",
    });
  });
  it("refuses a push to another remote or another branch — repo:use outside the run's grant", () => {
    expect(bash("git push upstream load-pi/test-gap-1")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to remote `upstream`, not the run's repository (origin)",
    });
    expect(bash("git push origin main")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `main`, not the run's branch load-pi/test-gap-1",
    });
    expect(bash("git checkout -b fix && git push origin fix")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `fix`, not the run's branch load-pi/test-gap-1",
    });
  });
  it("refuses merging or approving a pull request, by CLI or by API — never the agent's to do", () => {
    expect(bash("gh pr merge 12 --squash")).toEqual({
      verdict: "refused",
      reason: "merge/approve — a coding run never merges or approves a pull request",
    });
    expect(bash("gh pr review 12 --approve")).toEqual({
      verdict: "refused",
      reason: "merge/approve — a coding run never merges or approves a pull request",
    });
    expect(bash("curl -X PUT https://api.github.com/repos/o/r/pulls/12/merge")).toEqual({
      verdict: "refused",
      reason: "merge/approve — a coding run never merges or approves a pull request",
    });
    expect(bash('curl -X POST https://api.github.com/repos/o/r/pulls/12/reviews -d \'{"event":"APPROVE"}\'')).toEqual({
      verdict: "refused",
      reason: "merge/approve — a coding run never merges or approves a pull request",
    });
    expect(bash("gh pr view 12")).toEqual({ verdict: "allowed" });
  });
  it("refuses reading credential material the executor keeps beside the worktree", () => {
    expect(bash("cat .git/github-credentials")).toEqual({
      verdict: "refused",
      reason: "credential — reads the executor's credential store",
    });
    expect(bash("cat ~/.git-credentials | head")).toEqual({
      verdict: "refused",
      reason: "credential — reads the executor's credential store",
    });
    expect(bash("printenv | grep -i key")).toEqual({
      verdict: "refused",
      reason: "credential — dumps the process environment",
    });
    expect(bash("git config credential.helper")).toEqual({ verdict: "allowed" });
  });
  it("an environment dump is the whole environment, however it is asked for — not a prefix or one variable", () => {
    const dump = { verdict: "refused", reason: "credential — dumps the process environment" };
    for (const cmd of [
      "env",
      "env -0 | sort",
      "printenv",
      "cd src && printenv",
      "export -p",
      "declare -px",
      "set",
      "cat /proc/self/environ",
      "node -e 'console.log(process.env)'",
    ]) {
      expect(bash(cmd), cmd).toEqual(dump);
    }
    for (const cmd of [
      "env CI=1 npm test",
      "env -u FOO npm test",
      "set -e",
      "set -o pipefail",
      "printenv HOME",
      "node -e 'console.log(process.env.HOME)'",
      "grep -rn ANTHROPIC_API_KEY src/",
      "export FOO=bar",
    ]) {
      expect(bash(cmd), cmd).toEqual({ verdict: "allowed" });
    }
  });
  it("expanding or printing a credential-named variable is refused", () => {
    const expand = { verdict: "refused", reason: "credential — expands a credential variable" };
    expect(bash('curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user')).toEqual(expand);
    expect(bash("echo ${ANTHROPIC_API_KEY}")).toEqual(expand);
    expect(bash("printenv OPENAI_API_KEY")).toEqual(expand);
    expect(bash("echo $HOME $PATH")).toEqual({ verdict: "allowed" });
  });
  it("a non-string command is refused as malformed rather than allowed by accident", () => {
    expect(judgeToolCall("bash", { command: 42 }, ctx)).toEqual({
      verdict: "refused",
      reason: "malformed — bash without a string command",
    });
  });
});

describe("judgeToolCall — a run that names its own branch", () => {
  const own = { checkout: "/work/repo", protectedBranches: ["main", "release/1.2"] };
  it("may push any branch to origin but the protected ones — the base its pull request targets", () => {
    expect(judgeToolCall("bash", { command: "git push -u origin feat/login" }, own)).toEqual({ verdict: "allowed" });
    expect(judgeToolCall("bash", { command: "git push origin HEAD" }, own)).toEqual({ verdict: "allowed" });
    expect(judgeToolCall("bash", { command: "git push" }, own)).toEqual({ verdict: "allowed" });
    expect(judgeToolCall("bash", { command: "git push origin main" }, own)).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `main`, the branch this run's pull request targets; push your own branch",
    });
    expect(judgeToolCall("bash", { command: "git push origin HEAD:refs/heads/release/1.2" }, own)).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `release/1.2`, the branch this run's pull request targets; push your own branch",
    });
    expect(judgeToolCall("bash", { command: "git push upstream feat/x" }, own)).toEqual({
      verdict: "refused",
      reason: "repo:use — push to remote `upstream`, not the run's repository (origin)",
    });
  });
});

describe("judgeToolCall — file tools", () => {
  it("allows paths inside the checkout, relative or absolute", () => {
    expect(judgeToolCall("write", { path: "src/x.ts", content: "" }, ctx)).toEqual({ verdict: "allowed" });
    expect(judgeToolCall("edit", { path: "/work/repo/src/x.ts" }, ctx)).toEqual({ verdict: "allowed" });
    expect(judgeToolCall("read", { path: "./docs/../README.md" }, ctx)).toEqual({ verdict: "allowed" });
  });
  it("refuses a path that leaves the checkout — the files bundles are the worktree", () => {
    expect(judgeToolCall("write", { path: "../other/x.ts", content: "" }, ctx)).toEqual({
      verdict: "refused",
      reason: "path — `../other/x.ts` resolves outside the checkout",
    });
    expect(judgeToolCall("read", { path: "/etc/passwd" }, ctx)).toEqual({
      verdict: "refused",
      reason: "path — `/etc/passwd` resolves outside the checkout",
    });
    expect(judgeToolCall("read", { path: "/work/repo-2/x" }, ctx)).toEqual({
      verdict: "refused",
      reason: "path — `/work/repo-2/x` resolves outside the checkout",
    });
  });
  it("refuses the credential file even inside the checkout", () => {
    expect(judgeToolCall("read", { path: ".git/github-credentials" }, ctx)).toEqual({
      verdict: "refused",
      reason: "credential — reads the executor's credential store",
    });
  });
  it("a search tool without a path searches the checkout and is allowed", () => {
    expect(judgeToolCall("grep", { pattern: "reasonOf" }, ctx)).toEqual({ verdict: "allowed" });
    expect(judgeToolCall("find", { pattern: "*.ts", path: "src" }, ctx)).toEqual({ verdict: "allowed" });
  });
});
