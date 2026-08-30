import { describe, expect, it } from "vitest";
import { parseWorktreeCleanliness, worktreeCleanlinessScript } from "./residentCleanliness.js";

const r = (stdout: string, over: Partial<{ stderr: string; exitCode: number; timedOut: boolean }> = {}) => ({
  stdout,
  stderr: "",
  exitCode: 0,
  timedOut: false,
  ...over,
});

describe("worktreeCleanlinessScript (#356 item 6: three probes in one spawn)", () => {
  const script = worktreeCleanlinessScript("/workspace/threads/t1/wt", "worker3");
  it("probes .git existence before touching git, and short-circuits when it is missing", () => {
    expect(script).toContain("test -d '/workspace/threads/t1/wt/.git'");
    expect(script).toContain("present=no");
  });
  it("runs the git probes AS THE THREAD USER via su, never root git in a thread-writable tree", () => {
    expect(script).toContain("su -s /bin/bash 'worker3' -c ");
    // Both probes live inside the su -c payload, after the su invocation.
    const su = script.slice(script.indexOf("su -s /bin/bash"));
    expect(su).toContain("git status --porcelain");
    expect(su).toContain("git rev-list --count HEAD --not --remotes");
  });
  it("quotes a hostile worktree path so it cannot break out of the script", () => {
    const s = worktreeCleanlinessScript("/workspace/threads/a'; rm -rf /; '/wt", "worker2");
    expect(s).toContain(`'/workspace/threads/a'\\''; rm -rf /; '\\''/wt/.git'`);
  });
});

describe("parseWorktreeCleanliness (tag-keyed, PAM-banner safe)", () => {
  it("a missing worktree is releasable: nothing to preserve", () => {
    expect(parseWorktreeCleanliness(r("present=no\n"))).toEqual({ clean: true, reason: "worktree missing (disk recycled)" });
  });
  it("a clean tree with nothing unpushed is clean", () => {
    expect(parseWorktreeCleanliness(r("present=yes\ngitrc=0\nchanges=0\nunpushed=0\n"))).toEqual({ clean: true });
  });
  it("uncommitted changes and unpushed commits are named, in the exact pre-existing wording", () => {
    expect(parseWorktreeCleanliness(r("present=yes\ngitrc=0\nchanges=3\nunpushed=2\n"))).toEqual({
      clean: false,
      reason: "dirty: 3 uncommitted change(s), 2 unpushed commit(s)",
    });
  });
  it("unpushed commits alone are dirty", () => {
    expect(parseWorktreeCleanliness(r("present=yes\ngitrc=0\nchanges=0\nunpushed=1\n")).clean).toBe(false);
  });
  it("a failed git probe is NOT clean — never destroy work on a guess — and the first error line is named", () => {
    expect(parseWorktreeCleanliness(r("present=yes\ngitrc=1\ngiterr=fatal: not a git repository\n"))).toEqual({
      clean: false,
      reason: "clean-check failed: fatal: not a git repository",
    });
  });
  it("a probe that failed without a message still fails closed", () => {
    expect(parseWorktreeCleanliness(r("present=yes\ngitrc=1\ngiterr=git exited non-zero\n"))).toEqual({
      clean: false,
      reason: "clean-check failed: git exited non-zero",
    });
  });
  it("a script that died before emitting gitrc (su refused, timeout) fails closed with the stderr's first line", () => {
    expect(parseWorktreeCleanliness(r("present=yes\n", { exitCode: 1, stderr: "su: user worker3 does not exist\nmore" }))).toEqual({
      clean: false,
      reason: "clean-check failed: su: user worker3 does not exist",
    });
    expect(parseWorktreeCleanliness(r("present=yes\ngitrc=0\nchanges=0\nunpushed=0\n", { timedOut: true })).clean).toBe(false);
  });
  it("a PAM/su banner cannot shift a field: tags are keyed, not positional, and the first occurrence wins", () => {
    expect(
      parseWorktreeCleanliness(r("Warning: your password will expire\npresent=yes\ngitrc=0\nchanges=0\nunpushed=0\npresent=no\n")),
    ).toEqual({ clean: true });
  });
  it("a non-numeric unpushed value reads as 0, exactly like the old Number(...) || 0", () => {
    expect(parseWorktreeCleanliness(r("present=yes\ngitrc=0\nchanges=0\nunpushed=oops\n"))).toEqual({ clean: true });
  });
});
