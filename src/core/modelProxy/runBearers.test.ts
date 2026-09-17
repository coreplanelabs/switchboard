// Feature: docs/reference/specs/model-proxy.md — the run-scoped bearer: minted
// per run, bound to its id, expiring at its budget plus the margin, revoked
// when the run ends, verified in constant time.
import { describe, expect, it } from "vitest";
import { createTracer } from "../trace/tracer.js";
import type { RunEvent } from "../runEvents.js";
import { bearerExpiresAt, MINUTE_MS, provisionalBearerExpiresAt } from "../budgets.js";
import { BEARER_PREFIX, bearerHashOf, RunBearerStore, type RunBearerGrant } from "./runBearers.js";

const START = 1_700_000_000_000;

function harness(now = START) {
  const clock = { now };
  const store = new RunBearerStore({ clock: () => clock.now });
  const published: RunEvent[] = [];
  const span = createTracer({ clock: () => clock.now }).start("request", { sinks: [] });
  const grant = (runId: string, over: Partial<RunBearerGrant> = {}): RunBearerGrant => ({
    runId,
    modelRef: "anthropic/claude-opus-5",
    providerName: "anthropic",
    providerType: "anthropic",
    model: "claude-opus-5",
    maxTokens: 64000,
    maxTurns: 3,
    expiresAt: provisionalBearerExpiresAt(now, 45),
    span,
    publish: (e) => void published.push(e),
    ...over,
  });
  return { clock, store, grant, published };
}

