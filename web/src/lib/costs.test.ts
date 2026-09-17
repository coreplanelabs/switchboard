import { describe, expect, it } from "vitest";
import type { CostsSnapshotStatus } from "@core/core/costsSnapshot.js";
import { parseStatusFrame, snapshotLineOf } from "./costs";

// costs.md item 6 — the one line the page shows about its snapshot.

const NOW = Date.parse("2026-09-16T09:15:00Z");
const status = (over: Partial<CostsSnapshotStatus> = {}): CostsSnapshotStatus => ({
  snapshot: { takenAt: "2026-09-16T06:15:00Z", takenBy: "schedule", durationMs: 31_000 },
  inFlight: null,
  everyHours: 24,
  nextAt: "2026-09-17T06:15:00Z",
  lastFailure: null,
  ...over,
});

describe("parseStatusFrame", () => {
  it("reads a status frame off the feed and ignores anything else on the wire", () => {
    expect(parseStatusFrame(JSON.stringify({ type: "status", ...status() }))).toEqual(status());
    expect(parseStatusFrame(JSON.stringify({ type: "hb" }))).toBeNull();
    expect(parseStatusFrame(JSON.stringify({ type: "status" }))).toBeNull();
    expect(parseStatusFrame("not json")).toBeNull();
    expect(parseStatusFrame("null")).toBeNull();
  });
});

describe("snapshotLineOf", () => {
  it("names when the snapshot was taken, how long ago, that the loop took it, and when the next is due", () => {
    expect(snapshotLineOf(status(), NOW)).toBe(
      "Snapshot from Sep 16, 06:15 UTC, 3 hours ago on schedule · next in 21 hours",
    );
  });

  it("an overdue next take reads as overdue — due now for its first minute, then due n minutes ago — never as forever imminent", () => {
    expect(snapshotLineOf(status({ nextAt: "2026-09-16T09:14:30Z" }), NOW)).toContain("· next due now");
    expect(snapshotLineOf(status({ nextAt: "2026-09-16T09:00:00Z" }), NOW)).toContain("· next due 15 minutes ago");
  });

  it("credits a person's take by name", () => {
    const s = status({ snapshot: { takenAt: "2026-09-16T09:10:00Z", takenBy: "casey", durationMs: 4_000 } });
    expect(snapshotLineOf(s, NOW)).toContain("Snapshot from Sep 16, 09:10 UTC, 5 minutes ago by casey");
  });

  it("while a take is in flight says so, who started it and when, and which snapshot is shown meanwhile", () => {
    const s = status({ inFlight: { startedAt: "2026-09-16T09:14:30Z", by: "casey" } });
    expect(snapshotLineOf(s, NOW)).toBe(
      "Taking a snapshot now — started just now by casey · showing the one from Sep 16, 06:15 UTC meanwhile",
    );
    const first = status({
      snapshot: null,
      nextAt: null,
      inFlight: { startedAt: "2026-09-16T09:13:00Z", by: "schedule" },
    });
    expect(snapshotLineOf(first, NOW)).toBe("Taking a snapshot now — started 2 minutes ago on schedule");
  });

  it("before the first snapshot says none has landed and when one is taken; a failed last attempt is named until one succeeds", () => {
    expect(snapshotLineOf(status({ snapshot: null, nextAt: null }), NOW)).toBe(
      "No snapshot yet — the first one is taken within a minute of startup",
    );
    const failed = status({
      lastFailure: { at: "2026-09-16T09:00:00Z", by: "casey", message: "cloudflare graphql 502" },
    });
    expect(snapshotLineOf(failed, NOW)).toContain("· last attempt 15 minutes ago failed: cloudflare graphql 502");
  });
});
