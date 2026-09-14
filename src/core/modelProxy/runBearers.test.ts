// Feature: docs/reference/specs/model-proxy.md — the run-scoped bearer: minted
// per run, bound to its id, expiring at its budget plus the margin, revoked
// when the run ends, verified in constant time.
import { describe, expect, it } from "vitest";
import { createTracer } from "../trace/tracer.js";
import type { RunEvent } from "../runEvents.js";
import { BEARER_MARGIN_MS, BEARER_PREFIX, RunBearerStore, type RunBearerGrant } from "./runBearers.js";

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
    expiresAt: now + 45 * 60_000 + BEARER_MARGIN_MS,
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

describe("RunBearerStore — expiry and revocation", () => {
  it("verifies up to the instant before expiry and refuses `expired` from the expiry on", () => {
    const h = harness();
    const expiresAt = START + 10 * 60_000 + BEARER_MARGIN_MS;
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
