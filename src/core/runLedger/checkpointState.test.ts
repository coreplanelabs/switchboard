import { describe, it, expect } from "vitest";
import { preserveCheckpointState } from "./checkpointState.js";
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
