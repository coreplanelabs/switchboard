import { describe, expect, it } from "vitest";
import { LIVE_GATE_DEADLINE_MS } from "./liveGate.js";
import {
  authorizeRestart,
  constantTimeEqual,
  lookupConstantTime,
  BOT_ADMIN_RESTART_URL,
  classifyRestartResponse,
  decideRestart,
  formatRestartPlan,
  parseRestartRequest,
  planRestart,
  RESTART_SCOPE,
  RESTART_TOKEN_ENV,
  restartResponse,
} from "./restart.js";

// features/slack-channel.md item 8 — `deploy restart`: a rotated bot secret goes
// live by restarting the container WITHOUT an image build. `wrangler secret put`
// updates the Worker's env but a running container keeps the env it started
// with, so the Worker's `POST /admin/restart` asks the Container DO to `stop()`
// (SIGTERM → the bot's drain) and the next request starts it again with the
// current env. Same refusal rules as the deploy preflight: never on top of a
// run in flight or an instance already draining, unless forced.

const idle = { ok: true, inFlight: 0, draining: false, startedAt: "2026-08-30T10:00:00.000Z" };

describe("decideRestart", () => {
  it("idle bot → allow, not forced", () => {
    expect(decideRestart(idle, { force: false })).toMatchObject({ allow: true, forced: false, problems: [] });
  });

  it("runs in flight → refuse, naming the count; --force allows with the warning", () => {
    const refused = decideRestart({ ...idle, inFlight: 2 }, { force: false });
    expect(refused.allow).toBe(false);
    expect(refused.problems).toEqual(["2 run(s) in flight — a restart would kill them"]);
    expect(refused.message).toMatch(/REFUSED/);
    const forced = decideRestart({ ...idle, inFlight: 2 }, { force: true });
    expect(forced).toMatchObject({ allow: true, forced: true, problems: ["2 run(s) in flight — a restart would kill them"] });
    expect(forced.message).toMatch(/SIGTERM'd into the drain/);
    expect(forced.message).not.toMatch(/WILL be killed/); // stop() drains; nothing is killed before the deadline
  });

  it("already draining → refuse even with 0 in flight (the bot is restarting on its own)", () => {
    const d = decideRestart({ ...idle, draining: true }, { force: false });
    expect(d.allow).toBe(false);
    expect(d.problems[0]).toMatch(/already draining/);
  });

  it("fails closed: no JSON body or an impossible inFlight refuses (force still bypasses)", () => {
    expect(decideRestart(undefined, { force: false })).toMatchObject({ allow: false, problems: [expect.stringMatching(/not answering with JSON/)] });
    expect(decideRestart({ ok: true, inFlight: -1, draining: false }, { force: false })).toMatchObject({ allow: false, problems: [expect.stringMatching(/impossible inFlight/)] });
    expect(decideRestart(undefined, { force: true }).allow).toBe(true);
  });
});

describe("authorizeRestart", () => {
  const tokens = JSON.stringify({
    "tok-deployer": { subject: "ops", scopes: ["dispatch", "deploy:write"] },
    "tok-reader": { subject: "reader", scopes: ["runs:read"] },
    "tok-cron": { subject: "cron" },
  });

  it("a bearer whose identity carries deploy:write is allowed and named by subject", () => {
    expect(authorizeRestart("Bearer tok-deployer", tokens)).toEqual({ ok: true, subject: "ops" });
    expect(RESTART_SCOPE).toBe("deploy:write");
  });

  it("no bearer → 401; an unknown bearer → 401; a known bearer without the scope (incl. the default `dispatch`-only cron) → 403", () => {
    expect(authorizeRestart(undefined, tokens)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeRestart("Basic abc", tokens)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeRestart("Bearer nope", tokens)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeRestart("Bearer tok-reader", tokens)).toMatchObject({ ok: false, status: 403, reason: expect.stringContaining("deploy:write") });
    expect(authorizeRestart("Bearer tok-cron", tokens)).toMatchObject({ ok: false, status: 403 });
  });

  it("the bearer lookup compares against every configured token with fixed work (no early exit on the first mismatch)", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("", "")).toBe(true);
    const map = { "tok-a": 1, "tok-b": 2, "tok-c": 3 };
    expect(lookupConstantTime(map, "tok-b")).toBe(2);
    expect(lookupConstantTime(map, "tok-")).toBeUndefined(); // a prefix of a real token never matches
    expect(lookupConstantTime(map, "tok-bb")).toBeUndefined();
  });

  it("fails closed without a token map (503 — the route is disabled, never open) and never echoes token material", () => {
    expect(authorizeRestart("Bearer tok-deployer", undefined)).toMatchObject({ ok: false, status: 503 });
    expect(authorizeRestart("Bearer tok-deployer", "not json")).toMatchObject({ ok: false, status: 503 });
    const r = authorizeRestart("Bearer tok-secret-value", tokens);
    expect(JSON.stringify(r)).not.toContain("tok-secret-value");
  });
});

