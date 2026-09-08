import { describe, expect, it } from "vitest";
import { COLD_START_ALLOWANCE_MS, DRAIN_DEADLINE_MS, MIN_CATCH_UP_WINDOW_MS } from "../core/drain.js";
import {
  decideLive,
  decideRestarted,
  heartbeatLine,
  LIVE_GATE_DEADLINE_MS,
  parseHealthz,
  sameCommit,
} from "./liveGate.js";

// docs/reference/specs/slack-channel.md item 8 — deployed ≠ live: `deploy:all` exits 0 for
// the bot only once `/healthz` is answered by the NEW container (not draining,
// `build.commit` == the deployed commit). Without the gate the script says
// `deployed` while the old container is still draining runs
// (docs/decisions/0015-deploy-order-deployed-is-not-live.md).

const HEAD = "e6af1aa0b7c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9";
const live = (commit = HEAD) => ({
  ok: true,
  inFlight: 0,
  draining: false,
  build: { commit, builtAt: "2026-08-30T05:00:00.000Z" },
});

describe("parseHealthz", () => {
  it("parses a JSON object body; anything else is undefined", () => {
    expect(parseHealthz(JSON.stringify(live()))).toMatchObject({ draining: false });
    expect(parseHealthz("ok")).toBeUndefined();
    expect(parseHealthz("")).toBeUndefined();
    expect(parseHealthz("[1]")).toBeUndefined();
    expect(parseHealthz("<html>502</html>")).toBeUndefined();
  });
});

describe("decideLive", () => {
  it("live: not draining and the served build is the deployed commit (full or short form)", () => {
    expect(decideLive(live(), HEAD, 0)).toEqual({ kind: "live", commit: HEAD });
    expect(decideLive(live(HEAD.slice(0, 7)), HEAD, 0)).toEqual({ kind: "live", commit: HEAD.slice(0, 7) });
    expect(decideLive(live(), HEAD.slice(0, 12), 0)).toEqual({ kind: "live", commit: HEAD });
  });

  it("waiting while the old container drains — names the in-flight count and since when", () => {
    const d = decideLive(
      { ok: true, inFlight: 2, draining: true, drainStartedAt: "2026-08-30T05:05:39.817Z" },
      HEAD,
      60_000,
    );
    expect(d).toEqual({
      kind: "waiting",
      reason: "old container still draining — 2 run(s) in flight since 2026-08-30T05:05:39.817Z",
    });
  });

  it("a draining container that serves the deployed commit is live only when its startedAt is later than the pre-upload reading — a same-commit rollout drains an old container that serves the commit too (run-history item 39; review F2)", () => {
    const draining = (startedAt?: string) => ({
      ok: true,
      inFlight: 1,
      draining: true,
      build: { commit: HEAD },
      ...(startedAt ? { startedAt } : {}),
    });
    const before = "2026-08-30T10:00:00.000Z";
    const after = "2026-08-30T10:05:00.000Z";
    // Provably the new container: it started after the reading taken before the upload.
    expect(decideLive(draining(after), HEAD, 0, LIVE_GATE_DEADLINE_MS, { previousStartedAt: before })).toEqual({
      kind: "live",
      commit: HEAD,
    });
    // The same commit, the same start: the old container, draining under a same-commit rollout.
    expect(decideLive(draining(before), HEAD, 0, LIVE_GATE_DEADLINE_MS, { previousStartedAt: before })).toEqual({
      kind: "waiting",
      reason: `the deployed commit answers but is draining (started ${before}) — a same-commit rollout replaces it; waiting for the new container`,
    });
    // No pre-upload reading, or a container without startedAt: a draining same-commit body waits.
    expect(decideLive(draining(after), HEAD, 0).kind).toBe("waiting");
    expect(decideLive(draining(), HEAD, 0, LIVE_GATE_DEADLINE_MS, { previousStartedAt: before })).toEqual({
      kind: "waiting",
      reason:
        "the deployed commit answers but is draining — a same-commit rollout replaces it; waiting for the new container",
    });
    // Not draining: the commit alone proves it, as before.
    expect(decideLive({ ...draining(before), draining: false }, HEAD, 0).kind).toBe("live");
  });

  it("waiting while an OLD commit answers (not draining yet, rollout not started) — names both commits", () => {
    const d = decideLive(live("610682f7abcdef0123456789"), HEAD, 0);
    expect(d).toEqual({
      kind: "waiting",
      reason: `serving commit 610682f, expected ${HEAD.slice(0, 7)} (old container still up)`,
    });
  });

  it("waiting when /healthz is not JSON (container restarting) or has no build identity (pre-gate container)", () => {
    expect(decideLive(undefined, HEAD, 0)).toMatchObject({
      kind: "waiting",
      reason: expect.stringContaining("not answering with JSON"),
    });
    expect(decideLive({ ok: true, inFlight: 0, draining: false }, HEAD, 0)).toMatchObject({
      kind: "waiting",
      reason: expect.stringContaining("no build identity"),
    });
    expect(decideLive(live("unknown"), HEAD, 0)).toMatchObject({
      kind: "waiting",
      reason: expect.stringContaining('"unknown"'),
    });
  });

  it("a dirty build never counts as live, even on the same commit", () => {
    expect(decideLive(live(`${HEAD}-dirty`), HEAD, 0).kind).toBe("waiting");
    expect(sameCommit(`${HEAD}-dirty`, HEAD)).toBe(false);
    expect(sameCommit("abc", "abc")).toBe(false); // too short to identify a commit
  });

  it("the same reason becomes a timeout once the deadline is reached; the deadline covers the full drain plus a cold start", () => {
    const draining = { ok: true, inFlight: 1, draining: true };
    expect(decideLive(draining, HEAD, LIVE_GATE_DEADLINE_MS - 1).kind).toBe("waiting");
    expect(decideLive(draining, HEAD, LIVE_GATE_DEADLINE_MS)).toEqual({
      kind: "timeout",
      reason: "old container still draining — 1 run(s) in flight",
    });
    // Same cold-start allowance as the reconnect catch-up (item 7): the gate never gives up on a container the catch-up still expects.
    expect(LIVE_GATE_DEADLINE_MS).toBe(DRAIN_DEADLINE_MS + COLD_START_ALLOWANCE_MS);
    expect(LIVE_GATE_DEADLINE_MS).toBe(MIN_CATCH_UP_WINDOW_MS);
    // A live answer is live regardless of elapsed time.
    expect(decideLive(live(), HEAD, LIVE_GATE_DEADLINE_MS * 2).kind).toBe("live");
  });
});

