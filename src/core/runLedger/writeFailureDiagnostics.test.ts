import { describe, expect, it } from "vitest";
import { WorkerRunLedger } from "../runLedgerWorker.js";
import { UncertainStoreError, uncertainStoreSummary } from "../storeFailure.js";
import { sourceHash } from "../references/receipts.js";
import { createLedgerWriteThrough } from "./writeThrough.js";
import { InMemoryRunLedger } from "./inMemory.js";
import { InMemoryRunStore } from "../runStore.js";
import { STATE_WRITE_DIAGNOSTIC_HEADER } from "../runStateWriteDiagnostic.js";
import { storeRequestWitness } from "../storeResponse.js";

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
