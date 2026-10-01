import { describe, expect, it, vi } from "vitest";
import { inspectResidentCredentials } from "./credentialInspection.js";
import { emptyCredentialInspection } from "../../src/execution/credentialInspection.js";
import { methodOf, readSource } from "./testing/sourceScan.js";

const input = {
  runId: "run-one",
  pid: 42,
  processBirth: "11111111-1111-1111-1111-111111111111:123",
  repo: "example/repo",
  ref: "canary/test",
  head: "a".repeat(40),
};
const env = { GH_ENTERPRISE_TOKEN: "sbr_run-one.abcdefghijklmnopqrstuv", GH_HOST: "door.example" };
const counts = {
  ...emptyCredentialInspection(),
  completed: true,
  bindingMatched: true,
  commandEnvironments: 1,
  harnessEnvironments: 1,
  filesChecked: 4,
  helperEntries: 2,
  unknownCount: 0,
};
describe("resident credential diagnostic", () => {
  it("allows only validated counts across the Worker boundary, including timeout and exception paths", async () => {
    for (const raw of [
      { stdout: "synthetic-private-output", stderr: "", exitCode: 0, truncated: false },
      { stdout: JSON.stringify(counts), stderr: "synthetic-private-error", exitCode: 0, truncated: false },
      { stdout: JSON.stringify(counts), stderr: "", exitCode: 0, truncated: false, timedOut: true },
      {
        stdout: JSON.stringify({ ...counts, raw: "synthetic-private-output" }),
        stderr: "",
        exitCode: 0,
        truncated: false,
      },
      new Error("synthetic-private-error"),
    ]) {
      const execute = vi.fn(async () => {
        if (raw instanceof Error) throw raw;
        return raw;
      });
      expect(await inspectResidentCredentials(input, env, "door.example", execute)).toEqual(
        emptyCredentialInspection(),
      );
      expect(execute).toHaveBeenCalledOnce();
    }
    expect(
      await inspectResidentCredentials(input, env, "door.example", async () => ({
        stdout: JSON.stringify(counts),
        stderr: "",
        exitCode: 0,
        truncated: false,
        timedOut: false,
      })),
    ).toEqual(counts);
  });
  it("rejects unbound, malformed and shell-loading inputs before execution", async () => {
    const execute = vi.fn();
    for (const bad of [
      { ...input, processBirth: undefined },
      { ...input, command: "echo private" },
      { ...input, pid: 0 },
    ])
      expect(await inspectResidentCredentials(bad, env, "door.example", execute)).toEqual(emptyCredentialInspection());
    for (const bad of [
      { ...env, GH_HOST: "other.example" },
      { ...env, LD_PRELOAD: "/workspace/evil.so" },
      { ...env, LD_AUDIT: "/workspace/evil.so" },
      { ...env, BASH_ENV: "/workspace/evil.sh" },
    ])
      expect(await inspectResidentCredentials(input, bad, "door.example", execute)).toEqual(
        emptyCredentialInspection(),
      );
    expect(execute).not.toHaveBeenCalled();
  });
  it("wires only the typed operator route and a single nonrecovering process transport", () => {
    const source = readSource("worker.ts");
    const method = methodOf(source.slice(source.indexOf("export class ResidentDO")), "inspectThreadCredentials") ?? "";
    expect(source).toContain('"/inspect-credentials": { scope: "operator", method: "POST" }');
    expect(method).toContain("inspectResidentCredentials");
    expect(method).toContain("createExtensionProcessSandbox(this).exec");
    expect(method).not.toMatch(
      /threadRunCapped|threadPreflight|ensureHydrated|this\.run\(|console\.|withLevels|recoverCapturedOutput/,
    );
    const route = source.slice(
      source.indexOf("async function handleInspectCredentials"),
      source.indexOf("async function handlePublish"),
    );
    expect(route).toContain("parseCredentialInspection");
    expect(route).toContain("emptyCredentialInspection");
    expect(route).not.toMatch(/catchAllErr|streamThreadExec|withLevels/);
  });
});
