import { captureSourceTaskSnapshot } from "../references/sourceTaskSnapshot.js";
import { describe, expect, it, vi } from "vitest";
import { InMemoryRunLedger } from "./inMemory.js";
import { WorkerRunLedger } from "../runLedgerWorker.js";
import { seedSourceInputCheckpoints } from "../testing/sourceInputs.js";
import type { StepRecord } from "./types.js";
import { unreadInbox } from "./decisions.js";
import { sourceHash } from "../references/receipts.js";
import { sourceSnapshot } from "./sourceEvents.js";
import { sourceInputIntentsOf, type SourceInputCheckpointRequest } from "./sourceInputIntent.js";

async function fixture() {
  const ledger = new InMemoryRunLedger(() => 1000);
  return { ledger, ...(await seedSourceInputCheckpoints(ledger)) };
}
async function unread(ledger: InMemoryRunLedger, id: string, gen = "g1") {
  const peek = await ledger.peekInbox(id, gen, 0);
  if (!peek.ok) throw new Error("missing fixture owner");
  return peek.items.filter(unreadInbox(peek.boundary.lastStep as StepRecord | null)).map((item) => item.seq);
}

describe("canonical source input checkpoints", () => {
  it("commits proof before exact ACK and preserves unrelated rows through later steps", async () => {
    const { ledger, id, gen, receipt, step, session } = await fixture();
    const committed = await ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt });
    expect(committed).toEqual({
      ok: true,
      checkpoint: {
        receipt,
        receiptHash: await sourceHash(sourceSnapshot(receipt)),
        taskHash: await sourceHash(null),
        acknowledged: false,
      },
    });
    expect(await unread(ledger, id)).toEqual([1, 2, 3, 4]);
    const read = await ledger.sourceInputCheckpoint(id, gen, { operation: "read", inputId: receipt.inputId });
    expect(read).toEqual(committed);
    if (!read.ok || !read.checkpoint) throw new Error("missing checkpoint");
    const ack = { operation: "ack", inputId: receipt.inputId, receiptHash: read.checkpoint.receiptHash } as const;
    expect(await ledger.sourceInputCheckpoint(id, gen, ack)).toEqual({
      ok: true,
      checkpoint: { ...read.checkpoint, acknowledged: true },
    });
    expect(await unread(ledger, id)).toEqual([1, 3, 4]);
    expect(await ledger.step(id, gen, { ...step, step: 1 }, [], session)).toEqual({ ok: true });
    expect(await unread(ledger, id)).toEqual([1, 3, 4]);
    expect(await ledger.step(id, gen, { ...step, step: 2, inboxConsumedSeq: 4 }, [], session)).toEqual({ ok: true });
    expect(await unread(ledger, id)).toEqual([1, 4]);
    expect(await ledger.setState(id, gen, { progress: "later" })).toEqual({ ok: true });
    expect(await ledger.sourceInputCheckpoint(id, gen, ack)).toEqual({
      ok: true,
      checkpoint: { ...read.checkpoint, acknowledged: true },
    });
  });

  it("holds source rows when an ordinary high-water step supplies no receipt", async () => {
    const { ledger, id, gen, step, session } = await fixture();
    expect(await ledger.step(id, gen, { ...step, step: 1, inboxConsumedSeq: 4 }, [], session)).toEqual({ ok: true });
    expect(await unread(ledger, id)).toEqual([2, 4]);
  });

  it("refuses mismatched native identity, original digest, owner and ACK hashes", async () => {
    const { ledger, id, gen, receipt } = await fixture();
    for (const invalid of [
      { ...receipt, inputId: "foreign" },
      { ...receipt, intentHash: "b".repeat(64) },
      { ...receipt, native: { ...receipt.native, sessionId: "foreign" } },
      { ...receipt, native: { ...receipt.native, harness: "opencode" as const } },
    ])
      expect(await ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt: invalid })).toEqual({
        ok: false,
        reason: "fenced",
      });
    expect(await ledger.sourceInputCheckpoint(id, "stale", { operation: "commit", receipt })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(
      await ledger.sourceInputCheckpoint(id, gen, {
        operation: "ack",
        inputId: receipt.inputId,
        receiptHash: "a".repeat(64),
      }),
    ).toEqual({ ok: false, reason: "fenced" });
    expect(await ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt })).toMatchObject({
      ok: true,
      checkpoint: { acknowledged: false },
    });
    expect(
      await ledger.sourceInputCheckpoint(id, gen, {
        operation: "commit",
        receipt: { ...receipt, native: { ...receipt.native, entryId: "replacement" } },
      }),
    ).toEqual({ ok: false, reason: "fenced" });
    expect(await unread(ledger, id)).toEqual([1, 2, 3, 4]);
  });

  it("keeps canonical proof private and rejects ordinary mint, erase or ACK", async () => {
    const { ledger, id, gen, receipt, intents } = await fixture();
    const saved = {
      version: 2,
      entries: intents.entries,
      checkpoints: [
        {
          receipt,
          receiptHash: await sourceHash(sourceSnapshot(receipt)),
          taskHash: await sourceHash(null),
          acknowledged: false,
        },
      ],
    };
    expect(await ledger.setState(id, gen, { sourceInputIntents: saved })).toEqual({ ok: false, reason: "fenced" });
    expect(await ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt })).toMatchObject({
      ok: true,
      checkpoint: { acknowledged: false },
    });
    expect(await ledger.setState(id, gen, { sourceInputIntents: intents })).toEqual({ ok: false, reason: "fenced" });
    expect(
      await ledger.setState(id, gen, {
        sourceInputIntents: { ...saved, checkpoints: [{ ...saved.checkpoints[0], acknowledged: true }] },
      }),
    ).toEqual({ ok: false, reason: "fenced" });
    expect(await unread(ledger, id)).toEqual([1, 2, 3, 4]);
    expect(sourceInputIntentsOf({ ...saved, version: 1 })).toBeUndefined();
  });

  it("reconciles the same original after reclaim and never aliases two native entries", async () => {
    const { ledger, id, gen, receipt, intents } = await fixture();
    expect(await ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt })).toMatchObject({ ok: true });
    const second = {
      ...receipt,
      inputId: intents.entries[1]!.id,
      intentHash: await sourceHash(sourceSnapshot(intents.entries[1])),
    };
    expect(await ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt: second })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(
      await ledger.sourceInputCheckpoint(id, gen, {
        operation: "commit",
        receipt: { ...second, native: { ...second.native, entryId: "native-entry-two" } },
      }),
    ).toMatchObject({ ok: true, checkpoint: { receipt: { inputId: "source-input-two" } } });
    expect(await ledger.handoff(gen, [id])).toEqual({ marked: [id] });
    const reclaimed = await ledger.reclaim("g2", 20000, 10000);
    expect(reclaimed[0]?.row.ownerGen).toBe("g2");
    const read = await ledger.sourceInputCheckpoint(id, "g2", { operation: "read", inputId: receipt.inputId });
    expect(read).toMatchObject({ ok: true, checkpoint: { receipt, acknowledged: false } });
    if (!read.ok || !read.checkpoint) throw new Error("missing original");
    expect(
      await ledger.sourceInputCheckpoint(id, "g2", {
        operation: "ack",
        inputId: receipt.inputId,
        receiptHash: read.checkpoint.receiptHash,
      }),
    ).toMatchObject({ ok: true, checkpoint: { acknowledged: true } });
    expect(await unread(ledger, id, "g2")).toEqual([1, 3, 4]);
  });

  it.each(["session", "launch", "ended", "task"] as const)(
    "holds ACK when the current %s changes after commit",
    async (change) => {
      const { ledger, id, gen, receipt } = await fixture();
      const committed = await ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt });
      if (!committed.ok || !committed.checkpoint) throw new Error("missing checkpoint");
      const row = (await ledger.listLive()).find((row) => row.runId === id)!;
      if (change === "task") {
        const sourceTask = captureSourceTaskSnapshot(row);
        expect(sourceTask).toMatchObject({ version: 1, owner: { runId: id } });
        expect(await ledger.setState(id, gen, { sourceTask })).toEqual({ ok: true });
      } else {
        const harness = row.state.harness as Record<string, unknown>;
        expect(
          await ledger.setState(id, gen, {
            harness: { ...harness, ...(change === "session" ? { sessionFile: "foreign" } : { ended: true }) },
          }),
        ).toEqual({ ok: true });
        if (change === "launch")
          expect(
            await ledger.setState(id, gen, {
              harnessLaunch: { ...(row.state.harnessLaunch as Record<string, unknown>), ordinal: 1, phase: "prepared" },
            }),
          ).toEqual({ ok: true });
      }
      expect(await ledger.sourceInputCheckpoint(id, gen, { operation: "read", inputId: receipt.inputId })).toEqual(
        committed,
      );
      expect(
        await ledger.sourceInputCheckpoint(id, gen, {
          operation: "ack",
          inputId: receipt.inputId,
          receiptHash: committed.checkpoint.receiptHash,
        }),
      ).toEqual({ ok: false, reason: "fenced" });
      expect(await unread(ledger, id)).toEqual([1, 2, 3, 4]);
    },
  );

  it("retains unrelated canonical deferrals when a stale report drops them", async () => {
    const { ledger, id, gen, receipt, step, session } = await fixture();
    expect(
      await ledger.step(id, gen, { ...step, step: 1, inboxConsumedSeq: 4, inboxDeferredSeqs: [1] }, [], session),
    ).toEqual({ ok: true });
    const committed = await ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt });
    if (!committed.ok || !committed.checkpoint) throw new Error("missing checkpoint");
    expect(
      await ledger.sourceInputCheckpoint(id, gen, {
        operation: "ack",
        inputId: receipt.inputId,
        receiptHash: committed.checkpoint.receiptHash,
      }),
    ).toMatchObject({ ok: true, checkpoint: { acknowledged: true } });
    expect(await unread(ledger, id)).toEqual([1, 4]);
    expect(
      await ledger.step(id, gen, { ...step, step: 2, inboxConsumedSeq: 4, inboxDeferredSeqs: [] }, [], session),
    ).toEqual({ ok: true });
    expect(await unread(ledger, id)).toEqual([1, 4]);
  });

  it("settles only a confirmed normal row and never resurrects it from a stale report", async () => {
    const { ledger, id, gen, receipt, step, session } = await fixture();
    const original = await ledger.peekInbox(id, gen, 0);
    if (!original.ok) throw new Error("missing original inbox");
    const witness = original.items.find((item) => item.seq === 1)!.witness;
    const committed = await ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt });
    if (!committed.ok || !committed.checkpoint) throw new Error("missing checkpoint");
    expect(
      await ledger.sourceInputCheckpoint(id, gen, {
        operation: "ack",
        inputId: receipt.inputId,
        receiptHash: committed.checkpoint.receiptHash,
      }),
    ).toMatchObject({ ok: true });
    expect(await unread(ledger, id)).toEqual([1, 3, 4]);
    const confirmed = { ...step, step: 1, inboxConsumedSeq: 2, inboxAcknowledgedRows: [witness] };
    expect(await ledger.step(id, gen, confirmed, [], session)).toEqual({ ok: true });
    expect(await unread(ledger, id)).toEqual([3, 4]);
    expect(await ledger.step(id, gen, confirmed, [], session)).toEqual({ ok: true });
    expect(
      await ledger.step(id, gen, { ...step, step: 2, inboxConsumedSeq: 0, inboxDeferredSeqs: [1] }, [], session),
    ).toEqual({ ok: true });
    expect(await unread(ledger, id)).toEqual([3, 4]);
  });

  it("refuses false normal-row proof and cannot settle source evidence through it", async () => {
    const { ledger, id, gen, step, session } = await fixture();
    const observed = await ledger.peekInbox(id, gen, 0);
    if (!observed.ok) throw new Error("missing original inbox");
    const normal = observed.items.find((item) => item.seq === 1)!.witness;
    const source = observed.items.find((item) => item.seq === 2)!.witness;
    for (const witnesses of [
      [source],
      [{ ...normal, digest: "0".repeat(64) }],
      [{ ...normal, runId: "foreign" }],
      [normal, normal],
    ]) {
      const report = { ...step, step: 1, inboxConsumedSeq: 4, inboxAcknowledgedRows: witnesses };
      expect(await ledger.step(id, gen, report, [], session)).toEqual({ ok: false, reason: "fenced" });
      expect(await unread(ledger, id)).toEqual([1, 2, 3, 4]);
    }
  });

  it("uses positive normal proof without consuming another row below the proposed cursor", async () => {
    const { ledger, id, gen, step, session } = await fixture();
    const observed = await ledger.peekInbox(id, gen, 0);
    if (!observed.ok) throw new Error("missing original inbox");
    const witness = observed.items[0]!.witness;
    expect(
      await ledger.step(
        id,
        gen,
        { ...step, step: 1, inboxConsumedSeq: 4, inboxAcknowledgedRows: [witness] },
        [],
        session,
      ),
    ).toEqual({ ok: true });
    expect(await unread(ledger, id)).toEqual([2, 3, 4]);
    expect(await ledger.step(id, gen, { ...step, step: 1, inboxConsumedSeq: 4 }, [], session)).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(await unread(ledger, id)).toEqual([2, 3, 4]);
  });

  it("keeps normal-only confirmation monotonic through later reports with no new proof", async () => {
    const { ledger, id, gen, step, session } = await fixture();
    ledger.inbox.set(
      id,
      ledger.inbox.get(id)!.filter((item) => item.seq === 1 || item.seq === 3),
    );
    delete ledger.live.get(id)!.state.sourceInputIntents;
    const observed = await ledger.peekInbox(id, gen, 0);
    if (!observed.ok) throw new Error("missing original inbox");
    expect(
      await ledger.step(
        id,
        gen,
        { ...step, step: 1, inboxAcknowledgedRows: [observed.items[0]!.witness] },
        [],
        session,
      ),
    ).toEqual({ ok: true });
    expect(await unread(ledger, id)).toEqual([3]);
    for (const n of [2, 3, 4]) {
      expect(
        await ledger.step(
          id,
          gen,
          { ...step, step: n, inboxConsumedSeq: n === 2 ? 4 : 0, inboxDeferredSeqs: [1] },
          [],
          session,
        ),
      ).toEqual({
        ok: true,
      });
      expect(await unread(ledger, id)).toEqual([3]);
    }
  });

  it("holds changed original rows and ownership races during normal confirmation", async () => {
    for (const change of ["row", "owner"] as const) {
      const { ledger, id, gen, step, session } = await fixture();
      const observed = await ledger.peekInbox(id, gen, 0);
      if (!observed.ok) throw new Error("missing original inbox");
      const report = { ...step, step: 1, inboxConsumedSeq: 4, inboxAcknowledgedRows: [observed.items[0]!.witness] };
      if (change === "row") ledger.inbox.get(id)![0]!.message.text = "replacement row";
      const saving = ledger.step(id, gen, report, [], session);
      if (change === "owner") expect(await ledger.handoff(gen, [id])).toEqual({ marked: [id] });
      expect(await saving).toEqual({ ok: false, reason: "fenced" });
      if (change === "owner") {
        expect((await ledger.reclaim("g2", 20000, 10000))[0]?.row.ownerGen).toBe("g2");
        expect(await unread(ledger, id, "g2")).toEqual([1, 2, 3, 4]);
      } else expect(await unread(ledger, id)).toEqual([1, 2, 3, 4]);
    }
  });

  it("compares the original row and owner again after an asynchronous digest", async () => {
    for (const change of ["row", "owner"] as const) {
      const { ledger, id, gen, step, session } = await fixture();
      const observed = await ledger.peekInbox(id, gen, 0);
      if (!observed.ok) throw new Error("missing original inbox");
      let release!: () => void, entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const spy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
        entered();
        await pending;
        return digest(...args);
      });
      try {
        const saving = ledger.step(
          id,
          gen,
          { ...step, step: 1, inboxAcknowledgedRows: [observed.items[0]!.witness] },
          [],
          session,
        );
        await started;
        if (change === "row") ledger.inbox.get(id)![0]!.message.text = "changed during confirmation";
        else expect(await ledger.handoff(gen, [id])).toEqual({ marked: [id] });
        release();
        expect(await saving).toEqual({ ok: false, reason: "fenced" });
      } finally {
        release();
        spy.mockRestore();
      }
    }
  });

  it("preserves a committed normal receipt when a later exact source ACK changes the cursor", async () => {
    const { ledger, id, gen, receipt, step, session } = await fixture();
    const observed = await ledger.peekInbox(id, gen, 0);
    if (!observed.ok) throw new Error("missing original inbox");
    expect(
      await ledger.step(
        id,
        gen,
        { ...step, step: 1, inboxAcknowledgedRows: [observed.items[0]!.witness] },
        [],
        session,
      ),
    ).toEqual({ ok: true });
    const committed = await ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt });
    if (!committed.ok || !committed.checkpoint) throw new Error("missing checkpoint");
    expect(
      await ledger.sourceInputCheckpoint(id, gen, {
        operation: "ack",
        inputId: receipt.inputId,
        receiptHash: committed.checkpoint.receiptHash,
      }),
    ).toMatchObject({ ok: true });
    expect(await unread(ledger, id)).toEqual([3, 4]);
    const last = await ledger.peekInbox(id, gen, 0);
    expect(last.ok && (last.boundary.lastStep as StepRecord | null)?.inboxAcknowledgedRows).toEqual([
      observed.items[0]!.witness,
    ]);
  });

  it("refuses a legacy success reply without positive normal-row acknowledgment", async () => {
    const { ledger, id, gen, step, session } = await fixture();
    const observed = await ledger.peekInbox(id, gen, 0);
    if (!observed.ok) throw new Error("missing original inbox");
    for (const echo of [undefined, [], [{ ...observed.items[0]!.witness, digest: "a".repeat(64) }]]) {
      let mutations = 0;
      const wire = new WorkerRunLedger({
        baseUrl: "https://state.invalid",
        token: "fixture",
        storeKey: "runs:fixture",
        fetch: async (input) => {
          if (!String(input).endsWith("/runs/step")) return Response.json({ ok: true });
          mutations++;
          return Response.json({ ok: true, ...(echo === undefined ? {} : { inboxAcknowledgedRows: echo }) });
        },
      });
      await expect(
        wire.step(id, gen, { ...step, step: 1, inboxAcknowledgedRows: [observed.items[0]!.witness] }, [], session),
      ).rejects.toMatchObject({ name: "UncertainStoreError" });
      expect(mutations).toBe(1);
    }
    expect(await unread(ledger, id)).toEqual([1, 2, 3, 4]);
  });

  it("reports only safe step protection refusal fields and leaves the prior boundary intact", async () => {
    const { ledger, id, gen, step, session } = await fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await ledger.step(id, gen, { ...step, step: 1 }, [], session)).toEqual({ ok: true });
      expect(warn.mock.calls).toEqual([]);
      ledger.live.get(id)!.state.sourceInputIntents = {
        version: 999,
        native: "PRIVATE_NATIVE_SESSION",
        input: "PRIVATE_INPUT_IDENTIFIER",
      };
      expect(await ledger.step(id, gen, { ...step, step: 2, inboxConsumedSeq: 4 }, [], session)).toEqual({
        ok: false,
        reason: "fenced",
      });
      expect(warn.mock.calls).toEqual([
        ["[runs/step] source input protection refused", { runId: id, ownerGen: gen, step: 2, acknowledged: 0 }],
      ]);
      expect(ledger.steps.get(id)!.at(-1)).toMatchObject({ step: 1, inboxConsumedSeq: 0 });
      expect(await unread(ledger, id)).toEqual([1, 2, 3, 4]);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a checkpoint when ownership changes while its digest is pending", async () => {
    const { ledger, id, gen, receipt } = await fixture();
    const saving = ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt });
    expect(await ledger.handoff(gen, [id])).toEqual({ marked: [id] });
    expect(await saving).toEqual({ ok: false, reason: "fenced" });
    expect((await ledger.reclaim("g2", 20000, 10000))[0]?.row.ownerGen).toBe("g2");
    expect(await ledger.sourceInputCheckpoint(id, "g2", { operation: "read", inputId: receipt.inputId })).toEqual({
      ok: true,
      checkpoint: null,
    });
    expect(await unread(ledger, id, "g2")).toEqual([1, 2, 3, 4]);
  });

  it.each(["commit", "ack"] as const)(
    "reads the original after a lost %s reply without repeating a mutation",
    async (operation) => {
      for (const committed of [false, true]) {
        const { ledger, id, gen, receipt } = await fixture();
        if (operation === "ack")
          expect(await ledger.sourceInputCheckpoint(id, gen, { operation: "commit", receipt })).toMatchObject({
            ok: true,
          });
        let mutations = 0;
        const wire = new WorkerRunLedger({
          baseUrl: "https://state.invalid",
          token: "fixture",
          storeKey: "runs:fixture",
          fetch: async (_url, init) => {
            const body = JSON.parse(String(init?.body)) as { request: SourceInputCheckpointRequest };
            if (body.request.operation === "read")
              return Response.json(await ledger.sourceInputCheckpoint(id, gen, body.request));
            mutations++;
            if (committed) await ledger.sourceInputCheckpoint(id, gen, body.request);
            throw new TypeError("lost original response");
          },
        });
        const request: SourceInputCheckpointRequest =
          operation === "commit"
            ? { operation, receipt }
            : { operation, inputId: receipt.inputId, receiptHash: await sourceHash(sourceSnapshot(receipt)) };
        await expect(wire.sourceInputCheckpoint(id, gen, request)).rejects.toThrow();
        expect(mutations).toBe(1);
        const read = await wire.sourceInputCheckpoint(id, gen, { operation: "read", inputId: receipt.inputId });
        expect(read).toEqual({
          ok: true,
          checkpoint:
            operation === "commit" && !committed
              ? null
              : {
                  receipt,
                  receiptHash: await sourceHash(sourceSnapshot(receipt)),
                  taskHash: await sourceHash(null),
                  acknowledged: operation === "ack" && committed,
                },
        });
        expect(await unread(ledger, id)).toEqual(operation === "ack" && committed ? [1, 3, 4] : [1, 2, 3, 4]);
        expect(mutations).toBe(1);
      }
    },
  );
});
