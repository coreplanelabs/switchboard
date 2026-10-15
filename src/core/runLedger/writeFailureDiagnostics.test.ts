import { describe, expect, it, vi } from "vitest";
import { WorkerRunLedger } from "../runLedgerWorker.js";
import { UncertainStoreError, uncertainStoreSummary } from "../storeFailure.js";
import { sourceHash } from "../references/receipts.js";
import { createLedgerWriteThrough } from "./writeThrough.js";
import { InMemoryRunLedger } from "./inMemory.js";
import { InMemoryRunStore } from "../runStore.js";
import {
  STATE_WRITE_DIAGNOSTIC_HEADER,
  stateWriteException,
  stateWriteDiagnosticHeader,
} from "../runStateWriteDiagnostic.js";
import { storeRequestWitness } from "../storeResponse.js";
import {
  STORAGE_FAILURE_DIAGNOSTIC_HEADER,
  STORAGE_REQUEST_ID_HEADER,
  storageFailureNote,
} from "../storageFailureDiagnostic.js";
import { testRegistry } from "../runRegistry/testing.js";
import type { RunEvent } from "../runEvents.js";
import { assembleRunRecord } from "../dispatch/record.js";
import { analyzeRunFriction } from "../runFriction.js";
import { parseRunEventLines } from "../runEventLines.js";
import * as clock from "../trace/clock.js";

const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const gen = "diagnostic-owner";
const cases = [
  ["transport", { kind: "transport" }],
  ["http", { kind: "http", status: 503 }],
  ["body", { kind: "response-body", status: 200 }],
  ["json", { kind: "response-json", status: 200 }],
  ["shape", { kind: "response-shape", status: 200 }],
  ["ack", { kind: "acknowledgement", status: 200 }],
] as const;

function response(mode: string): Response {
  if (mode === "transport") throw new Error("private transport bytes");
  if (mode === "http") return new Response("private server body", { status: 503 });
  if (mode === "body") {
    const reply = Response.json({ ok: true });
    reply.text = async () => {
      throw new Error("private response bytes");
    };
    return reply;
  }
  if (mode === "json") return new Response("private invalid JSON");
  if (mode === "shape") return Response.json([]);
  if (mode === "refused") return Response.json({ ok: false, reason: "fenced" }, { status: 409 });
  return Response.json({ unexpected: "private malformed ACK" });
}

