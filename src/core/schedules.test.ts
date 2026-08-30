import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CRON_IDENTITY,
  interpretIngressResponse,
  isScheduleFiring,
  nextFire,
  parseCron,
  planScheduledFiring,
  SCHEDULES,
  scheduleForCron,
  type RunSchedule,
} from "./schedules.js";

// Feature: features/self-improvement.md item 7c + features/live-view.md item 13
// (#244): the schedule registry is the single source of truth for every cron
// the Worker shim runs — wrangler.jsonc `triggers.crons` and the shim both
// derive from it — and the pure helpers the shim uses to turn a firing into a
// normal /ingress run and to record the outcome.

const T0 = Date.UTC(2026, 7, 29, 12, 34, 56); // Sat 2026-08-29 12:34:56Z

/** wrangler.jsonc is JSON with comments; strip them string-aware (URLs in
 *  string values contain `//`). */
function readJsonc(path: string): unknown {
  const text = readFileSync(path, "utf8");
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i];
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const selfImprovement = SCHEDULES.find((s) => s.name === "self-improvement") as RunSchedule;

describe("schedule registry", () => {
  it("is the source of truth for wrangler.jsonc triggers.crons (same set, no drift)", () => {
    const wrangler = readJsonc("deploy/cloudflare/wrangler.jsonc") as { triggers: { crons: string[] } };
    expect([...wrangler.triggers.crons].sort()).toEqual(SCHEDULES.map((s) => s.cron).sort());
  });

  it("every schedule has a unique name and a unique, parseable cron expression", () => {
    expect(new Set(SCHEDULES.map((s) => s.name)).size).toBe(SCHEDULES.length);
    expect(new Set(SCHEDULES.map((s) => s.cron)).size).toBe(SCHEDULES.length);
    for (const s of SCHEDULES) expect(parseCron(s.cron), s.cron).toBeDefined();
  });

  it("the keep-alive is NOT a run; the self-improvement pass runs `friction propose` as the cron identity", () => {
    const keepAlive = scheduleForCron("* * * * *");
    expect(keepAlive?.kind).toBe("keep-alive");
    expect(selfImprovement).toMatchObject({ kind: "run", cron: "0 * * * *", command: "friction propose", identity: CRON_IDENTITY });
  });

  it("scheduleForCron: unknown expression → undefined (the shim logs and does nothing)", () => {
    expect(scheduleForCron("5 4 * * *")).toBeUndefined();
    expect(scheduleForCron("")).toBeUndefined();
  });
});

describe("cron evaluation (nextFire, UTC)", () => {
  it("parses the five standard fields, lists, ranges, steps, and dow 7 = Sunday", () => {
    expect(parseCron("* * * * *")).toBeDefined();
    const spec = parseCron("0,30 9-17/4 1 */3 7")!;
    expect([...spec.minute]).toEqual([0, 30]);
    expect([...spec.hour]).toEqual([9, 13, 17]);
    expect([...spec.dayOfMonth]).toEqual([1]);
    expect([...spec.month]).toEqual([1, 4, 7, 10]);
    expect([...spec.dayOfWeek]).toEqual([0]);
  });

  it("rejects malformed expressions instead of guessing", () => {
    // `5/2` (a step on a single value) is malformed in Vixie cron — rejected, never expanded to 5-59/2.
    for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "a * * * *", "*/0 * * * *", "5-1 * * * *", "5/2 * * * *"]) {
      expect(parseCron(bad), bad).toBeUndefined();
    }
    expect(nextFire("nope", T0)).toBeUndefined();
  });

  it("every-minute fires at the next whole minute strictly after `from`", () => {
    expect(nextFire("* * * * *", T0)).toBe(Date.UTC(2026, 7, 29, 12, 35));
    expect(nextFire("* * * * *", Date.UTC(2026, 7, 29, 12, 35))).toBe(Date.UTC(2026, 7, 29, 12, 36));
  });

  it("Mondays 14:00 UTC from a Saturday is the coming Monday", () => {
    expect(nextFire("0 14 * * 1", T0)).toBe(Date.UTC(2026, 7, 31, 14, 0));
    // Exactly at the firing minute → the NEXT one, a week later.
    expect(nextFire("0 14 * * 1", Date.UTC(2026, 7, 31, 14, 0))).toBe(Date.UTC(2026, 8, 7, 14, 0));
  });

  it("day-of-month and day-of-week are OR'd when both are restricted (Vixie cron)", () => {
    // 1st of the month OR a Monday, at 00:00 — from Sat Aug 29: Mon Aug 31 comes before Tue Sep 1.
    expect(nextFire("0 0 1 * 1", T0)).toBe(Date.UTC(2026, 7, 31, 0, 0));
    // Only dom restricted: Sep 1.
    expect(nextFire("0 0 1 * *", T0)).toBe(Date.UTC(2026, 8, 1, 0, 0));
  });

  it("skips months without the day (Feb 30) and crosses a year boundary", () => {
    expect(nextFire("0 0 30 2 *", T0)).toBeUndefined(); // never fires
    expect(nextFire("0 0 29 2 *", T0)).toBe(Date.UTC(2028, 1, 29, 0, 0)); // next leap day
    expect(nextFire("0 0 1 1 *", T0)).toBe(Date.UTC(2027, 0, 1, 0, 0));
  });
});

