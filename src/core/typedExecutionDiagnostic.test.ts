// Feature: docs/reference/specs/execution.md — closed typed refusal observations.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareSandboxExecutor } from "../execution/cloudflareSandbox.js";
import { ExecCapacityError, annotateExecutionDiagnostic } from "../execution/executor.js";
import {
  typedExecutionDiagnosticFrom,
  typedExecutionDiagnosticOf,
  type ExecutionDiagnosticContext,
  type TypedExecutionDiagnostic,
} from "../execution/typedExecutionDiagnostic.js";
import { runCheckTool } from "../tools/check.js";
import { parseRunEventLines } from "./runEventLines.js";
import { ExecHarnessContainer } from "./harness/container.js";
import { createCheckExecution, type CheckExecutionBinding } from "./checkExecution.js";
import type { CheckExecutionState } from "./checkExecutionTypes.js";

const options = {
  url: "https://sandbox.example",
  token: "private-token",
  threadKey: "cli:private",
  resolveEnvs: async () => ({ PRIVATE: "private-env" }),
};
const metadata = {
  stdout: `/work/repo\n${"a".repeat(40)}\n${"b".repeat(64)}\n`,
  stderr: "",
  exitCode: 0,
  truncated: false,
};
const busy = { reason: "runtime-busy", error: "private platform refusal", containerId: "private-container" };
const diagnostic = {
  version: 1,
  phase: "pre_execution_busy",
  route: "exec",
  reason: "runtime-busy",
  responseClass: "success",
  caller: "executor",
  operation: "unclassified",
};
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function binding(executor: CloudflareSandboxExecutor, save: CheckExecutionBinding["save"]): CheckExecutionBinding {
  return {
    executor: () => executor,
    workspace: () => "/work/repo",
    owner: { runId: "run-check", requester: "cli:owner", threadKey: "cli:task", repo: "acme/api" },
    recordingAvailable: true,
    save,
    authorizeCommand: async () => true,
    remainingMs: () => 120_000,
    signal: new AbortController().signal,
    clock: () => 1000,
  };
}
afterEach(() => vi.unstubAllGlobals());
describe("closed typed execution refusal observations", () => {
  it("keeps wire requests, persisted check bytes and default tool output identical apart from the closed observation", async () => {
    const observations = [];
    for (const include of [false, true]) {
      const wires: string[] = [];
      const fetch = vi.fn(async (_url, init: RequestInit) => {
        wires.push(String(init.body));
        return response(wires.length === 1 ? metadata : busy);
      });
      vi.stubGlobal("fetch", fetch);
      const executor = new CloudflareSandboxExecutor(options);
      const native = executor.execResult.bind(executor);
      executor.execResult = async (...args) => {
        try {
          return await native(...args);
        } catch (error) {
          if (!include && error instanceof ExecCapacityError) delete error.executionDiagnostic;
          throw error;
        }
      };
      const saved: CheckExecutionState[] = [];
      const capability = createCheckExecution(
        binding(executor, async (state) => {
          saved.push(structuredClone(state));
          return true;
        }),
      );
      const output = await runCheckTool.run({ command: "private check", purpose: "verification" }, {
        checkExecution: capability,
        callId: "call-one",
      } as Parameters<typeof runCheckTool.run>[1]);
      if (typeof output !== "string") throw new Error("Expected string check output");
      observations.push({ wires, saved, output: output.replace(/\nExecution diagnostic: [^\n]+/, "") });
    }
    expect(observations[0]).toEqual(observations[1]);
    expect(Object.hasOwn(new ExecCapacityError("ordinary"), "executionDiagnostic")).toBe(false);
  });
  it("covers the trusted harness operations without reading their command, path or request body", async () => {
    const paths = {
      dir: "/tmp/private",
      dirs: ["/tmp/private"],
      fifo: "/tmp/private/in",
      log: "/tmp/private/out",
      errLog: "/tmp/private/err",
      pidFile: "/tmp/private/pid",
      commandDir: "/tmp/private/cmd",
    };
    const request = { method: "GET", port: 41000, path: "/private", secretHeaders: { authorization: "private-token" } };
    const cases: Array<[string, (container: ExecHarnessContainer) => Promise<unknown>]> = [
      ["write", (c) => c.writeFile("/tmp/private", "private body")],
      ["start", (c) => c.start({ paths, command: "pi", args: [], env: { PRIVATE: "private-env" } })],
      ["send", (c) => c.writeLine(paths, "private body")],
      ["request_observation", (c) => c.request(paths, request)],
      ["request_control", (c) => c.request(paths, { ...request, method: "POST", body: "private body" })],
      ["input", (c) => c.cancelInput(paths, "private body")],
      ["http_observation", (c) => c.observeRequest(paths, request)],
      ["http_control", (c) => c.cancelRequest(paths, { ...request, method: "POST", body: "private body" })],
      ["alive", (c) => c.alive(4242)],
      ["identity", (c) => c.identity()],
      ["log", (c) => c.readLog(paths.log, 0, 1024)],
      ["tail", (c) => c.tail(paths.errLog, 1024)],
      ["kill", (c) => c.kill(4242)],
      ["remove", (c) => c.remove(paths)],
    ];
    for (const [operation, run] of cases) {
      const fetch = vi.fn(async () => response(busy));
      vi.stubGlobal("fetch", fetch);
      const executor = new CloudflareSandboxExecutor(options);
      const native = executor.execResult.bind(executor);
      let captured: unknown;
      executor.execResult = async (...args) => {
        try {
          return await native(...args);
        } catch (error) {
          captured = error;
          throw error;
        }
      };
      const result = await run(new ExecHarnessContainer(executor)).catch((e) => e);
      if (operation === "identity") expect(result).toBeUndefined();
      else expect(result).toBe(captured);
      const error = captured as ExecCapacityError;
      expect(error).toBeInstanceOf(ExecCapacityError);
      expect(error.executionDiagnostic).toEqual({ ...diagnostic, caller: "harness", operation });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(error.executionDiagnostic)).not.toContain("private");
    }
  });
  it.each(["fleet-busy", "sandbox-starting", "runtime-busy"] as const)(
    "keeps %s distinct across the two accepted HTTP response classes",
    async (reason) => {
      for (const status of [200, 503]) {
        const fetch = vi.fn(async () => response({ ...busy, reason }, status));
        vi.stubGlobal("fetch", fetch);
        const error = await new CloudflareSandboxExecutor(options).execResult("private command").catch((e) => e);
        expect(error.executionDiagnostic).toEqual({
          ...diagnostic,
          reason,
          responseClass: status === 200 ? "success" : "service_unavailable",
        });
        expect(fetch).toHaveBeenCalledTimes(1);
      }
    },
  );
  it.each([
    { ...busy, error: "" },
    { ...busy, error: {} },
    { ...busy, error: "x".repeat(4097) },
    { ...busy, exitCode: 0 },
    { ...busy, stdout: "private output" },
    { ...busy, stderr: "different" },
    { ...busy, containerId: {} },
    { ...busy, containerId: "" },
    { ...busy, containerId: "x".repeat(513) },
    { ...busy, truncated: true },
  ])("keeps a malformed busy body generic without changing its one-send refusal", async (body) => {
    const fetch = vi.fn(async () => response(body));
    vi.stubGlobal("fetch", fetch);
    const error = await new CloudflareSandboxExecutor(options).execResult("private command").catch((e) => e);
    expect(error).toBeInstanceOf(ExecCapacityError);
    expect(error.message).toBe("The typed command was refused before execution.");
    expect(error.executionDiagnostic).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    { status: 502, body: busy },
    { status: 403, body: busy },
    { status: 200, body: { error: busy.error } },
    { status: 200, body: { ...busy, reason: "unknown" } },
    { status: 201, body: busy },
  ])("never makes an unverified transport or legacy error a pre-execution fact", async ({ status, body }) => {
    const fetch = vi.fn(async () => response(body, status));
    vi.stubGlobal("fetch", fetch);
    const error = await new CloudflareSandboxExecutor(options).execResult("private command").catch((e) => e);
    expect(typedExecutionDiagnosticOf(error)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("ignores foreign, proxy, accessor and frozen carriers without replacing the original exception", () => {
    const accessor = vi.fn(() => {
      throw new Error("private getter");
    });
    class AccessorError extends ExecCapacityError {}
    Object.defineProperty(AccessorError.prototype, "executionDiagnostic", { get: accessor });
    const subclass = new AccessorError("original");
    expect(() => annotateExecutionDiagnostic(subclass, { caller: "harness", operation: "alive" })).not.toThrow();
    expect(typedExecutionDiagnosticOf(subclass)).toBeUndefined();
    const producedSubclass = new AccessorError("original", undefined, diagnostic as TypedExecutionDiagnostic);
    expect(typedExecutionDiagnosticOf(producedSubclass)).toEqual(diagnostic);
    const own = new ExecCapacityError("original");
    Object.defineProperty(own, "executionDiagnostic", { get: accessor });
    const frozen = Object.freeze(new ExecCapacityError("original", undefined, diagnostic as TypedExecutionDiagnostic));
    const nonwritable = new ExecCapacityError("original", undefined, diagnostic as TypedExecutionDiagnostic);
    Object.defineProperty(nonwritable, "executionDiagnostic", { writable: false });
    const foreign = new Error("original");
    const proxy = new Proxy(foreign, {
      getPrototypeOf() {
        throw new Error("private proxy");
      },
      getOwnPropertyDescriptor() {
        throw new Error("private proxy");
      },
    });
    for (const error of [own, frozen, nonwritable, foreign, proxy, null]) {
      expect(() => typedExecutionDiagnosticOf(error)).not.toThrow();
      expect(() => annotateExecutionDiagnostic(error, { caller: "harness", operation: "alive" })).not.toThrow();
    }
    expect(accessor).not.toHaveBeenCalled();
    expect(typedExecutionDiagnosticOf(own)).toBeUndefined();
    expect(typedExecutionDiagnosticOf(proxy)).toBeUndefined();
    expect(frozen.executionDiagnostic).toEqual(diagnostic);
    expect(nonwritable.executionDiagnostic).toEqual(diagnostic);
    const current = new ExecCapacityError("original", undefined, diagnostic as TypedExecutionDiagnostic);
    const stack = current.stack;
    annotateExecutionDiagnostic(current, { caller: "check", operation: "metadata" });
    expect(current.stack).toBe(stack);
    expect(current.message).toBe("original");
    annotateExecutionDiagnostic(current, { caller: "harness", operation: "alive" });
    expect(current.executionDiagnostic?.caller).toBe("check");
    const malformed = new ExecCapacityError("original", undefined, diagnostic as TypedExecutionDiagnostic);
    annotateExecutionDiagnostic(malformed, {
      caller: "harness",
      operation: "private-operation",
    } as unknown as ExecutionDiagnosticContext);
    expect(malformed.executionDiagnostic).toEqual(diagnostic);
    const getter = { ...diagnostic };
    Object.defineProperty(getter, "reason", { get: accessor });
    for (const value of [
      getter,
      { ...diagnostic, body: "private" },
      { ...diagnostic, reason: "unknown" },
      { ...diagnostic, caller: "check", operation: "alive" },
      Object.create(diagnostic),
      null,
    ])
      expect(typedExecutionDiagnosticFrom(value)).toBeUndefined();
    expect(accessor).not.toHaveBeenCalled();
  });
  it("omits misbound, accessor and contradictory tool diagnostics while keeping the original response", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(metadata))
      .mockResolvedValueOnce(response({ stdout: "", stderr: "", exitCode: 0, truncated: false }));
    vi.stubGlobal("fetch", fetch);
    const capability = createCheckExecution(binding(new CloudflareSandboxExecutor(options), async () => true));
    const completed = await capability.run({ command: "private check", purpose: "verification" }, "call-one");
    const wrong = [
      { ...completed, executionDiagnostic: { ...diagnostic, caller: "check", operation: "command" } },
      {
        kind: "unavailable",
        reason: "workspace_unavailable",
        executionDiagnostic: { ...diagnostic, caller: "check", operation: "metadata" },
      },
      {
        kind: "unavailable",
        reason: "metadata_unavailable",
        metadataFailure: { phase: "execute", kind: "thrown" },
        executionDiagnostic: { ...diagnostic, caller: "harness", operation: "alive" },
      },
    ];
    for (const result of wrong) {
      const output = await runCheckTool.run({ command: "private check", purpose: "verification" }, {
        callId: "call-one",
        checkExecution: { run: async () => result },
      } as unknown as Parameters<typeof runCheckTool.run>[1]);
      expect(output).not.toContain("Execution diagnostic");
    }
    const getter = vi.fn(() => {
      throw new Error("private getter");
    });
    Object.defineProperty(completed, "executionDiagnostic", { get: getter });
    const output = await runCheckTool.run({ command: "private check", purpose: "verification" }, {
      callId: "call-one",
      checkExecution: { run: async () => completed },
    } as unknown as Parameters<typeof runCheckTool.run>[1]);
    expect(output).not.toContain("Execution diagnostic");
    expect(getter).not.toHaveBeenCalled();
  });
  it("retains valid saved failure observations and removes malformed extras without erasing the failure", () => {
    const note = {
      type: "run_note",
      kind: "run_failed",
      summary: "original failure",
      executionDiagnostic: { ...diagnostic, caller: "harness", operation: "alive" },
    };
    expect(parseRunEventLines(JSON.stringify(note)).events).toEqual([note]);
    expect(parseRunEventLines(JSON.stringify({ ...note, kind: "fleet_busy" })).events).toEqual([
      { type: note.type, kind: "fleet_busy", summary: note.summary },
    ]);
    for (const value of [{ ...diagnostic, body: "private" }, { ...diagnostic, reason: "unknown" }, null])
      expect(parseRunEventLines(JSON.stringify({ ...note, executionDiagnostic: value })).events).toEqual([
        { type: note.type, kind: note.kind, summary: note.summary },
      ]);
  });
  it.each(["metadata", "command"] as const)(
    "exposes only closed %s observations through the actual run_check output",
    async (phase) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(response(phase === "metadata" ? busy : metadata))
        .mockResolvedValueOnce(response(busy));
      vi.stubGlobal("fetch", fetch);
      const saved: CheckExecutionState[] = [];
      const capability = createCheckExecution(
        binding(new CloudflareSandboxExecutor(options), async (state) => {
          saved.push(structuredClone(state));
          return true;
        }),
      );
      const input = { command: "private check", purpose: "verification" };
      const output = await runCheckTool.run(input, { checkExecution: capability, callId: "call-one" } as Parameters<
        typeof runCheckTool.run
      >[1]);
      expect(output).toContain(
        `Execution diagnostic: ${JSON.stringify({ ...diagnostic, caller: "check", operation: phase })}`,
      );
      expect(output).not.toContain("private platform");
      expect(output).not.toContain("private-env");
      expect(output).not.toContain("private-container");
      if (phase === "command") {
        expect(saved.at(-1)?.receipts[0]?.outcome).toEqual({ kind: "unknown", reason: "transport" });
        expect(JSON.stringify(saved)).not.toContain("executionDiagnostic");
      } else expect(saved).toEqual([]);
    },
  );
  it("retains only the authenticated adapter's closed busy facts without another send", async () => {
    const fetch = vi.fn(async () => response(busy));
    vi.stubGlobal("fetch", fetch);
    const error = await new CloudflareSandboxExecutor(options).execResult("private command").catch((e) => e);
    expect(error).toBeInstanceOf(ExecCapacityError);
    expect(error.message).toBe("The typed command was refused before execution.");
    expect(error.executionDiagnostic).toEqual(diagnostic);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.executionDiagnostic)).not.toContain("private");
  });
  it.each(["metadata", "command"] as const)(
    "keeps a caught check %s refusal distinct from its unknown completion receipt",
    async (phase) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(response(phase === "metadata" ? busy : metadata))
        .mockResolvedValueOnce(response(busy));
      vi.stubGlobal("fetch", fetch);
      const saved: CheckExecutionState[] = [];
      const capability = createCheckExecution(
        binding(new CloudflareSandboxExecutor(options), async (state) => {
          saved.push(structuredClone(state));
          return true;
        }),
      );
      const result = await capability.run({ command: "private check", purpose: "verification" }, "call-one");
      expect(result).toMatchObject({ executionDiagnostic: { ...diagnostic, caller: "check", operation: phase } });
      if (result.kind === "recorded") {
        expect(result.receipt.outcome).toEqual({ kind: "unknown", reason: "transport" });
        expect(JSON.stringify(saved)).not.toContain("executionDiagnostic");
        const calls = fetch.mock.calls.length;
        expect(await capability.run({ command: "private check", purpose: "verification" }, "call-two")).toMatchObject({
          kind: "unavailable",
          reason: "reconciliation_required",
        });
        expect(fetch).toHaveBeenCalledTimes(calls);
      } else expect(saved).toEqual([]);
    },
  );
  it("identifies a refused harness observation while the selected check remains pending and unknown", async () => {
    let announce!: () => void;
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(metadata))
      .mockImplementationOnce(async (_url, init: RequestInit) => {
        announce();
        return new Promise((_resolve, reject) =>
          init.signal!.addEventListener("abort", () => reject(new Error("original command answer lost")), {
            once: true,
          }),
        );
      })
      .mockResolvedValueOnce(response(busy));
    vi.stubGlobal("fetch", fetch);
    const saved: CheckExecutionState[] = [];
    const executor = new CloudflareSandboxExecutor(options);
    const capability = createCheckExecution(
      binding(executor, async (state) => {
        saved.push(structuredClone(state));
        return true;
      }),
    );
    const stopped = new AbortController();
    const check = capability.run({ command: "private check", purpose: "verification" }, "call-one", {
      signal: stopped.signal,
    });
    await started;
    const before = JSON.stringify(saved);
    const error = await new ExecHarnessContainer(executor).alive(4242).catch((e) => e);
    expect(error).toBeInstanceOf(ExecCapacityError);
    expect(JSON.stringify(saved)).toBe(before);
    expect(saved.at(-1)?.receipts[0]?.outcome).toEqual({ kind: "pending" });
    stopped.abort();
    const result = await check;
    expect(result).toMatchObject({
      kind: "recorded",
      receipt: { outcome: { kind: "unknown", reason: "interrupted" } },
    });
    expect(error.executionDiagnostic).toEqual({ ...diagnostic, caller: "harness", operation: "alive" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
