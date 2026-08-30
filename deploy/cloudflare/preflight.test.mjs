import { describe, expect, it } from "vitest";
import { APP_NAME, decide } from "./preflight.mjs";

// Feature: features/slack-channel.md item 8 — the bot deploy preflight. Live
// 2026-08-29: two `wrangler deploy`s 90 s apart (23:49:45Z, 23:51:15Z) landed on
// a review run started 23:48:40Z; the second rollout replaced the instance the
// first had already put into its graceful drain, killing the run at 153 s and
// freezing its status card forever. A single deploy at 00:11:31Z during the
// re-run finished normally (drain works) — the killer is a deploy on top of a
// draining instance or a rollout still in progress.

const health = (inFlight, draining = false) => ({ ok: true, payload: { ok: true, inFlight, draining } });
const apps = (state, name = APP_NAME) => ({ ok: true, payload: [{ name: "other-app", state: "active" }, { name, state }] });

describe("bot deploy preflight — decide()", () => {
  it("idle bot, settled container app → allow, not forced", () => {
    const d = decide({ health: health(0), apps: apps("active") });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(false);
    expect(d.message).toMatch(/preflight ok/);
  });

  it("runs in flight → refuse, naming the count", () => {
    const d = decide({ health: health(2), apps: apps("active") });
    expect(d.allow).toBe(false);
    expect(d.message).toContain("2 run(s) in flight");
    expect(d.message).toMatch(/SWITCHBOARD_DEPLOY_FORCE=1/);
  });

  it("bot already draining (a previous deploy's SIGTERM landed) → refuse even with 0 in flight", () => {
    const d = decide({ health: health(0, true), apps: apps("active") });
    expect(d.allow).toBe(false);
    expect(d.message).toMatch(/draining/);
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

  it("fails closed: unreachable bot, non-JSON / legacy `ok` health, impossible inFlight, wrangler failure, app not listed", () => {
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
    expect(decide(cases[1]).message).toMatch(/predates the preflight/);
  });

  it("force → allow with a warning that names what will be killed", () => {
    const d = decide({ health: health(1, true), apps: apps("provisioning") }, { force: true });
    expect(d.allow).toBe(true);
    expect(d.forced).toBe(true);
    expect(d.message).toMatch(/WARNING/);
    expect(d.message).toContain("1 run(s) in flight");
    expect(d.message).toContain("state=provisioning");
  });

  it("problems are all reported at once (an operator waits for the runs and is not surprised by a second refusal)", () => {
    const d = decide({ health: health(3, false), apps: apps("updating") });
    expect(d.message).toContain("3 run(s) in flight");
    expect(d.message).toContain("state=updating");
  });
});
