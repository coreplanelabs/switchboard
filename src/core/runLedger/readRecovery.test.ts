import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerRunLedger } from "../runLedgerWorker.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("read-only ledger recovery", () => {
  it("recovers a server error and a transport interruption with current data under one deadline", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const notices: unknown[] = [];
    const wire = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "fixture",
      storeKey: "runs:default",
      onFailure: (notice) => notices.push(notice),
      fetch: async (_url, init) => {
        signals.push(init?.signal);
        if (signals.length === 1) return Response.json({ error: "internal error" }, { status: 500 });
        if (signals.length === 2) throw new TypeError("network interrupted");
        return Response.json({ next: 7 });
      },
    });
    expect(await wire.sessionTail("session")).toBe(7);
    expect(signals).toHaveLength(3);
    expect(new Set(signals).size).toBe(1);
    expect(notices).toMatchObject([
      { diagnostic: { operation: "/runs/session/tail", kind: "read", phase: "http", httpStatus: 500 } },
      { diagnostic: { operation: "/runs/session/tail", kind: "read", phase: "transport" } },
    ]);
  });

  it("stops at a current access denial after a transient failure", async () => {
    let calls = 0;
    const wire = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "fixture",
      storeKey: "runs:default",
      fetch: async () => Response.json({ error: "refused" }, { status: ++calls === 1 ? 503 : 403 }),
    });
    await expect(wire.sessionTail("session")).rejects.toMatchObject({ name: "PermanentStoreError" });
    expect(calls).toBe(2);
  });

  it.each([400, 401, 403])("does not retry HTTP %s when its denial body is interrupted", async (status) => {
    let calls = 0;
    const notices: unknown[] = [];
    const wire = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "fixture",
      storeKey: "runs:default",
      onFailure: (notice) => notices.push(notice),
      fetch: async () => {
        if (++calls > 1) return Response.json({ next: 7 });
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException("body interrupted", "AbortError"));
            },
          }),
          { status },
        );
      },
    });
    await expect(wire.sessionTail("session")).rejects.toMatchObject({ name: "PermanentStoreError" });
    expect(calls).toBe(1);
    expect(notices).toMatchObject([{ diagnostic: { phase: "http", httpStatus: status } }]);
  });

  it("returns an availability error when the bounded retries are exhausted", async () => {
    let calls = 0;
    const wire = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "fixture",
      storeKey: "runs:default",
      fetch: async () => {
        calls++;
        return Response.json({ error: "unavailable" }, { status: 503 });
      },
    });
    await expect(wire.sessionTail("session")).rejects.toMatchObject({ name: "TransientStoreError" });
    expect(calls).toBe(3);
  });

  it("does not renew an expired read deadline or retry an uncertain heartbeat", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let calls = 0;
    const wire = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "fixture",
      storeKey: "runs:default",
      fetch: async () => {
        calls++;
        controller.abort();
        return Response.json({ error: "internal error" }, { status: 500 });
      },
    });
    await expect(wire.sessionTail("session")).rejects.toMatchObject({ name: "TransientStoreError" });
    expect(calls).toBe(1);
    expect(timeout).toHaveBeenCalledTimes(1);
    await expect(wire.heartbeat("r1", "g1", 1000)).rejects.toMatchObject({
      name: "UncertainStoreError",
      outcome: "unknown",
    });
    expect(calls).toBe(2);
  });

  it("ends the backoff when the original read deadline expires", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let started!: () => void;
    const request = new Promise<void>((resolve) => (started = resolve));
    const wire = new WorkerRunLedger({
      baseUrl: "https://memory.test",
      token: "fixture",
      storeKey: "runs:default",
      fetch: async () => {
        setTimeout(() => controller.abort(), 50);
        started();
        return Response.json({ error: "internal error" }, { status: 500 });
      },
    });
    let outcome: unknown;
    void wire.sessionTail("session").catch((error) => (outcome = error));
    await request;
    await vi.advanceTimersByTimeAsync(50);
    expect(outcome).toMatchObject({ name: "TransientStoreError" });
  });
});
