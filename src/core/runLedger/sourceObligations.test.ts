import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSourceInput } from "../testing/sourceInputs.js";
import {
  sourceObligationHolder,
  sourceObligationHolderOf,
  sourceObligationJobOf,
  sourceEventStorageCharge,
  retainSourceObligationRangeHolders,
} from "./sourceObligations.js";

const reference = testSourceInput();
const obligation = {
  reference,
  context: { version: 1, status: "known", revision: 1, origins: [], slack: [], mcp: [] },
  state: "uncertain",
  automaticUntil: 10_000,
  reservedBytes: 8_000,
  settlementMaxBytes: 4_000,
  protections: [],
};
const frame = {
  version: 4,
  eventKey: reference.receipt.key,
  stage: "received",
  state: "waiting",
  prior: {
    version: 2,
    eventKey: reference.receipt.key,
    stage: "received",
    state: "leased",
    attempts: 1,
    nextAttemptAt: 60_123,
    releases: [],
    lease: { owner: "fixture-owner", token: "fixture-token", claimedAt: 123, until: 60_123 },
  },
  attempts: 1,
  nextAttemptAt: 10_000,
  obligations: [obligation],
};

describe("inactive source obligation readers", () => {
  it("loads the public run record API in a fresh process", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        'import { utf8ByteLength } from "./src/core/runRecord.ts"; console.log(JSON.stringify({ bytes: utf8ByteLength("é") }));',
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
      status: 0,
      stdout: '{"bytes":2}\n',
      stderr: "",
    });
  });

  it("reads an exact waiting frame and its original notice holder", () => {
    expect(sourceObligationJobOf(frame)).toEqual(frame);
    const holder = sourceObligationHolder(reference);
    expect(sourceObligationHolderOf(holder)).toEqual({
      rootRunId: reference.root.runId,
      eventKey: reference.receipt.key,
      kind: "notice",
      decisionId: null,
    });
    const protectedFrame = {
      ...frame,
      obligations: [
        {
          ...obligation,
          protections: [
            {
              sessionKey: "session:source",
              ranges: [{ from: 1, to: 3 }],
              receipt: { version: 1, revision: 2, guarded: true },
            },
          ],
        },
      ],
    };
    expect(sourceObligationJobOf(protectedFrame)).toEqual(protectedFrame);
    expect(
      sourceObligationJobOf({
        ...protectedFrame,
        obligations: [
          {
            ...protectedFrame.obligations[0],
            protections: [
              { ...protectedFrame.obligations[0]!.protections[0], receipt: { version: 1, revision: 0, guarded: true } },
            ],
          },
        ],
      }),
    ).toBeUndefined();
    expect(sourceObligationJobOf({ ...frame, future: true })).toBeUndefined();
    expect(sourceObligationJobOf({ ...frame, obligations: [{ ...obligation, reservedBytes: 1 }] })).toBeUndefined();
  });

  it("keeps pending and expired holders during a revision-fenced prune, without promoting another holder", () => {
    const holder = sourceObligationHolder(reference);
    expect(
      retainSourceObligationRangeHolders({ [holder]: [{ from: 2, to: 4 }], ordinary: [{ from: 0, to: 1 }] }, []),
    ).toEqual([holder]);
    expect(
      sourceObligationJobOf({ ...frame, nextAttemptAt: null, obligations: [{ ...obligation, state: "expired" }] }),
    ).toMatchObject({ state: "waiting", nextAttemptAt: null });
    expect(
      retainSourceObligationRangeHolders({ "@source-obligation:future-format": [{ from: 1, to: 1 }] }, []),
    ).toEqual(["@source-obligation:future-format"]);
    expect(sourceObligationHolderOf("@source-obligation:future-format")).toBeUndefined();
    expect(retainSourceObligationRangeHolders({ ordinary: [{ from: 0, to: 1 }] }, [])).toEqual([]);
  });

  it("charges the retained reservation once and refuses admission beside unreadable obligation metadata", () => {
    const json = JSON.stringify({ source: "saved" });
    const charged = 8_485; // 18 event bytes, 467 frame bytes and the 8,000-byte reservation.
    expect(sourceEventStorageCharge(json, frame, 1)).toBe(charged);
    expect(sourceEventStorageCharge(json, frame, charged)).toBe(charged);
    expect(sourceEventStorageCharge(json, { ...frame, obligations: [{}] }, 1)).toBe(32 * 1024 * 1024);
    expect(sourceEventStorageCharge(json, { version: 1 }, 40)).toBe(40);
    expect(sourceEventStorageCharge(json, { version: 9, state: "future" }, 131_072)).toBe(131_072);
    expect(sourceEventStorageCharge(json, { version: 9, obligations: [{}] }, 131_072)).toBe(32 * 1024 * 1024);
  });
});

import { InMemoryRunLedger } from "./inMemory.js";
import { InMemoryRunStore, FileRunStore } from "../runStore.js";
import { analyzeRunFriction } from "../runFriction.js";
import type { RunRecord } from "../runRecord.js";

