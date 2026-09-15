import { describe, expect, it } from "vitest";
import { CODING_REACH, NONE_REACH, PI_TOOL_BUNDLES, READ_REACH, judgeToolCall, reachFor } from "./toolRules.js";

// A preset's tool rules under pi (docs/reference/specs/harness-pi.md items 7
// and 10): which calls are refused by name, and which name a reach the run's
// identity does not have at all — a write run's reach is the coding preset's,
// a read run's holds no write bundle and never pushes or writes to GitHub. The
// load harness previews the spike's calls against them; the pi harness's gate
// refuses with them. The judge never executes anything.

const ctx = { identity: "write" as const, checkout: "/work/repo", branch: "load-pi/test-gap-1" };
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
      reason: "submit_verdict is the `verdict` bundle, outside the write identity's reach",
    });
    expect(judgeToolCall("powershell", { command: "dir" }, ctx)).toEqual({
      verdict: "outside-profile",
      reason: "powershell is not in any bundle the write identity reaches",
    });
  });
  it("the reach is the identity's: write is the coding preset's, read holds no write bundle, none holds no bundle of pi's own tools at all", () => {
    expect(reachFor("write")).toBe(CODING_REACH);
    expect(reachFor("read")).toBe(READ_REACH);
    expect(reachFor("none")).toBe(NONE_REACH);
    for (const bundle of ["write-files", "github-write", "pr"]) expect(READ_REACH.has(bundle), bundle).toBe(false);
    for (const bundle of ["shell", "files", "web", "search", "github-read", "verdict"])
      expect(READ_REACH.has(bundle), bundle).toBe(true);
    expect(NONE_REACH.size).toBe(0);
  });
});

// docs/reference/specs/harness-pi.md item 12: a run without a workspace
// (identity none: the general, research and conductor presets) has none of
// pi's own tools, so every one of them a pi somehow asks for is refused by
// name, before any rule about what the call does is consulted: the run has
// no checkout for a path to be inside of and no shell for a command to run in.
describe("judgeToolCall: a run without a workspace (identity none)", () => {
  const none = { identity: "none" as const, checkout: "/workspace" };
  it("refuses every one of pi's own tools by name (the shell, the reads, the writes), whatever the call asks", () => {
    for (const [tool, input] of [
      ["bash", { command: "ls" }],
      ["read", { path: "README.md" }],
      ["grep", { pattern: "x" }],
      ["find", {}],
      ["ls", {}],
      ["edit", { path: "src/x.ts" }],
      ["write", { path: "src/x.ts", content: "" }],
    ] as const) {
      const bundle = PI_TOOL_BUNDLES[tool];
      expect(judgeToolCall(tool, input, none), tool).toEqual({
        verdict: "outside-profile",
        reason: `${tool} is the \`${bundle}\` bundle: a run without a workspace (identity none) has none of pi's own tools`,
      });
    }
  });
  it("the load driver's terminal tools and an unknown tool are outside the profile too", () => {
    expect(judgeToolCall("submit_verdict", { verdict: "approve" }, none).verdict).toBe("outside-profile");
    expect(judgeToolCall("submit_pr_description", { title: "x" }, none).verdict).toBe("outside-profile");
    expect(judgeToolCall("powershell", { command: "dir" }, none)).toEqual({
      verdict: "outside-profile",
      reason: "powershell is not in any bundle the none identity reaches",
    });
  });
});