describe("original uncertain write diagnostics", () => {
  it("retains body evidence from the original decoder without reading a ledger response twice", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const notices: Parameters<typeof storageFailureNote>[0][] = [];
    const replies = [
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("private body failure"));
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
      Response.json({ error: "private refusal" }, { status: 401 }),
    ];
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "fixture",
      onFailure: ({ diagnostic }) => notices.push(diagnostic),
      fetch: async () => replies.shift()!,
    });
    try {
      await expect(wire.setState(id, gen, {})).rejects.toMatchObject({ outcome: "unknown" });
      await expect(wire.listLive()).rejects.toMatchObject({ name: "PermanentStoreError" });
      expect(notices).toMatchObject([
        { phase: "response-body", httpStatus: 200, response: { contentType: "json", bodyKind: "unreadable" } },
        { phase: "http", httpStatus: 401, response: { contentType: "json", bodyKind: "json" } },
      ]);
      expect(JSON.stringify(notices)).not.toMatch(/private body failure|private refusal/);
    } finally {
      warn.mockRestore();
    }
  });

  it("distinguishes identical requests with malformed acknowledgments by their original transport observations", async () => {
    const now = vi.spyOn(clock, "systemClock").mockReturnValue(1000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-a111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-a222-222222222222");
    const notices: Parameters<typeof storageFailureNote>[0][] = [];
    let calls = 0;
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "fixture",
      onFailure: ({ diagnostic }) => notices.push(diagnostic),
      fetch: async () => {
        calls++;
        now.mockReturnValue(calls === 1 ? 1005 : 1010);
        return Response.json({ unexpected: "PRIVATE_ACK" });
      },
    });
    try {
      for (let i = 0; i < 2; i++) {
        const failure = await wire.setState(id, gen, { notepad: "PRIVATE_REQUEST" }).catch((error) => error);
        expect(failure).toMatchObject({ name: "UncertainStoreError", outcome: "unknown" });
      }
      const captured = parseRunEventLines(notices.map((d) => JSON.stringify(storageFailureNote(d))).join("\n"));
      expect(captured.events).toMatchObject([
        {
          storageFailure: {
            phase: "acknowledgement",
            requestId: "11111111-1111-4111-a111-111111111111",
            timing: { elapsedMs: 5, timeoutMs: 10000, deadlineExceeded: false },
          },
        },
        {
          storageFailure: {
            phase: "acknowledgement",
            requestId: "22222222-2222-4222-a222-222222222222",
            timing: { elapsedMs: 5, timeoutMs: 10000, deadlineExceeded: false },
          },
        },
      ]);
      expect(notices[0].requestDigest).toBe(notices[1].requestDigest);
      expect(calls).toBe(2);
      expect(JSON.stringify(captured)).not.toContain("PRIVATE_");
    } finally {
      now.mockRestore();
      warn.mockRestore();
      ids.mockRestore();
    }
  });
  it.each(["deadline", "remote-timeout", "response-body"] as const)(
    "retains elapsed time and deadline evidence for %s without replay",
    async (mode) => {
      const controller = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
      const now = vi.spyOn(clock, "systemClock").mockReturnValue(1000);
      const notices: Parameters<typeof storageFailureNote>[0][] = [];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let calls = 0;
      let requestId: string | null = null;
      const wire = new WorkerRunLedger({
        baseUrl: "https://state.invalid",
        token: "fixture",
        storeKey: "fixture",
        onFailure: ({ diagnostic }) => notices.push(diagnostic),
        fetch: async (_url, init) => {
          calls++;
          requestId = new Headers(init?.headers).get(STORAGE_REQUEST_ID_HEADER);
          const error = new DOMException("The operation timed out", "TimeoutError");
          const fail = () => {
            now.mockReturnValue(11000);
            if (mode !== "remote-timeout") controller.abort(error);
            throw error;
          };
          if (mode !== "response-body") return fail();
          const response = Response.json({ ok: true });
          response.text = async () => fail();
          return response;
        },
      });
      try {
        const failure = await wire.setState(id, gen, { notepad: "PRIVATE_REQUEST" }).catch((error) => error);
        expect(failure).toMatchObject({ name: "UncertainStoreError", outcome: "unknown" });
        const captured = parseRunEventLines(JSON.stringify(storageFailureNote(notices[0])));
        expect(captured.events).toMatchObject([
          {
            kind: "storage_failure",
            storageFailure: {
              operation: "/runs/state",
              requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
              phase: mode === "response-body" ? "response-body" : "transport",
              timing: { elapsedMs: 10000, timeoutMs: 10000, deadlineExceeded: mode !== "remote-timeout" },
            },
          },
        ]);
        expect(calls).toBe(1);
        expect(notices[0].requestId).toBe(requestId);
        expect(JSON.stringify(captured)).not.toContain("PRIVATE_REQUEST");
      } finally {
        timeout.mockRestore();
        now.mockRestore();
        warn.mockRestore();
      }
    },
  );

  it("retains a closed append rejection through private backlog trimming and final record assembly", async () => {
    const { reg } = testRegistry({ genId: () => id, backlogLimit: 4 });
    const run = reg.create("private", {
      agent: "orchestrator",
      channelId: "slack:D1",
      userId: "slack:UA",
      threadKey: "slack:D1:1",
      directAudience: { kind: "slack-unshared-im", channelId: "slack:D1", userId: "slack:UA", threadKey: "slack:D1:1" },
    });
    reg.publish(id, { type: "tool_call", tool: "read", summary: "private" });
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "fixture",
      onFailure: ({ diagnostic }) => reg.publish(id, storageFailureNote(diagnostic)),
      fetch: async (url, init) => {
        const witness = await storeRequestWitness(new URL(String(url)).pathname, String(init?.body));
        return Response.json(
          { error: "PRIVATE_BODY" },
          {
            status: 400,
            headers: {
              [STORAGE_FAILURE_DIAGNOSTIC_HEADER]: JSON.stringify({
                version: 1,
                requestDigest: witness.digest,
                failure: { stage: "request", errorKind: "rejection", reason: "append_event_too_large" },
              }),
            },
          },
        );
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        await wire.append(id, gen, [{ seq: 1, type: "assistant", text: "PRIVATE_REQUEST" }]).catch(() => "rejected"),
      ).toBe("rejected");
    } finally {
      warn.mockRestore();
    }
    for (let i = 0; i < 10; i++)
      reg.publish(id, { type: "tool_result", tool: "read", ok: true, summary: "PRIVATE_REPLY" });
    const snap = reg.snapshot(id, run.token)!;
    expect(snap.events.length).toBe(4);
    const saved = assembleRunRecord({
      run,
      snap,
      msg: { channelId: "slack:D1", userId: "slack:UA", threadKey: "slack:D1:1" },
      channelVisibility: "private",
      finishedAt: 10,
      status: "interrupted",
      diagnosis: analyzeRunFriction(snap.events),
    });
    const captured = parseRunEventLines(saved.events.map((event) => JSON.stringify(event)).join("\n"));
    expect(captured.events.find((event) => event.type === "run_note")).toMatchObject({
      kind: "storage_failure",
      summary: "Private storage request failed.",
      storageFailure: {
        operation: "/runs/append",
        httpStatus: 400,
        server: { stage: "request", errorKind: "rejection", reason: "append_event_too_large" },
      },
    });
    expect(saved.truncated).toBe(true);
    expect(saved.diagnosis.byCategory.infra_failure.count).toBe(1);
    expect(JSON.stringify(captured)).not.toContain("PRIVATE_");
  });

  it("keeps private diagnostic appends non-recursive after registry projection without exposing exception prose", async () => {
    const { reg } = testRegistry();
    const run = reg.create("private", {
      agent: "orchestrator",
      channelId: "slack:D1",
      userId: "slack:UA",
      threadKey: "slack:D1:1",
      directAudience: { kind: "slack-unshared-im", channelId: "slack:D1", userId: "slack:UA", threadKey: "slack:D1:1" },
    });
    let emitted = 0;
    let posts = 0;
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "fixture",
      onFailure: ({ runIds, diagnostic }) => {
        emitted++;
        for (const target of runIds) reg.publish(target, storageFailureNote(diagnostic));
      },
      fetch: async (url, init) => {
        posts++;
        const witness = await storeRequestWitness(new URL(String(url)).pathname, String(init?.body));
        return new Response("private body", {
          status: 500,
          headers: {
            [STATE_WRITE_DIAGNOSTIC_HEADER]: stateWriteDiagnosticHeader({
              version: 1,
              requestDigest: witness.digest,
              failure: stateWriteException("state-rpc", new Error("private fixture words")),
            }),
          },
        });
      },
    });
    expect(await wire.setState(run.id, gen, {}).catch(() => "held")).toBe("held");
    const events = reg.snapshot(run.id, run.token)!.events;
    expect(events).toMatchObject([
      {
        kind: "storage_failure",
        summary: "Private storage request failed.",
        storageFailure: { operation: "/runs/state", phase: "http", httpStatus: 500 },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private fixture words");
    expect(await wire.append(run.id, gen, events as Array<RunEvent & { seq: number }>).catch(() => "held")).toBe(
      "held",
    );
    expect({ emitted, posts }).toEqual({ emitted: 1, posts: 2 });
  });
  it("keeps the source-save owner visible when the session write fails", async () => {
    const notices: unknown[] = [];
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "fixture",
      onFailure: (notice) => notices.push(notice),
      fetch: async () => new Response("private", { status: 503 }),
    });
    expect(
      await wire
        .writeSessionSources("slack:C1:1:general", id, gen, { version: 1, status: "unknown" })
        .catch(() => "held"),
    ).toBe("held");
    expect(notices).toMatchObject([
      { runIds: [id], diagnostic: { operation: "/runs/session/write", ownerGen: gen, phase: "http", httpStatus: 503 } },
    ]);
  });
  it("reports a caught checkpoint exception with its original request and redacted remote cause", async () => {
    const notices: unknown[] = [];
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "fixture",
      onFailure: (notice) => notices.push(notice),
      fetch: async (_url, init) => {
        const request = await storeRequestWitness("/runs/state", String(init?.body));
        const error = Object.assign(new Error("Durable Object reset token=fixture-credential"), {
          remote: true,
          retryable: true,
          cause: Object.assign(new Error("storage unavailable"), { code: "E_STORAGE" }),
        });
        error.stack = "Error: reset at setState (worker.ts:1:2)";
        error.cause.stack = "Error: storage unavailable";
        return new Response("private response body", {
          status: 500,
          headers: {
            [STATE_WRITE_DIAGNOSTIC_HEADER]: stateWriteDiagnosticHeader({
              version: 1,
              requestDigest: request.digest,
              failure: stateWriteException("state-rpc", error, 3),
            }),
            "cf-ray": "a49d0ab74f2e09ac-DFW",
          },
        });
      },
    });
    const result = await wire.setState(id, gen, { notepad: "private request bytes" }).catch(() => "held");
    expect(result).toBe("held");
    expect(notices).toMatchObject([
      {
        runIds: [id],
        diagnostic: {
          version: 1,
          operation: "/runs/state",
          ownerGen: gen,
          kind: "write",
          phase: "http",
          httpStatus: 500,
          rayId: "a49d0ab74f2e09ac-DFW",
          server: {
            stage: "state-rpc",
            attempts: 3,
            exception: {
              message: "Durable Object reset token=«redacted»",
              remote: true,
              retryable: true,
              cause: { message: "storage unavailable", code: "E_STORAGE" },
            },
          },
        },
      },
    ]);
    expect(JSON.stringify(notices)).not.toMatch(/fixture-credential|private request|private response/);
  });

  it("captures read transport failures and malformed write acknowledgments at the shared boundary", async () => {
    const notices: unknown[] = [];
    let calls = 0;
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "fixture",
      onFailure: (notice) => notices.push(notice),
      fetch: async () => {
        if (++calls === 1)
          throw Object.assign(new Error("connection reset token=fixture-credential"), { code: "ECONNRESET" });
        return Response.json({ unexpected: "private acknowledgment" });
      },
    });
    expect(await wire.readInbox(id, 0).catch(() => "failed")).toBe("failed");
    expect(await wire.setState(id, gen, {}).catch(() => "held")).toBe("held");
    expect(notices).toMatchObject([
      {
        runIds: [id],
        diagnostic: {
          operation: "/runs/inbox/read",
          kind: "read",
          phase: "transport",
          exception: { message: "connection reset token=«redacted»", code: "ECONNRESET" },
        },
      },
      {
        runIds: [id],
        diagnostic: { operation: "/runs/state", kind: "write", phase: "acknowledgement", httpStatus: 200 },
      },
    ]);
    expect(calls).toBe(2);
    expect(JSON.stringify(notices)).not.toMatch(/fixture-credential|private acknowledgment/);
  });

  it("does not turn failed diagnostic appends or a throwing telemetry sink into another write", async () => {
    const notices: unknown[] = [];
    let calls = 0;
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "fixture",
      onFailure: (notice) => {
        notices.push(notice);
        throw new Error("broken telemetry sink");
      },
      fetch: async () => {
        calls++;
        return new Response("private", { status: 503 });
      },
    });
    expect(await wire.setState(id, gen, {}).catch(() => "held")).toBe("held");
    expect(
      await wire
        .append(id, gen, [{ seq: 1, type: "run_note", kind: "storage_failure", summary: "failure" }])
        .catch(() => "held"),
    ).toBe("held");
    expect(notices).toMatchObject([{ runIds: [id], diagnostic: { phase: "http", httpStatus: 503 } }]);
    expect(notices).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it("mirrors the digest-bound remote exception and Ray ID into operator telemetry", async () => {
    const logs: string[] = [];
    const log = vi.spyOn(console, "warn").mockImplementation((line) => logs.push(String(line)));
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "fixture",
      fetch: async (_url, init) => {
        const request = await storeRequestWitness("/runs/state", String(init?.body));
        const error = Object.assign(new Error("Durable Object reset token=fixture-credential"), {
          retryable: true,
          remote: true,
        });
        error.stack = "Error: Durable Object reset token=fixture-credential\n at setState (worker.ts:1:2)";
        const response = new Response("private response body", {
          status: 500,
          headers: {
            [STATE_WRITE_DIAGNOSTIC_HEADER]: stateWriteDiagnosticHeader({
              version: 1,
              requestDigest: request.digest,
              failure: stateWriteException("state-rpc", error, 3),
            }),
            "cf-ray": "a49d0ab74f2e09ac-DFW",
          },
        });
        response.text = async () => {
          throw new Error("error bodies must not be read");
        };
        return response;
      },
    });
    let failure: unknown;
    try {
      failure = await wire.setState(id, gen, { notepad: "private request bytes" }).catch((error) => error);
    } finally {
      log.mockRestore();
    }
    expect((failure as UncertainStoreError).diagnosis).toMatchObject({
      kind: "http",
      status: 500,
      stateWrite: {
        stage: "state-rpc",
        attempts: 3,
        exception: { message: "Durable Object reset token=«redacted»", remote: true, retryable: true },
      },
    });
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      {
        event: "storage.request.failure",
        side: "client",
        runIds: [id],
        diagnostic: {
          version: 1,
          operation: "/runs/state",
          kind: "write",
          phase: "http",
          ownerGen: gen,
          httpStatus: 500,
          requestDigest: (failure as UncertainStoreError).request.digest,
          requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
          rayId: "a49d0ab74f2e09ac-DFW",
          timing: { elapsedMs: expect.any(Number), timeoutMs: 10000, deadlineExceeded: false },
          response: { contentType: "text", bodyKind: "not-read" },
          server: {
            stage: "state-rpc",
            errorKind: "error",
            attempts: 3,
            exception: {
              name: "Error",
              message: "Durable Object reset token=«redacted»",
              remote: true,
              retryable: true,
              stack: "Error: Durable Object reset token=«redacted»\n at setState (worker.ts:1:2)",
            },
          },
        },
      },
    ]);
    expect(logs.join("\n")).not.toMatch(/fixture-credential|private request|private response/);
  });
  it("keeps missing, malformed, truncated, foreign and non-state 5xx diagnostics generic and unknown", async () => {
    for (const mode of ["missing", "malformed", "truncated", "foreign", "extra", "step"]) {
      let calls = 0;
      const wire = new WorkerRunLedger({
        baseUrl: "https://state.invalid",
        token: "fixture",
        storeKey: "fixture",
        fetch: async (url, init) => {
          calls++;
          const digest = (await storeRequestWitness(new URL(String(url)).pathname, String(init?.body))).digest;
          const value = {
            version: 1,
            requestDigest: mode === "foreign" ? "f".repeat(64) : digest,
            failure: { stage: "state-rpc", errorKind: "type" },
            ...(mode === "extra" ? { secret: "private bytes" } : {}),
          };
          const header =
            mode === "malformed"
              ? "<html>private bytes"
              : mode === "truncated"
                ? JSON.stringify(value).slice(0, -1)
                : JSON.stringify(value);
          const reply = new Response("<html>private response", {
            status: 500,
            headers: mode === "missing" ? {} : { [STATE_WRITE_DIAGNOSTIC_HEADER]: header },
          });
          reply.text = async () => {
            throw new Error("private 5xx body must stay unread");
          };
          return reply;
        },
      });
      let failure: unknown;
      try {
        if (mode === "step")
          await wire.step(
            id,
            gen,
            { step: 0, seq: 0, turnIndex: 0, inFlight: [], inboxConsumedSeq: 0, remainingMs: 1, turn: 0, iteration: 0 },
            [],
          );
        else await wire.setState(id, gen, {});
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(UncertainStoreError);
      expect((failure as UncertainStoreError).diagnosis).toEqual({ kind: "http", status: 500 });
      expect(calls).toBe(1);
    }
  });
  it("retains only a bounded state failure bound to the original wire digest, without reading or replaying its body", async () => {
    let calls = 0;
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "private token",
      storeKey: "fixture",
      fetch: async (_url, init) => {
        calls++;
        const request = await storeRequestWitness("/runs/state", String(init?.body));
        const reply = new Response("private response bytes", {
          status: 500,
          headers: {
            [STATE_WRITE_DIAGNOSTIC_HEADER]: JSON.stringify({
              version: 1,
              requestDigest: request.digest,
              failure: { stage: "state-rpc", errorKind: "type" },
            }),
          },
        });
        reply.text = async () => {
          throw new Error("must not consume private 5xx body");
        };
        return reply;
      },
    });
    let failure: UncertainStoreError | undefined;
    try {
      await wire.setState(id, gen, { harness: { private: "original bytes" } });
    } catch (error) {
      if (!(error instanceof UncertainStoreError)) throw error;
      failure = error;
    }
    expect(failure).toBeDefined();
    expect(failure!.diagnosis).toEqual({
      kind: "http",
      status: 500,
      stateWrite: { stage: "state-rpc", errorKind: "type" },
    });
    expect(uncertainStoreSummary(failure!)).toBe(
      "operation=/runs/state failure=http status=500 stage=state-rpc errorKind=type",
    );
    expect(JSON.stringify(failure)).not.toContain("private");
    expect(calls).toBe(1);
  });
  it.each(cases)(
    "classifies %s from observed transport facts and preserves the exact request",
    async (mode, diagnosis) => {
      let payload = "";
      let calls = 0;
      const wire = new WorkerRunLedger({
        baseUrl: "https://state.invalid",
        token: "private credential",
        storeKey: "fixture",
        fetch: async (_url, init) => {
          calls++;
          payload = String(init?.body);
          return response(mode);
        },
      });
      const failure = await wire.setState(id, gen, { notepad: "private request bytes" }).catch((error) => error);
      expect(failure).toBeInstanceOf(UncertainStoreError);
      expect(failure.diagnosis).toEqual(diagnosis);
      expect(Object.isFrozen(failure.diagnosis)).toBe(true);
      expect(failure.request.payload).toBe(payload);
      expect(failure.request.digest).toBe(await sourceHash({ operation: "/runs/state", payload }));
      expect(calls).toBe(1);
    },
  );

  it.each(["state", "live-state"] as const)(
    "keeps the first %s diagnostic through later held patches without replay or private logging",
    async (kind) => {
      const inner = new InMemoryRunLedger(() => 100);
      const warnings: string[] = [];
      let calls = 0;
      let payload = "";
      let original: UncertainStoreError | undefined;
      const wire = new WorkerRunLedger({
        baseUrl: "https://state.invalid",
        token: "private credential",
        storeKey: "fixture",
        fetch: async (_url, _init) => {
          calls++;
          payload = String(_init?.body);
          return response("http");
        },
      });
      const ledger = new Proxy(inner, {
        get(target, key) {
          if (key === "setState")
            return async (...args: Parameters<typeof wire.setState>) => {
              try {
                return await wire.setState(...args);
              } catch (error) {
                original = error as UncertainStoreError;
                throw error;
              }
            };
          if (key === "assignLiveState")
            return async (...args: Parameters<typeof wire.assignLiveState>) => {
              try {
                return await wire.assignLiveState(...args);
              } catch (error) {
                original = error as UncertainStoreError;
                throw error;
              }
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const wt = createLedgerWriteThrough({
        ledger,
        gen,
        fallback: new InMemoryRunStore(),
        warn: (message) => warnings.push(message),
        setInterval: () => ({ unref() {} }),
        clearInterval: () => {},
      });
      const opened = await wt.open({
        runId: id,
        threadKey: "slack:C1:1",
        startedAt: 100,
        system: "",
        tools: [],
        card: null,
        meta: {
          agent: "general",
          channelId: "slack:C1",
          userId: "slack:UALICE",
          threadKey: "slack:C1:1",
          channelVisibility: "public",
        },
      });
      if (opened.kind !== "tracked") throw new Error("fixture did not open");
      if (kind === "state")
        expect(await opened.run.commitState({ notepad: "private request bytes" })).toBe("unavailable");
      else
        expect(
          await opened.run.assignLiveState({
            expectedSeq: 0,
            at: 100,
            state: "admitted",
            bound: 1000,
            eventSeq: 1,
            statePatch: { notepad: "private request bytes" },
          }),
        ).toEqual({ ok: false, reason: "unavailable" });
      const first = opened.run.writeBoundaryFailure;
      expect(first).toMatchObject({
        kind,
        diagnosis: { kind: "http", status: 503 },
        requestDigest: original!.request.digest,
      });
      expect(original!.request.payload).toBe(payload);
      expect(await opened.run.commitState({ notepad: "later private bytes" })).toBe("unavailable");
      expect(opened.run.writeBoundaryFailure).toEqual(first);
      expect(calls).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`operation=/runs/${kind} failure=http status=503`);
      expect(warnings.join("\n")).not.toMatch(/private|later/);
    },
  );

  it("keeps a known refusal definite and never manufactures an uncertain diagnostic", async () => {
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "fixture",
      fetch: async () => response("refused"),
    });
    expect(await wire.setState(id, gen, {})).toEqual({ ok: false, reason: "fenced" });
  });

  it("does not infer a diagnosis from arbitrary exception prose", () => {
    const failure = new UncertainStoreError("HTTP 503 private body", {
      version: 1,
      operation: "/runs/state",
      payload: "private bytes",
      digest: "a".repeat(64),
    });
    expect(failure.diagnosis).toBeUndefined();
  });

  it("rejects malformed diagnostic metadata and hides unknown operation bytes", () => {
    const failure = new UncertainStoreError(
      "private exception",
      { version: 1, operation: "private operation", payload: "private bytes", digest: "a".repeat(64) },
      {
        diagnosis: { kind: "http", status: 503, body: "private response" } as never,
      },
    );
    expect(failure.diagnosis).toBeUndefined();
    expect(uncertainStoreSummary(failure)).toBe("operation=other failure=unclassified");
    expect(JSON.stringify(failure)).not.toContain("private");
  });
});
