import { describe, expect, it } from "vitest";
import { MAX_RECORD_BYTES } from "../runRecord.js";
import { closeInboxSegment, encodeInboxSegment, inboxSegmentFloor } from "./inboxSegment.js";
import type { LiveRunRow, StepRecord } from "./types.js";

const row: LiveRunRow = {
  runId: "original",
  threadKey: "slack:C1:1.0",
  ownerGen: "g1",
  leaseUntil: 2_000,
  startedAt: 1_000,
  phase: "live",
  stop: null,
  meta: { channelId: "slack:C1", threadKey: "slack:C1:1.0", userId: "slack:UALICE", agent: "review" },
  card: null,
  system: "",
  tools: [],
  state: {},
};
const step: StepRecord = {
  step: 1,
  seq: 1,
  turnIndex: 1,
  inFlight: [],
  inboxConsumedSeq: 1,
  remainingMs: 1_000,
  turn: 1,
  iteration: 0,
};

describe("private inbox segment archive", () => {
  it("rejects the non-ASCII counterexample that fits character count but exceeds the existing byte ceiling", () => {
    const original = { ...step, padding: "雪".repeat(300_000) };
    const archive = closeInboxSegment(undefined, row, original, 1);
    const json = JSON.stringify(archive);
    expect(json.length).toBeLessThan(MAX_RECORD_BYTES);
    expect(new TextEncoder().encode(json).byteLength).toBeGreaterThan(MAX_RECORD_BYTES);
    expect(() => encodeInboxSegment(archive, MAX_RECORD_BYTES)).toThrow("byte limit");
    expect(inboxSegmentFloor(archive, row)).toBeUndefined();
    expect(original.padding).toHaveLength(300_000);
  });

  it("retains complete escaped first and latest boundaries while folding without history nesting", () => {
    const original = { ...step, padding: '\\雪"'.repeat(65_000) };
    const first = closeInboxSegment(undefined, row, original, 1);
    const nextRow = { ...row, ownerGen: "g2" };
    const latest = { ...step, step: 2, inboxConsumedSeq: 2 };
    const folded = closeInboxSegment(first, nextRow, latest, 2);
    const encoded = encodeInboxSegment(folded, MAX_RECORD_BYTES);
    const archive = JSON.parse(encoded);
    expect(archive.first.lastStep).toEqual(original);
    expect(archive.latest.lastStep).toEqual(latest);
    expect(archive).not.toHaveProperty("previous");
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(MAX_RECORD_BYTES);
    expect(inboxSegmentFloor(archive, { ...row, ownerGen: "g3" })).toBe(2);
    expect(inboxSegmentFloor(archive, { ...row, meta: { ...row.meta, userId: "foreign" } })).toBeUndefined();
  });
});
