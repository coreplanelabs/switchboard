import { describe, expect, it, vi } from "vitest";
import { ExecInfraError } from "../execution/executor.js";
import { createCheckExecution } from "./checkExecution.js";
import { runCheckTool } from "../tools/check.js";

const clean = {
  exitCode: 0,
  stdout: `/private/fixture\n${"a".repeat(40)}\n${"b".repeat(40)}\n`,
  stderr: "",
  truncated: false,
};
function setup(result: unknown, thrown?: unknown) {
  const execResult = vi.fn(async () => {
    if (thrown !== undefined) throw thrown;
    return result as typeof clean;
  });
  const save = vi.fn(async () => true);
  const capability = createCheckExecution({
    executor: () => ({ execResult }),
    workspace: () => "/private/fixture",
    recordingAvailable: true,
    owner: { runId: "r", requester: "u", threadKey: "t", repo: "example/repo" },
    authorizeCommand: () => true,
    save,
    remainingMs: () => 300_000,
    signal: new AbortController().signal,
    clock: () => 1,
  });
  return { capability, execResult, save };
}
const input = { command: "git status --short", purpose: "verification" as const };

describe("recorded check structural metadata diagnostics", () => {
  it.each([
    [
      "invalid typed result",
      { stdout: "PRIVATE-secret /private/fixture", exitCode: 0 },
      { phase: "result", kind: "invalid_result" },
    ],
    [
      "nonzero exit",
      { ...clean, exitCode: 7, stderr: "PRIVATE-secret /private/fixture" },
      { phase: "result", kind: "nonzero_exit", exitCode: 7, truncated: false },
    ],
    ["truncation", { ...clean, truncated: true }, { phase: "result", kind: "truncated", exitCode: 0, truncated: true }],
    [
      "framing",
      { ...clean, stdout: "PRIVATE-secret /private/fixture" },
      {
        phase: "framing",
        kind: "invalid_fields",
        lineCount: 1,
        cwdAbsolute: false,
        headValid: false,
        fingerprintValid: false,
      },
    ],
    [
      "bad cwd",
      { ...clean, stdout: `relative\n${"a".repeat(40)}\n${"b".repeat(40)}\n` },
      { phase: "framing", cwdAbsolute: false, headValid: true, fingerprintValid: true },
    ],
    [
      "bad head",
      { ...clean, stdout: `/private/fixture\nPRIVATE-secret\n${"b".repeat(40)}\n` },
      { phase: "framing", cwdAbsolute: true, headValid: false, fingerprintValid: true },
    ],
    [
      "bad fingerprint",
      { ...clean, stdout: `/private/fixture\n${"a".repeat(40)}\nPRIVATE-secret\n` },
      { phase: "framing", cwdAbsolute: true, headValid: true, fingerprintValid: false },
    ],
  ])(
    "preserves %s classification without command dispatch, persistence or private output",
    async (_name, result, expected) => {
      const w = setup(result);
      const response = await w.capability.run(input, "call");
      expect(response).toMatchObject({
        kind: "unavailable",
        reason: "metadata_unavailable",
        metadataFailure: expected,
      });
      expect(w.execResult).toHaveBeenCalledTimes(1);
      expect(w.save).not.toHaveBeenCalled();
      expect(JSON.stringify(response)).not.toContain("PRIVATE-secret");
      expect(JSON.stringify(response)).not.toContain("/private/fixture");
    },
  );
  it.each([false, true])("reports only a real typed infrastructure cause (nested=%s)", async (nested) => {
    const actual = new ExecInfraError("PRIVATE-secret /private/fixture", "transport-lost");
    const w = setup(clean, nested ? new Error("outer PRIVATE-secret", { cause: actual }) : actual);
    const response = await w.capability.run(input, "call");
    expect(response).toMatchObject({
      kind: "unavailable",
      metadataFailure: { phase: "execute", kind: "thrown", infrastructureReason: "transport-lost" },
    });
    expect(w.save).not.toHaveBeenCalled();
    expect(JSON.stringify(response)).not.toContain("PRIVATE-secret");
  });
  it("does not classify infrastructure from a throw's prose or spoofed name/reason", async () => {
    const fake = Object.assign(new Error("transport-lost PRIVATE-secret /private/fixture"), {
      name: "ExecInfraError",
      reason: "transport-lost",
    });
    const w = setup(clean, fake);
    expect(await w.capability.run(input, "call")).toMatchObject({
      metadataFailure: { phase: "execute", kind: "thrown" },
    });
    const response = await w.capability.run(input, "other-call");
    expect(response).not.toHaveProperty("metadataFailure.infrastructureReason");
  });
  it("carries safe classification in the existing failed tool result without completion or retry credit", async () => {
    const w = setup({ ...clean, exitCode: 7, stderr: "PRIVATE-secret /private/fixture" });
    const output = await runCheckTool.run(input, {
      executor: { exec: async () => "", readFile: async () => "", writeFile: async () => "" },
      checkExecution: w.capability,
      callId: "call",
    });
    expect(output).toContain("metadata_unavailable");
    expect(output).toContain('"kind":"nonzero_exit"');
    expect(output).not.toContain("PRIVATE-secret");
    expect(output).not.toContain("/private/fixture");
    expect(w.execResult).toHaveBeenCalledTimes(1);
    expect(w.save).not.toHaveBeenCalled();
  });
});
