import { describe, expect, it } from "vitest";
import { LIVE_GATE_DEADLINE_MS } from "./liveGate.js";
import { NO_GRANTS, type Grants } from "../core/authz/types.js";
import { TEST_PROFILE } from "./testing/profile.js";
import {
  authenticateRestart,
  authorizeRestart,
  constantTimeEqual,
  lookupConstantTime,
  classifyRestartResponse,
  decideRestart,
  formatRestartPlan,
  parseRestartAuthorization,
  parseRestartRequest,
  planRestart,
  RESTART_AUTHORIZE_PATH,
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

  it("runs in flight → allow with a WARNING naming the count and the handoff (run-history item 39); --force changes nothing here", () => {
    const d = decideRestart({ ...idle, inFlight: 2 }, { force: false });
    expect(d).toMatchObject({ allow: true, forced: false, problems: [] });
    expect(d.warnings).toEqual([expect.stringMatching(/^2 run\(s\) in flight — handed to the next generation/)]);
    expect(d.message).toMatch(/restart ok/);
    expect(d.message).toContain("\n  - 2 run(s) in flight"); // a real newline before each warning, never a literal \n
    expect(d.message).not.toMatch(/REFUSED|WILL be killed/);
    expect(decideRestart({ ...idle, inFlight: 2 }, { force: true })).toMatchObject({ allow: true, forced: false });
  });

  it("already draining → allow with a WARNING even at 0 in flight (the bot is restarting on its own; a second stop is harmless)", () => {
    const d = decideRestart({ ...idle, draining: true }, { force: false });
    expect(d).toMatchObject({ allow: true, forced: false, problems: [] });
    expect(d.warnings[0]).toMatch(/already draining/);
  });

  it("fails closed: no JSON body or an impossible inFlight refuses (force still bypasses)", () => {
    expect(decideRestart(undefined, { force: false })).toMatchObject({
      allow: false,
      problems: [expect.stringMatching(/not answering with JSON/)],
    });
    expect(decideRestart({ ok: true, inFlight: -1, draining: false }, { force: false })).toMatchObject({
      allow: false,
      problems: [expect.stringMatching(/impossible inFlight/)],
    });
    expect(decideRestart(undefined, { force: true }).allow).toBe(true);
  });
});

