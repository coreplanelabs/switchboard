import { createLedgerWriteThrough } from "./runLedger/writeThrough.js";
import { InMemoryRunStore } from "./runStore.js";
import { WorkerRunLedger } from "./runLedgerWorker.js";
import type { RunRecord } from "./runRecord.js";
import { analyzeRunFriction } from "./runFriction.js";
import { storeRequestWitness } from "./storeResponse.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "./runLedger/inMemory.js";
import { createCheckExecution, type CheckExecutionBinding } from "./checkExecution.js";
import type { CheckExecutionInput, CheckExecutionState } from "./checkExecutionTypes.js";
import { BASH_TIMEOUT_MS, RUN_DEADLINE_RESERVE_MS } from "../execution/bashTimeout.js";
import { ResidentExecutor } from "../execution/resident.js";
import { CloudflareSandboxExecutor } from "../execution/cloudflareSandbox.js";
import { runCheckTool } from "../tools/check.js";
import { ExecInfraError } from "../execution/executor.js";

const ok = { stdout: "", stderr: "", exitCode: 0, truncated: false };
const metadata = { ...ok, stdout: `/work/repo\n${"a".repeat(40)}\n${"b".repeat(40)}\n` };
const input: CheckExecutionInput = { command: "node tests/focused.js", purpose: "baseline", timeoutMs: 10_000 };
function setup(previous?: unknown) {
  const saved: CheckExecutionState[] = [];
  const execResult = vi.fn().mockResolvedValueOnce(metadata).mockResolvedValue(ok);
  const stop = new AbortController();
  const binding: CheckExecutionBinding = {
    executor: () => ({ execResult }),
    workspace: () => "/work/repo",
    recordingAvailable: true,
    owner: { runId: "r1", requester: "u1", threadKey: "t1", unit: "unit1", repo: "acme/repo" },
    authorizeCommand: () => true,
    previous,
    save: async (state) => {
      saved.push(structuredClone(state));
      return true;
    },
    remainingMs: () => RUN_DEADLINE_RESERVE_MS + 60_000,
    signal: stop.signal,
    clock: () => 100,
  };
  return { binding, saved, execResult, stop, capability: () => createCheckExecution(binding) };
}

