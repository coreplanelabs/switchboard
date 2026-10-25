export class RootProcessOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super("root process output did not complete", { cause });
    this.name = "RootProcessOutcomeUnknownError";
  }
}

export async function rootProcessOutput(
  process: {
    output(options: { encoding: "utf8"; timeout: number }): Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
      timedOut?: boolean;
    }>;
    status(): Promise<{ state: string }>;
    kill(signal: number): Promise<unknown>;
  },
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const output = await process.output({ encoding: "utf8", timeout: timeoutMs });
    return { stdout: output.stdout, stderr: output.stderr, exitCode: output.timedOut ? 124 : output.exitCode };
  } catch (error) {
    const status = await process.status().catch(() => null);
    if (status?.state !== "exited") await process.kill(9).catch(() => {});
    throw new RootProcessOutcomeUnknownError(error);
  }
}

export async function failedSeedCleanupOutcome(
  cleanup: () => Promise<{ exitCode: number }>,
): Promise<"finished" | "unknown"> {
  try {
    const result = await cleanup();
    return Number.isInteger(result.exitCode) &&
      result.exitCode >= 0 &&
      result.exitCode <= 255 &&
      result.exitCode !== 124 &&
      result.exitCode !== 137
      ? "finished"
      : "unknown";
  } catch {
    return "unknown";
  }
}