describe("planScheduledFiring (the shim's request plan)", () => {
  const map = JSON.stringify({ aaaa: { subject: "justin-ingress" }, cccc: { subject: "cron", channel: "cron" } });

  it("finds the cron identity's token and plans a POST /ingress of the schedule's command", () => {
    const plan = planScheduledFiring(selfImprovement, map, T0);
    expect(plan).toEqual({
      ok: true,
      token: "cccc",
      body: { text: "friction propose", thread: `self-improvement-${T0}` },
    });
  });

  it("fail-closed: no token map, an unparseable map, or no `cron` identity → nothing to run, with the reason", () => {
    expect(planScheduledFiring(selfImprovement, undefined, T0)).toEqual({ ok: false, reason: "SWITCHBOARD_INGRESS_TOKENS is not set" });
    expect(planScheduledFiring(selfImprovement, "{oops", T0)).toEqual({ ok: false, reason: "SWITCHBOARD_INGRESS_TOKENS is not valid JSON" });
    expect(planScheduledFiring(selfImprovement, JSON.stringify({ aaaa: { subject: "justin-ingress" } }), T0)).toEqual({
      ok: false,
      reason: 'SWITCHBOARD_INGRESS_TOKENS has no entry with subject "cron"',
    });
  });

  it("an ambiguous identity (two tokens for `cron`) is refused, never guessed", () => {
    const dup = JSON.stringify({ a: { subject: "cron" }, b: { subject: "cron" } });
    expect(planScheduledFiring(selfImprovement, dup, T0)).toEqual({ ok: false, reason: 'SWITCHBOARD_INGRESS_TOKENS has no entry with subject "cron"' });
  });
});

describe("interpretIngressResponse (the firing record)", () => {
  it("200 with a run receipt → the run's id and terminal status", () => {
    const body = JSON.stringify({ reply: "🔍 8 runs analyzed", run: { id: "run-1", status: "completed" } });
    expect(interpretIngressResponse(selfImprovement, T0, 200, body)).toEqual({
      schedule: "self-improvement",
      firedAt: T0,
      runId: "run-1",
      outcome: "completed",
      detail: "🔍 8 runs analyzed",
    });
    const failed = JSON.stringify({ reply: "🚫 restricted", run: { id: "run-2", status: "failed" } });
    expect(interpretIngressResponse(selfImprovement, T0, 200, failed)).toMatchObject({ runId: "run-2", outcome: "failed", detail: "🚫 restricted" });
  });

  it("200 without a run receipt → `no-run` (an older bot answered; nothing to link)", () => {
    const none = interpretIngressResponse(selfImprovement, T0, 200, JSON.stringify({ reply: "ok" }));
    expect(none).toMatchObject({ outcome: "no-run", detail: "ok" });
    expect(none.runId).toBeUndefined();
    expect(interpretIngressResponse(selfImprovement, T0, 200, "not json")).toMatchObject({ outcome: "no-run" });
  });

  it("non-2xx (401 unknown identity, 503 disabled, 5xx) → `ingress-error` naming the status", () => {
    expect(interpretIngressResponse(selfImprovement, T0, 401, '{"error":"unauthorized"}')).toMatchObject({ outcome: "ingress-error", detail: "HTTP 401 unauthorized" });
    expect(interpretIngressResponse(selfImprovement, T0, 503, '{"error":"disabled","detail":"no ingress tokens configured"}')).toMatchObject({
      outcome: "ingress-error",
      detail: "HTTP 503 disabled",
    });
    expect(interpretIngressResponse(selfImprovement, T0, 502, "<html>bad gateway</html>")).toMatchObject({ outcome: "ingress-error", detail: "HTTP 502 <html>bad gateway</html>" });
  });

  it("detail is capped so a firing record never carries a whole report", () => {
    const body = JSON.stringify({ reply: "x".repeat(5000), run: { id: "r", status: "completed" } });
    const rec = interpretIngressResponse(selfImprovement, T0, 200, body);
    expect(rec.detail!.length).toBeLessThanOrEqual(300);
  });
});

describe("isScheduleFiring", () => {
  it("accepts the record shape and rejects anything else", () => {
    expect(isScheduleFiring({ schedule: "s", firedAt: 1, outcome: "completed" })).toBe(true);
    expect(isScheduleFiring({ schedule: "s", firedAt: 1, outcome: "completed", runId: "r", detail: "d" })).toBe(true);
    for (const bad of [null, "x", {}, { schedule: "", firedAt: 1, outcome: "completed" }, { schedule: "s", firedAt: "1", outcome: "completed" }, { schedule: "s", firedAt: 1, outcome: "meh" }, { schedule: "s", firedAt: 1, outcome: "completed", runId: 5 }]) {
      expect(isScheduleFiring(bad)).toBe(false);
    }
  });
});
