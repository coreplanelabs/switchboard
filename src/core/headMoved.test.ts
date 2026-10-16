import { describe, expect, it } from "vitest";
import {
  classifyHeadMove,
  headMovedNote,
  headRereviewNote,
  rereviewFollowUp,
  type HeadMove,
  type PrCommitList,
} from "./headMoved.js";

type Sub = Extract<HeadMove, { kind: "substantive" }>;

const A = "e8e43f480a09b76989b85ebe6a2a254d99a4d2a3";
const B = "d75b5a51aba97d43c64a42c96e580dd9abbfd78e";

describe("headMovedNote (review post-step, agent-review.md item 10)", () => {
  it("no note when the PR head is still the reviewed commit (full or 7-char form)", () => {
    expect(headMovedNote({ where: "acme/api#42", reviewed: A, current: A })).toBeUndefined();
    expect(headMovedNote({ where: "acme/api#42", reviewed: A, current: A.slice(0, 7) })).toBeUndefined();
    expect(headMovedNote({ where: "acme/api#42", reviewed: A.toUpperCase(), current: A })).toBeUndefined();
  });
  it("no note when the current head is unknown (fetch failed) — never a false alarm", () => {
    expect(headMovedNote({ where: "acme/api#42", reviewed: A })).toBeUndefined();
    expect(headMovedNote({ where: "acme/api#42", reviewed: A, current: "" })).toBeUndefined();
  });
  it("the note names both commits, the pinned post, the no-auto-approve consequence, and the action", () => {
    const note = headMovedNote({ where: "acme/api#42", reviewed: A, current: B });
    expect(note).toBe(
      "ℹ️ acme/api#42 moved during the run: reviewed e8e43f4, head is now d75b5a5. " +
        "The review was posted pinned to e8e43f4 and will not auto-approve — re-request to review d75b5a5.",
    );
  });
});

// The two commit lists describe matching or changed metadata. Neither proves
// unchanged contents. A moved head needs a fresh review in the same run.
describe("classifyHeadMove (item 12)", () => {
  const list = (msgs: string[], files: string[], filesTruncated = false): PrCommitList => ({
    commits: msgs.map((message, i) => ({ sha: `${i}`.repeat(40).slice(0, 40), message })),
    files,
    filesTruncated,
  });

  it("same count, messages and files identify matching metadata, not unchanged contents", () => {
    const before = list(["feat: catalog\n\nbody", "fix: nits"], ["src/a.ts", "docs/b.md"]);
    const after = list(["feat: catalog\n\nbody", "fix: nits"], ["docs/b.md", "src/a.ts"]); // order of files is irrelevant
    expect(classifyHeadMove(before, after)).toEqual({ kind: "matching-metadata", commits: 2 });
  });

  it("message comparison ignores surrounding whitespace only — a reworded commit is a change", () => {
    const before = list(["feat: catalog\n"], ["src/a.ts"]);
    expect(classifyHeadMove(before, list(["feat: catalog"], ["src/a.ts"]))).toEqual({
      kind: "matching-metadata",
      commits: 1,
    });
    expect(classifyHeadMove(before, list(["feat: catalogue"], ["src/a.ts"])).kind).toBe("substantive");
  });

  it("a new commit → substantive, naming the added subjects (first line only)", () => {
    const before = list(["feat: catalog"], ["src/a.ts"]);
    const after = list(["feat: catalog", "fix: review nits\n\nlonger body"], ["src/a.ts", "src/a.test.ts"]);
    expect(classifyHeadMove(before, after)).toEqual({
      kind: "substantive",
      before: 1,
      after: 2,
      added: ["fix: review nits"],
      removed: [],
    });
  });

  it("a dropped or squashed commit → substantive, naming what went away", () => {
    const before = list(["feat: catalog", "wip", "fix typo"], ["src/a.ts"]);
    const after = list(["feat: catalog"], ["src/a.ts"]);
    expect(classifyHeadMove(before, after)).toEqual({
      kind: "substantive",
      before: 3,
      after: 1,
      added: [],
      removed: ["wip", "fix typo"],
    });
  });

  it("same commits but a different set of touched files → substantive (an amend that keeps the message)", () => {
    const before = list(["feat: catalog"], ["src/a.ts"]);
    const after = list(["feat: catalog"], ["src/a.ts", "src/new.ts"]);
    const r = classifyHeadMove(before, after);
    expect(r.kind).toBe("substantive");
    if (r.kind === "substantive") expect(r.added).toEqual([]); // nothing new to name — the messages match
  });

  it("the file-set check is skipped when GitHub truncated either list (300-file cap) — messages decide", () => {
    const before = list(["feat: catalog"], ["src/a.ts"], true);
    const after = list(["feat: catalog"], ["src/a.ts", "src/b.ts"]);
    expect(classifyHeadMove(before, after)).toEqual({ kind: "matching-metadata", commits: 1 });
  });

  it("same messages in a different order → substantive (a reorder changes what each commit applies to)", () => {
    const before = list(["a", "b"], ["x"]);
    expect(classifyHeadMove(before, list(["b", "a"], ["x"])).kind).toBe("substantive");
  });
});