// `deploy restart` (item 8): the image is unchanged, so `build.commit` cannot
// tell the restarted container from the old one — `startedAt` (process start)
// does. Live only once a non-draining container reports a startedAt that is
// LATER than the one the operator saw before asking for the restart.
describe("decideRestarted", () => {
  const before = "2026-08-30T10:00:00.000Z";
  const after = "2026-08-30T10:00:41.000Z";
  const at = (startedAt?: string, extra: Record<string, unknown> = {}) => ({
    ok: true,
    inFlight: 0,
    draining: false,
    ...(startedAt ? { startedAt } : {}),
    ...extra,
  });

  it("live once startedAt is later than the previous one", () => {
    expect(decideRestarted(at(after), before, 0)).toEqual({ kind: "live", startedAt: after });
  });

  it("keeps waiting while the OLD startedAt (or an earlier one) is still answering — the same commit is no evidence", () => {
    expect(decideRestarted(at(before, { build: { commit: "abc1234" } }), before, 0)).toEqual({
      kind: "waiting",
      reason: `old container still answering (started ${before})`,
    });
    expect(decideRestarted(at("2026-08-30T09:00:00.000Z"), before, 0).kind).toBe("waiting");
  });

  it("waiting while draining, while not JSON, or while a container without startedAt (predates deploy restart) answers", () => {
    expect(
      decideRestarted({ ok: true, inFlight: 1, draining: true, drainStartedAt: before, startedAt: before }, before, 0),
    ).toEqual({ kind: "waiting", reason: `old container still draining — 1 run(s) in flight since ${before}` });
    expect(decideRestarted(undefined, before, 0)).toEqual({
      kind: "waiting",
      reason: "/healthz not answering with JSON (container restarting, or unreachable)",
    });
    expect(decideRestarted(at(), before, 0)).toEqual({
      kind: "waiting",
      reason: "/healthz carries no startedAt — a container that predates `deploy restart` is answering",
    });
    expect(decideRestarted(at("not a date"), before, 0).kind).toBe("waiting");
  });

  it("a draining container with a LATER startedAt is restarted — the restart landed and a further stop is draining it (run-history item 39)", () => {
    expect(decideRestarted(at(after, { draining: true, inFlight: 1 }), before, 0)).toEqual({
      kind: "live",
      startedAt: after,
    });
  });

  it("when the previous startedAt is unknown (old container predated it), any non-draining startedAt counts as restarted", () => {
    expect(decideRestarted(at(after), undefined, 0)).toEqual({ kind: "live", startedAt: after });
    expect(decideRestarted(at(), undefined, 0).kind).toBe("waiting");
  });

  it("the same reason becomes a timeout at the live-gate deadline; live is live regardless of elapsed", () => {
    expect(decideRestarted(at(before), before, LIVE_GATE_DEADLINE_MS - 1).kind).toBe("waiting");
    expect(decideRestarted(at(before), before, LIVE_GATE_DEADLINE_MS)).toEqual({
      kind: "timeout",
      reason: `old container still answering (started ${before})`,
    });
    expect(decideRestarted(at(after), before, LIVE_GATE_DEADLINE_MS * 2).kind).toBe("live");
  });
});

describe("heartbeatLine", () => {
  it("is tagged for the command that waits (deploy:all by default, deploy:restart when asked)", () => {
    expect(heartbeatLine("bot", { inFlight: 1, draining: false }, 0, 60_000, "deploy:restart")).toBe(
      "[deploy:restart] bot: still waiting — 1 run(s) in flight (draining: no), waited 0m of 1m",
    );
  });

  it("says how many runs are in flight, whether draining, and how long we have waited of the budget", () => {
    expect(heartbeatLine("bot", { inFlight: 2, draining: false }, 3 * 60_000 + 5_000, 30 * 60_000)).toBe(
      "[deploy:all] bot: still waiting — 2 run(s) in flight (draining: no), waited 3m of 30m",
    );
    expect(heartbeatLine("bot", { inFlight: 1, draining: true }, 0, 30 * 60_000)).toContain(
      "(draining: yes), waited 0m of 30m",
    );
    expect(heartbeatLine("bot", undefined, 120_000, 30 * 60_000)).toBe(
      "[deploy:all] bot: still waiting — /healthz not answering, waited 2m of 30m",
    );
  });
});
