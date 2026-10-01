import { describe, expect, it, vi } from "vitest";
import {
  emptyCredentialInspection,
  runCredentialInspection,
  parseCredentialInspection,
} from "./credentialInspection.js";

const input = {
  runId: "run-one",
  pid: 42,
  processBirth: "11111111-1111-1111-1111-111111111111:123",
  repo: "example/repo",
  ref: "canary/test",
  head: "a".repeat(40),
};
describe("credential inspection transport", () => {
  it("accepts only the exact bounded count and boolean schema", () => {
    const counts = emptyCredentialInspection();
    expect(parseCredentialInspection({ ...counts, completed: true })).toEqual(counts);
    expect(parseCredentialInspection(counts)).toEqual(counts);
    for (const value of [
      { ...counts, extra: "synthetic" },
      { ...counts, appTokenMatches: -1 },
      { ...counts, filesChecked: Infinity },
      { ...counts, completed: "true" },
    ]) {
      expect(parseCredentialInspection(value)).toEqual(emptyCredentialInspection());
    }
  });
  it("never returns raw stdout, stderr, truncation or transport exceptions", async () => {
    const planted = "synthetic-secret-must-stay-private";
    for (const execute of [
      vi.fn(async () => ({ stdout: planted, stderr: "", exitCode: 0, truncated: false })),
      vi.fn(async () => ({
        stdout: JSON.stringify({ ...emptyCredentialInspection(), completed: true }),
        stderr: planted,
        exitCode: 0,
        truncated: false,
      })),
      vi.fn(async () => ({
        stdout: JSON.stringify({ ...emptyCredentialInspection(), completed: true }),
        stderr: "",
        exitCode: 0,
        truncated: true,
      })),
      vi.fn(async () => {
        throw new Error(planted);
      }),
    ]) {
      const result = await runCredentialInspection(execute, input);
      expect(result.completed).toBe(false);
      expect(JSON.stringify(result)).not.toContain(planted);
    }
  });
  it("uses a fixed isolated interpreter command with no injected environment or publication capability", async () => {
    const execute = vi.fn(async (_command: string, _opts: import("./executor.js").ExecOptions) => ({
      stdout: JSON.stringify(emptyCredentialInspection()),
      stderr: "",
      exitCode: 0,
      truncated: false,
    }));
    await runCredentialInspection(execute, input);
    expect(execute).toHaveBeenCalledOnce();
    const [command, opts] = execute.mock.calls[0]!;
    expect(command).toContain("/usr/bin/python3 -I");
    expect(command).not.toContain("git push");
    expect(opts).not.toHaveProperty("env");
    expect(opts).not.toHaveProperty("span");
  });
});
