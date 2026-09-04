import { describe, expect, it, vi } from "vitest";
import type { OpenedPullRequest, PullRequestTarget, RepoShipInfo } from "../execution/githubPulls.js";
import type { RunEvent } from "./runEvents.js";
import { observeCodingWorkspace, runCodingPrPostStep, type WorkspaceObservation } from "./codingPrPostStep.js";

// A base is already known from `target` in most of the tests below — the
// GitHub fetch must stay LAZY (never called) whenever one of the three
// fields already resolves it. Throwing here would be silently swallowed
// (resolveBaseRefLazy .catch()s it), so laziness is asserted with
// `.not.toHaveBeenCalled()`, not by relying on the throw to fail a test.
const unreachable = async (): Promise<RepoShipInfo | undefined> => {
  throw new Error("fetchRepoInfo must not be called when a base is already known");
};

// Feature: features/pr-description.md item 5 — the coding PR post-step as a
// callable unit (agent:ship plan U4): given a workspace observation and the
// run's submitted PrDescription, open or edit the PR from typed values and
// return the honest reply note. The dispatcher suite proves the end-to-end
// behavior byte-identical; here the unit is driven directly, as a ship round
// (U7) will drive it — no dispatch state, only explicit inputs.

const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

const DESCRIPTION = {
  title: "Fix the login redirect",
  tldr: "Restores the session cookie on login. Users can sign in again.",
  whatWhy: "The handler dropped the cookie after #12; this restores it.",
  tour: [{ title: "The fix", description: "The cookie is set again.", anchor: { path: "src/login.ts", from: 10, to: 20 } }],
  remaining: [],
  decisions: [],
  risks: "none",
  validation: { criteria: [{ criterion: "auth suite green", proof: "npm test — 24 passing" }] },
};

const observation = (over: Partial<WorkspaceObservation> = {}): WorkspaceObservation => ({
  head: HEAD,
  branch: "feat/x",
  remoteHead: HEAD,
  remoteRepo: undefined,
  ...over,
});

function openSpy(result: Partial<OpenedPullRequest> | Error = {}) {
  const calls: PullRequestTarget[] = [];
  const fn = vi.fn(async (target: PullRequestTarget): Promise<OpenedPullRequest> => {
    calls.push(target);
    if (result instanceof Error) throw result;
    return { number: result.number ?? 7, htmlUrl: result.htmlUrl ?? "https://github.com/acme/api/pull/7", created: result.created ?? true };
  });
  return { calls, fn };
}

