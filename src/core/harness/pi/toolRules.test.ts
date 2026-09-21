import { describe, expect, it } from "vitest";
import {
  CODING_REACH,
  NONE_REACH,
  PI_TOOL_BUNDLES,
  READ_REACH,
  createPushGuard,
  inspectGitPush,
  inspectGitRefTree,
  inspectGitTree,
  judgeToolCall,
  judgeToolCallWithTree,
  reachFor,
  recordToolResult,
  type PushRefspec,
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
  it("reads a shell redirection as the shell's, never as the push's remote or refspec", () => {
    expect(bash("git push --force-with-lease 2>&1 | tail -1")).toEqual({ verdict: "allowed" });
    expect(bash("git push origin HEAD 2>/dev/null")).toEqual({ verdict: "allowed" });
    expect(bash("git push origin HEAD:load-pi/test-gap-1 > push.log 2>&1")).toEqual({ verdict: "allowed" });
    // a bare operator's target is the next word, not a refspec
    expect(bash("git push origin 2> push.log")).toEqual({ verdict: "allowed" });
    // a redirection never hides the push's own arguments from the rule
    expect(bash("git push evil main | tail -1")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to remote `evil`, not the run's repository (origin)",
    });
    expect(bash("git push 2>/dev/null evil main")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to remote `evil`, not the run's repository (origin)",
    });
    expect(bash("git push origin main 2>&1")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `main`, not the run's branch load-pi/test-gap-1",
    });
    // a redirection's `&` never cuts the tail — the arguments after it are judged
    for (const redirection of ["2>&1", ">&2", "1>&2", "&>push.log", "&>>push.log"]) {
      expect(bash(`git push ${redirection} evil main`)).toEqual({
        verdict: "refused",
        reason: "repo:use — push to remote `evil`, not the run's repository (origin)",
      });
      expect(bash(`git push ${redirection} origin main`)).toEqual({
        verdict: "refused",
        reason: "repo:use — push to `main`, not the run's branch load-pi/test-gap-1",
      });
    }
    // a control `&&` still ends the tail, and the push after it is judged too
    expect(bash("git push origin HEAD 2>&1 && git push evil main")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to remote `evil`, not the run's repository (origin)",
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

describe("inspectGitTree — the formatter receipt's checkout identity", () => {
  it("reads the committed tree id and working-tree dirty state through the executor", async () => {
    const commands: string[] = [];
    const executor = {
      exec: async (command: string) => {
        commands.push(command);
        return "__SWITCHBOARD_TREE__0123456789abcdef0123456789abcdef01234567:dirty\n";
      },
    };

    await expect(inspectGitTree(executor as never)).resolves.toBe("0123456789abcdef0123456789abcdef01234567:dirty");
    expect(commands[0]).toContain("git rev-parse 'HEAD^{tree}'");
    expect(commands[0]).toContain("git status --porcelain=v1 --untracked-files=normal");
  });

  it("resolves an explicit push source as data and returns its committed tree", async () => {
    const commands: string[] = [];
    const executor = {
      exec: async (command: string) => {
        commands.push(command);
        return "__SWITCHBOARD_TREE__0123456789abcdef0123456789abcdef01234567:clean\n";
      },
    };

    await expect(inspectGitRefTree(executor as never, "topic'$(touch nope)")).resolves.toBe(
      "0123456789abcdef0123456789abcdef01234567:clean",
    );
    expect(commands[0]).toContain("git rev-parse --verify --end-of-options");
    expect(commands[0]).toContain("'topic'\\''$(touch nope)^{tree}'");
  });

  const pushResolutionOutput = (sources: string, branch = "fix/the-pr-head") =>
    `__SWITCHBOARD_PUSH_URLS__\0https://github.com/acme/api.git\0__SWITCHBOARD_PUSH_URLS_END__\0` +
    `__SWITCHBOARD_PUSH_BRANCH__${branch}\0${sources}`;

  it("resolves the effective remote and every configured push refspec together", async () => {
    const commands: string[] = [];
    const configured = {
      exec: async (command: string) => {
        commands.push(command);
        return pushResolutionOutput("__SWITCHBOARD_PUSH_REFS__\0HEAD:fix/the-pr-head\0stale-ref:refs/tags/stale\0");
      },
    };
    await expect(inspectGitPush(configured as never, "origin", "acme/api")).resolves.toEqual({
      remote: "origin",
      remoteUrl: "https://github.com/acme/api.git",
      refspecs: [
        { source: "HEAD", destination: "fix/the-pr-head" },
        { source: "stale-ref", destination: "refs/tags/stale" },
      ],
    });
    expect(commands[0]).toContain("pushInsteadOf");
    expect(commands[0]).toContain("remote.origin.pushurl");
    expect(commands[0]).toContain("remote.origin.url");
    expect(commands[0]).toContain("remote.origin.push");
    expect(commands[0]).toContain("remote.origin.mirror");
    expect(commands[0]).toContain("push.followTags");
    expect(commands[0]).toContain("push.default");
    expect(commands[0]).toContain("git symbolic-ref --quiet --short HEAD");

    const defaults = { exec: async () => pushResolutionOutput("__SWITCHBOARD_PUSH_DEFAULT__simple\0") };
    await expect(inspectGitPush(defaults as never, "origin", "acme/api")).resolves.toMatchObject({
      refspecs: [{ source: "HEAD", destination: "fix/the-pr-head" }],
    });

    const matching = { exec: async () => pushResolutionOutput("__SWITCHBOARD_PUSH_DEFAULT__matching\0") };
    await expect(inspectGitPush(matching as never, "origin", "acme/api")).resolves.toBeUndefined();
  });

  it("refuses every effective endpoint outside the run repository", async () => {
    const explicit = [{ source: "HEAD", destination: "fix/the-pr-head" }];
    const redirected = {
      exec: async () =>
        "__SWITCHBOARD_PUSH_URLS__\0https://github.com/other/repository.git\0__SWITCHBOARD_PUSH_URLS_END__\0__SWITCHBOARD_PUSH_BRANCH__fix/the-pr-head\0",
    };
    await expect(inspectGitPush(redirected as never, "origin", "acme/api", explicit)).resolves.toBeUndefined();

    const multiple = {
      exec: async () =>
        "__SWITCHBOARD_PUSH_URLS__\0https://github.com/acme/api.git\0https://github.com/other/repository.git\0__SWITCHBOARD_PUSH_URLS_END__\0__SWITCHBOARD_PUSH_BRANCH__fix/the-pr-head\0",
    };
    await expect(inspectGitPush(multiple as never, "origin", "acme/api", explicit)).resolves.toBeUndefined();
  });
});

describe("judgeToolCall — the pushed tree passed formatting", () => {
  const formatChangedSet = (base = "main") =>
    `set -o pipefail && git diff --name-only --diff-filter=ACMR -z origin/${base}...HEAD -- | xargs -0 -r npx prettier --check --ignore-unknown --`;
  const guarded = () => {
    let tree = "tree-a:clean";
    let checkoutBranch = "fix/the-pr-head";
    const refs = new Map<string, string>();
    const configuredPushSources = new Map<string, readonly PushRefspec[] | undefined>();
    const redirectedRemotes = new Set<string>();
    const rules: ToolRuleContext = {
      identity: "write",
      checkout: "/work/repo",
      branch: "fix/the-pr-head",
      protectedBranches: ["main"],
      pushGuard: createPushGuard(),
      inspectTree: async () => tree,
      inspectRefTree: async (ref) => refs.get(ref) ?? tree.replace(/:(clean|dirty)$/, ":clean"),
      inspectPush: async (remote, explicit) => {
        if (redirectedRemotes.has(remote)) return undefined;
        const refspecs =
          explicit ?? (configuredPushSources.has(remote) ? configuredPushSources.get(remote) : [{ source: "HEAD" }]);
        return refspecs === undefined
          ? undefined
          : {
              remote,
              remoteUrl: "https://github.com/acme/api.git",
              refspecs: refspecs.map((refspec) =>
                refspec.source === "HEAD" && refspec.destination === undefined
                  ? { ...refspec, destination: checkoutBranch }
                  : refspec,
              ),
            };
      },
    };
    return {
      rules,
      moveTo: (next: string) => void (tree = next),
      pointRef: (ref: string, next: string) => void refs.set(ref, next),
      configurePushSources: (remote: string, refspecs: readonly PushRefspec[] | undefined) =>
        void configuredPushSources.set(remote, refspecs),
      configure: (entries: readonly string[]) => {
        const pushEntries = entries
          .filter((entry) => entry.startsWith("remote.origin.push="))
          .map((entry) => entry.slice("remote.origin.push=".length))
          .map((entry) => {
            const [source, destination] = entry.split(":", 2);
            return destination === undefined ? { source } : { source, destination };
          });
        if (pushEntries.length > 0) configuredPushSources.set("origin", pushEntries);
        const pushDefault = entries.find((entry) => entry.startsWith("push.default="))?.split("=", 2)[1];
        if (pushDefault !== undefined)
          configuredPushSources.set(
            "origin",
            pushDefault === "current" || pushDefault === "simple" ? [{ source: "HEAD" }] : undefined,
          );
        const branch = entries.find((entry) => entry.startsWith("branch="))?.slice("branch=".length);
        if (branch !== undefined) checkoutBranch = branch;
        if (
          entries.some(
            (entry) => /remote\.origin\.(?:pushurl|url)=/.test(entry) && !entry.endsWith("github.com/acme/api.git"),
          )
        )
          redirectedRemotes.add("origin");
        if (pushEntries.some(({ source }) => source === "stale-ref")) refs.set("stale-ref", "tree-b:clean");
      },
    };
  };
  const call = (rules: ToolRuleContext, id: string, command: string) =>
    judgeToolCallWithTree("bash", { command }, rules, id);
  const settle = (rules: ToolRuleContext, id: string, ok: boolean) => recordToolResult(rules, id, ok);

  it("refuses an npm-version-style tree change after a passing formatting check", async () => {
    const { rules, moveTo } = guarded();
    expect(await call(rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);

    expect(await call(rules, "version", "npm version patch")).toEqual({ verdict: "allowed" });
    moveTo("tree-b:clean");

    expect(await call(rules, "push", "git push origin fix/the-pr-head")).toEqual({
      verdict: "refused",
      reason: "the tree changed since the gates ran; run them on this tree, then push",
    });
  });

  it("refuses a compound command that can change the tree before its push", async () => {
    const { rules } = guarded();
    expect(await call(rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);

    expect(await call(rules, "compound-push", "npm version patch && git push origin fix/the-pr-head")).toEqual({
      verdict: "refused",
      reason: "the tree changed since the gates ran; run them on this tree, then push",
    });
  });

  it("does not let a dirty worktree earn a receipt whose contents are unidentified", async () => {
    const { rules, moveTo } = guarded();
    moveTo("tree-a:dirty");
    expect(await call(rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);

    expect(await call(rules, "push", "git push origin fix/the-pr-head")).toEqual({
      verdict: "refused",
      reason: "the tree changed since the gates ran; run them on this tree, then push",
    });
  });

  it("does not let a formatter over only part of the changed set certify the pushed tree", async () => {
    const { rules } = guarded();
    expect(await call(rules, "format", "npx prettier --check src/core/harness/pi/toolRules.test.ts")).toEqual({
      verdict: "allowed",
    });
    await settle(rules, "format", true);

    expect(await call(rules, "push", "git push origin fix/the-pr-head")).toEqual({
      verdict: "refused",
      reason: "the tree changed since the gates ran; run them on this tree, then push",
    });
  });

  it("does not treat a command that merely mentions Prettier as a formatting receipt", async () => {
    const { rules } = guarded();
    expect(await call(rules, "mention", "printf 'run npx prettier --check before pushing\\n'")).toEqual({
      verdict: "allowed",
    });
    await settle(rules, "mention", true);

    expect(await call(rules, "push", "git push origin fix/the-pr-head")).toEqual({
      verdict: "refused",
      reason: "the tree changed since the gates ran; run them on this tree, then push",
    });
  });

  it("does not let the canonical check use an arbitrary branch instead of the protected base", async () => {
    const { rules } = guarded();
    expect(await call(rules, "format", formatChangedSet("older-base"))).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);

    expect(await call(rules, "push", "git push origin fix/the-pr-head")).toEqual({
      verdict: "refused",
      reason: "the tree changed since the gates ran; run them on this tree, then push",
    });
  });

  it("allows the push after the canonical changed-set formatting gate passes on the current tree", async () => {
    const { rules } = guarded();
    expect(await call(rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);

    expect(await call(rules, "push", "git push origin fix/the-pr-head")).toEqual({ verdict: "allowed" });
  });

  const receiptRefusal = {
    verdict: "refused",
    reason: "the tree changed since the gates ran; run them on this tree, then push",
  } as const;
  const wrongRemoteRefusal = {
    verdict: "refused",
    reason: "repo:use — push to remote `backup`, not the run's repository (origin)",
  } as const;
  const tagRefusal = {
    verdict: "refused",
    reason: "repo:use — push to `refs/tags/v1`, not the run's branch fix/the-pr-head",
  } as const;

  it.each<{
    name: string;
    command: string;
    config: readonly string[];
    expected: { verdict: "allowed" } | { verdict: "refused"; reason: string };
  }>([
    {
      name: "one explicit refspec",
      command: "git push origin HEAD:fix/the-pr-head",
      config: [],
      expected: { verdict: "allowed" },
    },
    {
      name: "several explicit refspecs",
      command: "git push origin HEAD:fix/the-pr-head stale-ref:fix/the-pr-head",
      config: [],
      expected: receiptRefusal,
    },
    {
      name: "remote.origin.push selects only the gated tree and run branch",
      command: "git push origin",
      config: ["remote.origin.push=HEAD:fix/the-pr-head"],
      expected: { verdict: "allowed" },
    },
    {
      name: "push.default uses its default simple mode",
      command: "git push origin",
      config: [],
      expected: { verdict: "allowed" },
    },
    {
      name: "push.default=current selects the gated tree and current branch",
      command: "git push origin",
      config: ["push.default=current"],
      expected: { verdict: "allowed" },
    },
    {
      name: "push.default=current refuses an equal tree checked out on another branch",
      command: "git push origin",
      config: ["push.default=current", "branch=chore/other"],
      expected: {
        verdict: "refused",
        reason: "repo:use — push to `chore/other`, not the run's branch fix/the-pr-head",
      },
    },
    {
      name: "push.default=upstream is ambiguous",
      command: "git push origin",
      config: ["push.default=upstream"],
      expected: receiptRefusal,
    },
    {
      name: "push.default=simple selects the gated tree and current branch",
      command: "git push origin",
      config: ["push.default=simple"],
      expected: { verdict: "allowed" },
    },
    {
      name: "push.default=matching can fan out",
      command: "git push origin",
      config: ["push.default=matching"],
      expected: receiptRefusal,
    },
    {
      name: "push.default=nothing does not resolve the gated destination",
      command: "git push origin",
      config: ["push.default=nothing"],
      expected: receiptRefusal,
    },
    {
      name: "remote.origin.push can add another source tree",
      command: "git push origin",
      config: ["remote.origin.push=HEAD:fix/the-pr-head", "remote.origin.push=stale-ref:fix/the-pr-head"],
      expected: receiptRefusal,
    },
    {
      name: "remote.origin.url resolves to the run repository",
      command: "git push origin HEAD:fix/the-pr-head",
      config: ["remote.origin.url=https://github.com/acme/api.git"],
      expected: { verdict: "allowed" },
    },
    {
      name: "remote.origin.url can redirect literal origin",
      command: "git push origin HEAD:fix/the-pr-head",
      config: ["remote.origin.url=https://github.com/other/repository.git"],
      expected: receiptRefusal,
    },
    {
      name: "remote.origin.pushurl redirects a bare push",
      command: "git push origin",
      config: ["remote.origin.pushurl=https://github.com/other/repository.git"],
      expected: receiptRefusal,
    },
    {
      name: "remote.origin.pushurl redirects an explicit-refspec push",
      command: "git push origin HEAD:fix/the-pr-head",
      config: ["remote.origin.pushurl=https://github.com/other/repository.git"],
      expected: receiptRefusal,
    },
    {
      name: "a second remote is not the run's remote",
      command: "git push backup HEAD:fix/the-pr-head",
      config: ["remote.backup.url=https://github.com/other/repository.git"],
      expected: wrongRemoteRefusal,
    },
    {
      name: "a URL in place of the run remote is refused",
      command: "git push https://github.com/acme/api.git HEAD:fix/the-pr-head",
      config: [],
      expected: {
        verdict: "refused",
        reason: "repo:use — push to remote `https://github.com/acme/api.git`, not the run's repository (origin)",
      },
    },
    { name: "--all can fan out", command: "git push origin --all", config: [], expected: receiptRefusal },
    {
      name: "--mirror can redirect or fan out",
      command: "git push --mirror origin",
      config: [],
      expected: receiptRefusal,
    },
    { name: "--tags can add tag trees", command: "git push origin --tags", config: [], expected: receiptRefusal },
    {
      name: "a tag refspec is not the run's branch",
      command: "git push origin HEAD:refs/tags/v1",
      config: [],
      expected: tagRefusal,
    },
    {
      name: "--force keeps the same gated source and destination",
      command: "git push --force origin HEAD:fix/the-pr-head",
      config: [],
      expected: { verdict: "allowed" },
    },
    {
      name: "--force-with-lease keeps the same gated source and destination",
      command: "git push --force-with-lease origin HEAD:fix/the-pr-head",
      config: [],
      expected: { verdict: "allowed" },
    },
    {
      name: "a plus refspec keeps the same gated source and destination",
      command: "git push origin +HEAD:fix/the-pr-head",
      config: [],
      expected: { verdict: "allowed" },
    },
  ])("push invariant: $name", async ({ name, command, config, expected }) => {
    const guardedPush = guarded();
    guardedPush.configure(config);
    expect(await call(guardedPush.rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(guardedPush.rules, "format", true);

    expect(await call(guardedPush.rules, `push-${name}-${config.join(",")}`, command)).toEqual(expected);
  });

  it("allows an omitted refspec when no configured refspec selects another tree", async () => {
    const { rules } = guarded();
    expect(await call(rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);

    expect(await call(rules, "push", "git push origin")).toEqual({ verdict: "allowed" });
  });

  it("allows an omitted refspec whose configured HEAD source selects the formatted tree", async () => {
    const { rules, configurePushSources } = guarded();
    configurePushSources("origin", [{ source: "HEAD" }]);
    expect(await call(rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);

    expect(await call(rules, "push", "git push origin")).toEqual({ verdict: "allowed" });
  });

  it("refuses an omitted refspec when an extra configured source selects another tree", async () => {
    const { rules, pointRef, configurePushSources } = guarded();
    configurePushSources("origin", [{ source: "HEAD" }, { source: "stale-ref", destination: "stale-ref" }]);
    pointRef("stale-ref", "tree-b:clean");
    expect(await call(rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);

    expect(await call(rules, "push", "git push origin")).toEqual({
      verdict: "refused",
      reason: "the tree changed since the gates ran; run them on this tree, then push",
    });
  });

  it("refuses an omitted refspec whose configured destination is outside the run's branch", async () => {
    const { rules, configurePushSources } = guarded();
    configurePushSources("origin", [{ source: "HEAD", destination: "main" }]);
    expect(await call(rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);

    expect(await call(rules, "push", "git push origin")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `main`, not the run's branch fix/the-pr-head",
    });

    configurePushSources("origin", [{ source: "HEAD", destination: "HEAD" }]);
    expect(await call(rules, "push-literal-head", "git push origin")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `HEAD`, not the run's branch fix/the-pr-head",
    });
    expect(await call(rules, "push-explicit-head", "git push origin HEAD:HEAD")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `HEAD`, not the run's branch fix/the-pr-head",
    });
  });

  it("refuses an omitted refspec whose configured destination is protected", async () => {
    const { rules, configurePushSources } = guarded();
    const branchless = { ...rules, branch: undefined };
    configurePushSources("origin", [{ source: "HEAD", destination: "refs/heads/main" }]);
    expect(await call(branchless, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(branchless, "format", true);

    expect(await call(branchless, "push", "git push origin")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `main`, the branch this run's pull request targets; push your own branch",
    });
  });

  it("refuses configured and explicit destinations outside branch refs", async () => {
    const configured = guarded();
    const configuredBranchless = { ...configured.rules, branch: undefined };
    configured.configurePushSources("origin", [{ source: "HEAD", destination: "refs/tags/release" }]);
    expect(await call(configuredBranchless, "format-configured", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(configuredBranchless, "format-configured", true);
    expect(await call(configuredBranchless, "push-configured", "git push origin")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `refs/tags/release`, not a branch owned by this run",
    });

    const explicit = guarded();
    const explicitBranchless = { ...explicit.rules, branch: undefined };
    expect(await call(explicitBranchless, "format-explicit", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(explicitBranchless, "format-explicit", true);
    expect(await call(explicitBranchless, "push-explicit", "git push origin HEAD:refs/tags/release")).toEqual({
      verdict: "refused",
      reason: "repo:use — push to `refs/tags/release`, not a branch owned by this run",
    });
  });

  it("refuses multiple configured destinations when the run has not bound its own branch", async () => {
    const { rules, configurePushSources } = guarded();
    const branchless = { ...rules, branch: undefined };
    configurePushSources("origin", [
      { source: "HEAD", destination: "topic-a" },
      { source: "HEAD", destination: "topic-b" },
    ]);
    expect(await call(branchless, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(branchless, "format", true);

    expect(await call(branchless, "push", "git push origin")).toEqual({
      verdict: "refused",
      reason: "the tree changed since the gates ran; run them on this tree, then push",
    });
  });

  it("refuses an implicit remote and syntax that can change the inspected push selection", async () => {
    const { rules } = guarded();
    expect(await call(rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);

    for (const command of [
      "git push",
      "git -c remote.origin.push=HEAD:fix/the-pr-head push origin",
      "git -C /tmp/other push origin HEAD:fix/the-pr-head",
      "git --config-env=remote.origin.push=PUSH_REFSPEC push origin",
      "git push origin HEAD:fix/the-pr-head && git --config-env=remote.origin.push=PUSH_REFSPEC push origin",
      "git push --repo=other origin HEAD:fix/the-pr-head",
      "git push origin $SOURCE:$DESTINATION",
      "git push origin m'a'in",
    ]) {
      expect(await call(rules, `unsafe-${command}`, command), command).toEqual({
        verdict: "refused",
        reason: "the tree changed since the gates ran; run them on this tree, then push",
      });
    }
  });

  it("refuses an alternate-source refspec whose tree did not earn the receipt", async () => {
    const { rules, pointRef } = guarded();
    expect(await call(rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);
    pointRef("unformatted-ref", "tree-b:clean");

    expect(await call(rules, "push", "git push origin unformatted-ref:fix/the-pr-head")).toEqual({
      verdict: "refused",
      reason: "the tree changed since the gates ran; run them on this tree, then push",
    });
  });

  it("refuses multi-refspec and bulk pushes whose additional source trees have no receipts", async () => {
    const { rules } = guarded();
    expect(await call(rules, "format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "format", true);

    for (const command of [
      "git push origin HEAD:fix/the-pr-head stale-ref:refs/tags/stale",
      "git push origin --all",
      "git push --mirror origin",
      "git push origin '--tags'",
      "git push origin --follow-tags HEAD:fix/the-pr-head",
      "git push origin --delete fix/the-pr-head",
      "git push origin --prune HEAD:fix/the-pr-head",
      "git push origin --recurse-submodules=on-demand HEAD:fix/the-pr-head",
      "git push origin :",
      "git push origin 'refs/heads/*:refs/heads/*'",
    ]) {
      expect(await call(rules, `push-${command}`, command), command).toEqual({
        verdict: "refused",
        reason: "the tree changed since the gates ran; run them on this tree, then push",
      });
    }

    const branchless = { ...rules, branch: undefined, protectedBranches: ["main"] };
    expect(await call(branchless, "protected-second", "git push origin HEAD:topic stale-ref:main")).toEqual({
      verdict: "refused",
      reason: "the tree changed since the gates ran; run them on this tree, then push",
    });
  });

  it("a failed formatter after a passing check invalidates the earlier receipt", async () => {
    const { rules } = guarded();
    expect(await call(rules, "passing-format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "passing-format", true);
    expect(await call(rules, "failed-format", formatChangedSet())).toEqual({ verdict: "allowed" });
    await settle(rules, "failed-format", false);

    expect(await call(rules, "push", "git push origin fix/the-pr-head")).toEqual({
      verdict: "refused",
      reason: "the tree changed since the gates ran; run them on this tree, then push",
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