describe("restart request/response wire shapes", () => {
  it("parseRestartRequest: empty body → not forced; {force:true} → forced; anything else is an error", () => {
    expect(parseRestartRequest("")).toEqual({ ok: true, force: false });
    expect(parseRestartRequest('{"force":true}')).toEqual({ ok: true, force: true });
    expect(parseRestartRequest('{"force":"yes"}')).toMatchObject({ ok: false });
    expect(parseRestartRequest("[1]")).toMatchObject({ ok: false });
    expect(parseRestartRequest("{")).toMatchObject({ ok: false });
  });

  it("restartResponse maps the DO outcome onto HTTP: 202 stopping, 409 refused (problems listed), 200 not-running", () => {
    expect(restartResponse({ kind: "stopping", forced: false, inFlight: 0, previousStartedAt: idle.startedAt })).toEqual({
      status: 202,
      body: { ok: true, stopping: true, forced: false, inFlight: 0, previousStartedAt: idle.startedAt },
    });
    expect(restartResponse({ kind: "refused", problems: ["2 run(s) in flight — a restart would kill them"] })).toEqual({
      status: 409,
      body: { ok: false, refused: true, problems: ["2 run(s) in flight — a restart would kill them"] },
    });
    expect(restartResponse({ kind: "not-running" })).toEqual({ status: 200, body: { ok: true, stopping: false, note: expect.stringContaining("not running") } });
  });

  it("classifyRestartResponse (CLI side): 202 → stopping with the previous startedAt; 409 → refused (retryable) with the first problem; 401/403 → unauthorized; else failed", () => {
    expect(classifyRestartResponse(202, JSON.stringify({ ok: true, stopping: true, previousStartedAt: idle.startedAt }))).toEqual({ kind: "stopping", previousStartedAt: idle.startedAt });
    expect(classifyRestartResponse(202, "{}")).toEqual({ kind: "stopping", previousStartedAt: undefined });
    expect(classifyRestartResponse(200, JSON.stringify({ ok: true, stopping: false, note: "container not running" }))).toEqual({ kind: "not-running" });
    expect(classifyRestartResponse(409, JSON.stringify({ ok: false, refused: true, problems: ["2 run(s) in flight — a restart would kill them", "x"] }))).toEqual({
      kind: "refused",
      reason: "2 run(s) in flight — a restart would kill them",
    });
    expect(classifyRestartResponse(401, "unauthorized")).toEqual({ kind: "unauthorized", reason: expect.stringContaining("401") });
    expect(classifyRestartResponse(403, "forbidden")).toEqual({ kind: "unauthorized", reason: expect.stringContaining("403") });
    expect(classifyRestartResponse(502, "<html>bad gateway</html>")).toEqual({ kind: "failed", reason: expect.stringContaining("502") });
  });
});

describe("planRestart / formatRestartPlan", () => {
  it("the plan names the bot's admin route, its /healthz, the token env, the force flag and the wait budget", () => {
    const plan = planRestart({ only: "bot", force: false, waitMaxMinutes: 30, pollSeconds: 60 });
    expect(plan).toEqual({
      target: "bot",
      adminUrl: BOT_ADMIN_RESTART_URL,
      healthUrl: "https://switchboard.coreplanelabs.dev/healthz",
      tokenEnv: RESTART_TOKEN_ENV,
      force: false,
      waitMaxMs: 30 * 60_000,
      pollMs: 60_000,
      liveDeadlineMs: LIVE_GATE_DEADLINE_MS,
    });
    expect(BOT_ADMIN_RESTART_URL).toBe("https://switchboard.coreplanelabs.dev/admin/restart");
    const text = formatRestartPlan(plan);
    expect(text).toContain("POST https://switchboard.coreplanelabs.dev/admin/restart");
    expect(text).toContain(RESTART_TOKEN_ENV);
    expect(text).toContain("startedAt");
    expect(formatRestartPlan(planRestart({ only: "bot", force: true, waitMaxMinutes: 5, pollSeconds: 10 }))).toContain("FORCED");
  });
});