describe("runCodingPrPostStep (callable with explicit inputs)", () => {
  it("description + observed pushed branch → PR opened from typed values, pr_opened published, note carries the URL", async () => {
    const spy = openSpy();
    const events: RunEvent[] = [];
    const fetchRepoInfo = vi.fn(unreachable);
    const note = await runCodingPrPostStep({
      observed: observation(),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: "main", resolvedRef: "main" },
      openPullRequest: spy.fn,
      fetchRepoInfo,
      publish: (e) => events.push(e),
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({ repo: "acme/api", headBranch: "feat/x", base: "main", title: DESCRIPTION.title });
    expect(events.some((e) => e.type === "pr_opened")).toBe(true);
    expect(note).toContain("https://github.com/acme/api/pull/7");
    // A binding ref already resolved the base — the GitHub last resort never fires.
    expect(fetchRepoInfo).not.toHaveBeenCalled();
  });

  it("the base falls to the PR's true base ref first (a fix round repushes the PR's own head branch)", async () => {
    const spy = openSpy();
    await runCodingPrPostStep({
      observed: observation(),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: "main", bindingRef: "feat/x", resolvedRef: "feat/x" },
      openPullRequest: spy.fn,
      fetchRepoInfo: unreachable,
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls[0]?.base).toBe("main");
  });

  // Live incident (2026-09-04): a bare issue-link coding run has no
  // bound PR and no explicit ref, and the resident attach failed for an infra
  // reason (not needs-ref) — target's three fields were ALL undefined, so no
  // PR could open despite a real push. The fix: the repo's own default branch,
  // fetched from GitHub, is the true last resort (resolveBaseRefLazy,
  // githubPulls.ts) — shared with agent:ship's identical resolution.
  it("no explicit base signal anywhere, but GitHub's default branch resolves one → PR opens against it", async () => {
    const spy = openSpy();
    const fetchRepoInfo = vi.fn(async (repo: string): Promise<RepoShipInfo | undefined> => {
      expect(repo).toBe("acme/api");
      return { defaultBranch: "main" };
    });
    const note = await runCodingPrPostStep({
      observed: observation(),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: undefined, resolvedRef: undefined },
      openPullRequest: spy.fn,
      fetchRepoInfo,
      publish: () => {},
      logKey: "t",
    });
    expect(fetchRepoInfo).toHaveBeenCalledTimes(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.base).toBe("main");
    expect(note).toContain("PR opened");
  });

  // Review nit (PR #425, F1): the fetch fires here BECAUSE we don't yet know
  // whether the observed branch IS the default branch — that's exactly what
  // this test proves out. Once fetched, the "sat on the base branch, nothing
  // pushed" guard must win over "PR opened": no PR call, no compare-URL note,
  // same as if a candidate had named "main" as the base from the start.
  it("GitHub's fetched default branch equals the observed branch → nothing pushed, no PR call (the branch never left the default)", async () => {
    const spy = openSpy();
    const fetchRepoInfo = vi.fn(async () => ({ defaultBranch: "main" }) as RepoShipInfo);
    const note = await runCodingPrPostStep({
      observed: observation({ branch: "main" }),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: undefined, resolvedRef: undefined },
      openPullRequest: spy.fn,
      fetchRepoInfo,
      publish: () => {},
      logKey: "t",
    });
    expect(fetchRepoInfo).toHaveBeenCalledTimes(1);
    expect(spy.calls).toHaveLength(0);
    expect(note).toBeUndefined();
  });

  it("no explicit base signal AND the GitHub fetch also comes back empty → no PR call, the note names the missing base with the compare URL", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation(),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: undefined, resolvedRef: undefined },
      openPullRequest: spy.fn,
      fetchRepoInfo: async () => undefined,
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(0);
    expect(note).toContain("no base branch");
    expect(note).toContain("https://github.com/acme/api/compare/feat/x");
  });

  it("a failing GitHub fetch degrades honestly — no PR call, same note as a genuinely empty answer", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation(),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: undefined, resolvedRef: undefined },
      openPullRequest: spy.fn,
      fetchRepoInfo: async () => {
        throw new Error("network down");
      },
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(0);
    expect(note).toContain("no base branch");
  });

  it("an unproven push (the remote branch behind the workspace) → honest note naming both commits, no PR call, no compare URL", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation({ remoteHead: "b".repeat(40) }),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: "main", resolvedRef: "main" },
      openPullRequest: spy.fn,
      fetchRepoInfo: unreachable,
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(0);
    expect(note).toContain("has unpushed commits (the remote branch is at bbbbbbb, the workspace at a1b2c3d)");
    expect(note).not.toContain("github.com");
  });

  it("the branch is not on the remote at all → the note says so plainly (never 'no upstream' — the clone's tracking config is not the proof), no PR call, no compare URL", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation({ remoteHead: undefined }),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: "main", resolvedRef: "main" },
      openPullRequest: spy.fn,
      fetchRepoInfo: unreachable,
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(0);
    expect(note).toBe("⚠️ A PR description was submitted but the branch `feat/x` was not found on the remote, so no PR was opened.");
  });

  it("no description and nothing pushed → nothing to report (undefined note), no GitHub fetch", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation({ branch: "main", remoteHead: undefined }),
      description: undefined,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: "main", resolvedRef: "main" },
      openPullRequest: spy.fn,
      fetchRepoInfo: unreachable,
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(0);
    expect(note).toBeUndefined();
  });

  it("no description submitted, no base signal anywhere → no GitHub fetch (never needed for a run with nothing to open)", async () => {
    const spy = openSpy();
    const fetchRepoInfo = vi.fn(unreachable);
    await runCodingPrPostStep({
      observed: observation({ branch: "main", remoteHead: undefined }),
      description: undefined,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: undefined, resolvedRef: undefined },
      openPullRequest: spy.fn,
      fetchRepoInfo,
      publish: () => {},
      logKey: "t",
    });
    expect(fetchRepoInfo).not.toHaveBeenCalled();
  });

  it("no repo anywhere (none at dispatch, no origin remote) → honest note when a description was submitted", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation({ remoteRepo: undefined }),
      description: DESCRIPTION,
      target: { repo: undefined, baseRef: undefined, bindingRef: undefined, resolvedRef: "main" },
      openPullRequest: spy.fn,
      fetchRepoInfo: unreachable,
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(0);
    expect(note).toContain("no repository is known");
  });
});

