import { describe, expect, it } from "vitest";
import { planRestart } from "./restart.js";
import { runBotRestart, type RestartRunnerDeps } from "./run.js";
import { TEST_PROFILE } from "./testing/profile.js";

// `deploy restart`'s runner (src/deploy/run.ts): POST the Worker's
// /admin/restart with the operator's bearer, wait out a 409 (runs in flight)
// with a heartbeat, then poll /healthz until a non-draining container reports a
// LATER startedAt than the one the old container had. Every I/O is injected:
// nothing here reaches the network or the clock.

const BEFORE = "2026-08-30T10:00:00.000Z";
const AFTER = "2026-08-30T10:00:41.000Z";
const plan = (force = false) => planRestart({ only: "bot", force, waitMaxMinutes: 2, pollSeconds: 30 }, TEST_PROFILE);

interface Scripted {
  /** Successive /healthz bodies (the last one repeats). */
  health: (string | undefined)[];
  /** Successive /admin/restart answers (the last one repeats). */
  restart: { status: number; body: string }[];
}

function harness(script: Scripted, env: Record<string, string> = { SWITCHBOARD_DEPLOY_TOKEN: "tok-deployer" }) {
  const calls: { method: string; url: string; auth?: string; body?: string }[] = [];
  const lines: string[] = [];
  let clock = 0;
  let healthIdx = 0;
  let restartIdx = 0;
  const next = <T>(arr: T[], i: number) => arr[Math.min(i, arr.length - 1)];
  const deps: RestartRunnerDeps = {
    env,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({
        method,
        url,
        auth: headers.authorization,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.endsWith("/healthz")) {
        const body = next(script.health, healthIdx++);
        return body === undefined
          ? new Response("<html>502</html>", { status: 502 })
          : new Response(body, { status: 200 });
      }
      const r = next(script.restart, restartIdx++);
      return new Response(r.body, { status: r.status });
    },
  };
  const io = { log: (l: string) => lines.push(l), warn: (l: string) => lines.push(`WARN ${l}`) };
  return { deps, io, calls, lines };
}

const healthz = (inFlight: number, startedAt: string, draining = false) =>
  JSON.stringify({ ok: true, inFlight, draining, startedAt, build: { commit: "abc1234" } });
const stopping = (previousStartedAt: string) => ({
  status: 202,
  body: JSON.stringify({ ok: true, stopping: true, forced: false, inFlight: 0, previousStartedAt }),
});
const refused = (n: number) => ({
  status: 409,
  body: JSON.stringify({ ok: false, refused: true, problems: [`${n} run(s) in flight — a restart would kill them`] }),
});

