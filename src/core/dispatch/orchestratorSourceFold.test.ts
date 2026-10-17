import { describe, expect, it, vi } from "vitest";
import {
  createOrchestratorDecisions,
  type OrchestratorDecision,
  type OrchestratorSourceFoldDecision,
} from "./orchestratorDecisions.js";

const owner = { runId: "root", requesterId: "http:person", channelId: "http:one", threadKey: "http:one:t" };
const fold = (): OrchestratorSourceFoldDecision => ({
  version: 2,
  kind: "source-fold",
  id: '["root","source-one"]',
  owner,
  source: {
    kind: "source-evidence",
    receipt: { version: 1, key: "source:" + "a".repeat(64), sequence: 7, receivedAt: 1000, bodyHash: "b".repeat(64) },
  },
  target: { kind: "run", hash: "c".repeat(64) },
  inputHash: "d".repeat(64),
  contextHash: "e".repeat(64),
});

describe("orchestrator source fold decisions", () => {
  it("captures the complete decision before its first queued turn", async () => {
    const writer = createOrchestratorDecisions({ owner, save: async () => true });
    const input = fold();
    const pending = writer.record(input);
    input.source.receipt.sequence = 99;
    input.target.hash = "f".repeat(64);
    expect(await pending).toBe(true);
    expect(writer.snapshot()).toEqual([fold()]);
    expect(await writer.record(fold())).toBe(true);
  });

  it("keeps a waiting source decision fixed behind an earlier save", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = createOrchestratorDecisions({
      owner,
      save: async (rows) => {
        if (rows.length === 1) {
          entered();
          await wait;
        }
        return true;
      },
    });
    const first = { ...fold(), id: '["root","first"]' };
    const firstSave = writer.record(first);
    await started;
    const input = fold();
    const secondSave = writer.record(input);
    input.source.receipt.bodyHash = "f".repeat(64);
    input.contextHash = "a".repeat(64);
    release();
    expect(await firstSave).toBe(true);
    expect(await secondSave).toBe(true);
    expect(writer.snapshot()).toEqual([first, fold()]);
  });

  it("retains its original save callback while the write is queued", async () => {
    const dependencies = {
      owner,
      stored: [] as readonly OrchestratorDecision[],
      async save(rows: readonly OrchestratorDecision[]) {
        this.stored = rows;
        return true;
      },
    };
    const writer = createOrchestratorDecisions(dependencies);
    const pending = writer.record(fold());
    dependencies.save = async () => true;
    expect(await pending).toBe(true);
    expect(dependencies.stored).toEqual([fold()]);
  });

  it("rejects an uncloneable proposal without blocking a later valid decision", async () => {
    const writer = createOrchestratorDecisions({ owner, save: async () => true });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await writer.record(new Proxy(fold(), {}))).toBe(false);
      expect(warning.mock.calls.map(([value]) => JSON.parse(value as string))).toEqual([
        { event: "orchestrator.decision.refused", cause: "uncloneable-proposal" },
      ]);
      warning.mockImplementation(() => {
        throw new Error("diagnostic sink failed");
      });
      expect(await writer.record(new Proxy(fold(), {}))).toBe(false);
      expect(await writer.record(fold())).toBe(true);
      expect(writer.snapshot()).toEqual([fold()]);
    } finally {
      warning.mockRestore();
    }
  });

  it("retains source evidence and its exact destination reference through history recovery", async () => {
    let stored: readonly OrchestratorDecision[] = [];
    const writer = createOrchestratorDecisions({
      owner,
      save: async (rows) => {
        stored = rows;
        return true;
      },
    });
    expect(await writer.record(fold())).toBe(true);
    const restored = createOrchestratorDecisions({
      owner,
      previous: stored,
      save: async () => {
        throw new Error("replay must not write");
      },
    });
    expect(await restored.record(fold())).toBe(true);
    expect(restored.snapshot()).toEqual([
      {
        version: 2,
        kind: "source-fold",
        id: '["root","source-one"]',
        owner: { runId: "root", requesterId: "http:person", channelId: "http:one", threadKey: "http:one:t" },
        source: {
          kind: "source-evidence",
          receipt: {
            version: 1,
            key: "source:" + "a".repeat(64),
            sequence: 7,
            receivedAt: 1000,
            bodyHash: "b".repeat(64),
          },
        },
        target: { kind: "run", hash: "c".repeat(64) },
        inputHash: "d".repeat(64),
        contextHash: "e".repeat(64),
      },
    ]);
    expect(await restored.record({ ...fold(), target: { kind: "unit", hash: "c".repeat(64) } })).toBe(false);
    expect(await restored.record({ ...fold(), contextHash: "f".repeat(64) })).toBe(false);
  });

  it("keeps requester commands and source folds in one immutable identity space", async () => {
    const writer = createOrchestratorDecisions({ owner, save: async () => true });
    expect(
      await writer.record({
        ...fold(),
        source: { ...fold().source, kind: "source-fact" },
        target: { kind: "unit", hash: "c".repeat(64) },
      }),
    ).toBe(true);
    expect(
      await writer.record({
        version: 1,
        id: fold().id,
        owner,
        source: { kind: "request", messageId: "one", textHash: "a".repeat(64) },
        command: "config.show",
        line: "config show",
        inputHash: "d".repeat(64),
        contextHash: "e".repeat(64),
      }),
    ).toBe(false);
    expect(writer.snapshot()).toMatchObject([
      { kind: "source-fold", source: { kind: "source-fact" }, target: { kind: "unit" } },
    ]);
  });

  it("holds malformed references and injected requester or action fields", async () => {
    const writer = createOrchestratorDecisions({ owner, save: async () => true });
    for (const bad of [
      { ...fold(), version: 3 },
      { ...fold(), owner: { ...owner, requesterId: "http:other" } },
      { ...fold(), id: '["other","source-one"]' },
      { ...fold(), source: { ...fold().source, requesterId: owner.requesterId } },
      { ...fold(), source: { kind: "request", receipt: fold().source.receipt } },
      { ...fold(), source: { kind: "source-evidence", receipt: { ...fold().source.receipt, bodyHash: "bad" } } },
      { ...fold(), target: { kind: "agent", hash: "c".repeat(64) } },
      { ...fold(), target: { ...fold().target, runId: "worker" } },
      { ...fold(), command: "config.show" },
      { ...fold(), tool: "work_start" },
    ])
      expect(await writer.record(bad as OrchestratorDecision)).toBe(false);
    expect(await writer.record(fold())).toBe(true);
    expect(writer.snapshot()).toMatchObject([{ version: 2, kind: "source-fold" }]);
    const held = createOrchestratorDecisions({ owner, previous: [{ ...fold(), version: 3 }], save: async () => true });
    expect(await held.record(fold())).toBe(false);
    expect(() => held.snapshot()).toThrow("retained orchestrator decisions could not be verified");
  });

  it("keeps an unknown save held and captures the original receipt before awaiting storage", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured: readonly OrchestratorDecision[] = [];
    const writer = createOrchestratorDecisions({
      owner,
      save: async (rows) => {
        captured = rows;
        await wait;
        throw new Error("acknowledgement unknown");
      },
    });
    const input = fold();
    const pending = writer.record(input);
    await Promise.resolve();
    input.source.receipt.sequence = 99;
    release();
    expect(await pending).toBe(false);
    expect(captured).toMatchObject([{ source: { receipt: { sequence: 7 } } }]);
    expect(await writer.record({ ...fold(), id: '["root","later"]' })).toBe(false);
    expect(writer.snapshot()).toEqual([]);
  });
});
