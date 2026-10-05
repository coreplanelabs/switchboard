import { describe, expect, it } from "vitest";
import {
  CODING_REACH,
  NONE_REACH,
  PI_TOOL_BUNDLES,
  READ_REACH,
  judgeToolCall,
  literalPushSource,
  reachFor,
  type ToolRuleContext,
} from "./toolRules.js";
import { commandPastLoopEndRefusal } from "../windDown.js";

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

describe("judgeToolCall — output scratch", () => {
  it("allows only read within the bound output root for both workspace identities", () => {
    for (const identity of ["read", "write"] as const) {
      const rules = { ...ctx, identity, outputDir: "/var/tmp/run-one/output" };
      expect(judgeToolCall("read", { path: "/var/tmp/run-one/output/process/log" }, rules).verdict).toBe("allowed");
      for (const path of [
        "/tmp/pi-bash-output.log",
        "/var/tmp/run-two/output/log",
        "/var/tmp/run-one/agent/models.json",
        "/var/tmp/run-one/output/../agent/models.json",
        "/var/tmp/run-one/output-other/log",
      ])
        expect(judgeToolCall("read", { path }, rules).verdict).toBe("refused");
      for (const tool of ["write", "edit", "ls", "grep", "find"])
        expect(judgeToolCall(tool, { path: "/var/tmp/run-one/output/process/log" }, rules).verdict).not.toBe("allowed");
    }
    expect(judgeToolCall("read", { path: "/var/tmp/run-one/output/process/log" }, ctx).verdict).toBe("refused");
  });
});

describe("judgeToolCall — typed publication", () => {
  const native = { ...ctx, noShellPush: true };
  it("allows harmless wildcards, interpreters and shell composition without minting publication", () => {
    for (const command of [
      "cat src/core/models* | head -10; ls src/core/harness/pi",
      "node -e 'console.log(1)'",
      "python3 -c 'print(1)'",
      "cat README.md 2>/dev/null; git status --short",
      "echo $HOME && ls src",
      "rg -n 'git push' README.md",
      "echo 'git push is an example'",
    ])
      expect(judgeToolCall("bash", { command }, native), command).toEqual({ verdict: "allowed" });
  });

  it("refuses literal shell publication with typed-tool recovery guidance and preserves credential and merge guards", () => {
    for (const command of [
      "git push origin load-pi/test-gap-1",
      "git push origin main && ls",
      "git -C /work/repo push origin other",
    ])
      expect(judgeToolCall("bash", { command }, native)).toEqual({
        verdict: "refused",
        reason:
          "repo:use — publish through the runner-owned publish_branch tool; shell publication has no Git Door credential",
      });
    for (const command of ["env", "cat .git/github-credentials", "echo $GITHUB_TOKEN", "gh pr merge 12"])
      expect(judgeToolCall("bash", { command }, native).verdict).toBe("refused");
  });
});