describe("runBotRestart", () => {
  it("refuses without the bearer in the env — nothing is posted", async () => {
    const h = harness({ health: [healthz(0, BEFORE)], restart: [stopping(BEFORE)] }, {});
    const r = await runBotRestart(plan(), h.io, h.deps);
    expect(r).toEqual({ kind: "refused", problems: [expect.stringContaining("SWITCHBOARD_DEPLOY_TOKEN is not set")] });
    expect(h.calls).toEqual([]);
  });

  it("happy path: POSTs with the bearer and {force:false}, then polls /healthz until a LATER startedAt answers; the old startedAt keeps it waiting", async () => {
    // Old container answers twice more after SIGTERM (draining, then still up), then restarts, then the new one.
    const h = harness({
      health: [healthz(0, BEFORE, true), healthz(0, BEFORE), undefined, healthz(0, AFTER)],
      restart: [stopping(BEFORE)],
    });
    const r = await runBotRestart(plan(), h.io, h.deps);
    expect(r).toMatchObject({ kind: "ran", ok: true, previousStartedAt: BEFORE, startedAt: AFTER });
    expect(h.calls[0]).toMatchObject({
      method: "POST",
      url: "https://switchboard.example.test/admin/restart",
      auth: "Bearer tok-deployer",
      body: '{"force":false}',
    });
    expect(h.calls.filter((c) => c.url.endsWith("/healthz"))).toHaveLength(4);
    expect(h.lines.filter((l) => /not live yet/.test(l))).toEqual([
      expect.stringContaining("old container still draining"),
      expect.stringContaining(`old container still answering (started ${BEFORE})`),
      expect.stringContaining("not answering with JSON"),
    ]);
    expect(h.lines.at(-1)).toMatch(/restarted — startedAt 2026-08-30T10:00:41.000Z \(was 2026-08-30T10:00:00.000Z\)/);
  });

  it("a 409 is waited out with a heartbeat and retried every poll; a later 202 proceeds", async () => {
    const h = harness({
      health: [healthz(2, BEFORE), healthz(1, BEFORE), healthz(0, AFTER)],
      restart: [refused(2), refused(1), stopping(BEFORE)],
    });
    const r = await runBotRestart(plan(), h.io, h.deps);
    expect(r).toMatchObject({ kind: "ran", ok: true, startedAt: AFTER });
    expect(h.calls.filter((c) => c.method === "POST")).toHaveLength(3);
    expect(h.lines.filter((l) => l.startsWith("[deploy:restart] bot: still waiting"))).toEqual([
      "[deploy:restart] bot: still waiting — 2 run(s) in flight (draining: no), waited 0m of 2m",
      "[deploy:restart] bot: still waiting — 1 run(s) in flight (draining: no), waited 0m of 2m",
    ]);
  });

  it("a 409 past the wait budget fails without ever stopping anything (exit non-zero), naming --force", async () => {
    const h = harness({ health: [healthz(2, BEFORE)], restart: [refused(2)] });
    const r = await runBotRestart(plan(), h.io, h.deps);
    expect(r).toMatchObject({
      kind: "ran",
      ok: false,
      reason: expect.stringMatching(/still refusing after 2 min.*--force/),
    });
    // 2 min budget / 30 s poll → the first attempt plus four retries at most.
    expect(h.calls.filter((c) => c.method === "POST").length).toBeLessThanOrEqual(5);
  });

  it("--force posts {force:true} once and never retries", async () => {
    const h = harness({
      health: [healthz(2, BEFORE), healthz(0, AFTER)],
      restart: [
        {
          status: 202,
          body: JSON.stringify({ ok: true, stopping: true, forced: true, inFlight: 2, previousStartedAt: BEFORE }),
        },
      ],
    });
    const r = await runBotRestart(plan(true), h.io, h.deps);
    expect(r).toMatchObject({ kind: "ran", ok: true });
    expect(h.calls.filter((c) => c.method === "POST")).toEqual([expect.objectContaining({ body: '{"force":true}' })]);
  });

  it("401/403 fails at once (no retry); any other error status fails with the status", async () => {
    const denied = harness({ health: [healthz(0, BEFORE)], restart: [{ status: 403, body: "forbidden" }] });
    expect(await runBotRestart(plan(), denied.io, denied.deps)).toMatchObject({
      kind: "ran",
      ok: false,
      reason: expect.stringContaining("HTTP 403"),
    });
    expect(denied.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const broken = harness({ health: [healthz(0, BEFORE)], restart: [{ status: 502, body: "bad gateway" }] });
    expect(await runBotRestart(plan(), broken.io, broken.deps)).toMatchObject({
      kind: "ran",
      ok: false,
      reason: expect.stringContaining("HTTP 502"),
    });
  });

  it("a container that was not running is reported as such — no gate to wait for, still ok", async () => {
    const h = harness({
      health: [healthz(0, AFTER)],
      restart: [{ status: 200, body: JSON.stringify({ ok: true, stopping: false, note: "container not running" }) }],
    });
    expect(await runBotRestart(plan(), h.io, h.deps)).toMatchObject({ kind: "ran", ok: true, startedAt: AFTER });
  });

  it("the gate times out past the live deadline with the last reason (never a false success)", async () => {
    const h = harness({ health: [healthz(0, BEFORE)], restart: [stopping(BEFORE)] });
    const r = await runBotRestart(plan(), h.io, h.deps);
    expect(r).toMatchObject({
      kind: "ran",
      ok: false,
      previousStartedAt: BEFORE,
      reason: expect.stringMatching(/old container still answering.*gave up after 20 min/),
    });
  });
});
