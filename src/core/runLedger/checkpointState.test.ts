import { describe, it, expect, vi } from "vitest";
import { preserveCheckpointState } from "./checkpointState.js";
import { testSourceInputIntent as inputIntent } from "../testing/sourceInputs.js";
import { sourceInputIntentsOf } from "./sourceInputIntent.js";

const inputOwner = {
  runId: "source-consumer",
  ownerGen: "g1",
  meta: { userId: "cli:alice", channelId: "cli:main", threadKey: "cli:thread" },
};

describe("original source input intent custody", () => {
  const nativeState = {
    harnessLaunch: {
      version: 1,
      harness: "pi",
      phase: "begun",
      ordinal: 0,
      sessionPolicy: { version: 1, commandRoute: "native", identity: "write" },
    },
    harness: {
      harness: "pi",
      launchOrdinal: 0,
      sessionFile: "original-native-session",
      sessionPolicy: { version: 1, commandRoute: "native", identity: "write" },
    },
  };

  it("preserves original input coordinates when an ordinary state update omits them", () => {
    const original = inputIntent();
    expect(preserveCheckpointState({ sourceInputIntents: original }, { progress: "later" })).toEqual({
      progress: "later",
      sourceInputIntents: original,
    });
  });

  it("rejects replacement, deletion and unsupported original state", () => {
    const original = inputIntent();
    for (const changed of [
      { ...original, version: 99 },
      { version: 1, entries: [] },
      { ...original, entries: [{ ...original.entries[0], renderedHash: "b".repeat(64) }] },
      { ...original, entries: [{ ...original.entries[0], witness: { ...original.entries[0]!.witness, seq: 9 } }] },
    ])
      expect(
        preserveCheckpointState({ sourceInputIntents: original }, { sourceInputIntents: changed }),
      ).toBeUndefined();
    expect(preserveCheckpointState({ sourceInputIntents: { version: 99 } }, {})).toBeUndefined();
    expect(preserveCheckpointState({ sourceInputIntents: original }, {})).toEqual({ sourceInputIntents: original });
  });

  it("admits only prepared metadata against the acknowledged native session and canonical owner", () => {
    const state = inputIntent();
    expect(preserveCheckpointState(nativeState, { sourceInputIntents: state }, false, inputOwner)).toEqual({
      sourceInputIntents: state,
      harnessLaunch: nativeState.harnessLaunch,
      harness: nativeState.harness,
    });
    expect(preserveCheckpointState(nativeState, { sourceInputIntents: state })).toBeUndefined();
    for (const owner of [
      { ...inputOwner, runId: "foreign" },
      { ...inputOwner, ownerGen: "g2" },
      { ...inputOwner, meta: { ...inputOwner.meta, userId: "cli:other" } },
    ])
      expect(preserveCheckpointState(nativeState, { sourceInputIntents: state }, false, owner)).toBeUndefined();
    for (const native of [
      { ...nativeState.harness, ended: true },
      { ...nativeState.harness, sessionFile: "/foreign/session.jsonl" },
      { ...nativeState.harness, launchOrdinal: 1 },
      undefined,
    ])
      expect(
        preserveCheckpointState({ ...nativeState, harness: native }, { sourceInputIntents: state }, false, inputOwner),
      ).toBeUndefined();
  });

  it("keeps begun monotonic and preserves original writer coordinates after reclaim", () => {
    const original = inputIntent(),
      begun = structuredClone(original);
    begun.entries[0]!.phase = "begun";
    const prior = { ...nativeState, sourceInputIntents: original };
    const nextOwner = { ...inputOwner, ownerGen: "g2" };
    expect(preserveCheckpointState(prior, { sourceInputIntents: begun }, false, nextOwner)).toEqual({
      sourceInputIntents: begun,
      harnessLaunch: nativeState.harnessLaunch,
      harness: nativeState.harness,
    });
    expect(begun.entries[0]!.owner.gen).toBe("g1");
    expect(
      preserveCheckpointState(
        { ...nativeState, sourceInputIntents: begun },
        { sourceInputIntents: original },
        false,
        nextOwner,
      ),
    ).toBeUndefined();
    expect(preserveCheckpointState(nativeState, { sourceInputIntents: begun }, false, inputOwner)).toBeUndefined();
  });

  it("reports one bounded guard reason per input refusal without private metadata", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const original = inputIntent();
      expect(preserveCheckpointState(nativeState, { sourceInputIntents: original }, false, inputOwner)).toMatchObject({
        sourceInputIntents: original,
      });
      expect(preserveCheckpointState({}, { progress: "unchanged" })).toEqual({ progress: "unchanged" });
      expect(warn.mock.calls).toEqual([]);
      const changed = structuredClone(original);
      changed.entries[0]!.renderedHash = "b".repeat(64);
      const begun = structuredClone(original);
      begun.entries[0]!.phase = "begun";
      for (const [prior, next] of [
        [nativeState, { version: 99, privateMarker: "PRIVATE_SOURCE_TEXT" }],
        [{ ...nativeState, sourceInputIntents: original }, changed],
        [{ ...nativeState, harness: undefined }, original],
        [nativeState, begun],
      ] as const)
        expect(preserveCheckpointState(prior, { sourceInputIntents: next }, false, inputOwner)).toBeUndefined();
      expect(warn.mock.calls).toEqual([
        ["[runs/state] source input intent refused", { runId: "source-consumer", reason: "invalid-metadata" }],
        ["[runs/state] source input intent refused", { runId: "source-consumer", reason: "original-changed" }],
        ["[runs/state] source input intent refused", { runId: "source-consumer", reason: "owner-or-session" }],
        ["[runs/state] source input intent refused", { runId: "source-consumer", reason: "new-intent" }],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses input aliases and unsafe metadata without evaluating accessors", () => {
    const original = inputIntent();
    expect(sourceInputIntentsOf(original)).toEqual(original);
    const alias = structuredClone(original.entries[0]!);
    alias.id = "replacement-id";
    alias.witness.seq = 9;
    expect(sourceInputIntentsOf({ version: 1, entries: [original.entries[0], alias] })).toBeUndefined();
    expect(sourceInputIntentsOf({ ...original, accepted: true })).toBeUndefined();
    expect(
      sourceInputIntentsOf({
        ...original,
        entries: Array.from({ length: 65 }, (_, i) => ({
          ...original.entries[0]!,
          id: `input-${i}`,
          witness: { ...original.entries[0]!.witness, seq: i + 1 },
          reference: {
            ...original.entries[0]!.reference,
            receipt: { ...original.entries[0]!.reference.receipt, key: `source:${i.toString(16).padStart(64, "0")}` },
          },
        })),
      }),
    ).toBeUndefined();
    expect(
      sourceInputIntentsOf({
        ...original,
        entries: [{ ...original.entries[0]!, native: { ...original.entries[0]!.native, sessionId: "x".repeat(4097) } }],
      }),
    ).toBeUndefined();
    let reads = 0;
    const unsafe = Object.defineProperty({}, "version", {
      enumerable: true,
      get() {
        reads++;
        return 1;
      },
    });
    expect(sourceInputIntentsOf(unsafe)).toBeUndefined();
    expect(reads).toBe(0);
    const saved = preserveCheckpointState({ sourceInputIntents: original }, {})!;
    original.entries[0]!.owner.gen = "changed";
    expect(saved.sourceInputIntents).toMatchObject({ version: 1, entries: [{ owner: { gen: "g1" } }] });
  });
});
const policy = { version: 1, commandRoute: "hosted-review", identity: "read" };
const facts = {
  harness: "pi",
  pid: 42,
  processBirth: "original",
  root: "/workspace/original",
  bearerHash: "a".repeat(64),
  sessionFile: "/workspace/original/session.jsonl",
  wire: "openai-responses",
  logOffset: 0,
  sessionPolicy: policy,
};
describe("original session policy custody", () => {
  it("keeps a confirmed ending bound to its producer and refuses stale resurrection", () => {
    const original = { ...facts, launchOrdinal: 0 };
    const ended = { ...original, ended: true };
    const saved = preserveCheckpointState({ harness: original }, { harness: ended });
    expect(saved?.harness).toMatchObject({ harness: "pi", pid: 42, processBirth: "original", ended: true });
    expect(preserveCheckpointState({ harness: ended }, { harness: original })).toBeUndefined();
    expect(preserveCheckpointState({ harness: original }, { harness: { ...ended, pid: 43 } })).toBeUndefined();
    expect(
      preserveCheckpointState({ harness: original }, { harness: { ...ended, processBirth: "foreign" } }),
    ).toBeUndefined();
    expect(preserveCheckpointState({}, { harness: ended })).toBeUndefined();
    expect(
      preserveCheckpointState({ harness: { ...ended, sessionPolicy: undefined } }, { notes: "later" })?.harness,
    ).toMatchObject({ pid: 42, ended: true });
  });
  it("admits a declared policy only with the first original facts", () => {
    expect(preserveCheckpointState({}, { harness: facts })).toEqual({ harness: facts });
  });
  it.each(["harness", "policy"])("preserves original policy when a generic state update omits %s", (mode) => {
    const incoming =
      mode === "harness" ? { verdict: "later" } : { harness: { ...facts, sessionPolicy: undefined, logOffset: 12 } };
    const actual = preserveCheckpointState({ harness: facts }, incoming);
    expect(actual?.harness).toHaveProperty("sessionPolicy", policy);
    if (mode === "policy") expect(actual?.harness).toHaveProperty("logOffset", 12);
  });
  it.each([
    { version: 1, commandRoute: "native", identity: "read" },
    { version: 1, commandRoute: "hosted-review", identity: "write" },
    { ...policy, extra: true },
    null,
  ])("refuses replacement or invalid original policy %#", (next) => {
    expect(preserveCheckpointState({ harness: facts }, { harness: { ...facts, sessionPolicy: next } })).toBeUndefined();
  });
  it("keeps ordinary legacy facts unknown and rejects retrospective policy injection", () => {
    const { sessionPolicy: _, ...legacy } = facts;
    expect(preserveCheckpointState({ harness: legacy }, { harness: { ...legacy, logOffset: 12 } })).toEqual({
      harness: { ...legacy, logOffset: 12 },
    });
    expect(preserveCheckpointState({ harness: legacy }, { harness: facts })).toBeUndefined();
  });
  it("preserves input aliases and legitimate lifecycle facts", () => {
    const prior = { harness: structuredClone(facts) },
      incoming = { harness: { ...structuredClone(facts), logOffset: 12 } };
    const a = structuredClone(prior),
      b = structuredClone(incoming);
    const actual = preserveCheckpointState(prior, incoming);
    expect(actual).toEqual(incoming);
    expect(prior).toEqual(a);
    expect(incoming).toEqual(b);
  });
});

import { InMemoryRunLedger } from "./inMemory.js";
describe("source input intent state transaction", () => {
  it.each(["pi", "opencode"] as const)("keeps %s original intent through omission and reclaim", async (harness) => {
    const ledger = new InMemoryRunLedger(() => 1000);
    const original = inputIntent(harness),
      entry = original.entries[0]!;
    const launch = { version: 1, harness, phase: "prepared", ordinal: 0, sessionPolicy: policy };
    expect(
      await ledger.claim({
        runId: "source-consumer",
        threadKey: "cli:thread",
        gen: "g1",
        startedAt: 1,
        leaseMs: 10000,
        system: "original",
        tools: [],
        meta: inputOwner.meta,
        state: { harnessLaunch: launch },
      }),
    ).toMatchObject({ ok: true });
    // Claim and generic state paths cannot backfill input metadata without original native facts.
    expect(await ledger.setState("source-consumer", "g1", { sourceInputIntents: original })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(await ledger.setState("source-consumer", "g1", { harnessLaunch: { ...launch, phase: "begun" } })).toEqual({
      ok: true,
    });
    const native = {
      harness,
      launchOrdinal: 0,
      sessionPolicy: policy,
      ...(harness === "pi" ? { sessionFile: entry.native.sessionId } : { sessionID: entry.native.sessionId }),
    };
    expect(await ledger.setState("source-consumer", "g1", { harness: native })).toEqual({ ok: true });
    for (const changed of [
      { ...entry, owner: { ...entry.owner, runId: "foreign" } },
      { ...entry, owner: { ...entry.owner, gen: "g2" } },
      { ...entry, owner: { ...entry.owner, requester: "cli:other" } },
      { ...entry, native: { ...entry.native, sessionId: "foreign-session" } },
      { ...entry, native: { ...entry.native, launchOrdinal: 1 } },
      { ...entry, phase: "begun" },
    ])
      expect(
        await ledger.setState("source-consumer", "g1", { sourceInputIntents: { version: 1, entries: [changed] } }),
      ).toEqual({ ok: false, reason: "fenced" });
    expect(await ledger.setState("source-consumer", "g1", { sourceInputIntents: original })).toEqual({ ok: true });
    expect(await ledger.setState("source-consumer", "g1", { progress: "later" })).toEqual({ ok: true });
    expect(await ledger.peekInbox("source-consumer", "g1", 0)).toMatchObject({
      ok: true,
      boundary: { state: { progress: "later", sourceInputIntents: original } },
    });
    expect(await ledger.handoff("g1", ["source-consumer"])).toEqual({ marked: ["source-consumer"] });
    expect(await ledger.reclaim("g2", 2000, 10000)).toMatchObject([
      { row: { ownerGen: "g2", state: { sourceInputIntents: original } } },
    ]);
    const begun = structuredClone(original);
    begun.entries[0]!.phase = "begun";
    expect(await ledger.setState("source-consumer", "g1", { sourceInputIntents: begun })).toEqual({
      ok: false,
      reason: "fenced",
    });
    expect(await ledger.setState("source-consumer", "g2", { sourceInputIntents: begun })).toEqual({ ok: true });
    for (const changed of [
      original,
      { version: 1, entries: [] },
      { version: 99, entries: begun.entries },
      { version: 1, entries: [{ ...begun.entries[0], id: "replacement-input" }] },
    ])
      expect(await ledger.setState("source-consumer", "g2", { sourceInputIntents: changed })).toEqual({
        ok: false,
        reason: "fenced",
      });
    expect(await ledger.setState("source-consumer", "g2", {})).toEqual({ ok: true });
    expect(await ledger.peekInbox("source-consumer", "g2", 0)).toMatchObject({
      ok: true,
      boundary: {
        state: { sourceInputIntents: { entries: [{ id: "source-input-one", phase: "begun", owner: { gen: "g1" } }] } },
      },
    });
  });
});
describe("durable launch state transaction", () => {
  it.each(["pi", "opencode"] as const)(
    "preserves %s intent and rejects phase or permission rollback",
    async (harness) => {
      const ledger = new InMemoryRunLedger(() => 1000);
      const intent = { version: 1, harness, phase: "prepared", ordinal: 0, sessionPolicy: policy };
      expect(
        await ledger.claim({
          runId: "launch",
          threadKey: "mcp:fixture:launch",
          gen: "g1",
          startedAt: 1,
          leaseMs: 10000,
          system: "original",
          tools: [],
          meta: { channelId: "mcp:fixture", userId: "slack:fixture", threadKey: "mcp:fixture:launch" },
          state: { harnessLaunch: intent },
        }),
      ).toMatchObject({ ok: true });
      expect(await ledger.setState("launch", "g1", { binding: "original workspace" })).toEqual({ ok: true });
      expect(ledger.live.get("launch")?.state).toEqual({ binding: "original workspace", harnessLaunch: intent });
      const begun = { ...intent, phase: "begun" };
      expect(await ledger.setState("launch", "g1", { harnessLaunch: begun })).toEqual({ ok: true });
      expect(await ledger.setState("launch", "g1", { harnessLaunch: { ...intent, ordinal: 1 } })).toEqual({
        ok: false,
        reason: "fenced",
      });
      expect(ledger.live.get("launch")?.state).toEqual({ harnessLaunch: begun });
      for (const replacement of [
        intent,
        { ...begun, sessionPolicy: { version: 1, commandRoute: "native", identity: "read" } },
        { ...begun, harness: "other" },
      ]) {
        expect(await ledger.setState("launch", "g1", { harnessLaunch: replacement })).toEqual({
          ok: false,
          reason: "fenced",
        });
        expect(ledger.live.get("launch")?.state).toEqual({ harnessLaunch: begun });
      }
      const producer = { harness, pid: 42, logOffset: 0, launchOrdinal: 0, sessionPolicy: policy };
      expect(await ledger.setState("launch", "g1", { harness: producer })).toEqual({ ok: true });
      const next = { ...intent, ordinal: 1 };
      expect(await ledger.setState("launch", "g1", { harnessLaunch: next })).toEqual({ ok: true });
      expect(ledger.live.get("launch")?.state).toEqual({ harness: producer, harnessLaunch: next });
      expect(await ledger.setState("launch", "g1", { harnessLaunch: begun })).toEqual({ ok: false, reason: "fenced" });
      expect(await ledger.setState("launch", "g1", { harnessLaunch: { ...next, phase: "begun" } })).toEqual({
        ok: true,
      });
      expect(ledger.live.get("launch")?.state).toEqual({
        harness: producer,
        harnessLaunch: { ...next, phase: "begun" },
      });
    },
  );
});
describe("original policy owning state transaction", () => {
  it.each([
    "omitted-harness",
    "omitted-policy",
    "changed",
    "invalid",
    "legacy-backfill",
    "lifecycle",
    "first-launch",
    "legacy-absence",
  ])("preserves admitted policy through actual InMemory state: %s", async (mode) => {
    const ledger = new InMemoryRunLedger(() => 1000),
      id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
    const { sessionPolicy: _, ...legacy } = facts;
    const initial = mode === "first-launch" ? {} : { harness: mode.startsWith("legacy") ? legacy : facts };
    expect(
      await ledger.claim({
        runId: id,
        threadKey: "mcp:fixture:policy",
        gen: "g1",
        startedAt: 1,
        leaseMs: 10000,
        system: "original",
        tools: [],
        meta: {
          channelId: "mcp:fixture",
          threadKey: "mcp:fixture:policy",
          userId: "slack:fixture",
          profile: { machine: "repo-resident", identity: "read", minutes: 25 },
        },
        state: initial,
      }),
    ).toMatchObject({ ok: true });
    const before = structuredClone(ledger.live.get(id)?.state);
    const incoming =
      mode === "omitted-harness"
        ? { verdict: "later" }
        : mode === "omitted-policy"
          ? { harness: { ...legacy, logOffset: 12 } }
          : mode === "changed"
            ? { harness: { ...facts, sessionPolicy: { version: 1, commandRoute: "native", identity: "read" } } }
            : mode === "invalid"
              ? { harness: { ...facts, sessionPolicy: { ...policy, extra: true } } }
              : mode === "legacy-absence"
                ? { harness: { ...legacy, logOffset: 12 } }
                : { harness: { ...facts, logOffset: 12 } };
    const result = await ledger.setState(id, "g1", incoming);
    if (["changed", "invalid", "legacy-backfill"].includes(mode)) {
      expect(result).toEqual({ ok: false, reason: "fenced" });
      expect(ledger.live.get(id)?.state).toEqual(before);
    } else {
      expect(result).toEqual({ ok: true });
      if (mode !== "legacy-absence") expect(ledger.live.get(id)?.state.harness).toHaveProperty("sessionPolicy", policy);
    }
    const saved = structuredClone(ledger.live.get(id)?.state);
    expect(await ledger.setState(id, "foreign", incoming)).toEqual({ ok: false, reason: "fenced" });
    expect(ledger.live.get(id)?.state).toEqual(saved);
  });
});

import { preserveHarnessPolicy } from "./checkpointState.js";
import { sourceHash } from "../references/receipts.js";
it("matches omitted-policy caller bytes to actual InMemory readback after accepted reply loss", async () => {
  const ledger = new InMemoryRunLedger(() => 1000),
    id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  expect(
    await ledger.claim({
      runId: id,
      threadKey: "mcp:fixture:policy",
      gen: "g1",
      startedAt: 1,
      leaseMs: 10000,
      system: "original",
      tools: [],
      meta: { channelId: "mcp:fixture", threadKey: "mcp:fixture:policy", userId: "slack:fixture" },
      state: { harness: facts, original: "retained" },
    }),
  ).toMatchObject({ ok: true });
  const before = await ledger.peekInbox(id, "g1", 0);
  if (!before.ok) throw new Error("owner missing");
  const { sessionPolicy: _, ...legacy } = facts;
  const expected = preserveHarnessPolicy(before.boundary.state as Record<string, unknown>, {
    ...(before.boundary.state as Record<string, unknown>),
    harness: { ...legacy, logOffset: 12 },
  })!;
  const expectedBefore = structuredClone(expected),
    wire = JSON.stringify({ runId: id, gen: "g1", state: expected });
  let writes = 0;
  const write = async () => {
    writes++;
    expect(await ledger.setState(id, "g1", expected)).toEqual({ ok: true });
    throw new Error("accepted reply lost");
  };
  await expect(write()).rejects.toThrow("accepted reply lost");
  const actual = await ledger.peekInbox(id, "g1", 0);
  if (!actual.ok) throw new Error("owner missing");
  expect(await sourceHash(actual.boundary.state)).toBe(await sourceHash(expected));
  expect(actual.boundary.state).toEqual(JSON.parse(wire).state);
  expect(expected).toEqual(expectedBefore);
  expect(writes).toBe(1);
});

it("never canonicalizes inherited policy fields or a marker absent from the wire", () => {
  const inherited = Object.assign(Object.create(policy), { a: 1, b: 2, c: 3 });
  expect(preserveHarnessPolicy({}, { harness: { ...facts, sessionPolicy: inherited } })).toBeUndefined();
  expect(preserveHarnessPolicy({ harness: { ...facts, sessionPolicy: inherited } }, {})).toBeUndefined();
  const frame = Object.create({ sessionPolicy: policy });
  Object.assign(frame, { harness: "pi", pid: 42, logOffset: 0 });
  const actual = preserveHarnessPolicy({}, { harness: frame });
  expect(JSON.parse(JSON.stringify(actual)).harness).not.toHaveProperty("sessionPolicy");
  expect(preserveHarnessPolicy({ harness: frame }, { harness: facts })).toBeUndefined();
});
