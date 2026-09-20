import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSweepGit, sweepCloneUrl } from "./sweepCheckout.js";
import { localGitRunner, type GitRunner } from "./gitRebase.js";
import { createPullSweepService, type SweepEffects, type SweepPullRequest } from "../core/pullSweep.js";

// The sweep's checkout (agent-ship.md item 20, issue 2067): `SweepGit` over a
// throwaway clone of the pull request's branch — real git in a temp directory,
// end to end: a DIRTY pull request from the fixture walks rung one whole
// (clone, rebase, range-diff, lease push, the carry) through the sweep service
// itself, and a conflicting one comes back named with the checkout removed.

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

const SEED = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n";
const edit = (line: number, to: string): string =>
  SEED.split("\n")
    .map((l) => (l === `l${line}` ? to : l))
    .join("\n");

function commitFile(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-m", message);
  return sh(cwd, "rev-parse", "HEAD").trim();
}

/** An "origin" with main at the seed and a pull-request branch, the base then
 *  moved: `baseEdit` far from the branch's hunk keeps the patch identical,
 *  one on the same line conflicts. */
function fixture(opts: { branchLine: number; baseLine: number }): {
  root: string;
  origin: string;
  branchHead: string;
  tmpRoot: string;
} {
  const root = mkdtempSync(join(tmpdir(), "sweep-checkout-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-b", "main", seed]);
  sh(seed, "config", "user.email", "t@example.test");
  sh(seed, "config", "user.name", "t");
  commitFile(seed, "f.txt", SEED, "seed");
  sh(seed, "remote", "add", "origin", origin);
  sh(seed, "push", "origin", "main");
  sh(seed, "checkout", "-b", "plan/demo/u1");
  const branchHead = commitFile(seed, "f.txt", edit(opts.branchLine, "BRANCH"), "branch change");
  sh(seed, "push", "origin", "plan/demo/u1");
  sh(seed, "checkout", "main");
  commitFile(seed, "f.txt", edit(opts.baseLine, "BASE"), "base moved");
  sh(seed, "push", "origin", "main");
  const tmpRoot = join(root, "checkouts");
  execFileSync("mkdir", ["-p", tmpRoot]);
  return { root, origin, branchHead, tmpRoot };
}

const pullRequest = (branchHead: string, approved = true): SweepPullRequest => ({
  repo: "acme/api",
  number: 7,
  branch: "plan/demo/u1",
  base: "main",
  headSha: branchHead,
  // GitHub's own fact from the fixture: the sweep trusts it, git decides the rest.
  mergeableState: "dirty",
  approved,
});

function recordingEffects(): { calls: string[]; effects: SweepEffects } {
  const calls: string[] = [];
  return {
    calls,
    effects: {
      carryApproval: async (_pr, newHead) => {
        calls.push(`carry@${newHead}`);
      },
      requestDeltaReview: async (_pr, newHead) => {
        calls.push(`delta@${newHead}`);
      },
      regenerateAnchors: async (_pr, newHead) => {
        calls.push(`anchors@${newHead}`);
      },
      modelRoundSpent: async () => false,
      startModelRound: async () => {
        calls.push("model-round");
        return { started: true };
      },
    },
  };
}