describe("recorded coding checks", () => {
  it("holds a restored preflight when the checkout head or fingerprint may have changed at the same path", async () => {
    for (const changed of ["head", "fingerprint"]) {
      const original = setup();
      original.binding.executor = () => ({
        inspectCheckResult: async () => undefined,
        execResult: async () => {
          throw new Error("preflight reply lost");
        },
      });
      expect(await original.capability().run(input, "original")).toMatchObject({
        kind: "unavailable",
        reason: "metadata_unavailable",
      });
      const saved = structuredClone(original.saved.at(-1)!);
      saved.metadata!.result = metadata;
      const currentMetadata = {
        ...metadata,
        stdout: `/work/repo\n${(changed === "head" ? "c" : "a").repeat(40)}\n${(changed === "fingerprint" ? "d" : "b").repeat(40)}\n`,
      };
      const restored = setup(saved);
      const effects: string[] = [];
      restored.binding.executor = () => ({
        inspectCheckResult: async () => metadata,
        execResult: async (command) => {
          effects.push(command);
          return { ...currentMetadata, stdout: "command ran against changed checkout" };
        },
      });
      expect(await restored.capability().run(input, "original")).toEqual({
        kind: "unavailable",
        reason: "metadata_revalidation_required",
      });
      expect(effects).toEqual([]);
      expect(restored.saved.at(-1)?.metadata?.result).toEqual(metadata);
      expect(restored.saved.at(-1)?.receipts).toEqual([]);
      const failures: Array<{ code: string; recovery: string }> = [];
      const text = await runCheckTool.run({ ...input }, {
        checkExecution: restored.capability(),
        callId: "original",
        reportToolFailure: (failure) => {
          failures.push(failure);
        },
      } as Parameters<typeof runCheckTool.run>[1]);
      expect(text).toBe(
        "error: original metadata completed; selected command did not start because checkout freshness is unverified. The saved metadata remains retained.",
      );
      expect(failures.at(-1)).toEqual({ code: "capability_unavailable", recovery: "stop" });
      expect(effects).toEqual([]);
    }
  });

  it("reports metadata capacity before start and preserves other held command identities", async () => {
    const prior = setup();
    prior.execResult
      .mockReset()
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(new ExecInfraError("original unknown", "transport-lost"));
    expect(await prior.capability().run(input, "held-original")).toMatchObject({
      receipt: { outcome: { kind: "unknown" } },
    });
    const retained = prior.saved.at(-1)!;
    const s = setup(retained);
    let requests = 0;
    s.binding.executor = () =>
      new ResidentExecutor({
        baseUrl: "https://resident.example",
        token: "fixture",
        resource: "repo:acme/repo",
        threadKey: "t1",
        runId: "r1",
        ownerGen: "g1",
        ownerFence: 1,
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        requests++;
        return Response.json({ error: "capacity", reason: "check-capacity", status: 409 });
      }),
    );
    try {
      const cap = s.capability();
      const result = await runCheckTool.run({ ...input, command: "different command" }, {
        checkExecution: cap,
        callId: "new-call",
      } as Parameters<typeof runCheckTool.run>[1]);
      expect(result).toBe("error: recorded check capacity exhausted; command did not start");
      expect(requests).toBe(1);
      expect(s.saved.at(-1)).toEqual(retained);
      expect(await cap.run(input, "new-identity-for-held-command")).toEqual({
        kind: "unavailable",
        reason: "reconciliation_required",
      });
      expect(requests).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("holds metadata admission or result persistence failure before the selected command starts", async () => {
    for (const phase of ["admission", "result"] as const) {
      const s = setup();
      const effects: string[] = [];
      s.binding.executor = () => ({
        inspectCheckResult: async () => metadata,
        execResult: async (command) => {
          effects.push(command);
          return metadata;
        },
      });
      s.binding.save = async (state) => phase === "result" && !state.metadata?.result;
      const cap = s.capability();
      expect(await cap.run(input, "original")).toEqual({ kind: "unavailable", reason: "persistence_failed" });
      expect(effects.length).toBe(phase === "admission" ? 0 : 1);
      expect(await cap.run(input, "original")).toEqual({ kind: "unavailable", reason: "persistence_failed" });
      expect(effects.length).toBe(phase === "admission" ? 0 : 1);
    }
  });

  it("inspects retained metadata without dispatch while inputs and foreign owners stay held", async () => {
    const s = setup();
    s.binding.executor = () => ({
      inspectCheckResult: async () => undefined,
      execResult: async () => {
        throw new Error("lost metadata");
      },
    });
    expect(await s.capability().run(input, "original")).toMatchObject({
      kind: "unavailable",
      reason: "metadata_unavailable",
    });
    const saved = s.saved.at(-1)!;
    expect(saved).toMatchObject({ receipts: [], metadata: { callId: "original", workspace: "/work/repo" } });
    const restored = setup(saved);
    const effects: string[] = [];
    restored.binding.executor = () => ({
      inspectCheckResult: async () => metadata,
      execResult: async (command) => {
        effects.push(command);
        return { ...ok, stdout: "business only" };
      },
    });
    const cap = restored.capability();
    expect(await cap.run(input, "different-call")).toEqual({ kind: "unavailable", reason: "reconciliation_required" });
    expect(await cap.run({ ...input, command: "different" }, "original")).toEqual({
      kind: "unavailable",
      reason: "reconciliation_required",
    });
    expect(await cap.run(input, "original")).toEqual({ kind: "unavailable", reason: "metadata_revalidation_required" });
    expect(effects).toEqual([]);
    expect(restored.saved.at(-1)?.metadata?.result).toEqual(metadata);
    const foreign = setup(saved);
    foreign.binding.owner = { ...foreign.binding.owner, runId: "foreign" };
    expect(await foreign.capability().run(input, "original")).toEqual({ kind: "unavailable", reason: "invalid_state" });
    expect(foreign.execResult).not.toHaveBeenCalled();
  });

  it("recovers the original metadata reply before starting the selected command", async () => {
    const s = setup();
    const requests: string[] = [];
    const identities: unknown[] = [];
    let original: unknown;
    s.binding.executor = () =>
      new ResidentExecutor({
        baseUrl: "https://resident.example",
        token: "fixture",
        resource: "repo:acme/repo",
        threadKey: "t1",
        runId: "r1",
        ownerGen: "g1",
        ownerFence: 1,
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const body = JSON.parse(String(init.body));
        requests.push(path);
        if (requests.length === 1) {
          original = body.checkOperation;
          identities.push(original);
          throw new Error("metadata reply lost");
        }
        if (path === "/native/exec-result")
          return Response.json({ kind: "completed", checkOperation: original, result: metadata });
        identities.push(body.checkOperation);
        return Response.json({ ...ok, stdout: "selected command executed once" });
      }),
    );
    try {
      expect(await s.capability().run(input, "metadata-recovery")).toMatchObject({
        kind: "recorded",
        receipt: { outcome: { kind: "completed", stdout: "selected command executed once" } },
      });
      expect(requests).toEqual(["/native/exec", "/native/exec-result", "/native/exec"]);
      expect(identities[0]).toMatchObject({ key: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(identities[1]).not.toEqual(identities[0]);
      expect(s.saved[0]).toMatchObject({
        receipts: [],
        metadata: { callId: "metadata-recovery", checkOperation: identities[0] },
      });
      expect(s.saved.at(-1)?.receipts[0]?.outcome).toEqual({
        kind: "completed",
        ...ok,
        stdout: "selected command executed once",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports an unavailable result read without exposing response or error text", async () => {
    const operation = { key: "a".repeat(64), commandHash: "b".repeat(64) };
    const executor = new ResidentExecutor({
      baseUrl: "https://resident.example",
      token: "private-token",
      resource: "repo:acme/repo",
      threadKey: "t1",
      runId: "r1",
      ownerGen: "g1",
      ownerFence: 1,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ kind: "unknown", error: "Cookie: private-response" })),
    );
    try {
      expect(await executor.inspectCheckResult(operation)).toBeUndefined();
      expect(warn.mock.calls.map((args) => [args[0], JSON.parse(String(args[1]))])).toEqual([
        [
          "[check-result]",
          {
            version: 1,
            code: "result_not_completed",
            threadKey: "t1",
            runId: "r1",
            ownerFence: 1,
            operationKey: "a".repeat(64),
          },
        ],
      ]);
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("records a definite Resident capacity refusal as not started", async () => {
    const s = setup();
    let requests = 0;
    s.binding.executor = () =>
      new ResidentExecutor({
        baseUrl: "https://resident.example",
        token: "fixture",
        resource: "repo:acme/repo",
        threadKey: "t1",
        runId: "r1",
        ownerGen: "g1",
        ownerFence: 1,
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        ++requests === 1
          ? Response.json(metadata)
          : Response.json({ error: "check capacity", status: 409, reason: "check-capacity" }),
      ),
    );
    try {
      expect(await s.capability().run(input, "capacity")).toMatchObject({
        kind: "recorded",
        receipt: { outcome: { kind: "not_started", reason: "capacity" } },
      });
      expect(requests).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("holds unreadable or mismatched result inspection and a failed recovery receipt write", async () => {
    for (const fault of ["unreadable", "wrong-key", "wrong-command", "not-saved"]) {
      const s = setup();
      let requests = 0;
      let op: { key: string; commandHash: string };
      s.binding.executor = () =>
        new ResidentExecutor({
          baseUrl: "https://resident.example",
          token: "fixture",
          resource: "repo:acme/repo",
          threadKey: "t1",
          runId: "r1",
          ownerGen: "g1",
          ownerFence: 1,
        });
      const save = s.binding.save;
      if (fault === "not-saved")
        s.binding.save = async (state) =>
          (state.receipts.length === 0 || state.receipts[0]?.outcome.kind === "pending") && (await save(state));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url, init: RequestInit) => {
          const path = new URL(String(url)).pathname;
          if (++requests === 1) return Response.json(metadata);
          if (path === "/exec") {
            op = JSON.parse(String(init.body)).checkOperation;
            throw new Error("reply lost");
          }
          if (fault === "unreadable") throw new Error("result read lost");
          return Response.json({
            kind: "completed",
            checkOperation: {
              ...op,
              ...(fault === "wrong-key"
                ? { key: "f".repeat(64) }
                : fault === "wrong-command"
                  ? { commandHash: "f".repeat(64) }
                  : {}),
            },
            result: ok,
          });
        }),
      );
      try {
        const answer = await s.capability().run(input, "held");
        expect(answer).toMatchObject(
          fault === "not-saved"
            ? { kind: "unavailable", reason: "persistence_failed" }
            : { kind: "recorded", receipt: { outcome: { kind: "unknown" } } },
        );
        expect(requests).toBe(3);
      } finally {
        vi.unstubAllGlobals();
      }
    }
  });

  it("inspects a retained unknown check on the same identity without redispatch and holds mismatches", async () => {
    const s = setup();
    const inspector = vi.fn().mockResolvedValue(undefined);
    s.execResult
      .mockReset()
      .mockResolvedValueOnce(metadata)
      .mockRejectedValueOnce(new ExecInfraError("lost", "transport-lost"));
    s.binding.executor = () => ({ execResult: s.execResult, inspectCheckResult: inspector });
    expect(await s.capability().run(input, "original")).toMatchObject({
      receipt: {
        outcome: { kind: "unknown" },
        checkOperation: { commandHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    });
    const saved = structuredClone(s.saved.at(-1)!);
    const restored = setup(saved);
    restored.binding.executor = () => ({
      execResult: restored.execResult,
      inspectCheckResult: async () => ({ ...ok, stdout: "original process result" }),
    });
    const cap = restored.capability();
    expect(await cap.run({ ...input, command: "different" }, "original")).toEqual({
      kind: "unavailable",
      reason: "call_mismatch",
    });
    expect(await cap.run(input, "different-id")).toEqual({ kind: "unavailable", reason: "reconciliation_required" });
    expect(await cap.run(input, "original")).toMatchObject({
      kind: "recorded",
      replayed: true,
      receipt: { outcome: { kind: "completed", stdout: "original process result", exitCode: 0 } },
    });
    expect(restored.execResult).not.toHaveBeenCalled();
    expect(restored.saved.at(-1)?.receipts[0]?.outcome).toEqual({
      kind: "completed",
      ...ok,
      stdout: "original process result",
    });
    const legacy = structuredClone(saved);
    delete legacy.receipts[0]!.checkOperation;
    const old = setup(legacy);
    old.binding.executor = restored.binding.executor;
    expect(await old.capability().run(input, "original")).toMatchObject({ receipt: { outcome: { kind: "unknown" } } });
  });

  it("recovers a saved Resident command result after a lost reply without repeating execution", async () => {
    const s = setup();
    const requests: string[] = [];
    let key: unknown;
    const executor = new ResidentExecutor({
      baseUrl: "https://resident.example",
      token: "fixture",
      resource: "repo:acme/repo",
      threadKey: "t1",
      runId: "r1",
      ownerGen: "g1",
      ownerFence: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, init: RequestInit) => {
        const path = new URL(String(url)).pathname;
        const body = JSON.parse(String(init.body));
        requests.push(path);
        if (requests.length === 1) return Response.json(metadata);
        if (path === "/native/exec") {
          key = body.checkOperation;
          throw new TypeError("reply lost");
        }
        if (path === "/native/exec-result")
          return Response.json({ kind: "completed", checkOperation: key, result: { ...ok, stdout: "one execution" } });
        throw new Error("unexpected route");
      }),
    );
    s.binding.executor = () => executor;
    try {
      const result = await s.capability().run(input, "recoverable-call");
      expect(result).toMatchObject({
        kind: "recorded",
        receipt: { outcome: { kind: "completed", stdout: "one execution", exitCode: 0 } },
      });
      expect(requests).toEqual(["/native/exec", "/native/exec", "/native/exec-result"]);
      expect(s.saved.at(-1)?.receipts[0]?.outcome).toEqual({ kind: "completed", ...ok, stdout: "one execution" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("retains a typed command failure on durable replay without dispatch or prose classification", async () => {
    for (const typed of [true, false]) {
      const w = setup();
      const error = typed
        ? new Error("PRIVATE wrapper", { cause: new ExecInfraError("PRIVATE command failure", "transport-lost") })
        : Object.assign(new Error("PRIVATE transport-lost"), { name: "ExecInfraError", reason: "transport-lost" });
      // The metadata observation precedes the command failure.
      w.execResult.mockReset().mockResolvedValueOnce(metadata).mockRejectedValueOnce(error);
      const result = await w.capability().run(input, "original");
      const expected = typed
        ? { kind: "unknown", reason: "transport", infrastructureReason: "transport-lost" }
        : { kind: "unknown", reason: "transport" };
      expect(result).toMatchObject({ kind: "recorded", receipt: { outcome: expected } });
      expect(w.saved.at(-1)?.receipts[0]?.outcome).toEqual(expected);
      const restored = setup(w.saved.at(-1));
      const replay = await restored.capability().run(input, "original");
      expect(replay).toMatchObject({ kind: "recorded", replayed: true, receipt: { outcome: expected } });
      expect(JSON.stringify([result, replay])).not.toContain("PRIVATE");
      expect(restored.execResult).not.toHaveBeenCalled();
    }
  });

  it.each(["resident", "sandbox"] as const)(
    "keeps the process timeout while awaiting its %s response and honors the original controls",
    async (backend) => {
      for (const ending of ["delivered", "call_stop", "run_stop", "deadline", "process_timeout"] as const) {
        vi.useFakeTimers();
        try {
          const s = setup();
          const call = new AbortController();
          const wires: Array<{ command: string; timeoutMs: number }> = [];
          const result = {
            ...ok,
            stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
            exitCode: ending === "process_timeout" ? 124 : 0,
          };
          if (ending === "deadline") s.binding.remainingMs = () => RUN_DEADLINE_RESERVE_MS + 1200;
          vi.stubGlobal(
            "fetch",
            vi.fn(async (_url, init: RequestInit) => {
              if (new URL(String(_url)).pathname === "/exec-result") return Response.json({ kind: "unknown" });
              wires.push(JSON.parse(String(init.body)));
              if (wires.length === 1) return new Response(JSON.stringify(metadata));
              return new Response(
                new ReadableStream({
                  start(controller) {
                    const timer = setTimeout(() => {
                      controller.enqueue(new TextEncoder().encode(JSON.stringify(result)));
                      controller.close();
                    }, 1500);
                    init.signal?.addEventListener(
                      "abort",
                      () => {
                        clearTimeout(timer);
                        controller.error(new Error("response interrupted"));
                      },
                      { once: true },
                    );
                  },
                }),
              );
            }),
          );
          const executor =
            backend === "resident"
              ? new ResidentExecutor({
                  baseUrl: "https://resident.example",
                  token: "private-token",
                  resource: "repo:acme/repo",
                  threadKey: "cli:private",
                })
              : new CloudflareSandboxExecutor({
                  url: "https://sandbox.example",
                  token: "private-token",
                  threadKey: "cli:private",
                  resolveEnvs: async () => ({}),
                });
          s.binding.executor = () => executor;
          const capability = s.capability();
          if (ending === "call_stop") setTimeout(() => call.abort(), 500);
          if (ending === "run_stop") setTimeout(() => s.stop.abort(), 500);
          const response = capability.run(
            { command: "git rev-parse HEAD", purpose: "verification", timeoutMs: 1000 },
            "original-call",
            { signal: call.signal },
          );
          await vi.advanceTimersByTimeAsync(1500);
          expect(await response).toMatchObject({
            kind: "recorded",
            receipt: {
              callId: "original-call",
              timeoutMs: 1000,
              outcome:
                ending === "delivered" ? { kind: "completed", ...result } : { kind: "unknown", reason: "interrupted" },
            },
          });
          expect(wires[1]).toMatchObject({
            command: "cd -- '/work/repo' && bash -c 'git rev-parse HEAD'",
            timeoutMs: 1000,
          });
          expect(s.saved.flatMap((state) => (state.receipts[0] ? [state.receipts[0].outcome.kind] : []))).toEqual([
            "pending",
            ending === "delivered" ? "completed" : "unknown",
          ]);
        } finally {
          vi.clearAllTimers();
          vi.useRealTimers();
          vi.unstubAllGlobals();
        }
      }
    },
  );

  it("records a short command after metadata takes longer than the command timeout", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      s.execResult
        .mockReset()
        .mockImplementationOnce(async (_command, options) => {
          return new Promise((resolve, reject) => {
            options?.signal?.addEventListener(
              "abort",
              () => reject(new ExecInfraError("metadata aborted", "aborted")),
              {
                once: true,
              },
            );
            setTimeout(() => resolve(metadata), 1500);
          });
        })
        .mockResolvedValue({ ...ok, stdout: "short check passed" });
      const result = s.capability().run({ ...input, timeoutMs: 1000 }, "short-check");
      await vi.advanceTimersByTimeAsync(1500);
      expect(await result).toMatchObject({
        kind: "recorded",
        receipt: {
          timeoutMs: 1000,
          outcome: { kind: "completed", stdout: "short check passed", stderr: "", exitCode: 0, truncated: false },
        },
      });
      expect(s.saved.flatMap((state) => (state.receipts[0] ? [state.receipts[0].outcome.kind] : []))).toEqual([
        "pending",
        "completed",
      ]);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ["resident", "metadata_deadline"],
    ["resident", "run_control"],
    ["resident", "call_control"],
    ["resident", "simultaneous"],
    ["resident", "later_control"],
    ["resident", "default"],
    ["resident", "clipped"],
    ["sandbox", "metadata_deadline"],
    ["sandbox", "run_control"],
    ["sandbox", "call_control"],
    ["sandbox", "simultaneous"],
    ["sandbox", "later_control"],
    ["sandbox", "default"],
    ["sandbox", "clipped"],
  ] as const)(
    "distinguishes metadata deadline and control cancellation through the actual %s adapter: %s",
    async (backend, source) => {
      try {
        vi.useFakeTimers();
        const s = setup();
        if (source === "clipped") s.binding.remainingMs = () => RUN_DEADLINE_RESERVE_MS + 1500;
        const effectiveTimeoutMs = source === "clipped" ? 1500 : 10000;
        const call = new AbortController();
        const wires: Array<{ command: string; timeoutMs: number }> = [];
        let pendingBody = false;
        let failMetadata: (() => void) | undefined;
        vi.stubGlobal(
          "fetch",
          vi.fn(async (_url, init: RequestInit) => {
            if (new URL(String(_url)).pathname === "/exec-result") return Response.json({ kind: "unknown" });
            wires.push(JSON.parse(String(init.body)));
            if (!pendingBody)
              return new Response(
                JSON.stringify(wires.length === 1 ? metadata : { ...ok, stdout: "private completed output" }),
              );
            return new Response(
              new ReadableStream({
                start(controller) {
                  failMetadata = () => controller.error(new Error("private body failure"));
                  init.signal?.addEventListener(
                    "abort",
                    () => {
                      if (source !== "later_control") failMetadata!();
                    },
                    { once: true },
                  );
                },
              }),
            );
          }),
        );
        const executor =
          backend === "resident"
            ? new ResidentExecutor({
                baseUrl: "https://resident.example",
                token: "private-token",
                resource: "repo:acme/repo",
                threadKey: "cli:private",
              })
            : new CloudflareSandboxExecutor({
                url: "https://sandbox.example",
                token: "private-token",
                threadKey: "cli:private",
                resolveEnvs: async () => ({ PRIVATE: "private-env" }),
              });
        s.binding.executor = () => executor;
        const capability = s.capability();
        const ctx = { checkExecution: capability, callId: "call-completed" } as Parameters<typeof runCheckTool.run>[1];
        const selected = {
          ...input,
          timeoutMs: source === "default" ? undefined : source === "clipped" ? 10000 : 1000,
        };
        const completed = await runCheckTool.run(selected, ctx);
        expect(completed).toContain("completed with exit 0");
        expect(s.saved.at(-1)?.receipts[0]?.outcome).toEqual({
          kind: "completed",
          ...ok,
          stdout: "private completed output",
        });
        expect(s.saved.flatMap((state) => (state.receipts[0] ? [state.receipts[0].outcome.kind] : []))).toEqual([
          "pending",
          "completed",
        ]);
        expect(wires[1]?.command).toContain("node tests/focused.js");
        const savedBytes = JSON.stringify(s.saved);
        vi.clearAllTimers();
        wires.length = 0;
        pendingBody = true;
        const result = runCheckTool.run(selected, { ...ctx, callId: "call-pending", signal: call.signal });
        await vi.advanceTimersByTimeAsync(0);
        expect(wires).toHaveLength(1);
        expect(wires[0]?.timeoutMs).toBe(effectiveTimeoutMs);
        if (source === "run_control") s.stop.abort(new Error("private run reason"));
        else if (source === "call_control") call.abort(new Error("private call reason"));
        else if (source === "simultaneous") {
          s.stop.abort(new Error("private run reason"));
          call.abort(new Error("private call reason"));
        } else {
          await vi.advanceTimersByTimeAsync(effectiveTimeoutMs);
          if (source === "later_control") {
            call.abort(new Error("private late reason"));
            failMetadata!();
          }
        }
        const output = await result;
        expect(output).toContain(
          "error: recorded check unavailable (metadata_unavailable); no completion receipt was returned",
        );
        expect(wires).toHaveLength(1);
        expect(wires[0]?.command).not.toBe(selected.command);
        if (backend === "resident") {
          expect(s.saved.at(-1)?.receipts).toEqual(JSON.parse(savedBytes).at(-1).receipts);
          expect(s.saved.at(-1)?.metadata).toMatchObject({ callId: "call-pending", workspace: "/work/repo" });
          expect(s.saved.at(-1)?.metadata?.result).toBeUndefined();
        } else expect(JSON.stringify(s.saved)).toBe(savedBytes);
        expect(output).not.toContain("private");
        if (typeof output !== "string") throw new Error("Expected string result");
        expect(JSON.parse(output.split("Metadata diagnostic: ")[1]!)).toEqual({
          phase: "execute",
          kind: "thrown",
          infrastructureReason: "aborted",
          abortSource: ["simultaneous", "later_control"].includes(source)
            ? "ambiguous"
            : ["default", "clipped"].includes(source)
              ? "metadata_deadline"
              : source,
          effectiveTimeoutMs,
        });
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );

  it("keeps an unobserved typed abort unknown and leaves arbitrary error diagnostics unchanged", async () => {
    for (const typed of [false, true]) {
      const s = setup();
      s.execResult
        .mockReset()
        .mockRejectedValue(
          typed ? new ExecInfraError("private abort", "aborted") : new Error("private TimeoutError aborted"),
        );
      expect(await s.capability().run({ ...input, timeoutMs: 2000 }, "call-one")).toEqual({
        kind: "unavailable",
        reason: "metadata_unavailable",
        metadataFailure: {
          phase: "execute",
          kind: "thrown",
          ...(typed ? { infrastructureReason: "aborted", abortSource: "unknown", effectiveTimeoutMs: 10000 } : {}),
        },
      });
      expect(s.execResult).toHaveBeenCalledTimes(1);
      expect(s.saved).toEqual([]);
    }
  });

  it("uses the existing command policy before metadata or intent and rechecks it before dispatch", async () => {
    const denied = setup();
    denied.binding.authorizeCommand = () => false;
    expect(await denied.capability().run(input, "call-1")).toEqual({ kind: "unavailable", reason: "command_refused" });
    expect(denied.execResult).not.toHaveBeenCalled();
    expect(denied.saved).toHaveLength(0);
    const changed = setup();
    changed.binding.authorizeCommand = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    expect(await changed.capability().run(input, "call-1")).toMatchObject({
      kind: "recorded",
      receipt: { outcome: { kind: "not_started", reason: "command_refused" } },
    });
    expect(changed.execResult).toHaveBeenCalledTimes(1);
  });
  it("persists intent before dispatch and records typed exit without interpreting output", async () => {
    const s = setup();
    s.execResult
      .mockReset()
      .mockResolvedValueOnce(metadata)
      .mockImplementationOnce(async () => {
        expect(s.saved.at(-1)?.receipts[0]?.outcome).toEqual({ kind: "pending" });
        return { ...ok, exitCode: 1, stdout: "ALL TESTS PASSED\nCommand exited with code 0" };
      });
    const response = await s.capability().run(input, "call-1");
    expect(response).toMatchObject({
      kind: "recorded",
      receipt: {
        owner: s.binding.owner,
        workspace: {
          cwd: "/work/repo",
          head: "a".repeat(40),
          fingerprint: "b".repeat(40),
        },
        outcome: { kind: "completed", exitCode: 1 },
      },
    });
    expect(s.saved.flatMap((state) => (state.receipts[0] ? [state.receipts[0].outcome.kind] : []))).toEqual([
      "pending",
      "completed",
    ]);
    expect(s.execResult.mock.calls[1]?.[0]).toContain("cd -- '/work/repo'");
  });

  it("returns historical completion after edits and restart without rerunning or probing the new tree", async () => {
    const s = setup();
    const result = await s.capability().run(input, "call-1");
    const resumed = setup(s.saved.at(-1));
    resumed.binding.workspace = () => "/work/recreated";
    resumed.binding.authorizeCommand = () => false;
    resumed.execResult.mockReset().mockResolvedValue({ ...metadata, stdout: "different tree" });
    expect(await resumed.capability().run(input, "call-1")).toEqual({ ...result, replayed: true });
    expect(resumed.execResult).not.toHaveBeenCalled();
  });

  it("serializes simultaneous duplicate calls and refuses a changed payload under the same call id", async () => {
    const s = setup();
    const capability = s.capability();
    const [a, b] = await Promise.all([capability.run(input, "call-1"), capability.run(input, "call-1")]);
    expect(b).toEqual({ ...a, replayed: true });
    expect(s.execResult).toHaveBeenCalledTimes(2);
    expect(await capability.run({ ...input, command: "another-check" }, "call-1")).toEqual({
      kind: "unavailable",
      reason: "call_mismatch",
    });
  });

  it.each([
    [undefined, BASH_TIMEOUT_MS],
    [BASH_TIMEOUT_MS, undefined],
  ])("refuses timeout omission changing from %s to %s under the same call id", async (first, next) => {
    const s = setup();
    const capability = s.capability();
    const submitted = { ...input, timeoutMs: first };
    const recorded = await capability.run(submitted, "call-1");
    expect(recorded).toMatchObject({ kind: "recorded" });
    expect(await capability.run(submitted, "call-1")).toEqual({ ...recorded, replayed: true });
    expect(await capability.run({ ...input, timeoutMs: next }, "call-1")).toEqual({
      kind: "unavailable",
      reason: "call_mismatch",
    });
    expect(s.execResult).toHaveBeenCalledTimes(2);
  });

  it.each([124, 137, 143])(
    "retains exit %s as unknown and suppresses another call id for the same command",
    async (exitCode) => {
      const s = setup();
      s.execResult.mockResolvedValueOnce({ ...ok, exitCode });
      const first = await s.capability().run(input, "call-1");
      expect(first).toMatchObject({ kind: "recorded", receipt: { outcome: { kind: "unknown" } } });
      const resumed = setup(s.saved.at(-1));
      const capability = resumed.capability();
      expect(await capability.run(input, "call-1")).toEqual({ ...first, replayed: true });
      expect(await capability.run(input, "call-2")).toEqual({ kind: "unavailable", reason: "reconciliation_required" });
      expect(resumed.execResult).not.toHaveBeenCalled();
    },
  );

  it.each(["transport", "malformed", "abort"])(
    "records %s as unknown without inventing successful completion",
    async (failure) => {
      const s = setup();
      s.execResult
        .mockReset()
        .mockResolvedValueOnce(metadata)
        .mockImplementationOnce(async () => {
          if (failure === "transport") throw new Error("private transport body");
          if (failure === "abort") s.stop.abort();
          return failure === "malformed" ? { stdout: "PASS" } : ok;
        });
      const result = await s.capability().run(input, "call-1");
      expect(result).toMatchObject({ kind: "recorded", receipt: { outcome: { kind: "unknown" } } });
      expect(JSON.stringify(result)).not.toContain("private transport body");
    },
  );

  it.each(["pending", "unknown"] as const)(
    "preserves %s uncertainty when recording and the checkout are unavailable after resume",
    async (kind) => {
      const s = setup();
      s.execResult.mockResolvedValueOnce({ ...ok, exitCode: 124 });
      await s.capability().run(input, "call-1");
      const previous = s.saved.find((state) => state.receipts[0]?.outcome.kind === kind)!;
      const resumed = setup(previous);
      resumed.binding.recordingAvailable = false;
      resumed.binding.workspace = () => undefined;
      const capability = resumed.capability();
      expect(await capability.run(input, "call-1")).toMatchObject({
        kind: "recorded",
        receipt: { outcome: { kind } },
      });
      expect(await capability.run(input, "call-2")).toEqual({ kind: "unavailable", reason: "reconciliation_required" });
      expect(resumed.execResult).not.toHaveBeenCalled();
      expect(resumed.saved).toHaveLength(0);
    },
  );

  it.each(["intent", "completion"])("does not return an accepted receipt when %s persistence fails", async (phase) => {
    const s = setup();
    s.binding.save = async (state) => phase === "completion" && state.receipts[0]?.outcome.kind === "pending";
    const capability = s.capability();
    expect(await capability.run(input, "call-1")).toEqual({ kind: "unavailable", reason: "persistence_failed" });
    expect(await capability.run(input, "call-2")).toEqual({ kind: "unavailable", reason: "persistence_failed" });
    expect(s.execResult).toHaveBeenCalledTimes(phase === "intent" ? 1 : 2);
  });

  it("refuses absent capabilities, malformed metadata, exhausted budget and stopped runs before dispatch", async () => {
    const unsupported = setup();
    unsupported.binding.executor = () => ({});
    expect(await unsupported.capability().run(input, "call-1")).toMatchObject({ reason: "unsupported_executor" });
    const malformed = setup();
    malformed.execResult.mockReset().mockResolvedValue({ ...metadata, stdout: "pretend metadata" });
    expect(await malformed.capability().run(input, "call-1")).toMatchObject({ reason: "metadata_unavailable" });
    expect(malformed.execResult).toHaveBeenCalledTimes(1);
    const exhausted = setup();
    exhausted.binding.remainingMs = () => RUN_DEADLINE_RESERVE_MS;
    expect(await exhausted.capability().run(input, "call-1")).toMatchObject({ reason: "budget_exhausted" });
    expect(exhausted.execResult).not.toHaveBeenCalled();
    const stopped = setup();
    stopped.stop.abort();
    expect(await stopped.capability().run(input, "call-1")).toMatchObject({ reason: "stopped" });
    expect(stopped.execResult).not.toHaveBeenCalled();
  });

  it("bounds result streams, records empty output honestly and rejects malformed or foreign durable state", async () => {
    const s = setup();
    s.execResult.mockResolvedValueOnce({ ...ok, stdout: "x".repeat(20_000) });
    const result = await s.capability().run(input, "call-1");
    expect(result).toMatchObject({ kind: "recorded", receipt: { outcome: { kind: "completed", truncated: true } } });
    expect(JSON.stringify(result).length).toBeLessThan(8_000);
    expect(await setup(s.saved.at(-1)).capability().run(input, "call-1")).toEqual({ ...result, replayed: true });
    for (const previous of [
      { version: 1, receipts: [{}] },
      { ...s.saved.at(-1), version: 2 },
    ]) {
      const resumed = setup(previous);
      expect(await resumed.capability().run(input, "call-1")).toMatchObject({ reason: "invalid_state" });
      expect(resumed.execResult).not.toHaveBeenCalled();
    }
    const foreign = setup(s.saved.at(-1));
    foreign.binding.owner.runId = "r2";
    expect(await foreign.capability().run(input, "call-1")).toMatchObject({ reason: "invalid_state" });
  });

  it("uses the rebound executor and clips each command to the original run reserve", async () => {
    const s = setup();
    const rebound = vi.fn().mockResolvedValueOnce(metadata).mockResolvedValue(ok);
    const capability = s.capability();
    s.binding.executor = () => ({ execResult: rebound });
    s.binding.remainingMs = () => RUN_DEADLINE_RESERVE_MS + 2_000;
    expect(await capability.run(input, "call-1")).toMatchObject({ kind: "recorded", receipt: { timeoutMs: 2_000 } });
    expect(s.execResult).not.toHaveBeenCalled();
    expect(rebound.mock.calls[1]?.[1]).toMatchObject({ timeoutMs: 2_000 });
  });

  it("honors the tool session's narrower deadline and abort independently of the owning run", async () => {
    const clipped = setup();
    expect(
      await clipped.capability().run(input, "call-1", { remainingMs: () => RUN_DEADLINE_RESERVE_MS + 2_000 }),
    ).toMatchObject({ kind: "recorded", receipt: { timeoutMs: 2_000 } });
    expect(clipped.execResult.mock.calls[1]?.[1]).toMatchObject({ timeoutMs: 2_000 });
    const stopped = setup();
    const session = new AbortController();
    stopped.execResult
      .mockReset()
      .mockResolvedValueOnce(metadata)
      .mockImplementationOnce(async (_command, options) => {
        session.abort();
        expect(options.signal.aborted).toBe(true);
        return ok;
      });
    expect(await stopped.capability().run(input, "call-1", { signal: session.signal })).toMatchObject({
      kind: "recorded",
      receipt: { outcome: { kind: "unknown", reason: "interrupted" } },
    });
    expect(stopped.stop.signal.aborted).toBe(false);
  });

  it("never dispatches a queued check after its tool session ends", async () => {
    const s = setup();
    const session = new AbortController();
    const capability = s.capability();
    const first = capability.run(input, "call-1");
    const queued = capability.run({ ...input, command: "another-check" }, "call-2", { signal: session.signal });
    session.abort();
    expect(await first).toMatchObject({ kind: "recorded" });
    expect(await queued).toEqual({ kind: "unavailable", reason: "stopped" });
    expect(s.execResult).toHaveBeenCalledTimes(2);
  });

  it("bounds durable growth without evicting duplicate suppression evidence", async () => {
    const s = setup();
    s.execResult
      .mockReset()
      .mockImplementation(async (command: string) => (command.startsWith("set -eu") ? metadata : ok));
    const capability = s.capability();
    for (let i = 0; i < 32; i++) expect(await capability.run(input, `call-${i}`)).toMatchObject({ kind: "recorded" });
    expect(await capability.run(input, "call-new")).toMatchObject({ reason: "receipt_limit" });
    const calls = s.execResult.mock.calls.length;
    expect(await capability.run(input, "call-0")).toMatchObject({ kind: "recorded" });
    expect(s.execResult).toHaveBeenCalledTimes(calls);
    expect(s.saved.at(-1)?.receipts).toHaveLength(32);
  });

  it.each(["ascii", "escaped"])(
    "refuses %s receipt capacity before dispatch without losing saved identities",
    async (encoding) => {
      const s = setup();
      const sizes: number[] = [];
      s.binding.save = async (state) => {
        const size = new TextEncoder().encode(JSON.stringify(state)).length;
        sizes.push(size);
        if (size > 512 * 1024) return false;
        s.saved.push(structuredClone(state));
        return true;
      };
      s.execResult
        .mockReset()
        .mockImplementation(async (command: string) =>
          command.startsWith("set -eu")
            ? metadata
            : { ...ok, stdout: (encoding === "ascii" ? "x" : "\0").repeat(4_000), stderr: "y".repeat(4_000) },
        );
      const longInput = { ...input, command: `true #${(encoding === "ascii" ? "x" : "\t").repeat(15_994)}` };
      const capability = s.capability();
      const first = await capability.run(longInput, "large-0");
      expect(first).toMatchObject({ kind: "recorded", receipt: { outcome: { kind: "completed", exitCode: 0 } } });
      for (let i = 1; i < 32; i++) {
        const calls = s.execResult.mock.calls.length;
        const result = await capability.run(longInput, `large-${i}`);
        if (result.kind === "recorded") continue;
        expect(result).toEqual({ kind: "unavailable", reason: "capacity" });
        expect(s.execResult).toHaveBeenCalledTimes(calls);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(256 * 1024);
        const restored = setup(s.saved.at(-1));
        expect(await restored.capability().run(longInput, "large-0")).toEqual({ ...first, replayed: true });
        expect(restored.execResult).not.toHaveBeenCalled();
        return;
      }
      throw new Error("Expected byte capacity before the receipt-count limit");
    },
  );

  it.each(["ordinary", "long"])(
    "keeps a quoted check within the receiver limit at the %s checkout path",
    async (kind) => {
      const s = setup();
      const cwd = kind === "long" ? `/${"'".repeat(3_799)}` : "/work/repo";
      s.binding.workspace = () => cwd;
      s.execResult.mockReset().mockImplementation(async (command: string) => {
        if (command.length > 64_000) throw new Error("receiver command limit exceeded before execution");
        return command.startsWith("set -eu")
          ? { ...metadata, stdout: `${cwd}\n${"a".repeat(40)}\n${"b".repeat(40)}\n` }
          : { ...ok, stdout: "quoted check completed" };
      });
      s.binding.executor = () => ({ execResult: s.execResult, inspectCheckResult: async () => undefined });
      const quoteInput = { ...input, command: `true #${"'".repeat(15_994)}` };
      const result = await s.capability().run(quoteInput, "quoted-check");
      expect(result).toMatchObject({
        kind: "recorded",
        receipt: {
          command: quoteInput.command,
          outcome: { kind: "completed", stdout: "quoted check completed", exitCode: 0 },
        },
      });
      const restored = setup(s.saved.at(-1));
      expect(await restored.capability().run(quoteInput, "quoted-check")).toEqual({ ...result, replayed: true });
      expect(restored.execResult).not.toHaveBeenCalled();
    },
  );

  it.each(["ordinary", "quote-heavy"])("executes %s checks in their recorded checkout", async (kind) => {
    const workspace = realpathSync(
      mkdtempSync(join(tmpdir(), `swb-recorded-check-${kind === "quote-heavy" ? "'".repeat(100) : ""}`)),
    );
    const env = { PATH: "/usr/bin:/bin:/usr/local/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    try {
      git("init", "-b", "work");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.invalid");
      writeFileSync(join(workspace, "source.txt"), "before\n");
      git("add", ".");
      git("commit", "-m", "fixture");
      const s = setup();
      s.binding.workspace = () => workspace;
      s.binding.executor = () => ({
        async execResult(command, options) {
          if (command.length > 64_000) throw new Error("receiver command limit exceeded before execution");
          try {
            const stdout = execFileSync("bash", ["-c", command], {
              cwd: tmpdir(),
              env: { ...env, ...options?.env },
              encoding: "utf8",
              timeout: options?.timeoutMs,
              stdio: ["ignore", "pipe", "pipe"],
            });
            return { ...ok, stdout };
          } catch (error) {
            const failure = error as { stdout: string; stderr: string; status: number };
            return { stdout: failure.stdout, stderr: failure.stderr, exitCode: failure.status, truncated: false };
          }
        },
      });
      const capability = s.capability();
      const literal = '$PWD `pwd` \\ "';
      const quoteHeavy = `printf '%s|%s' "$PWD" '${literal}'; exit 7\n# `;
      const actualInput = {
        ...input,
        command:
          kind === "quote-heavy"
            ? quoteHeavy.padEnd(16_000, "'")
            : `# ${"x".repeat(3_000)}\nprintf "%s" "$PWD"; exit 7`,
      };
      const receipt = await capability.run(actualInput, "real-call");
      expect(receipt).toMatchObject({
        kind: "recorded",
        receipt: {
          command: actualInput.command,
          workspace: { cwd: workspace, head: git("rev-parse", "HEAD") },
          outcome: {
            kind: "completed",
            stdout: kind === "quote-heavy" ? `${workspace}|${literal}` : workspace,
            exitCode: 7,
          },
        },
      });
      const scratch = realpathSync(mkdtempSync(join(tmpdir(), "swb-check-scratch-")));
      s.binding.temporaryDirectory = () => scratch;
      try {
        expect(await capability.run({ ...input, command: 'printf "%s" "$TMPDIR"' }, "scratch-call")).toMatchObject({
          kind: "recorded",
          receipt: { outcome: { kind: "completed", stdout: scratch, exitCode: 0 } },
        });
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
      writeFileSync(join(workspace, "source.txt"), "after\n");
      expect(await capability.run(actualInput, "real-call")).toEqual({ ...receipt, replayed: true });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

// Phase 1: command observations bind to a real run, optionally an actual plan unit.
describe("recorded command owner binding", () => {
  it("records and replays a genuine standalone run without minting a unit", async () => {
    const s = setup();
    delete (s.binding.owner as { unit?: string }).unit;
    const first = await s.capability().run(input, "standalone-call");
    expect(first).toMatchObject({ kind: "recorded", receipt: { owner: { runId: "r1", repo: "acme/repo" } } });
    if (first.kind !== "recorded") throw new Error("expected real run owner");
    expect(Object.hasOwn(first.receipt.owner, "unit")).toBe(false);
    const resumed = setup(s.saved.at(-1));
    delete (resumed.binding.owner as { unit?: string }).unit;
    expect(await resumed.capability().run(input, "standalone-call")).toEqual({ ...first, replayed: true });
    expect(resumed.execResult).not.toHaveBeenCalled();
  });

  it.each(["runId", "requester", "threadKey", "repo", "unit"] as const)(
    "rejects an empty owner %s before any metadata or command",
    async (field) => {
      const s = setup();
      s.binding.owner[field] = "";
      expect(await s.capability().run(input, "invalid-owner")).toEqual({
        kind: "unavailable",
        reason: "invalid_state",
      });
      expect(s.execResult).not.toHaveBeenCalled();
      expect(s.saved).toEqual([]);
    },
  );

  it("rejects an explicitly undefined unit before metadata or persistence", async () => {
    const s = setup();
    s.binding.owner.unit = undefined;
    expect(await s.capability().run(input, "undefined-unit")).toEqual({ kind: "unavailable", reason: "invalid_state" });
    expect(s.execResult).not.toHaveBeenCalled();
    expect(s.saved).toEqual([]);
  });

  it.each(["absent", "different"] as const)("rejects %s historical unit ownership", async (kind) => {
    const prior = setup();
    if (kind === "absent") delete prior.binding.owner.unit;
    await prior.capability().run(input, "owner-call");
    const resumed = setup(prior.saved.at(-1));
    if (kind === "different") resumed.binding.owner.unit = "another-unit";
    expect(await resumed.capability().run(input, "owner-call")).toEqual({
      kind: "unavailable",
      reason: "invalid_state",
    });
    expect(resumed.execResult).not.toHaveBeenCalled();
    expect(resumed.saved).toEqual([]);
  });

  it("holds a legacy standalone coding receipt even with matching canonical original metadata", async () => {
    let now = 100;
    const ledger = new InMemoryRunLedger(() => now);
    const prior = setup();
    prior.binding.owner = { runId: "r1", requester: "slack:UALICE", threadKey: "slack:C1:1", repo: "acme/repo" };
    await prior.capability().run(input, "legacy-standalone");
    const legacy = structuredClone(prior.saved.at(-1)!);
    legacy.receipts[0].owner.unit = ""; // The former standalone producer's exact owner shape.
    await ledger.claim({
      runId: "r1",
      threadKey: "slack:C1:1",
      gen: "g1",
      leaseMs: 1000,
      startedAt: now,
      meta: {
        channelId: "slack:C1",
        userId: "slack:UALICE",
        threadKey: "slack:C1:1",
        agent: "coding",
        repo: "acme/repo",
      },
      system: "",
      tools: [],
      state: { checkExecutions: legacy },
    });
    now = 2000;
    const [{ row }] = await ledger.reclaim("g2", now, 1000);
    expect(row.meta).toEqual({
      channelId: "slack:C1",
      userId: "slack:UALICE",
      threadKey: "slack:C1:1",
      agent: "coding",
      repo: "acme/repo",
    });
    expect(Object.hasOwn(row.meta, "idempotencyKey")).toBe(false);
    expect(Object.hasOwn(row.meta, "parentInstanceId")).toBe(false);
    const before = structuredClone(row.state.checkExecutions);
    const resumed = setup(row.state.checkExecutions);
    resumed.binding.owner = {
      runId: row.runId,
      requester: row.meta.userId,
      threadKey: row.meta.threadKey,
      repo: row.meta.repo!,
    };
    const save = vi.fn(
      async (state: CheckExecutionState) => (await ledger.setState(row.runId, "g2", { checkExecutions: state })).ok,
    );
    resumed.binding.save = save;
    for (const callId of ["legacy-standalone", "new-call"])
      expect(await resumed.capability().run(input, callId)).toEqual({ kind: "unavailable", reason: "invalid_state" });
    expect(resumed.execResult).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(ledger.live.get("r1")!.state.checkExecutions).toEqual(before);
  });

  it("does not dispatch after an actual generation-fenced pending write", async () => {
    let now = 100;
    const ledger = new InMemoryRunLedger(() => now);
    expect(
      (
        await ledger.claim({
          runId: "r1",
          threadKey: "slack:C1:1",
          gen: "g1",
          leaseMs: 1000,
          startedAt: now,
          meta: {
            channelId: "slack:C1",
            userId: "slack:UALICE",
            threadKey: "slack:C1:1",
            agent: "review",
            model: "p/m",
          },
          system: "",
          tools: [],
        })
      ).ok,
    ).toBe(true);
    now = 2000;
    expect((await ledger.reclaim("g2", now, 1000)).map((r) => r.row.ownerGen)).toEqual(["g2"]);
    const s = setup();
    s.binding.owner = { runId: "r1", requester: "slack:UALICE", threadKey: "slack:C1:1", repo: "acme/repo" };
    s.binding.save = async (state) => (await ledger.setState("r1", "g1", { checkExecutions: state })).ok;
    expect(await s.capability().run(input, "fenced-intent")).toEqual({
      kind: "unavailable",
      reason: "persistence_failed",
    });
    expect(s.execResult).toHaveBeenCalledTimes(1); // Structural metadata only; no command dispatch.
  });

  it("returns no result credit after an actual generation-fenced completion write", async () => {
    let now = 100;
    const ledger = new InMemoryRunLedger(() => now);
    await ledger.claim({
      runId: "r1",
      threadKey: "slack:C1:1",
      gen: "g1",
      leaseMs: 1000,
      startedAt: now,
      meta: { channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:1", agent: "review", model: "p/m" },
      system: "",
      tools: [],
    });
    const s = setup();
    s.binding.owner = { runId: "r1", requester: "slack:UALICE", threadKey: "slack:C1:1", repo: "acme/repo" };
    s.binding.save = async (state) => (await ledger.setState("r1", "g1", { checkExecutions: state })).ok;
    s.execResult
      .mockReset()
      .mockResolvedValueOnce(metadata)
      .mockImplementationOnce(async () => {
        now = 2000;
        await ledger.reclaim("g2", now, 1000);
        return ok;
      });
    expect(await s.capability().run(input, "fenced-result")).toEqual({
      kind: "unavailable",
      reason: "persistence_failed",
    });
    expect(ledger.live.get("r1")?.state.checkExecutions).toMatchObject({
      receipts: [{ outcome: { kind: "pending" } }],
    });
    expect(s.execResult).toHaveBeenCalledTimes(2);
  });

  it("rejects a unit receipt when the current actual owner has no unit", async () => {
    const prior = setup();
    await prior.capability().run(input, "unit-call");
    const runOnly = setup(prior.saved.at(-1));
    delete (runOnly.binding.owner as { unit?: string }).unit;
    expect(await runOnly.capability().run(input, "unit-call")).toEqual({
      kind: "unavailable",
      reason: "invalid_state",
    });
    expect(runOnly.execResult).not.toHaveBeenCalled();
    expect(runOnly.saved).toEqual([]);
  });

  it("retains an ambiguous legacy empty-unit receipt without normalizing or executing", async () => {
    const prior = setup();
    await prior.capability().run(input, "legacy-call");
    const legacy = structuredClone(prior.saved.at(-1)!);
    legacy.receipts[0].owner.unit = "";
    const before = structuredClone(legacy);
    const resumed = setup(legacy);
    delete (resumed.binding.owner as { unit?: string }).unit;
    expect(await resumed.capability().run(input, "legacy-call")).toEqual({
      kind: "unavailable",
      reason: "invalid_state",
    });
    expect(resumed.execResult).not.toHaveBeenCalled();
    expect(resumed.saved).toEqual([]);
    expect(legacy).toEqual(before);
  });
});

describe("recorded checks with uncertain canonical ACK", () => {
  it.each([
    ["intent", true],
    ["intent", false],
    ["result", true],
    ["result", false],
  ] as const)("holds %s receipt credit after unknown state ACK (committed=%s)", async (phase, committed) => {
    const inner = new InMemoryRunLedger(() => 100);
    const writes: CheckExecutionState[] = [];
    let lost = false;
    let lostRequestDigest: string | undefined;
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "runs:fixture",
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.storeKey).toBe("runs:fixture");
        const path = new URL(String(url)).pathname;
        if (path === "/runs/state") {
          const checks = body.state.checkExecutions as CheckExecutionState | undefined;
          if (checks) writes.push(structuredClone(checks));
          const outcome = checks?.receipts.at(-1)?.outcome.kind;
          if (!lost && outcome === (phase === "intent" ? "pending" : "completed")) {
            lost = true;
            lostRequestDigest = (await storeRequestWitness(path, String(init?.body))).digest;
            if (committed) expect((await inner.setState(body.runId, body.gen, body.state)).ok).toBe(true);
            return new Response("reply unavailable", { status: 500 });
          }
          const result = await inner.setState(body.runId, body.gen, body.state);
          return Response.json(result, { status: result.ok ? 200 : 409 });
        }
        if (path === "/runs/inbox/read") {
          expect(body.peek).toBe(true);
          return Response.json(await inner.peekInbox(body.runId, body.gen, body.afterSeq));
        }
        if (path === "/runs/live-state") {
          return Response.json(await inner.assignLiveState(body.runId, body.gen, body.assignment));
        }
        throw new Error(`unexpected fixture route ${path}`);
      },
    });
    const ledger = new Proxy(inner, {
      get(target, key) {
        if (key === "setState") return wire.setState.bind(wire);
        if (key === "peekInbox") return wire.peekInbox.bind(wire);
        if (key === "assignLiveState") return wire.assignLiveState.bind(wire);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wt = createLedgerWriteThrough({
      ledger,
      gen: "check-current",
      fallback: new InMemoryRunStore(),
      warn: () => {},
    });
    const opened = await wt.open({
      runId: "r1",
      threadKey: "slack:C1:1",
      startedAt: 100,
      meta: {
        agent: "review",
        channelId: "slack:C1",
        userId: "slack:UALICE",
        threadKey: "slack:C1:1",
        repo: "acme/repo",
      },
      card: null,
      system: "",
      tools: [],
    });
    if (opened.kind !== "tracked") throw new Error("canonical claim required");
    expect(
      (await opened.run.assignLiveState({ state: "admitted", at: 100, expectedSeq: 0, eventSeq: 1, bound: 10000 })).ok,
    ).toBe(true);
    const s = setup();
    s.binding.owner = { runId: "r1", requester: "slack:UALICE", threadKey: "slack:C1:1", repo: "acme/repo" };
    s.binding.save = (state) => opened.run.setStateAndFlush({ checkExecutions: state });
    const cap = s.capability();
    try {
      expect(await cap.run(input, "lost-check")).toEqual({ kind: "unavailable", reason: "persistence_failed" });
      expect(s.execResult).toHaveBeenCalledTimes(phase === "intent" ? 1 : 2);
      expect(writes).toHaveLength(phase === "intent" ? 1 : 2);
      const before = structuredClone(inner.live.get("r1")!.state.checkExecutions);
      if (phase === "intent" && !committed) expect(before).toBeUndefined();
      else
        expect(before).toMatchObject({
          receipts: [
            {
              callId: "lost-check",
              outcome: {
                kind: phase === "result" && committed ? "completed" : "pending",
              },
            },
          ],
        });
      const failure = opened.run.writeBoundaryFailure;
      expect(failure).toMatchObject({
        kind: "state",
        runId: "r1",
        gen: "check-current",
        requestDigest: lostRequestDigest,
      });
      const status = await opened.run.assignLiveState({
        state: "working",
        at: 150,
        expectedSeq: 1,
        eventSeq: 2,
        bound: 10000,
        detail: "model turn",
      });
      expect(status.ok).toBe(committed);
      if (!committed) expect(status).toEqual({ ok: false, reason: "unavailable" });
      expect(await opened.run.commitState({ checklist: "after canonical reconciliation" })).toBe(
        committed ? "ok" : "unavailable",
      );
      expect(writes).toHaveLength((phase === "intent" ? 1 : 2) + (committed ? 1 : 0));
      if (!committed) expect(opened.run.writeBoundaryFailure).toEqual(failure);
      expect(await cap.run(input, "another-check")).toEqual({ kind: "unavailable", reason: "persistence_failed" });
      expect(s.execResult).toHaveBeenCalledTimes(phase === "intent" ? 1 : 2);
      expect(inner.live.get("r1")!.state.checkExecutions).toEqual(before);
      const ending: RunRecord = {
        id: "r1",
        channelId: "slack:C1",
        channelVisibility: "public",
        userId: "slack:UALICE",
        threadKey: "slack:C1:1",
        startedAt: 100,
        finishedAt: 200,
        status: "failed",
        events: [],
        eventCount: 0,
        storedEventCount: 0,
        truncated: false,
        diagnosis: analyzeRunFriction([]),
      };
      if (committed) {
        await opened.run.sink.put(ending);
        expect(inner.live.has("r1")).toBe(false);
      } else {
        const row = structuredClone(inner.live.get("r1"));
        await expect(opened.run.sink.put(ending)).rejects.toMatchObject({
          hold: { runId: "r1", gen: "check-current", requestDigest: lostRequestDigest },
          request: { operation: "/runs/state", digest: lostRequestDigest },
        });
        expect(inner.live.get("r1")).toEqual(row);
        expect(opened.run.writeBoundaryFailure).toEqual(failure);
      }
    } finally {
      await opened.run.close();
    }
  });
});