describe("judgeToolCall — bash", () => {
  it("allows ordinary commands and a push of the run's own branch to origin", () => {
    expect(bash("npx vitest run src/load/reasons.test.ts")).toEqual({ verdict: "allowed" });
    expect(bash("git push -u origin load-pi/test-gap-1")).toEqual({ verdict: "allowed" });
    expect(bash("git push --force-with-lease origin load-pi/test-gap-1:load-pi/test-gap-1")).toEqual({
      verdict: "allowed",
    });
    expect(bash("git push")).toEqual({
      verdict: "refused",
      reason:
        "repo:use — name the run's branch load-pi/test-gap-1 as the push source and destination; the checkout may have moved",
    });
  });
  it("refuses implicit HEAD destinations after the checkout may have moved", () => {
    for (const command of ["git push origin HEAD", "git push -u origin HEAD", "git push origin +HEAD"]) {
      expect(bash(command)).toEqual({
        verdict: "refused",
        reason: "repo:use — push to `HEAD`, not the run's branch load-pi/test-gap-1",
      });
    }
    expect(bash("git push origin HEAD:main")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `main`, not the run's branch load-pi/test-gap-1",
    });
    for (const source of ["HEAD", "other", "+HEAD"]) {
      expect(bash(`git push origin ${source}:load-pi/test-gap-1`)).toEqual({
        verdict: "refused",
        reason: "repo:use — push from the run's branch load-pi/test-gap-1; the checkout may have moved",
      });
    }
    expect(bash("git push origin load-pi/test-gap-1 other:other")).toEqual({
      verdict: "refused",
      reason: "repo:use — a bound run may push exactly one branch",
    });
  });
  it("allows only a terminal stderr redirect, never a redirect that hides later arguments", () => {
    expect(bash("git push origin load-pi/test-gap-1:load-pi/test-gap-1 2>&1")).toEqual({ verdict: "allowed" });
    for (const command of [
      "git push origin load-pi/test-gap-1 > push.log 2>&1",
      "git push origin load-pi/test-gap-1 2>&1 evil main",
      "git push 2>/dev/null evil main",
      "git push origin load-pi/test-gap-1 2>&1 && git push evil main",
    ])
      expect(bash(command), command).toMatchObject({ verdict: "refused" });
    expect(bash("git push origin main 2>&1")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `main`, not the run's branch load-pi/test-gap-1",
    });
  });
  it("refuses a push to another remote or another branch — repo:use outside the run's grant", () => {
    expect(bash("git push upstream load-pi/test-gap-1")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to remote `upstream`, not the run's repository (origin)",
    });
    expect(bash("git -C /work/repo push origin main")).toMatchObject({ verdict: "refused" });
    expect(bash("git -c user.name=x push -u origin load-pi/test-gap-1")).toMatchObject({ verdict: "refused" });
    expect(bash("git push origin main")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `main`, not the run's branch load-pi/test-gap-1",
    });
    expect(bash("git checkout -b fix && git push origin fix")).toMatchObject({ verdict: "refused" });
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
    expect(bash("gh api -X GET repos/o/r/pulls/12/reviews")).toEqual({ verdict: "allowed" });
    expect(bash("curl https://api.github.com/repos/o/r/pulls/12/reviews")).toEqual({ verdict: "allowed" });
    expect(bash("gh api -X POST repos/o/r/pulls/12/reviews -f event=APPROVE")).toEqual({
      verdict: "refused",
      reason: "merge/approve — a coding run never merges or approves a pull request",
    });
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
    expect(bash("echo $HOME $PATH")).toMatchObject({ verdict: "refused" });
  });
  it("a non-string command is refused as malformed rather than allowed by accident", () => {
    expect(judgeToolCall("bash", { command: 42 }, ctx)).toEqual({
      verdict: "refused",
      reason: "malformed — bash without a string command",
    });
  });
});

describe("judgeToolCall — an existing-PR publication fence", () => {
  const expected = "a".repeat(40);
  const own = {
    identity: "write" as const,
    checkout: "/work/repo",
    branch: "fix/existing",
    protectedBranches: ["main"],
    publication: { authority: { ref: "fix/existing", expectedHeadSha: expected } },
  };

  it("allows only the owned ref with an explicit atomic lease at the durable expected head", () => {
    expect(
      judgeToolCall(
        "bash",
        {
          command: `git push --force-with-lease=refs/heads/fix/existing:${expected} origin fix/existing:refs/heads/fix/existing`,
        },
        own,
      ),
    ).toEqual({ verdict: "allowed" });
    for (const command of [
      "git push origin fix/existing",
      "git push --force-with-lease origin fix/existing",
      `git push --force-with-lease=refs/heads/fix/existing:${"b".repeat(40)} origin fix/existing`,
      `git push --force-with-lease=refs/heads/fix/existing:${expected} origin fix/alternate`,
      `git push --force-with-lease=refs/heads/fix/existing:${expected} origin HEAD:refs/heads/fix/existing`,
      `git push --force-with-lease=refs/heads/fix/existing:${expected} origin HEAD:refs/heads/fix/existing HEAD:refs/heads/fix/alternate`,
      "git push",
    ])
      expect(judgeToolCall("bash", { command }, own)).toMatchObject({ verdict: "refused" });
  });

  it("refuses every publication when the fresh binding check was blocked", () => {
    expect(
      judgeToolCall(
        "bash",
        { command: "git push origin fix/existing" },
        {
          ...own,
          publication: { authority: { blocked: "the remote head moved" } },
        },
      ),
    ).toEqual({ verdict: "refused", reason: "repo:use — existing-PR publication blocked: the remote head moved" });
  });
});

