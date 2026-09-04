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
  upstream: HEAD,
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

  it("an unproven push (upstream behind) → honest note, no PR call, no compare URL", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation({ upstream: "b".repeat(40) }),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: "main", resolvedRef: "main" },
      openPullRequest: spy.fn,
      fetchRepoInfo: unreachable,
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(0);
    expect(note).toContain("unpushed commits");
    expect(note).not.toContain("github.com");
  });

  it("no description and nothing pushed → nothing to report (undefined note), no GitHub fetch", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation({ branch: "main", upstream: undefined }),
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
      observed: observation({ branch: "main", upstream: undefined }),
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

describe("observeCodingWorkspace", () => {
  it("discovers a subdirectory clone when the workspace root is not a repo", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (cmd.startsWith("ls -d */.git")) return "api/.git\n";
      if (cmd.startsWith("git -C 'api'")) {
        if (/abbrev-ref/.test(cmd)) return "feat/x\n";
        if (/@\{u\}/.test(cmd)) return `${HEAD}\n`;
        if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
        return "";
      }
      return "fatal: not a git repository\n";
    });
    const observed = await observeCodingWorkspace({ exec }, { probeRemote: false });
    expect(observed).toMatchObject({ head: HEAD, branch: "feat/x", upstream: HEAD });
  });

  it("probes the origin remote only when asked, and vets it to a GitHub slug", async () => {
    const exec = vi.fn(async (cmd: string) => {
      if (/abbrev-ref/.test(cmd)) return "feat/x\n";
      if (/@\{u\}/.test(cmd)) return `${HEAD}\n`;
      if (/rev-parse HEAD/.test(cmd)) return `${HEAD}\n`;
      if (/remote get-url origin/.test(cmd)) return "git@github.com:Acme/API.git\n";
      return "";
    });
    const observed = await observeCodingWorkspace({ exec }, { probeRemote: true });
    expect(observed.remoteRepo).toBe("acme/api");
    const noProbe = await observeCodingWorkspace({ exec }, { probeRemote: false });
    expect(noProbe.remoteRepo).toBeUndefined();
  });
});
