import { createCheckExecution } from "../checkExecution.js";
import type { CheckExecutionOwner, CheckExecutionState } from "../checkExecutionTypes.js";

/** Uses the real producer so store tests exercise its canonical bytes. */
export async function checkStateFixture(
  owner: CheckExecutionOwner,
  options: {
    initial?: CheckExecutionState;
    callId?: string;
    output?: string;
    stderr?: string;
    unknown?: boolean;
    metadataUnknown?: boolean;
  } = {},
): Promise<CheckExecutionState> {
  const control = new AbortController();
  let saved = options.initial;
  let calls = 0;
  const check = createCheckExecution({
    owner,
    previous: options.initial,
    executor: () => ({
      inspectCheckResult: async () => undefined,
      execResult: async () => {
        if (options.metadataUnknown) throw new Error("fixture lost metadata reply");
        if (++calls === 1)
          return {
            stdout: `/work/repo\n${"a".repeat(40)}\n${"b".repeat(40)}\n`,
            stderr: "",
            exitCode: 0,
            truncated: false,
          };
        if (options.unknown) throw new Error("fixture lost reply");
        return {
          stdout: options.output ?? "saved original output",
          stderr: options.stderr ?? "",
          exitCode: 0,
          truncated: false,
        };
      },
    }),
    workspace: () => "/work/repo",
    recordingAvailable: true,
    authorizeCommand: () => true,
    save: async (state) => {
      saved = structuredClone(state);
      return true;
    },
    remainingMs: () => 120000,
    signal: control.signal,
    clock: () => 100,
  });
  await check.run({ command: "printf fixture", purpose: "verification", timeoutMs: 1000 }, options.callId ?? "call-1");
  control.abort();
  if (!saved) throw new Error("fixture did not save a check");
  return saved;
}
