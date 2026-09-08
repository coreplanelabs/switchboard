// Feature: docs/reference/specs/live-view.md item 4, docs/reference/specs/run-history.md item 15 — the
// dispatch's run ending: seal after the reply, records after the seal.
import { describe, expect, it } from "vitest";
import { createRunEnding } from "./runEnding.js";
import type { SealResult } from "./runRegistry.js";

/** A registry double that records every seal and answers like the real one:
 *  the first `replyOk` stands, the result is re-readable. */
function fakeRegistry() {
  const sealed = new Map<string, SealResult>();
  const calls: Array<{ id: string; replyOk?: boolean }> = [];
  return {
    calls,
    sealed,
    seal(id: string, opts: { replyOk?: boolean } = {}): SealResult {
      calls.push({ id, ...(opts.replyOk !== undefined ? { replyOk: opts.replyOk } : {}) });
      const prior = sealed.get(id);
      if (prior) return prior;
      const result: SealResult = {
        events: [],
        eventCount: 3,
        sealedAt: 1000,
        ...(opts.replyOk !== undefined ? { replyOk: opts.replyOk } : {}),
      };
      sealed.set(id, result);
      return result;
    },
  };
}

const ok = () => Promise.resolve();
const boom = (what: string) => () => Promise.reject(new Error(what));

describe("createRunEnding — seal after the reply, records after the seal", () => {
  it("sealAfterReply: the card close, then the reply, then one drain that seals with replyOk true and runs the writer once with the seal result", async () => {
    const reg = fakeRegistry();
    const ending = createRunEnding({ registry: reg });
    const order: string[] = [];
    const seals: SealResult[] = [];
    ending.finished("r1");
    ending.register({ runId: "r1", flipOnPostFinishFailure: true, write: (s) => void seals.push(s) });
    await ending.sealAfterReply(
      async () => void order.push("card"),
      async () => void order.push("reply"),
    );
    expect(order).toEqual(["card", "reply"]);
    expect(reg.calls[0]).toEqual({ id: "r1", replyOk: true });
    expect(seals).toEqual([{ events: [], eventCount: 3, sealedAt: 1000, replyOk: true }]);
    ending.drain(undefined); // nothing left: no second seal call for the writer, no second write
    expect(seals).toHaveLength(1);
    expect(reg.calls.filter((c) => c.replyOk !== undefined)).toHaveLength(1);
  });

  it("a reply that throws seals replyOk false, hands the opted-in writers failedAfterFinish=true (a command run's stays false), and rethrows", async () => {
    const reg = fakeRegistry();
    const ending = createRunEnding({ registry: reg });
    const flips: Array<[string, boolean]> = [];
    ending.finished("r1");
    ending.finished("cmd");
    ending.register({
      runId: "r1",
      flipOnPostFinishFailure: true,
      write: (_s, failed) => void flips.push(["r1", failed]),
    });
    ending.register({
      runId: "cmd",
      flipOnPostFinishFailure: false,
      write: (_s, failed) => void flips.push(["cmd", failed]),
    });
    await expect(ending.sealAfterReply(ok, boom("slack down"))).rejects.toThrow("slack down");
    expect(reg.calls.filter((c) => c.replyOk !== undefined)).toEqual([
      { id: "r1", replyOk: false },
      { id: "cmd", replyOk: false },
    ]);
    expect(flips).toEqual([
      ["r1", true],
      ["cmd", false],
    ]);
  });

  it("a card close that throws seals with no replyOk (no reply was attempted) but still flips the record, then rethrows", async () => {
    const reg = fakeRegistry();
    const ending = createRunEnding({ registry: reg });
    ending.finished("r1");
    const seen: Array<{ failed: boolean; seal: SealResult }> = [];
    ending.register({
      runId: "r1",
      flipOnPostFinishFailure: true,
      write: (s, failed) => void seen.push({ failed, seal: s }),
    });
    await expect(ending.sealAfterReply(boom("card edit failed"), ok)).rejects.toThrow("card edit failed");
    expect(reg.calls[0]).toEqual({ id: "r1" });
    expect(seen).toEqual([{ failed: true, seal: { events: [], eventCount: 3, sealedAt: 1000 } }]);
  });

  it("without a reply (a fall-through) the drain seals with no replyOk", async () => {
    const reg = fakeRegistry();
    const ending = createRunEnding({ registry: reg });
    ending.finished("cmd");
    await ending.sealAfterReply(ok);
    expect(reg.calls).toEqual([{ id: "cmd" }]);
  });

  it("drop forgets a writer (the run is another generation's); the drain still seals the run", () => {
    const reg = fakeRegistry();
    const ending = createRunEnding({ registry: reg });
    let wrote = 0;
    ending.finished("r1");
    ending.register({ runId: "r1", flipOnPostFinishFailure: true, write: () => void wrote++ });
    ending.drop("r1");
    ending.drain(undefined);
    expect(wrote).toBe(0);
    expect(reg.calls).toEqual([{ id: "r1" }]);
  });

  it("a writer that throws, or rejects, is logged with the run id and the message only, and never stops the others", async () => {
    const reg = fakeRegistry();
    const lines: string[] = [];
    const ending = createRunEnding({ registry: reg, log: (l) => void lines.push(l) });
    let second = 0;
    ending.finished("a");
    ending.finished("b");
    ending.register({
      runId: "a",
      flipOnPostFinishFailure: true,
      write: () => {
        throw new Error("store exploded with token=SECRET");
      },
    });
    ending.register({ runId: "b", flipOnPostFinishFailure: true, write: () => Promise.reject(new Error("later")) });
    ending.register({ runId: "b", flipOnPostFinishFailure: true, write: () => void second++ });
    ending.drain(true);
    await Promise.resolve();
    expect(second).toBe(1);
    expect(lines).toEqual(["[ending] record a: store exploded with token=SECRET", "[ending] record b: later"]);
  });

  it("finished(id, { afterSeal }) runs the hook once, after that run's seal and before the writers; a hook that throws is logged and the drain goes on", () => {
    const reg = fakeRegistry();
    const lines: string[] = [];
    const ending = createRunEnding({ registry: reg, log: (l) => void lines.push(l) });
    const order: string[] = [];
    ending.finished("r1", {
      afterSeal: () => {
        order.push(`after-seal r1 (sealed: ${reg.sealed.has("r1")})`);
        throw new Error("root end blew up");
      },
    });
    ending.finished("r2", { afterSeal: () => void order.push("after-seal r2") });
    ending.register({ runId: "r1", flipOnPostFinishFailure: true, write: () => void order.push("write r1") });
    ending.drain(true);
    ending.drain(true);
    expect(order).toEqual(["after-seal r1 (sealed: true)", "after-seal r2", "write r1"]);
    expect(lines).toEqual(["[ending] after seal r1: root end blew up"]);
  });

  it("a registry whose seal throws is logged and the drain goes on", () => {
    const lines: string[] = [];
    const ending = createRunEnding({
      registry: {
        seal() {
          throw new Error("registry gone");
        },
      },
      log: (l) => void lines.push(l),
    });
    ending.finished("r1");
    expect(() => ending.drain(true)).not.toThrow();
    expect(lines).toEqual(["[ending] seal r1: registry gone"]);
  });
});