describe("judgeToolCall — multiline pushes", () => {
  const expected = "a".repeat(40);
  const branch = "fix/existing";
  const lease = `--force-with-lease=refs/heads/${branch}:${expected}`;
  const own = {
    ...ctx,
    branch,
    publication: { authority: { ref: branch, expectedHeadSha: expected } },
  };
  const push = `git push ${lease} origin ${branch}:refs/heads/${branch}`;
  const status = 'result=$?\ncat push.log\ngit rev-parse HEAD\nexit "$result"';
  const judge = (command: string, rules: ToolRuleContext = own) => judgeToolCall("bash", { command }, rules);

  it("refuses a push in a shell call that also runs other commands", () => {
    for (const separator of ["\n", "; ", " && ", " || ", " | ", " & "]) {
      expect(judge(`${push}${separator}npm version patch`), separator).toEqual({
        verdict: "refused",
        reason: "repo:use — publish with one standalone push command; shell composition cannot bind its source",
      });
    }
    for (const command of [
      `git status --short && ${push}`,
      `(${push})`,
      `${push}; ${push}`,
      `bash -c '${push}'`,
      `bash -c 'git "push" ${lease} origin ${branch}'`,
      `env ${push}`,
      `command ${push}`,
      `exec ${push}`,
      `exec git 'push' ${lease} origin ${branch}`,
      `echo done; git 'push' ${lease} origin ${branch}`,
    ]) {
      expect(judge(command), command).toMatchObject({ verdict: "refused" });
    }
  });

  it("distinguishes quoted metacharacters from operative ones in a single owned push", () => {
    expect(judge(`${push} --push-option='note&read|only;yes'`)).toMatchObject({ verdict: "refused" });
    expect(judge(`${push} --push-option='note&read|only;yes'`, { ...ctx, branch })).toEqual({ verdict: "allowed" });
    expect(judge(`${push} --push-option=note&npm version patch`)).toMatchObject({ verdict: "refused" });
    expect(judge(`${push} 2>&1`)).toEqual({ verdict: "allowed" });
    expect(judge(`${push} > push.log`)).toMatchObject({ verdict: "refused" });
    expect(judge(`${push} 2>&1 other:other`)).toMatchObject({ verdict: "refused" });
    expect(judge(`echo '${push} & npm version patch'`)).toEqual({ verdict: "allowed" });
  });

  it("refuses dynamically assembled publication words and nested shell execution before any push", () => {
    for (const command of [
      `g\${0:+}it push origin ${branch}:${branch} & npm version patch`,
      `git p\${0:+}ush origin HEAD:${branch}`,
      `g\${0:+}it push upstream ${branch}:main`,
      `g{it,arbage} push origin ${branch}:${branch} & npm version patch`,
      `g?t push origin ${branch}:${branch} & npm version patch`,
      `bash -c 'g\${0:+}it push origin ${branch}:${branch} & npm version patch'`,
      `echo done; bash -c 'g\${0:+}it push origin ${branch}:${branch} & npm version patch'`,
      `env sh -c 'g\${0:+}it push origin ${branch}:${branch} & npm version patch'`,
      `~/git push origin ${branch}:${branch} & npm version patch`,
      `eval 'git push origin ${branch}:${branch}'`,
      ...[`${branch}:${branch}`, `HEAD:${branch}`, `${branch}:main`].flatMap((refspec, i) => [
        `node -e 'require("child_process").execFileSync("git",process.argv.slice(1))' push ${i === 2 ? "upstream" : "origin"} ${refspec}`,
        `node -e 'require("child_process").execFileSync("git",process.argv.slice(1))' push ${i === 2 ? "upstream" : "origin"} ${refspec} & npm version patch`,
      ]),
    ]) {
      expect(judge(command), command).toMatchObject({ verdict: "refused" });
    }
    const fresh = { ...ctx, branch };
    expect(judge(`git push origin ${branch}:${branch}`, fresh)).toEqual({ verdict: "allowed" });
    expect(judge(`git push origin ${branch}:${branch} & npm version patch`, fresh)).toMatchObject({
      verdict: "refused",
    });
    expect(judge(push)).toEqual({ verdict: "allowed" });
    expect(literalPushSource(push)).toBe(branch);
    expect(literalPushSource(`git -c http.postBuffer=512 push ${lease} origin ${branch}:${branch}`)).toBe(branch);
    expect(literalPushSource(`node -e 'git' push origin ${branch}:${branch}`)).toBeUndefined();
    expect(literalPushSource(`${push} & npm version patch`)).toBeUndefined();
  });

  it("refuses opaque programs that can spawn a push without adjacent publication words", () => {
    for (const command of [
      `node -e 'require("child_process").execFileSync(String.fromCharCode(103,105,116),["pu"+"sh","origin","${branch}:${branch}"])'`,
      `node -e 'require("child_process").execFileSync(String.fromCharCode(103,105,116),["pu"+"sh","origin","HEAD:${branch}"])'`,
      `node -e 'require("child_process").execFileSync(String.fromCharCode(103,105,116),["pu"+"sh","upstream","${branch}:main"])'`,
    ]) {
      expect(judge(command), command).toMatchObject({ verdict: "refused" });
    }
    expect(judge(`echo 'node -e opaque text'`)).toEqual({ verdict: "allowed" });
    expect(judge("node -e 'console.log(process.env.HOME)'")).toMatchObject({ verdict: "refused" });
    expect(judge("python3 -c 'print(1)'")).toMatchObject({ verdict: "refused" });
  });

  it("refuses a helper program passing Git's push verb as a separate argument before shell execution", () => {
    const command = `node -e 'require("child_process").execFileSync("git",process.argv.slice(1))' push origin ${branch}:${branch} & npm version patch`;
    expect(judge(command)).toEqual({
      verdict: "refused",
      reason: "repo:use — publish with one standalone push command; shell composition cannot bind its source",
    });
  });

  it("only executes existing-PR pushes the receipt parser can attribute", () => {
    for (const command of [
      `git \\\n push ${lease} origin ${branch}:${branch}`,
      `git push ${lease} origin '${branch}:${branch}'`,
      `git push ${lease} origin ${branch}:${branch} --push-option='note&read'`,
      `git -c http.postBuffer=512 -c http.postBuffer=1024 push ${lease} origin ${branch}:${branch}`,
      `${push} & npm version patch`,
    ]) {
      expect(judge(command), command).toMatchObject({ verdict: "refused" });
    }
    expect(judge(push)).toEqual({ verdict: "allowed" });
  });

  it("refuses configured or implicit refspecs, unsafe Git configuration and substitutions", () => {
    for (const command of [
      `git -c remote.origin.push=main push ${lease} origin`,
      `git -c remote.origin.url=https://other.example push ${lease} origin ${branch}`,
      `git -C /other push ${lease} origin ${branch}`,
      `${push}$(npm version patch)`,
      `${push} \`npm version patch\``,
      `${push} --receive-pack=custom`,
      `${push} --mirror`,
      `git push --force-with-lease=refs/heads/${branch}:${expected} origin`,
    ])
      expect(judge(command), command).toMatchObject({ verdict: "refused" });
    expect(judge(`git -c http.postBuffer=52428800 push ${lease} origin ${branch}:refs/heads/${branch}`)).toEqual({
      verdict: "allowed",
    });
  });

  it("refuses HEAD with the source-specific reason in a standalone push", () => {
    expect(judge(`git push ${lease} origin HEAD:refs/heads/${branch}`)).toEqual({
      verdict: "refused",
      reason: `repo:use — push from the owned publication ref ${branch}; the checkout may have moved`,
    });
  });

  it("keeps the bound branch source check without an existing-PR fence", () => {
    expect(judge(push, { ...ctx, branch })).toEqual({ verdict: "allowed" });
    expect(judge(`git push origin HEAD:${branch}`, { ...ctx, branch })).toEqual({
      verdict: "refused",
      reason: `repo:use — push from the run's branch ${branch}; the checkout may have moved`,
    });
  });

  it("refuses escaped-newline publication before execution even when it would form one command", () => {
    const command = `git \\\n  push \\\n  ${lease} \\\n  origin fix/ex\\\nisting:refs/heads/${branch} \\\n  2>&1\n${status}`;
    expect(judge(command)).toMatchObject({ verdict: "refused" });
    expect(
      judge(`git \\\n  push \\\n  ${lease} \\\n  origin fix/ex\\\nisting:refs/heads/${branch} \\\n  2>&1`),
    ).toMatchObject({ verdict: "refused" });
    expect(judge(command, { ...own, identity: "read" })).toEqual({
      verdict: "refused",
      reason: "read-only — a read-identity run never pushes",
    });
  });

  it("preserves the remote, owned ref, source, single destination and explicit lease fences on literal pushes", () => {
    for (const [args, reason] of [
      [`${lease} upstream ${branch}`, "repo:use — push to remote `upstream`, not the run's repository (origin)"],
      [`${lease} origin ${branch}:main`, `repo:use — push to \`main\`, not the owned publication ref ${branch}`],
      [
        `${lease} origin HEAD:${branch}`,
        `repo:use — push from the owned publication ref ${branch}; the checkout may have moved`,
      ],
      [
        `${lease} origin ${branch} other:other`,
        "repo:use — existing-PR publication allows exactly one owned destination",
      ],
      ...["", "--force-with-lease", lease.replace(expected, "b".repeat(40))].map((flag) => [
        `${flag} origin ${branch}`,
        `repo:use — existing-PR publication requires \`${lease}\` so concurrent movement fails atomically`,
      ]),
    ]) {
      expect(judge(`git push ${args}`), args).toEqual({ verdict: "refused", reason });
    }
  });

  it("never borrows the explicit lease from a later command", () => {
    expect(judge(`git push origin ${branch}\nprintf '%s' ${lease}\n${status}`)).toMatchObject({ verdict: "refused" });
    expect(judge(`git push origin ${branch}`)).toEqual({
      verdict: "refused",
      reason: `repo:use — existing-PR publication requires \`${lease}\` so concurrent movement fails atomically`,
    });
  });

  it("judges later pushes independently rather than swallowing them as the first push's arguments", () => {
    expect(judge(`${push}\n${push}\n${status}`)).toMatchObject({ verdict: "refused" });
    expect(judge(`${push}\ngit push ${lease} origin HEAD:${branch}\n${status}`)).toMatchObject({ verdict: "refused" });
  });

  it("does not let a quoted newline hide a second destination", () => {
    for (const quote of ["'", '"']) {
      expect(judge(`${push} --push-option=${quote}one\ntwo${quote} other:other\n${status}`)).toMatchObject({
        verdict: "refused",
      });
    }
  });

  it("does not mistake an escaped backslash before a newline for a continuation", () => {
    expect(judge(`${push} --push-option=literal\\\\\n${status}`)).toMatchObject({ verdict: "refused" });
  });
});