describe("authorizeRestart", () => {
  const tokens = JSON.stringify({
    "tok-deployer": { subject: "ops" },
    "tok-reader": { subject: "reader" },
    "tok-cron": { subject: "cron" },
  });
  // Config's grants for the tokens' `http:<subject>` actors: only ops holds deploy:write.
  const GRANTS: Record<string, Grants> = {
    "http:ops": { actions: new Set(["dispatch", "deploy:write"]), channels: new Set(), repos: new Set() },
    "http:reader": { actions: new Set(["runs:read"]), channels: new Set(), repos: new Set() },
    "http:cron": { actions: new Set(["dispatch"]), channels: new Set(), repos: new Set() },
  };
  const grantsFor = (id: string) => GRANTS[id] ?? NO_GRANTS;

  it("a bearer whose http:<subject> actor is granted deploy:write is allowed and named by subject", () => {
    expect(authorizeRestart("Bearer tok-deployer", tokens, grantsFor)).toEqual({ ok: true, subject: "ops" });
    expect(RESTART_SCOPE).toBe("deploy:write");
  });

  it("no bearer → 401; an unknown bearer → 401; a known bearer whose actor lacks the grant (incl. the dispatch-only cron) → 403", () => {
    expect(authorizeRestart(undefined, tokens, grantsFor)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeRestart("Basic abc", tokens, grantsFor)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeRestart("Bearer nope", tokens, grantsFor)).toMatchObject({ ok: false, status: 401 });
    expect(authorizeRestart("Bearer tok-reader", tokens, grantsFor)).toMatchObject({
      ok: false,
      status: 403,
      reason: expect.stringContaining("deploy:write"),
    });
    expect(authorizeRestart("Bearer tok-cron", tokens, grantsFor)).toMatchObject({ ok: false, status: 403 });
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
    expect(authorizeRestart("Bearer tok-deployer", undefined, grantsFor)).toMatchObject({ ok: false, status: 503 });
    expect(authorizeRestart("Bearer tok-deployer", "not json", grantsFor)).toMatchObject({ ok: false, status: 503 });
    const r = authorizeRestart("Bearer tok-secret-value", tokens, grantsFor);
    expect(JSON.stringify(r)).not.toContain("tok-secret-value");
  });

  it("authenticateRestart (the Worker's half) says WHO without deciding: the identity for a known bearer, 401 unknown/absent, 503 no map — never the grant, never the token", () => {
    expect(authenticateRestart("Bearer tok-reader", tokens)).toEqual({ ok: true, identity: { subject: "reader" } });
    expect(authenticateRestart("Bearer tok-cron", tokens)).toEqual({ ok: true, identity: { subject: "cron" } });
    expect(authenticateRestart(undefined, tokens)).toMatchObject({ ok: false, status: 401 });
    expect(authenticateRestart("Bearer nope", tokens)).toMatchObject({ ok: false, status: 401 });
    expect(authenticateRestart("Bearer tok-deployer", undefined)).toMatchObject({ ok: false, status: 503 });
    expect(authenticateRestart("Bearer tok-deployer", "[]")).toMatchObject({ ok: false, status: 503 });
    expect(JSON.stringify(authenticateRestart("Bearer tok-secret-value", tokens))).not.toContain("tok-secret-value");
  });

  it("parseRestartAuthorization (the Worker reading the bot's /admin/restart/authorize): 200 ok+subject → allowed; 401/403/503 with an error → relayed as they are; anything else → 503, fail-closed", () => {
    expect(RESTART_AUTHORIZE_PATH).toBe("/admin/restart/authorize");
    expect(parseRestartAuthorization(200, JSON.stringify({ ok: true, subject: "ops" }))).toEqual({
      ok: true,
      subject: "ops",
    });
    for (const status of [401, 403, 503] as const)
      expect(parseRestartAuthorization(status, JSON.stringify({ ok: false, error: "nope" }))).toEqual({
        ok: false,
        status,
        reason: "nope",
      });
    // A bot without the route (404), an HTML 500, a 200 without a subject, or a non-JSON body never restarts anything.
    for (const [status, text] of [
      [404, "not found"],
      [500, "<html>"],
      [200, JSON.stringify({ ok: true })],
      [200, JSON.stringify({ ok: false, error: "x" })],
      [403, "forbidden"],
    ] as const)
      expect(parseRestartAuthorization(status, text), `${status} ${text}`).toMatchObject({ ok: false, status: 503 });
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
    expect(
      restartResponse({ kind: "stopping", forced: false, inFlight: 0, previousStartedAt: idle.startedAt }),
    ).toEqual({
      status: 202,
      body: { ok: true, stopping: true, forced: false, inFlight: 0, previousStartedAt: idle.startedAt },
    });
    expect(restartResponse({ kind: "refused", problems: ["2 run(s) in flight — a restart would kill them"] })).toEqual({
      status: 409,
      body: { ok: false, refused: true, problems: ["2 run(s) in flight — a restart would kill them"] },
    });
    expect(restartResponse({ kind: "not-running" })).toEqual({
      status: 200,
      body: { ok: true, stopping: false, note: expect.stringContaining("not running") },
    });
  });

  it("classifyRestartResponse (CLI side): 202 → stopping with the previous startedAt; 409 → refused (retryable) with the first problem; 401/403 → unauthorized; else failed", () => {
    expect(
      classifyRestartResponse(202, JSON.stringify({ ok: true, stopping: true, previousStartedAt: idle.startedAt })),
    ).toEqual({ kind: "stopping", previousStartedAt: idle.startedAt });
    expect(classifyRestartResponse(202, "{}")).toEqual({ kind: "stopping", previousStartedAt: undefined });
    expect(
      classifyRestartResponse(200, JSON.stringify({ ok: true, stopping: false, note: "container not running" })),
    ).toEqual({ kind: "not-running" });
    expect(
      classifyRestartResponse(
        409,
        JSON.stringify({ ok: false, refused: true, problems: ["2 run(s) in flight — a restart would kill them", "x"] }),
      ),
    ).toEqual({
      kind: "refused",
      reason: "2 run(s) in flight — a restart would kill them",
    });
    expect(classifyRestartResponse(401, "unauthorized")).toEqual({
      kind: "unauthorized",
      reason: expect.stringContaining("401"),
    });
    expect(classifyRestartResponse(403, "forbidden")).toEqual({
      kind: "unauthorized",
      reason: expect.stringContaining("403"),
    });
    expect(classifyRestartResponse(502, "<html>bad gateway</html>")).toEqual({
      kind: "failed",
      reason: expect.stringContaining("502"),
    });
  });
});

describe("planRestart / formatRestartPlan", () => {
  it("the plan names the bot's admin route and /healthz — derived from the profile's bot hostname — the token env, the force flag and the wait budget", () => {
    const plan = planRestart({ only: "bot", force: false, waitMaxMinutes: 30, pollSeconds: 60 }, TEST_PROFILE);
    expect(plan).toEqual({
      target: "bot",
      adminUrl: "https://switchboard.example.test/admin/restart",
      healthUrl: "https://switchboard.example.test/healthz",
      tokenEnv: RESTART_TOKEN_ENV,
      force: false,
      waitMaxMs: 30 * 60_000,
      pollMs: 60_000,
      liveDeadlineMs: LIVE_GATE_DEADLINE_MS,
    });
    const text = formatRestartPlan(plan);
    expect(text).toContain("POST https://switchboard.example.test/admin/restart");
    expect(text).toContain(RESTART_TOKEN_ENV);
    expect(text).toContain("startedAt");
    expect(
      formatRestartPlan(planRestart({ only: "bot", force: true, waitMaxMinutes: 5, pollSeconds: 10 }, TEST_PROFILE)),
    ).toContain("FORCED");
  });
});