// docs/reference/specs/harness-pi.md item 10 — the review preset on the
// harness: a read-identity run's pi holds no `edit` or `write`, and its shell
// never pushes or writes to GitHub — the same read-only rule the resident
// enforces with a read-only worktree and no write token, said in pi's terms.
describe("judgeToolCall — a read-identity run", () => {
  const read = {
    identity: "read" as const,
    checkout: "/work/repo",
    branch: "fix/the-pr-head",
    protectedBranches: ["main"],
  };
  const rbash = (command: string) => judgeToolCall("bash", { command }, read);
  it("pi's edit and write are outside the reach; a submit_pr_description too; the reads and the verdict are in it", () => {
    expect(judgeToolCall("edit", { path: "src/x.ts" }, read)).toEqual({
      verdict: "outside-profile",
      reason: "edit is the `write-files` bundle, outside the read identity's reach",
    });
    expect(judgeToolCall("write", { path: "src/x.ts", content: "" }, read)).toEqual({
      verdict: "outside-profile",
      reason: "write is the `write-files` bundle, outside the read identity's reach",
    });
    expect(judgeToolCall("submit_pr_description", { title: "x" }, read)).toEqual({
      verdict: "outside-profile",
      reason: "submit_pr_description is the `pr` bundle, outside the read identity's reach",
    });
    for (const tool of ["read", "grep", "find", "ls"]) {
      expect(judgeToolCall(tool, { path: "src" }, read), tool).toEqual({ verdict: "allowed" });
    }
    expect(judgeToolCall("submit_verdict", { verdict: "approve" }, read)).toEqual({ verdict: "allowed" });
  });
  it("never pushes — not even its own branch — and never writes to GitHub by CLI or API; reads of both are allowed", () => {
    const push = { verdict: "refused", reason: "read-only — a read-identity run never pushes" };
    expect(rbash("git push origin fix/the-pr-head")).toEqual(push);
    expect(rbash("git push")).toEqual(push);
    expect(rbash("git add -A && git commit -m x && git push -u origin HEAD")).toEqual(push);
    // git's own options between the two words are the same push
    expect(rbash("git -C /work/repo push origin fix/the-pr-head")).toEqual(push);
    expect(rbash("git --work-tree=/work/repo --git-dir=/work/repo/.git push")).toEqual(push);
    expect(rbash("git -c push.default=current --no-pager push")).toEqual(push);
    expect(rbash("git -C /work/repo log --oneline -3")).toEqual({ verdict: "allowed" });
    const write = { verdict: "refused", reason: "read-only — a read-identity run never writes to GitHub" };
    expect(rbash("gh pr comment 12 --body 'LGTM'")).toEqual(write);
    expect(rbash("gh pr edit 12 --title x")).toEqual(write);
    expect(rbash("gh issue comment 3 -b done")).toEqual(write);
    expect(rbash("gh api repos/o/r/issues/12/comments -f body=hi")).toEqual(write);
    expect(rbash("gh api -X PATCH repos/o/r/pulls/12 -F draft=false")).toEqual(write);
    expect(rbash("gh api --method DELETE repos/o/r/issues/comments/9")).toEqual(write);
    expect(rbash('curl -X POST https://api.github.com/repos/o/r/issues/12/comments -d \'{"body":"x"}\'')).toEqual(
      write,
    );
    expect(rbash("curl --request PATCH https://api.github.com/repos/o/r/pulls/12 --data '{}'")).toEqual(write);
    expect(rbash("curl https://api.github.com/repos/o/r/pulls/12 --json '{}'")).toEqual(write);
    // merging or approving is refused before the read-only rule says its word
    expect(rbash("gh pr merge 12 --squash")).toEqual({
      verdict: "refused",
      reason: "merge/approve — a coding run never merges or approves a pull request",
    });
    for (const cmd of [
      "git rev-parse HEAD",
      "git diff origin/main...HEAD",
      "git log --oneline origin/main..HEAD",
      "gh pr view 12 --json files",
      "gh api repos/o/r/pulls/12",
      "gh api repos/o/r/pulls/12/files --paginate",
      "curl -s https://api.github.com/repos/o/r/pulls/12",
      "curl -s -H 'Accept: application/vnd.github+json' https://api.github.com/repos/o/r/pulls/12/files",
      "npm run --silent specs:coverage -- --changed origin/main...HEAD --test-guard",
    ]) {
      expect(rbash(cmd), cmd).toEqual({ verdict: "allowed" });
    }
  });
  it("a write run's pushes and GitHub writes are judged by the coding rules alone — nothing here reaches them", () => {
    expect(bash("gh pr comment 12 --body 'done'")).toEqual({ verdict: "allowed" });
    expect(bash("gh api repos/o/r/issues/12/comments -f body=hi")).toEqual({ verdict: "allowed" });
    expect(bash("git push -u origin load-pi/test-gap-1")).toEqual({ verdict: "allowed" });
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
    expect(bash("git -C /work/repo push origin main")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `main`, not the run's branch load-pi/test-gap-1",
    });
    expect(bash("git -c user.name=x push -u origin load-pi/test-gap-1")).toEqual({ verdict: "allowed" });
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
  const own = { identity: "write" as const, checkout: "/work/repo", protectedBranches: ["main", "release/1.2"] };
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
