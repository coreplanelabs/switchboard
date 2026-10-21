import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reclaimRuns } from "../boot.js";
import { InMemoryRunLedger } from "./inMemory.js";
import { InMemoryRunStore, FileRunStore, toListItem, type RunStore } from "../runStore.js";
import { isRunRecord, MAX_RECORD_BYTES, type RunRecord } from "../runRecord.js";
import { analyzeRunFriction } from "../runFriction.js";
import { seedSourceInputIntent, testSourceInputIntent } from "../testing/sourceInputs.js";
import { sourceInputArchiveState, sourceInputIntentsOf } from "./sourceInputIntent.js";
import { readSourceInputProof } from "../references/sourceInputProof.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function record(id = "source-consumer", finishedAt = 2): RunRecord {
  return {
    id,
    agent: "orchestrator",
    model: "fixture/model",
    userId: "cli:alice",
    channelId: "cli:main",
    threadKey: "cli:thread",
    channelVisibility: "unknown",
    startedAt: 1,
    finishedAt,
    status: "completed",
    eventCount: 0,
    storedEventCount: 0,
    truncated: false,
    events: [],
    diagnosis: analyzeRunFriction([]),
  };
}
async function fixture(phase: "prepared" | "begun") {
  const ledger = new InMemoryRunLedger(() => 1000);
  const input = testSourceInputIntent(),
    entry = input.entries[0]!;
  const policy = { version: 1, commandRoute: "native", identity: "write" };
  const launch = { version: 1, harness: "pi", phase: "prepared", ordinal: 0, sessionPolicy: policy };
  expect(
    await ledger.claim({
      runId: entry.owner.runId,
      gen: "g1",
      threadKey: entry.owner.threadKey,
      startedAt: 1,
      leaseMs: 10000,
      system: "original",
      tools: [],
      meta: {
        agent: "orchestrator",
        userId: entry.owner.requester,
        channelId: entry.owner.channelId,
        threadKey: entry.owner.threadKey,
      },
      state: { harnessLaunch: launch },
    }),
  ).toMatchObject({ ok: true });
  expect(await ledger.setState(entry.owner.runId, "g1", { harnessLaunch: { ...launch, phase: "begun" } })).toEqual({
    ok: true,
  });
  expect(
    await ledger.setState(entry.owner.runId, "g1", {
      harness: { harness: "pi", launchOrdinal: 0, sessionFile: entry.native.sessionId, sessionPolicy: policy },
    }),
  ).toEqual({ ok: true });
  const original = await seedSourceInputIntent(ledger, input);
  expect(await ledger.setState(entry.owner.runId, "g1", { sourceInputIntents: original })).toEqual({ ok: true });
  if (phase === "begun") {
    original.entries[0]!.phase = phase;
    expect(await ledger.setState(entry.owner.runId, "g1", { sourceInputIntents: original })).toEqual({ ok: true });
  }
  return { ledger, original };
}