// The exact remote probe the observation runs — the branch ref shell-quoted,
// `--exit-code` so "no such branch" (exit 2) is distinguishable from a probe
// that failed (network, auth, an unreadable origin).
const LS_REMOTE = "ls-remote --exit-code origin 'refs/heads/feat/x'";
const STALE = "0123456789abcdef0123456789abcdef01234567";
// What `git rev-parse @{u}` prints in a `--depth`/`--single-branch` clone after
// a successful `git push -u`: the fetch refspec covers only the default
// branch, so the remote-tracking ref for the pushed branch never exists (#438).
const SINGLE_BRANCH_UPSTREAM = "exit 128:\nfatal: upstream branch 'refs/heads/feat/x' not stored as a remote-tracking branch\n";
const NO_SUCH_REMOTE_BRANCH = "exit 2:\n";
const REMOTE_UNREACHABLE = "exit 128:\nfatal: unable to access 'https://github.com/acme/api.git/': Could not resolve host: github.com\n";

/** A workspace whose probes answer from `answers` (a regexp per command). */
function workspace(answers: Array<[RegExp, string]>) {
  const exec = vi.fn(async (cmd: string) => answers.find(([re]) => re.test(cmd))?.[1] ?? "exit 128:\nfatal: not a git repository\n");
  const commands = () => exec.mock.calls.map(([c]) => c);
  return { exec, commands };
}

