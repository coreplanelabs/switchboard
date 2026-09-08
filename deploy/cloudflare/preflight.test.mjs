import { describe, expect, it } from "vitest";
import { APP_NAME, BASE_URL_ENV, catchUpWarnings, decide, main, wranglerFailureText } from "./preflight.mjs";

describe("bot deploy preflight — main()", () => {
  it(`refuses (exit 2) before reading anything when ${BASE_URL_ENV} is not set — the Worker's origin is the deployment profile's, handed over by deploy all`, async () => {
    const errors = [];
    const original = console.error;
    console.error = (line) => errors.push(String(line));
    try {
      expect(await main([], {})).toBe(2);
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain(`${BASE_URL_ENV} is not set`);
    expect(errors.join("\n")).toContain("deploy all");
  });
});

describe("bot deploy preflight — wranglerFailureText()", () => {
  it("keeps wrangler's own [ERROR] lines from STDOUT (where wrangler prints them), ANSI stripped, npm noise dropped, with the exit code", () => {
    const stdout = [
      " ⛅️ wrangler 4.120.1",
      "\x1b[31m✘ [ERROR] A request to the Cloudflare API (/accounts/3c7b28f2/containers/applications) failed.\x1b[0m",
      "",
      "  Authentication error [code: 10000]",
    ].join("\n");
    expect(wranglerFailureText({ code: 1 }, stdout, "npm ERR! code 1\n")).toBe(
      "exit 1: ✘ [ERROR] A request to the Cloudflare API (/accounts/3c7b28f2/containers/applications) failed. | Authentication error [code: 10000]",
    );
  });

  it("falls back to the last lines of either stream, then to the exit alone; a timeout kill says so", () => {
    expect(wranglerFailureText({ code: 2 }, "one\ntwo\nthree\nfour", "")).toBe("exit 2: two | three | four");
    expect(wranglerFailureText({ code: 2 }, "", "   ")).toBe("exit 2, no output");
    expect(wranglerFailureText({ killed: true }, "", "")).toBe("killed (timeout?), no output");
  });
});

// Feature: docs/reference/specs/slack-channel.md item 8 — the bot deploy preflight. Seen
// live: two `wrangler deploy`s 90 s apart landed on a review run; the second
// rollout replaced the instance the first had already put into its graceful
// drain, killing the run at 153 s and freezing its status card forever. A
// single deploy during the re-run finished normally (drain works) — the killer
// is a deploy on top of a draining instance or a rollout still in progress.

const health = (inFlight, draining = false) => ({ ok: true, payload: { ok: true, inFlight, draining } });
const apps = (state, name = APP_NAME) => ({
  ok: true,
  payload: [
    { name: "other-app", state: "active" },
    { name, state },
  ],
});

describe("bot deploy preflight — decide()", () => {
  it("idle bot, settled container app → allow, not forced", () => {
    const d = decide({ health: health(0), apps: apps("active") });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(false);
    expect(d.message).toMatch(/preflight ok/);
  });

  it("runs in flight → allow with a WARNING naming the count and the handoff (run-history item 39) — never a refusal, nobody waits", () => {
    const d = decide({ health: health(2), apps: apps("active") });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(false);
    expect(d.problems).toEqual([]);
    expect(d.warnings).toEqual([expect.stringMatching(/^2 run\(s\) in flight — handed to the next generation/)]);
    expect(d.message).toMatch(/preflight ok/);
    expect(d.message).toMatch(/WARNING/);
    expect(d.message).toContain("2 run(s) in flight");
    expect(d.message).not.toMatch(/SWITCHBOARD_DEPLOY_FORCE=1/); // nothing to force
  });

  it("bot already draining (a previous deploy's SIGTERM landed) → allow with a WARNING: its resumable runs were handed off; a ship pipeline still in flight is what the warning names", () => {
    const d = decide({ health: health(0, true), apps: apps("active") });
    expect(d.allow).toBe(true);
    expect(d.problems).toEqual([]);
    expect(d.warnings).toEqual([expect.stringMatching(/draining/)]);
    expect(d.message).toMatch(/ship pipeline/);
  });

  it("container rollout still in progress (provisioning / updating / anything not settled) → refuse", () => {
    for (const state of ["provisioning", "updating", "rolling", "weird"]) {
      const d = decide({ health: health(0), apps: apps(state) });
      expect(d.allow, state).toBe(false);
      expect(d.message).toContain(`state=${state}`);
    }
  });

  it("`ready` is a settled state too (an app with no live instance yet)", () => {
    expect(decide({ health: health(0), apps: apps("ready") }).allow).toBe(true);
  });

  it("fails closed: unreachable bot, non-JSON / bare `ok` health, impossible inFlight, wrangler failure, app not listed", () => {
    const cases = [
      { health: { ok: false, error: "GET … failed: fetch failed" }, apps: apps("active") },
      { health: { ok: true, payload: "ok" }, apps: apps("active") },
      { health: { ok: true, payload: { ok: true } }, apps: apps("active") },
      { health: { ok: true, payload: { ok: true, inFlight: -1, draining: false } }, apps: apps("active") },
      { health: health(0), apps: { ok: false, error: "wrangler containers list failed: exit 1" } },
      { health: health(0), apps: apps("active", "some-other-app") },
    ];
    for (const c of cases) {
      const d = decide(c);
      expect(d.allow, JSON.stringify(c)).toBe(false);
    }
    expect(decide(cases[1]).message).toMatch(/not the JSON this preflight reads/);
  });

  it("force → allow with a warning that names what will be killed", () => {
    const d = decide({ health: health(1, true), apps: apps("provisioning") }, { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.message).toMatch(/WARNING/);
    expect(d.message).toContain("1 run(s) in flight");
    expect(d.message).toContain("state=provisioning");
  });

  it("problems and warnings are all reported at once: a rollout in progress refuses, the runs in flight are said alongside", () => {
    const d = decide({ health: health(3, false), apps: apps("updating") });
    expect(d.allow).toBe(false);
    expect(d.problems).toEqual([expect.stringContaining("state=updating")]);
    expect(d.warnings).toEqual([expect.stringContaining("3 run(s) in flight")]);
    expect(d.message).toContain("3 run(s) in flight");
    expect(d.message).toContain("state=updating");
  });
});

// A catch-up that is silently failing (missing scopes, listing error) is
// surfaced as a WARNING at deploy time; never a refusal, the deploy may be the fix.
describe("bot deploy preflight — catchUpWarnings()", () => {
  it("nothing to say when the catch-up is healthy or the payload predates the field", () => {
    expect(
      catchUpWarnings({
        ok: true,
        inFlight: 0,
        draining: false,
        catchUp: { lastRunAt: "x", channels: 3, missed: 0, skippedChannels: 0 },
      }),
    ).toEqual([]);
    expect(catchUpWarnings({ ok: true, inFlight: 0, draining: false })).toEqual([]);
    expect(catchUpWarnings("ok")).toEqual([]);
  });

  it("names a whole-scan error and the missing scopes", () => {
    const w = catchUpWarnings({
      ok: true,
      inFlight: 0,
      draining: false,
      catchUp: { error: "missing_scope", missingScopes: ["channels:read", "groups:read"] },
    });
    expect(w).toHaveLength(2);
    expect(w[0]).toContain("missing_scope");
    expect(w[1]).toContain("channels:read, groups:read");
  });

  it("an empty missingScopes list is not a warning", () => {
    expect(catchUpWarnings({ ok: true, inFlight: 0, draining: false, catchUp: { missingScopes: [] } })).toEqual([]);
  });

  it("decide() carries the warnings in an allowed message without refusing", () => {
    const d = decide({
      health: { ok: true, payload: { ok: true, inFlight: 0, draining: false, catchUp: { error: "missing_scope" } } },
      apps: apps("active"),
    });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(false);
    expect(d.warnings).toHaveLength(1);
    expect(d.message).toMatch(/WARNING/);
    expect(d.message).toContain("missing_scope");
  });

  it("a refusal (a rollout still in progress) still lists the catch-up warnings", () => {
    const d = decide({
      health: {
        ok: true,
        payload: { ok: true, inFlight: 0, draining: false, catchUp: { missingScopes: ["groups:read"] } },
      },
      apps: apps("updating"),
    });
    expect(d.allow).toBe(false);
    expect(d.message).toContain("groups:read");
  });
});
