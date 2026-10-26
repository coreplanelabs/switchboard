import { describe, expect, it, vi } from "vitest";
import { RootProcessOutcomeUnknownError, failedSeedCleanupOutcome, rootProcessOutput } from "./sandboxRootProcess.js";

const WAIT = new Error("output wait expired");

function processWith(output: () => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean }>) {
  return {
    output: vi.fn(output),
    status: vi.fn(async () => ({ state: "running" })),
    kill: vi.fn(async (_signal: number) => {}),
  };
}

describe("root process output", () => {
  it("returns a completed process result without stopping it", async () => {
    const process = processWith(async () => ({ stdout: "head\n", stderr: "", exitCode: 0 }));
    expect(await rootProcessOutput(process, 200_000)).toEqual({
      stdout: "head\n",
      stderr: "",
      exitCode: 0,
    });
    expect(process.output).toHaveBeenCalledWith({ encoding: "utf8", timeout: 200_000 });
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("kills a still-running process before reporting its outcome unknown", async () => {
    const process = processWith(async () => {
      throw WAIT;
    });
    await expect(rootProcessOutput(process, 200_000)).rejects.toMatchObject({
      name: "RootProcessOutcomeUnknownError",
      cause: WAIT,
    });
    expect(process.status).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(9);
  });

  it("retains an unknown outcome when the process exited but its output stayed open", async () => {
    const process = processWith(async () => {
      throw WAIT;
    });
    process.status.mockResolvedValue({ state: "exited" });
    await expect(rootProcessOutput(process, 200_000)).rejects.toBeInstanceOf(RootProcessOutcomeUnknownError);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("retains an unknown outcome when process inspection and kill fail", async () => {
    const process = processWith(async () => {
      throw WAIT;
    });
    process.status.mockRejectedValue(new Error("status unavailable"));
    process.kill.mockRejectedValue(new Error("kill unavailable"));
    await expect(rootProcessOutput(process, 200_000)).rejects.toBeInstanceOf(RootProcessOutcomeUnknownError);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(9);
  });

  it("keeps a launched process unknown when output transport fails", async () => {
    const failure = new Error("output transport unavailable");
    const process = processWith(async () => {
      throw failure;
    });
    await expect(rootProcessOutput(process, 200_000)).rejects.toMatchObject({
      name: "RootProcessOutcomeUnknownError",
      cause: failure,
    });
    expect(process.status).toHaveBeenCalledOnce();
    expect(process.kill).toHaveBeenCalledExactlyOnceWith(9);
  });
});

describe("failed seed cleanup", () => {
  it("keeps an expired output wait unknown after a kill request", async () => {
    expect(
      await failedSeedCleanupOutcome(async () => {
        throw new RootProcessOutcomeUnknownError(WAIT);
      }),
    ).toBe("unknown");
  });

  it("keeps a lost cleanup answer or timed-out exit unknown", async () => {
    expect(
      await failedSeedCleanupOutcome(async () => {
        throw new Error("cleanup answer unavailable");
      }),
    ).toBe("unknown");
    expect(await failedSeedCleanupOutcome(async () => ({ exitCode: 124 }))).toBe("unknown");
    expect(await failedSeedCleanupOutcome(async () => ({ exitCode: -1 }))).toBe("unknown");
  });

  it("retains ordinary failure handling after a completed cleanup result", async () => {
    expect(await failedSeedCleanupOutcome(async () => ({ exitCode: 0 }))).toBe("finished");
    expect(await failedSeedCleanupOutcome(async () => ({ exitCode: 1 }))).toBe("finished");
  });
});
