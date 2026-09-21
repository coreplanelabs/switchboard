import { describe, expect, it, vi } from "vitest";
import { assertNoPendingBackgroundTasks, backgroundTaskDiagnostics, holdBackgroundTask } from "./backgroundTasks.ts";

describe("memory Worker pending task guard", () => {
  it("fails on a fixture promise that is still pending when the test ends", async () => {
    let release!: () => void;
    const fixture = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitUntil = vi.fn<(task: Promise<unknown>) => void>();

    holdBackgroundTask({ waitUntil }, "fixture pending promise", fixture);

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(backgroundTaskDiagnostics()).toEqual({
      registeredBackgroundTasks: ["fixture pending promise"],
      pendingPromises: ["fixture pending promise"],
    });
    expect(() => assertNoPendingBackgroundTasks()).toThrow(/fixture pending promise/);

    release();
    await fixture;
    await Promise.resolve();
    expect(backgroundTaskDiagnostics()).toEqual({
      registeredBackgroundTasks: ["fixture pending promise"],
      pendingPromises: [],
    });
    expect(() => assertNoPendingBackgroundTasks()).not.toThrow();
  });
});
