import { describe, expect, it, vi } from "vitest";
import type { OpenedPullRequest, PullRequestTarget } from "../execution/githubPulls.js";
import type { RunEvent } from "./runEvents.js";
import { observeCodingWorkspace, runCodingPrPostStep, type WorkspaceObservation } from "./codingPrPostStep.js";

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
    const note = await runCodingPrPostStep({
      observed: observation(),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: "main", resolvedRef: "main" },
      openPullRequest: spy.fn,
      publish: (e) => events.push(e),
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]).toMatchObject({ repo: "acme/api", headBranch: "feat/x", base: "main", title: DESCRIPTION.title });
    expect(events.some((e) => e.type === "pr_opened")).toBe(true);
    expect(note).toContain("https://github.com/acme/api/pull/7");
  });

  it("the base falls to the PR's true base ref first (a fix round repushes the PR's own head branch)", async () => {
    const spy = openSpy();
    await runCodingPrPostStep({
      observed: observation(),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: "main", bindingRef: "feat/x", resolvedRef: "feat/x" },
      openPullRequest: spy.fn,
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls[0]?.base).toBe("main");
  });

  it("no base resolvable → no PR call, the note names the missing base with the compare URL", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation(),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: undefined, resolvedRef: undefined },
      openPullRequest: spy.fn,
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(0);
    expect(note).toContain("no base branch");
    expect(note).toContain("https://github.com/acme/api/compare/feat/x");
  });

  it("an unproven push (upstream behind) → honest note, no PR call, no compare URL", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation({ upstream: "b".repeat(40) }),
      description: DESCRIPTION,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: "main", resolvedRef: "main" },
      openPullRequest: spy.fn,
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(0);
    expect(note).toContain("unpushed commits");
    expect(note).not.toContain("github.com");
  });

  it("no description and nothing pushed → nothing to report (undefined note)", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation({ branch: "main", upstream: undefined }),
      description: undefined,
      target: { repo: "acme/api", baseRef: undefined, bindingRef: "main", resolvedRef: "main" },
      openPullRequest: spy.fn,
      publish: () => {},
      logKey: "t",
    });
    expect(spy.calls).toHaveLength(0);
    expect(note).toBeUndefined();
  });

  it("no repo anywhere (none at dispatch, no origin remote) → honest note when a description was submitted", async () => {
    const spy = openSpy();
    const note = await runCodingPrPostStep({
      observed: observation({ remoteRepo: undefined }),
      description: DESCRIPTION,
      target: { repo: undefined, baseRef: undefined, bindingRef: undefined, resolvedRef: "main" },
      openPullRequest: spy.fn,
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