describe("createSweepGit — rung one in a throwaway clone, real git", () => {
  it("a DIRTY pull request walks rung one end to end: clone, rebase, unchanged patch, lease push, approval carried, checkout removed", async () => {
    // Base moved far from the branch's hunk: rebase clean, patch byte-identical.
    const { origin, branchHead, tmpRoot } = fixture({ branchLine: 12, baseLine: 1 });
    const git = createSweepGit({
      cloneUrl: async () => origin,
      identity: async () => ({ name: "sweep", email: "sweep@example.test" }),
      tmpRoot,
    });
    const { calls, effects } = recordingEffects();
    const service = createPullSweepService({
      listOwnedPullRequests: async () => [pullRequest(branchHead)],
      git,
      effects,
    });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results).toEqual([
      { repo: "acme/api", number: 7, outcome: "carried", line: "#7 rebased, patch unchanged, approval carried" },
    ]);
    // The push landed on origin at a new head that carries the base's move.
    const remoteHead = sh(origin, "rev-parse", "refs/heads/plan/demo/u1").trim();
    expect(remoteHead).not.toBe(branchHead);
    expect(sh(origin, "show", `${remoteHead}:f.txt`)).toContain("BASE");
    expect(sh(origin, "show", `${remoteHead}:f.txt`)).toContain("BRANCH");
    expect(calls).toEqual([`anchors@${remoteHead}`, `carry@${remoteHead}`]);
    // The throwaway checkout is gone with the walk.
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("a conflict git leaves comes back named, the checkout is removed, and the model round is the service's step", async () => {
    const { origin, branchHead, tmpRoot } = fixture({ branchLine: 5, baseLine: 5 });
    const git = createSweepGit({
      cloneUrl: async () => origin,
      identity: async () => ({ name: "sweep", email: "sweep@example.test" }),
      tmpRoot,
    });
    const { calls, effects } = recordingEffects();
    const service = createPullSweepService({
      listOwnedPullRequests: async () => [pullRequest(branchHead)],
      git,
      effects,
    });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results).toEqual([
      { repo: "acme/api", number: 7, outcome: "fix-round", line: "#7 conflict in f.txt, a fix round is running" },
    ]);
    expect(calls).toEqual(["model-round"]);
    // Origin never moved and the checkout is gone.
    expect(sh(origin, "rev-parse", "refs/heads/plan/demo/u1").trim()).toBe(branchHead);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it("patchUnchanged and forcePushWithLease refuse a pull request rebase() never opened", async () => {
    const { origin, branchHead, tmpRoot } = fixture({ branchLine: 12, baseLine: 1 });
    const git = createSweepGit({ cloneUrl: async () => origin, tmpRoot });
    await expect(git.patchUnchanged(pullRequest(branchHead), "0".repeat(40))).rejects.toThrow(/no checkout is open/);
    await expect(git.forcePushWithLease(pullRequest(branchHead), "0".repeat(40))).rejects.toThrow(
      /no checkout is open/,
    );
    expect(existsSync(tmpRoot)).toBe(true);
  });

  it("the credential rides the clone's config as a header, never the remote URL git quotes on failure", async () => {
    const { origin, branchHead, tmpRoot } = fixture({ branchLine: 12, baseLine: 1 });
    const seen: string[][] = [];
    const recording: GitRunner = {
      run: (args, cwd) => {
        seen.push([...args]);
        return localGitRunner.run(args, cwd);
      },
    };
    const git = createSweepGit({
      runner: recording,
      cloneUrl: async () => origin,
      // Harmless on a local-path clone: git ignores http.* for the file
      // transport, so the real walk still runs end to end.
      authHeader: async () => "Authorization: Basic dG9rZW4=",
      identity: async () => ({ name: "sweep", email: "sweep@example.test" }),
      tmpRoot,
    });
    const { effects } = recordingEffects();
    const service = createPullSweepService({
      listOwnedPullRequests: async () => [pullRequest(branchHead)],
      git,
      effects,
    });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.outcome).toBe("carried");
    const clone = seen.find((args) => args[0] === "clone");
    expect(clone).toEqual([
      "clone",
      "--config",
      "http.extraHeader=Authorization: Basic dG9rZW4=",
      "--branch",
      "plan/demo/u1",
      origin,
      expect.stringContaining("pull-sweep-"),
    ]);
    // The production URL itself is credential-free.
    expect(await sweepCloneUrl("acme/api")).toBe("https://github.com/acme/api.git");
  });

  it("a failing clone's user-facing line carries no token, even when git's stderr quotes one", async () => {
    // A GitHub outage or 403 makes git print the remote URL verbatim; the
    // sweep's line must reach chat with the credential shape redacted.
    const failing: GitRunner = {
      run: async () => ({
        code: 128,
        stdout: "",
        stderr:
          "fatal: unable to access 'https://x-access-token:ghs_secret1234567890abcdefghij@github.com/acme/api.git/': Could not resolve host: github.com",
      }),
    };
    const git = createSweepGit({ runner: failing, cloneUrl: async () => "https://github.com/acme/api.git" });
    const { effects } = recordingEffects();
    const service = createPullSweepService({
      listOwnedPullRequests: async () => [pullRequest("0".repeat(40))],
      git,
      effects,
    });
    const report = await service.sweep({ repo: "acme/api" });
    expect(report.results[0]?.outcome).toBe("error");
    expect(report.results[0]?.line).not.toContain("ghs_secret1234567890abcdefghij");
    expect(report.results[0]?.line).toContain("x-access-token:«redacted»");
  });

  it("a clone that fails throws git's own words and leaves no checkout behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "sweep-checkout-"));
    roots.push(root);
    const git = createSweepGit({ cloneUrl: async () => join(root, "no-such-repo.git"), tmpRoot: root });
    await expect(git.rebase({ ...pullRequest("0".repeat(40)), repo: "acme/gone" })).rejects.toThrow(/git clone failed/);
    expect(readdirSync(root).filter((d) => d.startsWith("pull-sweep-"))).toEqual([]);
  });
});
