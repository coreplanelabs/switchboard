import { describe, expect, it } from "vitest";
import { PI_TASKS, piTaskByName, taskBranch, taskPrompt } from "./piTasks.js";

// The five representative coding tasks `load:pi` runs (docs/reference/specs/
// load-harness.md, the pi driver items). The same five prompts are sent to
// today's coding agent for the comparison, so each prompt is complete on its
// own: the branch, the change, the proof to run, and the terminal tool.

describe("PI_TASKS", () => {
  it("is five tasks of five different shapes, each with a distinct name", () => {
    expect(PI_TASKS).toHaveLength(5);
    expect(new Set(PI_TASKS.map((t) => t.name)).size).toBe(5);
    expect(new Set(PI_TASKS.map((t) => t.shape)).size).toBe(5);
  });
  it("finds a task by name and answers undefined for an unknown one", () => {
    expect(piTaskByName("test-gap")?.name).toBe("test-gap");
    expect(piTaskByName("nope")).toBeUndefined();
  });
  it("names the branch after the task and the run", () => {
    expect(taskBranch("test-gap", "20260911T120000Z")).toBe("load-pi/test-gap-20260911T120000Z");
  });
});

describe("taskPrompt", () => {
  it("carries the branch contract, the proof command, the terminal tool and the never-merge rule", () => {
    for (const task of PI_TASKS) {
      const prompt = taskPrompt(task, { name: "load-pi/x-1", created: true });
      expect(prompt).toContain("load-pi/x-1");
      expect(prompt).toContain(task.proof);
      expect(prompt).toContain("submit_pr_description");
      expect(prompt).toMatch(/never merge/i);
      expect(prompt).toMatch(/do not push/i);
      expect(prompt).toContain(task.body.trim());
    }
  });
  it("tells the truth about the branch: already checked out when a driver made it, create it otherwise", () => {
    const task = PI_TASKS[0];
    expect(taskPrompt(task, { name: "b", created: true })).toContain("The branch `b` is already checked out for you");
    const native = taskPrompt(task, { name: "b", created: false });
    expect(native).toContain("Create the branch `b` from the current head");
    expect(native).not.toContain("already checked out");
  });
});
