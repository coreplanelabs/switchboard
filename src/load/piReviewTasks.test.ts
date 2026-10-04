import { describe, expect, it } from "vitest";
import { PI_REVIEW_TASKS, parsePiReviewTasks, piReviewTaskByName, reviewTaskUrl } from "./piReviewTasks.js";

// The review tasks of `load:pi --suite review` (docs/reference/specs/
// load-harness.md, the review suite item): merged pull requests of the
// repository the checkout clones, each pinned to the head the review must
// read, so the suite is repeatable and its verdict is posted nowhere. The
// repository itself is the checkout's origin, never a name in the tree.

describe("PI_REVIEW_TASKS", () => {
  it("is three to five pull requests, distinct by name and number, each pinned to a full head sha on main with its head branch", () => {
    expect(PI_REVIEW_TASKS.length).toBeGreaterThanOrEqual(3);
    expect(PI_REVIEW_TASKS.length).toBeLessThanOrEqual(5);
    expect(new Set(PI_REVIEW_TASKS.map((t) => t.name)).size).toBe(PI_REVIEW_TASKS.length);
    expect(new Set(PI_REVIEW_TASKS.map((t) => t.number)).size).toBe(PI_REVIEW_TASKS.length);
    for (const task of PI_REVIEW_TASKS) {
      expect(task.head).toMatch(/^[0-9a-f]{40}$/);
      expect(task.baseRef).toBe("main");
      expect(task.headRef.length).toBeGreaterThan(0);
      expect(task.title.length).toBeGreaterThan(0);
      expect(Object.keys(task).sort()).toEqual(["baseRef", "head", "headRef", "name", "number", "title"]);
    }
  });
  it("finds a task by name and answers undefined for an unknown one", () => {
    expect(piReviewTaskByName(PI_REVIEW_TASKS[0].name)).toBe(PI_REVIEW_TASKS[0]);
    expect(piReviewTaskByName("nope")).toBeUndefined();
  });
  it("names the pull request's URL in whichever repository the checkout's origin is", () => {
    expect(reviewTaskUrl("acme/api", { number: 42 })).toBe("https://github.com/acme/api/pull/42");
  });
});

describe("parsePiReviewTasks", () => {
  it("accepts distinct historical heads of one PR with a pinned base and frozen context", () => {
    const first = { ...PI_REVIEW_TASKS[0], baseHead: "a".repeat(40), context: "Earlier feedback" };
    const next = { ...first, name: "followup", head: "b".repeat(40) };
    expect(parsePiReviewTasks([first, next])).toEqual([first, next]);
  });
  it("rejects empty sets, duplicate names, moving heads, invalid refs and malformed context", () => {
    const task = PI_REVIEW_TASKS[0];
    for (const value of [
      [],
      [task, task],
      [{ ...task, head: "main" }],
      [{ ...task, baseHead: "main" }],
      [{ ...task, number: 0 }],
      [{ ...task, baseRef: "--upload-pack=x" }],
      [{ ...task, context: {} }],
    ]) {
      expect(() => parsePiReviewTasks(value)).toThrow();
    }
  });
});