describe("RunBearerStore — mint and verify", () => {
  it("mints a bearer that names its run and verifies back to the grant with zero turns used", () => {
    const h = harness();
    const token = h.store.mint(h.grant("run-1"));
    expect(token.startsWith(`${BEARER_PREFIX}run-1.`)).toBe(true);
    const verdict = h.store.verify(token);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("expected ok");
    expect(verdict.grant.runId).toBe("run-1");
    expect(verdict.grant.model).toBe("claude-opus-5");
    expect(verdict.turns).toBe(0);
  });

  it("two mints never collide: the secret is random and each bearer verifies only for its own run", () => {
    const h = harness();
    const a = h.store.mint(h.grant("run-a"));
    const b = h.store.mint(h.grant("run-b"));
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
    const forged = `${BEARER_PREFIX}run-a.${b.split(".")[1]}`; // run-b's secret presented for run-a
    expect(h.store.verify(forged)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-a" });
  });

  it("refuses a malformed token, an unknown run, a wrong secret, and never throws on garbage", () => {
    const h = harness();
    h.store.mint(h.grant("run-1"));
    expect(h.store.verify("")).toEqual({ ok: false, reason: "malformed" });
    expect(h.store.verify("Bearer nope")).toEqual({ ok: false, reason: "malformed" });
    expect(h.store.verify(`${BEARER_PREFIX}run-1`)).toEqual({ ok: false, reason: "malformed" });
    expect(h.store.verify(`${BEARER_PREFIX}run-1.`)).toEqual({ ok: false, reason: "malformed" });
    expect(h.store.verify(`${BEARER_PREFIX}.secret`)).toEqual({ ok: false, reason: "malformed" });
    expect(h.store.verify(`${BEARER_PREFIX}run-9.abcdef`)).toEqual({
      ok: false,
      reason: "unknown_run",
      runId: "run-9",
    });
    expect(h.store.verify(`${BEARER_PREFIX}run-1.abcdef`)).toEqual({
      ok: false,
      reason: "unknown_bearer",
      runId: "run-1",
    });
  });

  it("a second mint for the same run replaces the first: the old bearer is unknown, the new one verifies", () => {
    const h = harness();
    const first = h.store.mint(h.grant("run-1"));
    const second = h.store.mint(h.grant("run-1", { model: "claude-sonnet-5" }));
    expect(h.store.verify(first)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-1" });
    const verdict = h.store.verify(second);
    expect(verdict.ok && verdict.grant.model).toBe("claude-sonnet-5");
  });
});

describe("RunBearerStore — the loop's end and a turn's tools, marked by the harness for the proxy (model-proxy item 6)", () => {
  it("marks the loop's end once and reads it back; a turn marked with tools narrows the next requests to them, a turn marked without tools leaves them open, and clearing the turn returns to the loop-ended state", () => {
    const h = harness();
    h.store.mint(h.grant("run-1"));
    expect(h.store.marksOf("run-1")).toEqual({ loopEnded: false });
    expect(h.store.markLoopEnded("run-1")).toBe(true);
    expect(h.store.marksOf("run-1")).toEqual({ loopEnded: true });
    expect(h.store.markTurn("run-1", ["submit_pr_description", "bash"])).toBe(true);
    expect(h.store.marksOf("run-1")).toEqual({ loopEnded: true, turn: { tools: ["submit_pr_description", "bash"] } });
    expect(h.store.clearTurn("run-1")).toBe(true);
    expect(h.store.marksOf("run-1")).toEqual({ loopEnded: true });
    expect(h.store.markTurn("run-1")).toBe(true);
    expect(h.store.marksOf("run-1")).toEqual({ loopEnded: true, turn: { tools: null } });
  });
  it("the marks survive a rotation and an adopt (the same entry), and a run this store never minted or one that ended takes none", () => {
    const h = harness();
    h.store.mint(h.grant("run-1"));
    h.store.markLoopEnded("run-1");
    const rotated = h.store.rotate("run-1", () => {});
    expect(rotated.ok).toBe(true);
    expect(h.store.adopt("run-1", "ab".repeat(32))).toBe(true);
    expect(h.store.marksOf("run-1")).toEqual({ loopEnded: true });
    expect(h.store.markLoopEnded("run-9")).toBe(false);
    expect(h.store.marksOf("run-9")).toBeUndefined();
    h.store.revoke("run-1");
    expect(h.store.markLoopEnded("run-1")).toBe(false);
    expect(h.store.markTurn("run-1", [])).toBe(false);
  });
});

describe("RunBearerStore — expiry and revocation", () => {
  it("the lease's start resets the expiry to the lease's end plus the grace: the mint's provisional expiry is replaced, `issue` and `rotate` hand out the new one, and a run this store never minted or one that ended takes no lease", () => {
    const h = harness();
    const token = h.store.mint(h.grant("run-1"));
    const leaseEndsAt = START + 30 * MINUTE_MS;
    expect(h.store.leaseStarted("run-1", leaseEndsAt)).toBe(true);
    expect(h.store.grantOf("run-1")?.expiresAt).toBe(bearerExpiresAt(leaseEndsAt));
    expect(h.store.issue("run-1")?.expiresAt).toBe(bearerExpiresAt(leaseEndsAt));
    h.clock.now = bearerExpiresAt(leaseEndsAt) - 1;
    expect(h.store.verify(token).ok).toBe(true);
    h.clock.now = bearerExpiresAt(leaseEndsAt);
    expect(h.store.verify(token)).toEqual({ ok: false, reason: "expired", runId: "run-1" });
    expect(h.store.leaseStarted("run-9", leaseEndsAt)).toBe(false);
    h.store.revoke("run-1");
    expect(h.store.leaseStarted("run-1", leaseEndsAt + MINUTE_MS)).toBe(false);
  });
  it("verifies up to the instant before expiry and refuses `expired` from the expiry on", () => {
    const h = harness();
    const expiresAt = provisionalBearerExpiresAt(START, 10);
    const token = h.store.mint(h.grant("run-1", { expiresAt }));
    h.clock.now = expiresAt - 1;
    expect(h.store.verify(token).ok).toBe(true);
    h.clock.now = expiresAt;
    expect(h.store.verify(token)).toEqual({ ok: false, reason: "expired", runId: "run-1" });
  });

  it("revoke ends every bearer of the run: a call after the run's end is `revoked`, not unknown; a second revoke is a no-op", () => {
    const h = harness();
    const token = h.store.mint(h.grant("run-1"));
    const extra = h.store.issue("run-1")!.token;
    expect(h.store.revoke("run-1")).toBe(true);
    expect(h.store.verify(token)).toEqual({ ok: false, reason: "revoked", runId: "run-1" });
    expect(h.store.verify(extra)).toEqual({ ok: false, reason: "revoked", runId: "run-1" });
    expect(h.store.revoke("run-1")).toBe(false);
    expect(h.store.revoke("never-minted")).toBe(false);
  });

  it("a revoked run's entry is swept once its expiry passes, after which the bearer is an unknown run", () => {
    const h = harness();
    const expiresAt = START + 60_000;
    const token = h.store.mint(h.grant("run-1", { expiresAt }));
    h.store.revoke("run-1");
    expect(h.store.size()).toBe(1);
    h.clock.now = expiresAt + 1;
    expect(h.store.sweep()).toBe(1);
    expect(h.store.size()).toBe(0);
    expect(h.store.verify(token)).toEqual({ ok: false, reason: "unknown_run", runId: "run-1" });
  });

  it("the sweep runs on every mint, so a store never grows past the runs still inside their expiry", () => {
    const h = harness();
    h.store.mint(h.grant("old", { expiresAt: START + 1000 }));
    h.clock.now = START + 2000;
    h.store.mint(h.grant("new"));
    expect(h.store.size()).toBe(1);
    expect(h.store.grantOf("old")).toBeUndefined();
  });
});

describe("RunBearerStore — turns and the operator's extra bearer", () => {
  it("reparent hangs the run's proxied turns under another span from here on — the harness's run.agent — and answers nothing for an unknown or ended run", () => {
    const h = harness();
    h.store.mint(h.grant("run-1"));
    const agentSpan = createTracer({ clock: () => h.clock.now })
      .start("request", { sinks: [] })
      .start("run.agent");
    expect(h.store.reparent("run-1", agentSpan)).toBe(true);
    const verdict = h.store.verify(h.store.issue("run-1")!.token);
    expect(verdict.ok && verdict.grant.span.id).toBe(agentSpan.id);
    expect(h.store.grantOf("run-1")).toMatchObject({ runId: "run-1", modelRef: "anthropic/claude-opus-5" });
    expect(h.store.reparent("run-9", agentSpan)).toBe(false);
    h.store.revoke("run-1");
    expect(h.store.reparent("run-1", agentSpan)).toBe(false);
  });

  it("consumeTurn counts up to maxTurns and refuses the call past it, naming the counts", () => {
    const h = harness();
    h.store.mint(h.grant("run-1", { maxTurns: 2 }));
    expect(h.store.consumeTurn("run-1")).toEqual({ ok: true, turn: 1 });
    expect(h.store.consumeTurn("run-1")).toEqual({ ok: true, turn: 2 });
    expect(h.store.consumeTurn("run-1")).toEqual({ ok: false, reason: "budget", turns: 2, maxTurns: 2 });
    expect(h.store.consumeTurn("run-1")).toEqual({ ok: false, reason: "budget", turns: 2, maxTurns: 2 }); // never past the cap
    expect(h.store.verify(h.store.issue("run-1")!.token)).toMatchObject({ ok: true, turns: 2 });
  });

  it("consumeTurn on an unknown or revoked run is refused as `ended`, never as a zero-turn budget", () => {
    const h = harness();
    expect(h.store.consumeTurn("nope")).toEqual({ ok: false, reason: "ended" });
    h.store.mint(h.grant("run-1"));
    h.store.revoke("run-1");
    expect(h.store.consumeTurn("run-1")).toEqual({ ok: false, reason: "ended" });
  });

  it("issue mints another bearer for a live run's entry — same expiry, same turn counter — and nothing for an unknown, revoked or expired run", () => {
    const h = harness();
    const expiresAt = START + 30 * 60_000;
    h.store.mint(h.grant("run-1", { expiresAt }));
    const issued = h.store.issue("run-1");
    expect(issued?.expiresAt).toBe(expiresAt);
    expect(issued?.token.startsWith(`${BEARER_PREFIX}run-1.`)).toBe(true);
    h.store.consumeTurn("run-1");
    expect(h.store.verify(issued!.token)).toMatchObject({ ok: true, turns: 1 });
    expect(h.store.issue("nope")).toBeUndefined();
    h.store.revoke("run-1");
    expect(h.store.issue("run-1")).toBeUndefined();
    const h2 = harness();
    h2.store.mint(h2.grant("run-2", { expiresAt: START + 1000 }));
    h2.clock.now = START + 1000;
    expect(h2.store.issue("run-2")).toBeUndefined();
  });

  it("grantOf reads a run's grant with its turns and revocation, never its secrets", () => {
    const h = harness();
    h.store.mint(h.grant("run-1"));
    h.store.consumeTurn("run-1");
    const read = h.store.grantOf("run-1");
    expect(read).toMatchObject({ runId: "run-1", turns: 1, revoked: false, maxTurns: 3 });
    expect(JSON.stringify(read)).not.toMatch(/secret/);
    h.store.revoke("run-1");
    expect(h.store.grantOf("run-1")).toMatchObject({ revoked: true });
  });
});

describe("RunBearerStore — a bearer across generations (docs/reference/specs/harness-pi.md item 8)", () => {
  it("bearerHashOf names a token's secret without being one: 64 hex chars, different per token, nothing for a malformed token", () => {
    const h = harness();
    const a = h.store.mint(h.grant("run-a"));
    const b = h.store.mint(h.grant("run-b"));
    expect(bearerHashOf(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(bearerHashOf(a)).not.toBe(bearerHashOf(b));
    expect(bearerHashOf("Bearer nope")).toBeUndefined();
    expect(bearerHashOf(`${BEARER_PREFIX}run-a`)).toBeUndefined();
  });

  it("adopt lets the bearer a previous generation minted verify on this one beside this generation's own, under this generation's grant and turns; the hash itself buys nothing", () => {
    const previous = harness();
    const theirs = previous.store.mint(previous.grant("run-1"));
    const next = harness();
    const ours = next.store.mint(next.grant("run-1", { maxTurns: 5 }));
    expect(next.store.verify(theirs)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-1" });
    expect(next.store.adopt("run-1", bearerHashOf(theirs)!)).toBe(true);
    const adopted = next.store.verify(theirs);
    expect(adopted.ok).toBe(true);
    if (!adopted.ok) throw new Error("expected ok");
    expect(adopted.grant.maxTurns).toBe(5);
    expect(adopted.turns).toBe(0);
    expect(next.store.verify(ours).ok).toBe(true);
    const hashAsSecret = `${BEARER_PREFIX}run-1.${Buffer.from(bearerHashOf(theirs)!, "hex").toString("base64url")}`;
    expect(next.store.verify(hashAsSecret)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-1" });
    expect(next.store.grantOf("run-1")).not.toHaveProperty("hashes");
  });

  it("adopt refuses a run this store never minted, a run past its expiry, a run that ended, and a hash of another shape, and changes nothing", () => {
    const previous = harness();
    const theirs = previous.store.mint(previous.grant("run-1"));
    const hash = bearerHashOf(theirs)!;
    const next = harness();
    expect(next.store.adopt("run-1", hash)).toBe(false);
    expect(next.store.verify(theirs)).toEqual({ ok: false, reason: "unknown_run", runId: "run-1" });
    next.store.mint(next.grant("run-1"));
    expect(next.store.adopt("run-1", "not-a-hash")).toBe(false);
    expect(next.store.adopt("run-1", hash.slice(0, 63))).toBe(false);
    expect(next.store.verify(theirs)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-1" });
    // Past the grant's expiry nothing is adopted (as `issue` mints nothing); back before it, the same hash would be.
    next.clock.now = provisionalBearerExpiresAt(START, 45);
    expect(next.store.adopt("run-1", hash)).toBe(false);
    next.clock.now = START;
    expect(next.store.verify(theirs)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-1" });
    next.store.revoke("run-1");
    expect(next.store.adopt("run-1", hash)).toBe(false);
    expect(next.store.verify(theirs)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-1" });
  });
});

// Feature: docs/reference/specs/model-proxy.md item 2 — the rotation a relaunch
// asks for: a new secret for the same run on the same grant, its hash handed
// to the row before the old secrets stop verifying, the meter untouched.
describe("RunBearerStore — rotate: a relaunch's new bearer on the run's own meter", () => {
  it("rotate mints a new bearer for the run and drops the old: the old answers unknown_bearer, the new verifies to the same grant with the same turns, expiry and span, and the row's hash is the new secret's", () => {
    const h = harness();
    const old = h.store.mint(h.grant("run-1", { maxTurns: 5 }));
    const adopted = harness().store.mint(harness().grant("run-1"));
    expect(h.store.adopt("run-1", bearerHashOf(adopted)!)).toBe(true);
    expect(h.store.consumeTurn("run-1")).toEqual({ ok: true, turn: 1 });
    expect(h.store.consumeTurn("run-1")).toEqual({ ok: true, turn: 2 });
    const agentSpan = h.grant("run-1").span.start("run.agent");
    expect(h.store.reparent("run-1", agentSpan)).toBe(true);
    const before = h.store.grantOf("run-1")!;
    const recorded: string[] = [];
    const rotated = h.store.rotate("run-1", (secretHash) => void recorded.push(secretHash));
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error("expected ok");
    expect(rotated.token.startsWith(`${BEARER_PREFIX}run-1.`)).toBe(true);
    expect(rotated.token).not.toBe(old);
    expect(rotated.expiresAt).toBe(before.expiresAt);
    // The row was handed exactly the new secret's hash, once.
    expect(recorded).toEqual([bearerHashOf(rotated.token)]);
    // Every earlier secret — the mint's and the adopted one — stops buying calls; the new one buys them under the unchanged meter.
    expect(h.store.verify(old)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-1" });
    expect(h.store.verify(adopted)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-1" });
    const verdict = h.store.verify(rotated.token);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("expected ok");
    expect(verdict.turns).toBe(2);
    expect(verdict.grant.maxTurns).toBe(5);
    expect(verdict.grant.expiresAt).toBe(before.expiresAt);
    expect(verdict.grant.span).toBe(agentSpan);
    expect(h.store.spanOf("run-1")).toBe(agentSpan);
    expect(h.store.grantOf("run-1")).toEqual({ ...before, bearers: 1 });
    expect(h.store.consumeTurn("run-1")).toEqual({ ok: true, turn: 3 });
  });

  it("rotate refuses by name a run this store never minted, one that ended and one past its expiry, hands the row nothing, and changes nothing", () => {
    const h = harness();
    const recorded: string[] = [];
    const record = (secretHash: string) => void recorded.push(secretHash);
    expect(h.store.rotate("run-1", record)).toEqual({ ok: false, reason: "unknown_run" });
    const token = h.store.mint(h.grant("run-1"));
    h.clock.now = provisionalBearerExpiresAt(START, 45);
    expect(h.store.rotate("run-1", record)).toEqual({ ok: false, reason: "expired" });
    h.clock.now = START;
    expect(h.store.verify(token).ok).toBe(true);
    h.store.revoke("run-1");
    expect(h.store.rotate("run-1", record)).toEqual({ ok: false, reason: "revoked" });
    expect(h.store.verify(token)).toEqual({ ok: false, reason: "revoked", runId: "run-1" });
    expect(recorded).toEqual([]);
  });

  it("the order is for a bot death: the new hash is stored and handed to the row BEFORE the old secrets are dropped, so a row write that fails leaves both buying calls — never neither — and the old still verifies", () => {
    const h = harness();
    const old = h.store.mint(h.grant("run-1"));
    expect(h.store.consumeTurn("run-1")).toEqual({ ok: true, turn: 1 });
    const recorded: string[] = [];
    expect(() =>
      h.store.rotate("run-1", (secretHash) => {
        recorded.push(secretHash);
        throw new Error("the ledger is unreachable");
      }),
    ).toThrow("the ledger is unreachable");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded[0]).not.toBe(bearerHashOf(old));
    // The old bearer still buys calls: the drop never ran. The new secret is
    // in the store beside it — two bearers on the run, not one and not none.
    expect(h.store.verify(old)).toMatchObject({ ok: true, turns: 1 });
    expect(h.store.grantOf("run-1")).toMatchObject({ turns: 1, bearers: 2, revoked: false });
    // A rotation that completes afterwards leaves the one bearer it minted.
    const again = h.store.rotate("run-1", () => {});
    expect(again.ok).toBe(true);
    expect(h.store.verify(old)).toEqual({ ok: false, reason: "unknown_bearer", runId: "run-1" });
    expect(h.store.grantOf("run-1")).toMatchObject({ turns: 1, bearers: 1 });
  });

  it("grantOf counts the secrets that buy the run's calls: one from the mint, one more per issue and adopt, one after a rotate", () => {
    const h = harness();
    h.store.mint(h.grant("run-1"));
    expect(h.store.grantOf("run-1")?.bearers).toBe(1);
    expect(h.store.issue("run-1")).toBeDefined();
    expect(h.store.grantOf("run-1")?.bearers).toBe(2);
    expect(h.store.adopt("run-1", bearerHashOf(harness().store.mint(harness().grant("run-1")))!)).toBe(true);
    expect(h.store.grantOf("run-1")?.bearers).toBe(3);
    expect(h.store.rotate("run-1", () => {}).ok).toBe(true);
    expect(h.store.grantOf("run-1")?.bearers).toBe(1);
  });
});