async function seeded() {
  let now = 1_000;
  const ledger = new InMemoryRunLedger(() => now);
  const accepted = await ledger.receiveSourceEvent({
    version: 1,
    sourceId: "fixture:installation:one",
    deliveryId: "one",
    objectId: "comment:one",
    changeId: "revision:one",
    kind: "source-evidence",
    payload: { text: "saved evidence" },
  });
  if (accepted.kind === "refused") throw new Error("expected source reception");
  const row = ledger.sourceEvents.get(accepted.receipt.key)!;
  const ref = { ...reference, receipt: accepted.receipt };
  const waiting = {
    ...frame,
    eventKey: accepted.receipt.key,
    prior: { ...frame.prior, eventKey: accepted.receipt.key },
    obligations: [{ ...obligation, reference: ref }],
  };
  row.job = waiting;
  return {
    ledger,
    row,
    waiting,
    clock: (at: number) => {
      now = at;
    },
  };
}

function record(id: string, finishedAt: number): RunRecord {
  return {
    id,
    agent: "orchestrator",
    model: "fixture/model",
    userId: "cli:user",
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

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("inactive source obligation reference storage", () => {
  it("reads waiting metadata, holds old job claimants and leaves attempts unchanged after expiry", async () => {
    const { ledger, waiting, clock } = await seeded();
    expect((await ledger.readSourceEvent(waiting.eventKey))?.job).toEqual(waiting);
    clock(100_000);
    expect(await ledger.claimSourceEvents({ owner: "old-reader", readerVersion: 3, limit: 1 })).toEqual({
      kind: "claimed",
      claims: [],
      held: 1,
      failed: [],
    });
    expect((await ledger.readSourceEvent(waiting.eventKey))?.job).toEqual(waiting);
    expect(
      await ledger.releaseSourceEvent({
        key: waiting.eventKey,
        owner: "old-reader",
        token: "stale",
        disposition: "retry",
        reason: "source-unavailable",
      }),
    ).toEqual({ kind: "refused", reason: "fenced" });
  });

  it.each(["memory", "file"] as const)(
    "keeps the original source root through %s retention and an expired automatic window",
    async (kind) => {
      const { ledger, clock } = await seeded();
      const options = {
        now: () => 100_000,
        policy: { maxRuns: 1, maxBytes: 1_000_000, retentionDays: 1 },
        contextRetention: () => ledger.sourceObligationRetention(),
      };
      const directory = kind === "file" ? mkdtempSync(join(tmpdir(), "source-obligation-reader-")) : undefined;
      if (directory) directories.push(directory);
      const store = directory ? new FileRunStore(directory, options) : new InMemoryRunStore(options);
      await store.put(record("source-root", 2));
      await store.put(record("newest", 3));
      clock(100_000);
      expect((await store.get("source-root"))?.id).toBe("source-root");
      expect((await store.list({})).map((row) => row.id)).toEqual(["newest", "source-root"]);
    },
  );

  it.each(["memory", "file"] as const)(
    "keeps ordinary dependency pins alongside obligation pins in %s storage",
    async (kind) => {
      const { ledger } = await seeded();
      const options = {
        now: () => 100_000,
        policy: { maxRuns: 1, maxBytes: 1_000_000, retentionDays: 1 },
        contextRetention: () => ledger.sourceObligationRetention(),
      };
      const directory = kind === "file" ? mkdtempSync(join(tmpdir(), "source-obligation-reader-")) : undefined;
      if (directory) directories.push(directory);
      const store = directory ? new FileRunStore(directory, options) : new InMemoryRunStore(options);
      await store.put(record("ordinary-source", 2));
      await store.put({
        ...record("ordinary-consumer", 3),
        contextDependencies: {
          version: 1,
          status: "known",
          revision: 1,
          origins: [
            { runId: "ordinary-source", requester: "cli:user", channelId: "cli:main", threadKey: "cli:thread" },
          ],
          slack: [],
          mcp: [],
        },
      });
      expect((await store.get("ordinary-source"))?.id).toBe("ordinary-source");
      expect(await store.get("source-root")).toBeNull();
    },
  );

  it("reserves capacity for waiting metadata before accepting another event", async () => {
    const { ledger, row, waiting } = await seeded();
    row.job = { ...waiting, obligations: [{ ...waiting.obligations[0], reservedBytes: 32 * 1024 * 1024 }] };
    expect(
      await ledger.receiveSourceEvent({
        version: 1,
        sourceId: "fixture:installation:one",
        deliveryId: "two",
        objectId: "comment:two",
        changeId: "revision:one",
        kind: "source-evidence",
        payload: {},
      }),
    ).toEqual({ kind: "refused", reason: "capacity" });
    expect((await ledger.readSourceEvent(waiting.eventKey))?.job).toMatchObject({ state: "waiting", attempts: 1 });
  });
});
