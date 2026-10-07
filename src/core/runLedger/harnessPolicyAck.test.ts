import { describe, expect, it } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
import { createLedgerWriteThrough } from "./writeThrough.js";
import { InMemoryRunStore } from "../runStore.js";
import { WorkerRunLedger } from "../runLedgerWorker.js";

const policy = { version: 1, commandRoute: "hosted-review", identity: "read" } as const;
const facts = { harness: "pi", pid: 1, logOffset: 0, relaunches: 0, sessionPolicy: policy };

describe("canonical original harness policy ACK", () => {
  async function world(committed: boolean) {
    const inner = new InMemoryRunLedger(() => 100);
    let loseReply = false,
      writes = 0;
    const wire = new WorkerRunLedger({
      baseUrl: "https://state.invalid",
      token: "fixture",
      storeKey: "runs:fixture",
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body));
        expect(body.storeKey).toBe("runs:fixture");
        if (new URL(String(url)).pathname === "/runs/state") {
          writes++;
          if (loseReply) {
            loseReply = false;
            if (committed) expect((await inner.setState(body.runId, body.gen, body.state)).ok).toBe(true);
            return new Response("reply unavailable", { status: 500 });
          }
          const result = await inner.setState(body.runId, body.gen, body.state);
          return Response.json(result, { status: result.ok ? 200 : 409 });
        }
        expect(new URL(String(url)).pathname).toBe("/runs/inbox/read");
        expect(body.peek).toBe(true);
        return Response.json(await inner.peekInbox(body.runId, body.gen, body.afterSeq));
      },
    });
    const ledger = new Proxy(inner, {
      get(target, key) {
        if (key === "setState") return wire.setState.bind(wire);
        if (key === "peekInbox") return wire.peekInbox.bind(wire);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wt = createLedgerWriteThrough({
      ledger,
      gen: "policy-current",
      fallback: new InMemoryRunStore(),
      warn: () => {},
    });
    const opened = await wt.open({
      runId: "r1",
      threadKey: "slack:C1:1",
      startedAt: 100,
      meta: { agent: "general", channelId: "slack:C1", userId: "slack:UALICE", threadKey: "slack:C1:1" },
      card: null,
      system: "",
      tools: [],
    });
    if (opened.kind !== "tracked") throw new Error("original canonical claim required");
    return {
      inner,
      run: opened.run,
      lose: () => {
        loseReply = true;
      },
      writes: () => writes,
    };
  }

  it.each([true, false])("retains omitted policy in the original unknown snapshot: committed=%s", async (committed) => {
    const w = await world(committed);
    try {
      expect(await w.run.setStateAndFlush({ harness: facts })).toBe(true);
      expect(w.inner.live.get("r1")!.state.harness).toEqual(facts);
      w.lose();
      expect(await w.run.setStateAndFlush({ harness: { harness: "pi", pid: 2, logOffset: 7, relaunches: 1 } })).toBe(
        false,
      );
      const original = w.run.writeBoundaryFailure;
      expect(original).toMatchObject({ kind: "state", runId: "r1", gen: "policy-current" });
      expect(await w.run.commitState({ checklist: "after original readback" })).toBe(committed ? "ok" : "unavailable");
      expect(w.writes()).toBe(committed ? 3 : 2);
      expect(w.inner.live.get("r1")!.state.harness).toEqual(
        committed ? { ...facts, pid: 2, logOffset: 7, relaunches: 1 } : facts,
      );
      if (!committed) expect(w.run.writeBoundaryFailure).toEqual(original);
    } finally {
      await w.run.close();
    }
  });

  it("rejects a changed original before transport rather than crediting an earlier ACK", async () => {
    const w = await world(true);
    try {
      expect(await w.run.setStateAndFlush({ harness: facts })).toBe(true);
      const before = structuredClone(w.inner.live.get("r1"));
      await expect(
        w.run.setStateAndFlush({
          harness: { ...facts, sessionPolicy: { version: 1, commandRoute: "native", identity: "read" } },
        }),
      ).rejects.toMatchObject({ name: "PermanentStoreError" });
      expect(w.writes()).toBe(1);
      expect(w.inner.live.get("r1")).toEqual(before);
      expect(w.run.writeBoundaryFailure).toBeUndefined();
    } finally {
      await w.run.close();
    }
  });
});
