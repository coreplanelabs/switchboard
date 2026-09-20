import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { forcePushWithLease, localGitRunner, patchUnchanged, rebaseOntoBase, type GitRunner } from "./gitRebase.js";

// Real git in a temp directory: the sweep's rung one is git's own behavior
// (rerere replay, range-diff, force-with-lease), so the proof runs git itself.

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A 12-line seed file: room for hunks far enough apart that a base move
 *  leaves the branch's patch text byte-identical. */
const SEED = "l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\n";
const edit = (line: number, to: string): string =>
  SEED.split("\n")
    .map((l) => (l === `l${line}` ? to : l))
    .join("\n");

/** An "origin" repo with main at the seed file, and a clone to work in. */
function makeRepos(): { origin: string; work: string } {
  const root = mkdtempSync(join(tmpdir(), "sweep-git-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  const seed = join(root, "seed");
  execFileSync("git", ["init", "-b", "main", seed]);
  sh(seed, "config", "user.email", "t@example.test");
  sh(seed, "config", "user.name", "t");
  writeFileSync(join(seed, "f.txt"), SEED);
  sh(seed, "add", ".");
  sh(seed, "commit", "-m", "seed");
  sh(seed, "remote", "add", "origin", origin);
  sh(seed, "push", "origin", "main");
  const work = join(root, "work");
  execFileSync("git", ["clone", origin, work]);
  sh(work, "config", "user.email", "t@example.test");
  sh(work, "config", "user.name", "t");
  return { origin, work };
}

function commitFile(cwd: string, file: string, content: string, message: string): void {
  writeFileSync(join(cwd, file), content);
  sh(cwd, "add", file);
  sh(cwd, "commit", "-m", message);
}

describe("gitRebase — rung one is git alone", () => {
  it("a clean rebase whose patch is unchanged (range-diff all '='), and the lease push lands", async () => {
    const { work } = makeRepos();
    // Branch edits line twelve; main moves on line one — hunks far apart, the
    // branch's patch text identical after the rebase.
    sh(work, "checkout", "-b", "b1");
    commitFile(work, "f.txt", edit(12, "L12"), "branch: l12");
    const preHead = sh(work, "rev-parse", "HEAD").trim();
    sh(work, "push", "-u", "origin", "b1");
    sh(work, "checkout", "main");
    commitFile(work, "f.txt", edit(1, "L1"), "base: l1");
    sh(work, "push", "origin", "main");
    sh(work, "checkout", "b1");
    const outcome = await rebaseOntoBase(localGitRunner, { dir: work, base: "main" });
    expect(outcome.kind).toBe("clean");
    const newHead = (outcome as { newHead: string }).newHead;
    expect(newHead).not.toBe(preHead);
    expect(await patchUnchanged(localGitRunner, { dir: work, base: "main", preRebaseHead: preHead, newHead })).toBe(
      true,
    );
    await forcePushWithLease(localGitRunner, { dir: work, branch: "b1", preRebaseHead: preHead });
    expect(sh(work, "ls-remote", "origin", "refs/heads/b1")).toContain(newHead);
  });

  it("a base edit inside the branch hunk's context changes the patch — range-diff says so", async () => {
    const { work } = makeRepos();
    // Line 8 and line 5: three lines apart — clean to merge, but inside the
    // branch hunk's context, so the rebased patch's text differs.
    sh(work, "checkout", "-b", "b2");
    commitFile(work, "f.txt", edit(8, "L8"), "branch: l8");
    const preHead = sh(work, "rev-parse", "HEAD").trim();
    sh(work, "checkout", "main");
    commitFile(work, "f.txt", edit(5, "L5"), "base: l5");
    sh(work, "push", "origin", "main");
    sh(work, "checkout", "b2");
    const outcome = await rebaseOntoBase(localGitRunner, { dir: work, base: "main" });
    expect(outcome.kind).toBe("clean");
    const newHead = (outcome as { newHead: string }).newHead;
    expect(await patchUnchanged(localGitRunner, { dir: work, base: "main", preRebaseHead: preHead, newHead })).toBe(
      false,
    );
  });

  it("a changed patch whose every range-diff line contains ' = ' still reads as changed", async () => {
    const { work } = makeRepos();
    // Assignment-heavy content and an ' = ' in the subject: every line of the
    // range-diff — the '!' header, the hunk header's function line, the
    // interdiff — contains ' = ', so an unanchored substring match would read
    // this changed patch as unchanged and carry the approval past re-review.
    const assigns = (last: string): string => `a = 1\nb = 2\nc = 3\nd = 4\ne = 5\nf = 6\ng = 7\nh = ${last}\n`;
    commitFile(work, "k.ts", assigns("8"), "seed: h = 8");
    sh(work, "push", "origin", "main");
    const preHead = sh(work, "rev-parse", "HEAD").trim();
    sh(work, "checkout", "-b", "changed");
    commitFile(work, "k.ts", assigns("81"), "fix: set h = 80");
    const newHead = sh(work, "rev-parse", "HEAD").trim();
    sh(work, "checkout", "-q", `${preHead}`);
    sh(work, "checkout", "-b", "pre");
    commitFile(work, "k.ts", assigns("80"), "fix: set h = 80");
    const preRebaseHead = sh(work, "rev-parse", "HEAD").trim();
    const diff = sh(work, "range-diff", `origin/main..${preRebaseHead}`, `origin/main..${newHead}`);
    // The fixture holds: no line of this range-diff is without ' = '.
    expect(diff.split("\n").filter((l) => l.trim() !== "" && !/ = /.test(l))).toEqual([]);
    expect(await patchUnchanged(localGitRunner, { dir: work, base: "main", preRebaseHead, newHead })).toBe(false);
  });

  it("a rebase refused for a non-conflict reason (a dirty checkout) throws git's words, never a conflict", async () => {
    const { work } = makeRepos();
    sh(work, "checkout", "-b", "b7");
    commitFile(work, "f.txt", edit(12, "L12"), "branch: l12");
    sh(work, "checkout", "main");
    commitFile(work, "f.txt", edit(1, "L1"), "base: l1");
    sh(work, "push", "origin", "main");
    sh(work, "checkout", "b7");
    writeFileSync(join(work, "f.txt"), edit(12, "dirty, uncommitted"));
    await expect(rebaseOntoBase(localGitRunner, { dir: work, base: "main" })).rejects.toThrow(/git rebase failed/);
  });

  it("a --continue that cannot progress past one stop aborts and throws, never a 'unknown file' conflict", async () => {
    // Scripted runner: the rebase stops, nothing is unmerged (rerere staged it),
    // and `--continue` stops on the SAME commit again — the emptied-commit shape
    // that demands `--skip`. The loop must abort and throw, not spin.
    const calls: string[][] = [];
    const scripted: GitRunner = {
      run: async (args) => {
        calls.push([...args]);
        const cmd = args.join(" ");
        if (cmd.startsWith("fetch")) return { code: 0, stdout: "", stderr: "" };
        if (cmd.includes("rebase --abort")) return { code: 0, stdout: "", stderr: "" };
        if (cmd.includes("rebase --show-current-patch")) return { code: 0, stdout: "patch", stderr: "" };
        if (cmd.includes("diff --name-only")) return { code: 0, stdout: "", stderr: "" };
        if (cmd.includes("rev-parse --verify REBASE_HEAD")) return { code: 0, stdout: "abc123\n", stderr: "" };
        if (cmd.includes("rebase --continue"))
          return { code: 1, stdout: "", stderr: "No changes - did you forget to use 'git add'?" };
        if (cmd.includes("rebase ")) return { code: 1, stdout: "", stderr: "stopped" };
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    await expect(rebaseOntoBase(scripted, { dir: "/nowhere", base: "main" })).rejects.toThrow(
      /made no progress at abc123/,
    );
    expect(calls.filter((a) => a.includes("--continue")).length).toBe(1);
    expect(calls.some((a) => a.includes("--abort"))).toBe(true);
  });

  it("a conflict git cannot take aborts the rebase, names the file, and leaves the checkout as it was", async () => {
    const { work } = makeRepos();
    sh(work, "checkout", "-b", "b3");
    commitFile(work, "f.txt", edit(1, "ONE"), "branch: one");
    const preHead = sh(work, "rev-parse", "HEAD").trim();
    sh(work, "checkout", "main");
    commitFile(work, "f.txt", edit(1, "UNO"), "base: uno");
    sh(work, "push", "origin", "main");
    sh(work, "checkout", "b3");
    const outcome = await rebaseOntoBase(localGitRunner, { dir: work, base: "main" });
    expect(outcome).toEqual({ kind: "conflict", file: "f.txt" });
    expect(sh(work, "rev-parse", "HEAD").trim()).toBe(preHead);
    expect(sh(work, "status", "--porcelain")).toBe("");
  });

  it("rerere replays a resolution made once on a later rebase of the same hunks — no model round", async () => {
    const { work } = makeRepos();
    // Two branches carry the SAME conflicting change; main moves under both.
    sh(work, "checkout", "-b", "b4");
    commitFile(work, "f.txt", edit(1, "ONE"), "branch: one");
    sh(work, "checkout", "main");
    sh(work, "checkout", "-b", "b5");
    commitFile(work, "f.txt", edit(1, "ONE"), "branch: one again");
    sh(work, "checkout", "main");
    commitFile(work, "f.txt", edit(1, "UNO"), "base: uno");
    sh(work, "push", "origin", "main");
    // First rebase: conflict; a person resolves it once, rerere records it.
    sh(work, "checkout", "b4");
    sh(work, "fetch", "origin", "main");
    let conflicted = false;
    try {
      sh(work, "-c", "rerere.enabled=true", "-c", "rerere.autoUpdate=true", "rebase", "origin/main");
    } catch {
      conflicted = true;
    }
    expect(conflicted).toBe(true);
    writeFileSync(join(work, "f.txt"), edit(1, "MERGED"));
    sh(work, "add", "f.txt");
    sh(
      work,
      "-c",
      "rerere.enabled=true",
      "-c",
      "rerere.autoUpdate=true",
      "-c",
      "core.editor=true",
      "rebase",
      "--continue",
    );
    // Second rebase, same hunks: rerere replays the recorded resolution and the
    // resolver's rung one completes clean.
    sh(work, "checkout", "b5");
    const outcome = await rebaseOntoBase(localGitRunner, { dir: work, base: "main" });
    expect(outcome.kind).toBe("clean");
    expect(sh(work, "show", "HEAD:f.txt")).toBe(edit(1, "MERGED"));
  });

  it("a lease push against a remote that moved under the sweep is refused", async () => {
    const { work, origin } = makeRepos();
    sh(work, "checkout", "-b", "b6");
    commitFile(work, "f.txt", edit(12, "L12"), "branch: l12");
    const preHead = sh(work, "rev-parse", "HEAD").trim();
    sh(work, "push", "-u", "origin", "b6");
    // The remote branch moves under us (another clone pushes).
    const root = mkdtempSync(join(tmpdir(), "sweep-git-other-"));
    roots.push(root);
    const other = join(root, "other");
    execFileSync("git", ["clone", "--branch", "b6", origin, other]);
    sh(other, "config", "user.email", "o@example.test");
    sh(other, "config", "user.name", "o");
    commitFile(other, "g.txt", "moved\n", "someone else pushed");
    sh(other, "push", "origin", "b6");
    // Our lease still names preHead — the push must be refused, not forced.
    commitFile(work, "f.txt", edit(12, "L12B"), "another local commit");
    await expect(
      forcePushWithLease(localGitRunner, { dir: work, branch: "b6", preRebaseHead: preHead }),
    ).rejects.toThrow(/git push refused/);
  });
});