describe("observeCodingWorkspace", () => {
  it("discovers a subdirectory clone when the workspace root is not a repo, and probes the remote inside it too", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.startsWith("ls -d */.git")) return "api/.git\n";
      if (cmd.startsWith("git -C 'api'")) {
        if (/abbrev-ref/.test(cmd)) return "feat/x\n";
        if (/@\{u\}/.test(cmd)) return `${HEAD}\n`;
        if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
        if (/ls-remote/.test(cmd)) return `${HEAD}\trefs/heads/feat/x\n`;
        return "";
      }
      return "fatal: not a git repository\n";
    });
    const observed = await observeCodingWorkspace({ exec }, { probeRemote: false });
    expect(observed).toMatchObject({ head: HEAD, branch: "feat/x", remoteHead: HEAD });
    expect(exec.mock.calls.map(([c]) => c)).toContain(`git -C 'api' ${LS_REMOTE}`);
  });

  // #438 — the incident shape: a cold sandbox clone (`gh repo clone … -- --depth 50`)
  // is single-branch, `git push -u origin <branch>` succeeds and records the
  // upstream in config, but `@{u}` cannot resolve. The push is proven by the
  // remote's own refs/heads/<branch>, not by the clone's tracking state.
  it("single-branch clone (#438): @{u} fails after a successful push, the remote's refs/heads/<branch> at HEAD proves the push", async () => {
    const ws = workspace([
      [/abbrev-ref/, "feat/x\n"],
      [/@\{u\}/, SINGLE_BRANCH_UPSTREAM],
      [/rev-parse HEAD/, `${HEAD}\n`],
      [/ls-remote/, `${HEAD}\trefs/heads/feat/x\n`],
    ]);
    const observed = await observeCodingWorkspace(ws, { probeRemote: false });
    expect(observed.remoteHead).toBe(HEAD);
    expect(ws.commands()).toContain(`git ${LS_REMOTE}`);
  });

  it("no upstream configured at all (a push without -u) → still proven by the remote", async () => {
    const ws = workspace([
      [/abbrev-ref/, "feat/x\n"],
      [/@\{u\}/, "exit 128:\nfatal: no upstream configured for branch 'feat/x'\n"],
      [/rev-parse HEAD/, `${HEAD}\n`],
      [/ls-remote/, `${HEAD}\trefs/heads/feat/x\n`],
    ]);
    expect((await observeCodingWorkspace(ws, { probeRemote: false })).remoteHead).toBe(HEAD);
  });

  it("the remote holds an older commit → that commit is reported (the post-step reads it as unpushed commits)", async () => {
    const ws = workspace([
      [/abbrev-ref/, "feat/x\n"],
      [/@\{u\}/, `${HEAD}\n`], // a stale local record cannot outrank the remote
      [/rev-parse HEAD/, `${HEAD}\n`],
      [/ls-remote/, `${STALE}\trefs/heads/feat/x\n`],
    ]);
    expect((await observeCodingWorkspace(ws, { probeRemote: false })).remoteHead).toBe(STALE);
  });

  it("the remote answers 'no such branch' (exit 2) → not pushed, even when a stale @{u} still resolves (a branch deleted on the remote)", async () => {
    const ws = workspace([
      [/abbrev-ref/, "feat/x\n"],
      [/@\{u\}/, `${HEAD}\n`],
      [/rev-parse HEAD/, `${HEAD}\n`],
      [/ls-remote/, NO_SUCH_REMOTE_BRANCH],
    ]);
    expect((await observeCodingWorkspace(ws, { probeRemote: false })).remoteHead).toBeUndefined();
  });

  it("the remote probe itself fails (network/auth/unreadable origin) → @{u}, the local record of the last push, is the fallback", async () => {
    const reachable = workspace([
      [/abbrev-ref/, "feat/x\n"],
      [/@\{u\}/, `${HEAD}\n`],
      [/rev-parse HEAD/, `${HEAD}\n`],
      [/ls-remote/, REMOTE_UNREACHABLE],
    ]);
    expect((await observeCodingWorkspace(reachable, { probeRemote: false })).remoteHead).toBe(HEAD);
    const nothing = workspace([
      [/abbrev-ref/, "feat/x\n"],
      [/@\{u\}/, SINGLE_BRANCH_UPSTREAM],
      [/rev-parse HEAD/, `${HEAD}\n`],
      [/ls-remote/, REMOTE_UNREACHABLE],
    ]);
    expect((await observeCodingWorkspace(nothing, { probeRemote: false })).remoteHead).toBeUndefined();
  });

  it("only the exact ref counts: an exit-0 answer of other refs (a tail match, a tag) is the remote saying the branch is absent — final, even over a resolving @{u}", async () => {
    const ws = workspace([
      [/abbrev-ref/, "feat/x\n"],
      [/@\{u\}/, `${HEAD}\n`], // a stale local record must not be rescued by a look-alike ref
      [/rev-parse HEAD/, `${HEAD}\n`],
      [/ls-remote/, `${STALE}\trefs/heads/archive/refs/heads/feat/x\n${STALE}\trefs/tags/feat/x\n`],
    ]);
    expect((await observeCodingWorkspace(ws, { probeRemote: false })).remoteHead).toBeUndefined();
  });

  it("an exit-0 answer with no ref line at all is not an answer → a failed probe, @{u} stands in", async () => {
    const ws = workspace([
      [/abbrev-ref/, "feat/x\n"],
      [/@\{u\}/, `${HEAD}\n`],
      [/rev-parse HEAD/, `${HEAD}\n`],
      [/ls-remote/, "(no output)\n"], // the executors' rendering of empty stdout
    ]);
    expect((await observeCodingWorkspace(ws, { probeRemote: false })).remoteHead).toBe(HEAD);
  });

  it("a detached checkout has no branch to look up on the remote: no ls-remote call", async () => {
    const ws = workspace([
      [/abbrev-ref/, "HEAD\n"],
      [/@\{u\}/, "exit 128:\nfatal: HEAD does not point to a branch\n"],
      [/rev-parse HEAD/, `${HEAD}\n`],
    ]);
    const observed = await observeCodingWorkspace(ws, { probeRemote: false });
    expect(observed).toMatchObject({ head: HEAD, branch: undefined, remoteHead: undefined });
    expect(ws.commands().some((c) => /ls-remote/.test(c))).toBe(false);
  });

  it("a branch name with shell metacharacters (git allows ' $ ( ) — never whitespace) reaches ls-remote quoted, never interpolated raw", async () => {
    const ws = workspace([
      [/abbrev-ref/, "feat/it's$(x)\n"],
      [/@\{u\}/, SINGLE_BRANCH_UPSTREAM],
      [/rev-parse HEAD/, `${HEAD}\n`],
      [/ls-remote/, `${HEAD}\trefs/heads/feat/it's$(x)\n`],
    ]);
    const observed = await observeCodingWorkspace(ws, { probeRemote: false });
    expect(ws.commands()).toContain(`git ls-remote --exit-code origin 'refs/heads/feat/it'\\''s$(x)'`);
    expect(observed.remoteHead).toBe(HEAD);
  });

  it("probes the origin remote only when asked, and vets it to a GitHub slug", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (/abbrev-ref/.test(cmd)) return "feat/x\n";
      if (/@\{u\}/.test(cmd)) return `${HEAD}\n`;
      if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
      if (/ls-remote/.test(cmd)) return `${HEAD}\trefs/heads/feat/x\n`;
      if (/remote get-url origin/.test(cmd)) return "git@github.com:Acme/API.git\n";
      return "";
    });
    const observed = await observeCodingWorkspace({ exec }, { probeRemote: true });
    expect(observed.remoteRepo).toBe("acme/api");
    const noProbe = await observeCodingWorkspace({ exec }, { probeRemote: false });
    expect(noProbe.remoteRepo).toBeUndefined();
  });
});