describe("judgeToolCall — load preview of its checked-out task branch", () => {
  const task = { identity: "write" as const, checkout: "/work/repo", branch: "load-pi/task" };
  it("refuses HEAD and foreign branches, but admits one explicit own-branch refspec", () => {
    for (const command of ["git push origin HEAD", "git push origin main", "git push origin other:other"])
      expect(judgeToolCall("bash", { command }, task), command).toMatchObject({ verdict: "refused" });
    expect(judgeToolCall("bash", { command: "git push origin load-pi/task:load-pi/task" }, task)).toEqual({
      verdict: "allowed",
    });
  });
});

describe("judgeToolCall — a run that names its own branch", () => {
  const own = { identity: "write" as const, checkout: "/work/repo", protectedBranches: ["main", "release/1.2"] };
  it("may push any branch to origin but the protected ones — the base its pull request targets", () => {
    expect(judgeToolCall("bash", { command: "git push -u origin feat/login" }, own)).toEqual({ verdict: "allowed" });
    expect(judgeToolCall("bash", { command: "git push origin HEAD" }, own)).toMatchObject({ verdict: "refused" });
    expect(judgeToolCall("bash", { command: "git push" }, own)).toMatchObject({ verdict: "refused" });
    expect(judgeToolCall("bash", { command: "git -c remote.origin.push=main push origin" }, own)).toMatchObject({
      verdict: "refused",
    });
    for (const command of [
      "git push origin feat/x other:other",
      "git push origin :feat/x",
      "git push origin feat/x:",
    ]) {
      expect(judgeToolCall("bash", { command }, own), command).toMatchObject({ verdict: "refused" });
    }
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

// docs/reference/specs/harness-pi.md items 7 and 15 — a bash call whose
// explicit `timeout` (pi's, in seconds; pi runs a call without one unbounded)
// reaches past the loop's end is refused before it runs, in the wind-down's
// words: the seconds left, the seconds asked, and the two ways forward. Only
// an explicit, finite, positive timeout is judged; a call naming none runs
// (a `git push` in the last minutes must) and the loop's end cuts it as today.
describe("judgeToolCall — bash: an explicit timeout against the loop's end", () => {
  const nearEnd = { ...ctx, loopEndsIn: () => 384_500 };
  const timed = (command: string, timeout: unknown, rules: ToolRuleContext = nearEnd) =>
    judgeToolCall("bash", { command, timeout }, rules);

  it("refuses a timeout that reaches past the loop's end with the exact sentence — the seconds left, the seconds asked and what can still finish", () => {
    expect(timed("npm run verify", 600)).toEqual({
      verdict: "refused",
      reason:
        "budget — this command asked for a 600 s timeout and the loop ends in 384 s, so it could never finish. A timeout inside the 384 s left can still finish; otherwise the current work and write-up stand, and CI owns full verification.",
    });
    expect(timed("npm run verify", 600)).toEqual({
      verdict: "refused",
      reason: commandPastLoopEndRefusal(600, 384),
    });
  });

  it("allows a timeout inside the loop's end, one that ends exactly at it, and one that rounds to it", () => {
    expect(timed("npm test -- one.test.ts", 60)).toEqual({ verdict: "allowed" });
    expect(timed("npm test -- one.test.ts", 384.5)).toEqual({ verdict: "allowed" });
    expect(timed("npm test -- one.test.ts", 384)).toEqual({ verdict: "allowed" });
  });

  it("never refuses a call that names no timeout, even with ten seconds left: the push must run and the loop's end bounds it", () => {
    const lastSeconds = { ...ctx, loopEndsIn: () => 10_000 };
    expect(judgeToolCall("bash", { command: "git push origin load-pi/test-gap-1" }, lastSeconds)).toEqual({
      verdict: "allowed",
    });
    expect(timed("git push origin load-pi/test-gap-1", 30, lastSeconds)).toEqual({
      verdict: "refused",
      reason: commandPastLoopEndRefusal(30, 10),
    });
  });

  it("a non-numeric, non-finite or non-positive timeout is not this rule's business (pi refuses it in its own words), nor is any timeout when no loop clock was handed over", () => {
    expect(timed("npm run verify", "600")).toEqual({ verdict: "allowed" });
    expect(timed("npm run verify", Number.NaN)).toEqual({ verdict: "allowed" });
    expect(timed("npm run verify", Number.POSITIVE_INFINITY)).toEqual({ verdict: "allowed" });
    expect(timed("npm run verify", 0)).toEqual({ verdict: "allowed" });
    expect(timed("npm run verify", -5)).toEqual({ verdict: "allowed" });
    expect(timed("npm run verify", 600, ctx)).toEqual({ verdict: "allowed" });
  });

  it("with the loop already past its end every explicit timeout is refused naming 0 s left, and the other rules still speak first", () => {
    const past = { ...ctx, loopEndsIn: () => -2_000 };
    expect(timed("npm test -- one.test.ts", 1, past)).toEqual({
      verdict: "refused",
      reason: commandPastLoopEndRefusal(1, 0),
    });
    expect(timed("cat .git/github-credentials", 600)).toEqual({
      verdict: "refused",
      reason: "credential — reads the executor's credential store",
    });
    expect(timed("git push origin main", 600)).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `main`, not the run's branch load-pi/test-gap-1",
    });
  });
});