describe("item 12 head-change notices", () => {
  it("re-review note: both shas, what changed, what happens next", () => {
    const move: Sub = { kind: "substantive", before: 1, after: 3, added: ["fix: nits", "test: panel"], removed: [] };
    expect(headRereviewNote({ where: "acme/api#42", reviewed: A, current: B, move })).toBe(
      "🔀 acme/api#42 moved during the run: reviewed e8e43f4, head is now d75b5a5 — 1 → 3 commits (+ “fix: nits”, + “test: panel”). " +
        "Re-reviewing at d75b5a5 before posting.",
    );
    const removed: Sub = { kind: "substantive", before: 2, after: 1, added: [], removed: ["wip"] };
    expect(headRereviewNote({ where: "acme/api#42", reviewed: A, current: B, move: removed })).toContain(
      "2 → 1 commits (− “wip”)",
    );
    const amend: Sub = { kind: "substantive", before: 1, after: 1, added: [], removed: [] };
    expect(headRereviewNote({ where: "acme/api#42", reviewed: A, current: B, move: amend })).toContain(
      "1 → 1 commits (same messages, different files)",
    );
  });

  it("re-review note caps the listed subjects", () => {
    const move: Sub = { kind: "substantive", before: 0, after: 6, added: ["a", "b", "c", "d", "e", "f"], removed: [] };
    const note = headRereviewNote({ where: "w", reviewed: A, current: B, move });
    expect(note).toContain("+ “d”, +2 more");
    expect(note).not.toContain("“e”");
  });
});

describe("rereviewFollowUp (the second model turn's instruction)", () => {
  const move: Sub = { kind: "substantive", before: 1, after: 2, added: ["fix: nits"], removed: [] };
  const before: PrCommitList = {
    commits: [{ sha: A, message: "feat: catalog\n\nbody" }],
    files: ["src/a.ts"],
    filesTruncated: false,
  };
  const after: PrCommitList = {
    commits: [
      { sha: "1".repeat(40), message: "feat: catalog\n\nbody" },
      { sha: B, message: "fix: nits" },
    ],
    files: ["src/a.ts", "src/a.test.ts"],
    filesTruncated: false,
  };

  it("worktree moved by Switchboard: names both heads, lists both commit sets, forbids fetching, demands a fresh verdict with the new head", () => {
    const text = rereviewFollowUp({
      where: "acme/api#42",
      reviewed: A,
      current: B,
      move,
      before,
      after,
    });
    expect(text).toContain("moved from e8e43f4 to d75b5a5 while you were reviewing");
    expect(text).toContain("Switchboard has already moved your worktree to d75b5a5");
    expect(text).toContain("`git rev-parse HEAD`");
    expect(text).toContain("- 1111111 feat: catalog");
    expect(text).toContain("- d75b5a5 fix: nits");
    expect(text).toContain("- e8e43f4 feat: catalog"); // the commits you reviewed
    expect(text).toContain("do NOT run `git fetch`");
    expect(text).toContain("submit_verdict");
    expect(text).toContain(`head` + "` = " + `\`${B}\``);
    expect(text).not.toContain("body"); // commit bodies are not pasted — subjects only
  });
});
