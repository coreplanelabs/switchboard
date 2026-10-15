import { describe, expect, it, vi } from "vitest";
import { inspectResidentCredentials } from "./credentialInspection.js";
import {
  credentialInspectionInputSchema,
  emptyCredentialInspection,
} from "../../src/execution/credentialInspection.js";
import { NativeRunScopes } from "./nativeScope.js";
import { NativeOperationJournal } from "./nativeOperation.js";
import { ErrorCode, OperationInterruptedError, RPCTransportError } from "@cloudflare/sandbox/errors";
import { runInNewContext } from "node:vm";
import { AsyncLocalStorage } from "node:async_hooks";
import { webcrypto } from "node:crypto";
import ts from "typescript";
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
  async function producer(error?: Error, loseOutput = false) {
    const source = readSource("worker.ts"),
      key = "native-operation:mcp:credential:run-one:original";
    const compiled = ts.transpileModule(
      `class Resident { ${["inspectThreadCredentials", "beginThreadNativeOperation"].map((name) => methodOf(source, name)).join("\n")} }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const rows = new Map<string, any>(),
      calls: string[] = [],
      logs: string[] = [];
    const storage = {
      get: async (key: string) => rows.get(key),
      put: async (key: string, value: unknown) => rows.set(key, structuredClone(value)),
      delete: async (key: string) => rows.delete(key),
      list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
      transaction: async (fn: (s: unknown) => Promise<unknown>) => fn(storage),
    };
    const Constructor = runInNewContext(`${compiled}\nResident`, {
      NativeOperationJournal,
      NativeRunScopes,
      credentialInspectionInputSchema,
      emptyCredentialInspection,
      inspectResidentCredentials,
      validateEnvNames: () => {},
      isResidentPoolUser: (user: string) => user === "worker2",
      threadBindingKey: (thread: string) => `thread:${thread}`,
      DESTROY_UNCONFIRMED_KEY: "destroy",
      isControlReset: () => false,
      isRuntimeReplacement: () => false,
      RPCTransportError,
      OperationInterruptedError,
      selfAndCauses: (error: unknown) => [error, (error as { cause?: unknown })?.cause].filter(Boolean),
      console: { warn: (line: string) => logs.push(line) },
      crypto: webcrypto,
      createExtensionProcessSandbox: () => ({
        exec: async () => {
          calls.push("exec");
          return {
            status: async () => {
              calls.push("status");
              if (error) throw error;
              return { id: "original-credential-process", pid: 42, startedAt: "2026-10-11T00:00:00.000Z" };
            },
            output: async () => {
              calls.push("output");
              if (loseOutput) throw new Error("synthetic-private-output");
              return { stdout: JSON.stringify(counts), stderr: "", exitCode: 0, truncated: false, timedOut: false };
            },
            kill: async () => {
              calls.push("kill");
            },
          };
        },
      }),
    });
    const instance = new Constructor(),
      scope = { key, active: true },
      threadScope = new AsyncLocalStorage(),
      opScope = new AsyncLocalStorage();
    Object.assign(instance, {
      ctx: { storage },
      threadOperationScope: threadScope,
      opOperationScope: opScope,
      workspaceExclusiveOpsInFlight: new Set(),
      memoryGate: async () => null,
      isRuntimeActive: async () => true,
      poolUserOwnerMatches: async () => true,
      assertThreadOperationAllowed: async () => {},
    });
    rows.set("thread:mcp:credential", {
      user: "worker2",
      ref: input.ref,
      worktreePath: "/workspace/fixture",
      githubDoorHost: "door.example",
    });
    instance.withThreadBusy = async (_thread: string, fn: () => Promise<unknown>) => {
      const journal = new NativeOperationJournal(storage);
      await journal.open(key, { opOwner: "op:legacy-credential" });
      try {
        return await opScope.run(scope, fn);
      } finally {
        scope.active = false;
        await journal.close(key);
      }
    };
    const result = await instance.inspectThreadCredentials("mcp:credential", input, env);
    return { result, calls, logs, operations: (await new NativeOperationJournal(storage).list()).operations };
  }
  it("collects the original credential-inspection handle after observational identity failure", async () => {
    const failure = new RPCTransportError({
      code: ErrorCode.RPC_TRANSPORT_ERROR,
      httpStatus: 500,
      timestamp: "2026-10-11T00:00:00.000Z",
      message: "synthetic-private-status",
      context: { kind: "invalid_frame", originalMessage: "synthetic-private-status", errorName: "TypeError" },
    });
    const actual = await producer(failure);
    expect(actual.result).toEqual(counts);
    expect(actual.calls).toEqual(["exec", "status", "output"]);
    expect(actual.operations).toEqual([]);
    expect(actual.logs.join("\n")).toContain("RPCTransportError");
    expect(actual.logs.join("\n")).not.toContain("synthetic-private");
  });
  it("retains unknown native outcome when credential collection also fails", async () => {
    const failure = new RPCTransportError({
      code: ErrorCode.RPC_TRANSPORT_ERROR,
      httpStatus: 500,
      timestamp: "2026-10-11T00:00:00.000Z",
      message: "synthetic-private-status",
      context: { kind: "protocol_error", originalMessage: "synthetic-private-status", errorName: "TypeError" },
    });
    const actual = await producer(failure, true);
    expect(actual.result).toEqual(emptyCredentialInspection());
    expect(actual.calls).toEqual(["exec", "status", "output", "kill"]);
    expect(actual.operations).toMatchObject([
      { recoverable: false, recoveryReason: "original-native-evidence-unavailable", journal: { closed: true } },
    ]);
  });
  it("does not collect after an authentication-denied identity observation", async () => {
    const failure = new RPCTransportError(
      {
        code: ErrorCode.RPC_TRANSPORT_ERROR,
        httpStatus: 500,
        timestamp: "2026-10-11T00:00:00.000Z",
        message: "synthetic-private-status",
        context: { kind: "invalid_frame", originalMessage: "synthetic-private-status", errorName: "TypeError" },
      },
      { cause: { status: 403 } },
    );
    const actual = await producer(failure);
    expect(actual.result).toEqual(emptyCredentialInspection());
    expect(actual.calls).toEqual(["exec", "status"]);
    expect(actual.operations).toMatchObject([{ recoverable: false, journal: { closed: true } }]);
  });
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
});