describe("unresolved source input archive", () => {
  it.each(["prepared", "begun"] as const)(
    "retains the exact %s input when the terminal writer omits it",
    async (phase) => {
      const f = await fixture(phase);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await f.ledger.abandon("source-consumer", "g1")).toEqual({ ok: false, reason: "fenced" });
      expect(await f.ledger.abandon("source-consumer", "g1", { settleTerminal: true })).toEqual({
        ok: false,
        reason: "fenced",
      });
      expect(warn.mock.calls).toEqual([
        [
          "[runs/archive] source input refused",
          { runId: "source-consumer", operation: "abandon", reason: "pending-input" },
        ],
        [
          "[runs/archive] source input refused",
          { runId: "source-consumer", operation: "abandon", reason: "pending-input" },
        ],
      ]);
      warn.mockClear();
      expect(await f.ledger.finish("source-consumer", "g1", record())).toMatchObject({ ok: true, stored: true });
      expect(warn.mock.calls).toEqual([]);
      const saved = f.ledger.finished.get("source-consumer")!;
      expect(saved.sourceInputIntents).toEqual(f.original);
      expect(f.ledger.inbox.get("source-consumer")?.map((value) => value.seq)).toEqual([
        f.original.entries[0]!.witness.seq,
      ]);
      expect(saved.contextDependencies).toMatchObject({ version: 4, sourceInputs: [f.original.entries[0]!.reference] });
      expect(isRunRecord(saved)).toBe(true);
      expect(toListItem(saved, 100)).not.toHaveProperty("sourceInputIntents");
      const store = new InMemoryRunStore({ now: () => 1000 });
      expect(await store.put(saved)).toMatchObject({ stored: true });
      expect(
        await readSourceInputProof(f.original.entries[0]!.reference, { ledger: f.ledger, runStore: store }),
      ).toEqual({ kind: "held", reason: "root-unproved" });
    },
  );

  it.each(["prepared", "begun"] as const)(
    "settles a saved %s original without losing pending input or blocking its thread",
    async (phase) => {
      const { ledger, original } = await fixture(phase);
      const terminal = { ...record(), sourceInputIntents: original };
      // The plain-store write committed while its live-ledger finish was lost.
      ledger.finished.set("source-consumer", structuredClone(terminal));
      expect(await ledger.abandon("source-consumer", "g1")).toEqual({ ok: false, reason: "fenced" });
      for (const fault of [
        undefined,
        { ...original, version: 99 },
        {
          ...original,
          entries: [{ ...original.entries[0]!, id: "replacement" }],
        },
      ]) {
        ledger.finished.set("source-consumer", { ...terminal, sourceInputIntents: fault } as RunRecord);
        expect(await ledger.abandon("source-consumer", "g1", { settleTerminal: true })).toEqual({
          ok: false,
          reason: "fenced",
        });
        expect(ledger.live.get("source-consumer")?.state.sourceInputIntents).toEqual(original);
      }
      ledger.finished.set("source-consumer", structuredClone(terminal));
      expect(await ledger.abandon("source-consumer", "g1", { settleTerminal: true })).toEqual({ ok: true });
      expect(ledger.finished.get("source-consumer")?.sourceInputIntents).toEqual(original);
      expect((await ledger.readInbox("source-consumer", 0)).map((item) => item.seq)).toEqual([
        original.entries[0]!.witness.seq,
      ]);
      expect(
        await ledger.claim({
          runId: "next-run",
          gen: "g2",
          threadKey: "cli:thread",
          startedAt: 1000,
          leaseMs: 10000,
          system: "next",
          tools: [],
          meta: { userId: "cli:alice", channelId: "cli:main", threadKey: "cli:thread" },
        }),
      ).toMatchObject({ ok: true });
    },
  );

  it.each([false, true])("recovery settles pending input and frees its thread: hosted=%s", async (hosted) => {
    const { ledger, original } = await fixture("begun");
    const row = ledger.live.get("source-consumer")!;
    if (hosted) {
      row.meta.hosted = true;
      row.state.hosting = { instanceId: "original-workflow", until: 30000 };
    }
    ledger.finished.set("source-consumer", { ...record(), sourceInputIntents: original });
    expect(
      await reclaimRuns({
        ledger,
        gen: "g2",
        now: () => 20000,
        storedRecord: async (id) => ledger.finished.get(id),
        storedStatus: async (id) => ledger.finished.get(id)?.status,
      }),
    ).toMatchObject({ closed: [], resumable: [], failed: [] });
    expect(ledger.finished.get("source-consumer")?.sourceInputIntents).toEqual(original);
    expect(
      await ledger.claim({
        runId: "next-run",
        gen: "g2",
        threadKey: "cli:thread",
        startedAt: 20000,
        leaseMs: 10000,
        system: "next",
        tools: [],
        meta: { userId: "cli:alice", channelId: "cli:main", threadKey: "cli:thread" },
      }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a replacement and retains malformed canonical input rather than archiving it as legacy", async () => {
    const f = await fixture("begun");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const replacement = structuredClone(f.original);
    replacement.entries[0]!.id = "replacement";
    expect(await f.ledger.finish("source-consumer", "g1", { ...record(), sourceInputIntents: replacement })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(f.ledger.live.get("source-consumer")?.state.sourceInputIntents).toEqual(f.original);
    f.ledger.live.get("source-consumer")!.state.sourceInputIntents = { ...f.original, version: 99 };
    expect(await f.ledger.finish("source-consumer", "g1", record())).toEqual({ ok: false, reason: "fenced" });
    expect(f.ledger.live.has("source-consumer")).toBe(true);
    expect(f.ledger.finished.has("source-consumer")).toBe(false);
    expect(warn.mock.calls).toEqual([
      [
        "[runs/archive] source input refused",
        { runId: "source-consumer", operation: "finish", reason: "original-changed" },
      ],
      [
        "[runs/archive] source input refused",
        { runId: "source-consumer", operation: "finish", reason: "invalid-metadata" },
      ],
    ]);
  });

  it.each(["memory", "file"] as const)(
    "keeps pending input and its source root through %s retention and rewrites",
    async (kind) => {
      let now = 1000;
      const options = { now: () => now, policy: { maxRuns: 1, maxBytes: MAX_RECORD_BYTES, retentionDays: 1 } };
      let store: RunStore;
      if (kind === "memory") store = new InMemoryRunStore(options);
      else {
        const dir = mkdtempSync(join(tmpdir(), "source-input-archive-"));
        dirs.push(dir);
        store = new FileRunStore(dir, options);
      }
      const input = testSourceInputIntent(),
        entry = input.entries[0]!;
      // Synthetic fold metadata tests retention only, not fold admission or access.
      entry.reference.root.runId = "original-root";
      entry.reference.routing = {
        kind: "fold",
        decision: { id: '["original-root","fold-one"]', hash: "c".repeat(64) },
      };
      expect(await store.put(record("original-root"))).toMatchObject({ stored: true });
      expect(await store.put({ ...record(), sourceInputIntents: input })).toMatchObject({ stored: true });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(await store.put({ ...record(), label: "later presentation" })).toMatchObject({ stored: true });
      expect((await store.get("source-consumer"))?.sourceInputIntents).toEqual(input);
      expect(warn.mock.calls).toEqual([]);
      const changed = structuredClone(input);
      changed.entries[0]!.id = "replacement";
      expect(await store.put({ ...record(), sourceInputIntents: changed })).toMatchObject({ stored: false });
      expect((await store.get("source-consumer"))?.sourceInputIntents).toEqual(input);
      expect(warn.mock.calls).toEqual([
        [
          "[runs/archive] source input refused",
          { runId: "source-consumer", operation: "put", reason: "original-changed" },
        ],
      ]);
      now += 3 * 86_400_000;
      expect(await store.put(record("newer", now))).toMatchObject({ stored: true });
      expect((await store.get("source-consumer"))?.sourceInputIntents).toEqual(input);
      expect(await store.get("original-root")).toMatchObject({ id: "original-root" });
      expect((await store.list({ limit: 10 })).find((value) => value.id === "source-consumer")).not.toHaveProperty(
        "sourceInputIntents",
      );
      await expect(store.delete("source-consumer")).rejects.toThrow();
    },
  );

  it("preserves every dependency or refuses capacity, without minting or advancing input", () => {
    const input = testSourceInputIntent();
    expect(sourceInputArchiveState(input, undefined, undefined)).toMatchObject({
      sourceInputIntents: input,
      contextDependencies: { version: 4, status: "unknown", sourceInputs: [input.entries[0]!.reference] },
    });
    const advanced = structuredClone(input);
    advanced.entries[0]!.phase = "begun";
    expect(sourceInputArchiveState(input, advanced, undefined)).toBeUndefined();
    expect(sourceInputArchiveState(undefined, input, undefined)).toBeUndefined();
    const full = structuredClone(input);
    full.entries = Array.from({ length: 33 }, (_, i) => ({
      ...structuredClone(input.entries[0]!),
      id: `input-${i}`,
      witness: { ...input.entries[0]!.witness, seq: i + 1 },
      reference: {
        ...input.entries[0]!.reference,
        receipt: { ...input.entries[0]!.reference.receipt, key: `source:${i.toString(16).padStart(64, "0")}` },
      },
    }));
    expect(sourceInputIntentsOf(full)?.entries).toHaveLength(33);
    expect(sourceInputArchiveState(full, undefined, undefined)).toBeUndefined();
  });

  it.each(["known", "unknown", "revoked"] as const)(
    "keeps a retained %s context stable on an archive rewrite",
    (status) => {
      const input = testSourceInputIntent();
      const context = {
        version: 4 as const,
        status,
        revision: 42,
        origins: [],
        slack: [],
        mcp: [],
        sourceInputs: [input.entries[0]!.reference],
      };
      expect(sourceInputArchiveState(input, undefined, context)).toEqual({
        sourceInputIntents: input,
        contextDependencies: context,
      });
    },
  );

  it("keeps the live original when terminal evidence exceeds capacity", async () => {
    const f = await fixture("begun");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      f.ledger.finish("source-consumer", "g1", { ...record(), label: "x".repeat(MAX_RECORD_BYTES) }),
    ).rejects.toThrow("source input evidence exceeds record byte limit");
    expect(f.ledger.live.get("source-consumer")?.state.sourceInputIntents).toEqual(f.original);
    expect(f.ledger.finished.has("source-consumer")).toBe(false);
    expect(warn.mock.calls).toEqual([
      [
        "[runs/archive] source input refused",
        { runId: "source-consumer", operation: "finish", reason: "record-capacity" },
      ],
    ]);
  });
});
