import { describe, it, expect } from "vitest";
import { WorkerRunLedger } from "../runLedgerWorker.js";
import { InMemoryRunLedger } from "./inMemory.js";
import { createLedgerWriteThrough, NativeClaimUnknownError } from "./writeThrough.js";

describe("unknown native claim observations", () => {
  it("preserves the first observation and filters before paging", async () => {
    const store = new InMemoryRunLedger();
    const base = {
      version: 1 as const,
      gen: "original",
      userId: "slack:UALICE",
      channelVisibility: "machine" as const,
      startedAt: 1,
      observedAt: 2,
      outcome: "unknown" as const,
      attempts: 1 as const,
    };
    for (const [runId, channelId] of [
      ["a-visible", "mcp:X"],
      ["b-hidden", "mcp:Y"],
      ["c-visible", "mcp:X"],
    ])
      await store.recordClaimObservation({ ...base, runId, channelId, threadKey: `${channelId}:original` });
    const first = await store.listClaimObservations({
      visibleTo: { kind: "channels-in", channelIds: ["mcp:X"] },
      limit: 1,
    });
    expect(first.observations.map((row) => row.runId)).toEqual(["a-visible"]);
    expect(first.nextAfter).toBe("a-visible|original");
    expect(
      (
        await store.listClaimObservations({
          visibleTo: { kind: "channels-in", channelIds: ["mcp:X"] },
          limit: 1,
          after: first.nextAfter,
        })
      ).observations.map((row) => row.runId),
    ).toEqual(["c-visible"]);
    expect(await store.recordClaimObservation({ ...first.observations[0], userId: "slack:UREPLACEMENT" })).toEqual({
      stored: false,
    });
    expect(
      (await store.listClaimObservations({ visibleTo: { kind: "all" } })).observations.map((row) => row.userId),
    ).toEqual(["slack:UALICE", "slack:UALICE", "slack:UALICE"]);
  });
  it.each([false, true])(
    "records the original unknown observation without changing run custody: committed=%s",
    async (committed) => {
      const memory = new InMemoryRunLedger(() => 1000);
      const claim = memory.claim.bind(memory);
      const wire = new WorkerRunLedger({
        baseUrl: "https://memory.test",
        storeKey: "fixture",
        token: "fixture",
        onFailure: ({ diagnostic }) => {
          diagnostic.httpStatus = 599;
          if (diagnostic.timing) diagnostic.timing.deadlineExceeded = true;
        },
        fetch: async (_input, init) => {
          if (committed) await claim(JSON.parse(String(init?.body)).run);
          return new Response("PRIVATE_RESPONSE", { status: 500 });
        },
      });
      memory.claim = wire.claim.bind(wire);
      const writer = createLedgerWriteThrough({
        ledger: memory,
        gen: "gen-original",
        now: () => 1000,
        fallback: { put: async () => {}, abandoned() {} },
        warn() {},
      });
      const request = {
        runId: "original-run",
        threadKey: "mcp:private:thread",
        startedAt: 500,
        card: null,
        meta: {
          residentExecution: "native-v1" as const,
          channelId: "mcp:private",
          userId: "slack:UALICE",
          threadKey: "mcp:private:thread",
          channelVisibility: "machine" as const,
          request: { text: "PRIVATE_REQUEST" },
        },
      };
      const failure = await writer.reserve(request).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NativeClaimUnknownError);
      const page = await memory.listClaimObservations({ visibleTo: { kind: "all" } });
      expect(page).toMatchObject({
        coverage: "recorded-only",
        observations: [
          {
            version: 1,
            runId: "original-run",
            gen: "gen-original",
            channelId: "mcp:private",
            threadKey: "mcp:private:thread",
            userId: "slack:UALICE",
            outcome: "unknown",
            attempts: 1,
            startedAt: 500,
            observedAt: 1000,
            diagnostic: {
              operation: "/runs/claim",
              phase: "http",
              httpStatus: 500,
              timing: { deadlineExceeded: false },
            },
          },
        ],
      });
      expect(page.observations).toHaveLength(1);
      expect(JSON.stringify(page)).not.toContain("PRIVATE_");
      expect(memory.live.has("original-run")).toBe(committed);
      expect(memory.finished.size).toBe(0);
      await expect(writer.reserve(request)).rejects.toBe(failure);
      expect((await memory.listClaimObservations({ visibleTo: { kind: "none" } })).observations).toEqual([]);
    },
  );
});
