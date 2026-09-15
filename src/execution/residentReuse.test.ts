import { describe, expect, it } from "vitest";
import { decideWorktree, parseReuse, type WorktreeFacts } from "./residentReuse.js";

// Feature: docs/reference/specs/resident-repos.md item 66: a resumed run's attach
// reuses the thread's worktree as it stands: a dirty or stale tree is the run's
// own work, and a tree that cannot be reused is a named refusal, never an rm -rf.
// A fresh attach keeps item 17's discipline byte for byte.

const SHA = "1220b9c487f9538a6dd509ef11b6a5042d85bd05";
const OTHER = "47c4230692cbc5961682532afb822e9c2f1f40b7";
const WT = "/workspace/threads/slack-CX-1.0-abcd1234/main";

const readable = (over: Partial<WorktreeFacts> = {}): WorktreeFacts => ({
  exists: true,
  readable: true,
  dirty: false,
  head: SHA,
  ...over,
});

describe("parseReuse: the `reuse` body field", () => {
  it("absent → false (a fresh attach, the body every bot always sent); a boolean → itself", () => {
    expect(parseReuse(undefined)).toEqual({ reuse: false });
    expect(parseReuse(true)).toEqual({ reuse: true });
    expect(parseReuse(false)).toEqual({ reuse: false });
  });

  it("anything else is a named 400-shaped error", () => {
    expect(parseReuse("yes")).toEqual({ error: "reuse must be a boolean when present" });
    expect(parseReuse(1)).toEqual({ error: "reuse must be a boolean when present" });
    expect(parseReuse(null)).toEqual({ error: "reuse must be a boolean when present" });
  });
});

describe("decideWorktree: a reuse-only attach keeps the tree as it stands", () => {
  it("a dirty tree is reused: the tracked changes are the run's own work", () => {
    expect(
      decideWorktree({ reuse: true, modeSwitch: false, sha: SHA, worktreePath: WT, facts: readable({ dirty: true }) }),
    ).toEqual({ kind: "reuse" });
  });

  it("a stale tree is reused: the run's HEAD is where the run left it, whatever the mirror's tip is now", () => {
    expect(
      decideWorktree({
        reuse: true,
        modeSwitch: false,
        sha: SHA,
        worktreePath: WT,
        facts: readable({ head: OTHER, descendsFromTip: false }),
      }),
    ).toEqual({ kind: "reuse" });
    // The ancestry probe is not even consulted: an unmeasured value reuses too.
    expect(
      decideWorktree({ reuse: true, modeSwitch: false, sha: SHA, worktreePath: WT, facts: readable({ head: OTHER }) }),
    ).toEqual({ kind: "reuse" });
  });

  it("a tree that is gone is refused by name, never recreated", () => {
    const d = decideWorktree({ reuse: true, modeSwitch: false, sha: SHA, worktreePath: WT, facts: { exists: false } });
    expect(d.kind).toBe("refuse");
    expect(d).toMatchObject({ why: expect.stringContaining(`no worktree at ${WT}`) });
  });

  it("a tree git cannot read is refused by name, with the probe's own words", () => {
    const d = decideWorktree({
      reuse: true,
      modeSwitch: false,
      sha: SHA,
      worktreePath: WT,
      facts: { exists: true, readable: false, detail: "fatal: not a git repository" },
    });
    expect(d).toEqual({
      kind: "refuse",
      why: `the worktree at ${WT} cannot be read (fatal: not a git repository)`,
    });
  });

  it("a tree built for the other mode is refused: a resumed run never changes mode, so this is not its tree", () => {
    const d = decideWorktree({ reuse: true, modeSwitch: true, sha: SHA, worktreePath: WT, facts: readable() });
    expect(d).toEqual({
      kind: "refuse",
      why: `the worktree at ${WT} was built for the other mode (read-only against writable)`,
    });
  });
});

describe("decideWorktree: a fresh attach keeps the dirty/stale discipline", () => {
  it("a missing tree is created", () => {
    expect(
      decideWorktree({ reuse: false, modeSwitch: false, sha: SHA, worktreePath: WT, facts: { exists: false } }),
    ).toEqual({ kind: "recreate", why: "missing" });
  });

  it("a mode switch recreates before any other check", () => {
    expect(decideWorktree({ reuse: false, modeSwitch: true, sha: SHA, worktreePath: WT, facts: readable() })).toEqual({
      kind: "recreate",
      why: "mode-switch",
    });
  });

  it("an unreadable tree is recreated", () => {
    expect(
      decideWorktree({
        reuse: false,
        modeSwitch: false,
        sha: SHA,
        worktreePath: WT,
        facts: { exists: true, readable: false, detail: "boom" },
      }),
    ).toEqual({ kind: "recreate", why: "unreadable" });
  });

  it("dirty tracked files recreate", () => {
    expect(
      decideWorktree({ reuse: false, modeSwitch: false, sha: SHA, worktreePath: WT, facts: readable({ dirty: true }) }),
    ).toEqual({ kind: "recreate", why: "dirty" });
  });

  it("a HEAD that is neither the tip nor a descendant of it is stale and recreates; a descendant is kept", () => {
    expect(
      decideWorktree({
        reuse: false,
        modeSwitch: false,
        sha: SHA,
        worktreePath: WT,
        facts: readable({ head: OTHER, descendsFromTip: false }),
      }),
    ).toEqual({ kind: "recreate", why: "stale" });
    expect(
      decideWorktree({
        reuse: false,
        modeSwitch: false,
        sha: SHA,
        worktreePath: WT,
        facts: readable({ head: OTHER, descendsFromTip: true }),
      }),
    ).toEqual({ kind: "reuse" });
  });

  it("a clean tree at the tip is reused byte for byte", () => {
    expect(decideWorktree({ reuse: false, modeSwitch: false, sha: SHA, worktreePath: WT, facts: readable() })).toEqual({
      kind: "reuse",
    });
  });
});
