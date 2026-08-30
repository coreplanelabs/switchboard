import { describe, expect, it } from "vitest";
import { headMovedNote } from "./headMoved.js";

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
