import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  CRON_IDENTITY,
  interpretIngressResponse,
  isRunSchedule,
  isScheduleFiring,
  nextFire,
  parseCron,
  planScheduledFiring,
  recordFiring,
  SCHEDULES,
  scheduleForCron,
  schedulesFor,
  watchdogFiring,
  type RunSchedule,
  type ScheduleFiring,
  type ScheduleWorker,
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

const WRANGLER_BY_WORKER: Record<ScheduleWorker, string> = {
  bot: "deploy/cloudflare/wrangler.jsonc",
  resident: "deploy/cloudflare-resident/wrangler.jsonc",
};

describe("schedule registry", () => {
  it("is the source of truth for every Worker's wrangler.jsonc triggers.crons (same set per worker, no drift)", () => {
    for (const worker of Object.keys(WRANGLER_BY_WORKER) as ScheduleWorker[]) {
      const wrangler = readJsonc(WRANGLER_BY_WORKER[worker]) as { triggers: { crons: string[] } };
      expect([...wrangler.triggers.crons].sort(), worker).toEqual(
        schedulesFor(worker)
          .map((s) => s.cron)
          .sort(),
      );
    }
  });

  it("every schedule has a unique name, a parseable cron, and a cron unique within its worker", () => {
    expect(new Set(SCHEDULES.map((s) => s.name)).size).toBe(SCHEDULES.length);
    for (const s of SCHEDULES) expect(parseCron(s.cron), s.cron).toBeDefined();
    for (const worker of ["bot", "resident"] as const) {
      const crons = schedulesFor(worker).map((s) => s.cron);
      expect(new Set(crons).size, worker).toBe(crons.length);
    }
  });

  it("catalog: keep-alive is internal (healthz, hidden); self-improvement runs `friction propose` as cron; the resident watchdog is a visible non-run", () => {
    expect(scheduleForCron("* * * * *", "bot")).toMatchObject({ name: "keep-alive", worker: "bot", internal: true, action: { type: "healthz" } });
    expect(selfImprovement).toMatchObject({ worker: "bot", cron: "0 14 * * 1", action: { type: "run", command: "friction propose", identity: CRON_IDENTITY } });
    expect(selfImprovement.internal).toBeUndefined();
    expect(scheduleForCron("*/10 * * * *", "resident")).toMatchObject({ name: "resident-watchdog", worker: "resident", action: { type: "watchdog" } });
    expect(scheduleForCron("*/10 * * * *", "resident")?.internal).toBeUndefined();
  });

  it("scheduleForCron is per worker: an expression is looked up only among that worker's schedules", () => {
    expect(scheduleForCron("* * * * *", "resident")).toBeUndefined();
    expect(scheduleForCron("*/10 * * * *", "bot")).toBeUndefined();
    expect(scheduleForCron("5 4 * * *", "bot")).toBeUndefined();
    expect(scheduleForCron("", "bot")).toBeUndefined();
  });

  it("isRunSchedule narrows to schedules the shim POSTs to /ingress", () => {
    expect(SCHEDULES.filter(isRunSchedule).map((s) => s.name)).toEqual(["self-improvement"]);
  });
});

describe("watchdogFiring (the resident's firing record)", () => {
  const watchdog = scheduleForCron("*/10 * * * *", "resident")!;

  it("summarizes a quiet pass as completed with the counts", () => {
    expect(watchdogFiring(watchdog, T0, { cap: 10, count: 3, results: [{ resource: "a", state: "ready", action: "none" }, { resource: "b" }, { resource: "c" }] })).toEqual({
      schedule: "resident-watchdog",
      firedAt: T0,
      outcome: "completed",
      detail: "3/10 residents · 0 re-armed · 0 timed out · 0 errors",
    });
  });

  it("counts re-armed chains and timed-out onboardings; any per-resident error makes the pass `failed`", () => {
    const summary = {
      cap: 10,
      count: 4,
      results: [{ resource: "a", action: "re-armed" }, { resource: "b", action: "provision-timed-out" }, { resource: "c", error: "boom" }, { resource: "d" }],
    };
    expect(watchdogFiring(watchdog, T0, summary)).toMatchObject({ outcome: "failed", detail: "4/10 residents · 1 re-armed · 1 timed out · 1 errors — c: boom" });
  });

  it("a thrown watchdog is `failed` with the message; detail stays capped", () => {
    expect(watchdogFiring(watchdog, T0, new Error("registry unreachable"))).toMatchObject({ outcome: "failed", detail: "watchdog threw: registry unreachable" });
    const many = { cap: 1, count: 1, results: Array.from({ length: 200 }, (_, i) => ({ resource: `r${i}`, error: "x".repeat(50) })) };
    expect(watchdogFiring(watchdog, T0, many).detail!.length).toBeLessThanOrEqual(300);
  });
});

describe("recordFiring (shared by both shims)", () => {
  const firing: ScheduleFiring = { schedule: "s", firedAt: T0, outcome: "completed" };

  it("fail-closed on config: no URL or bearer → nothing sent, the reason returned", async () => {
    const fetchSpy = vi.fn();
    expect(await recordFiring({ url: undefined, token: "t" }, firing, fetchSpy as never)).toEqual({ ok: false, reason: "STATE_WORKER_URL var is not set" });
    expect(await recordFiring({ url: "https://state", token: undefined }, firing, fetchSpy as never)).toEqual({ ok: false, reason: "MEMORY_TOKEN secret is not set" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs {firing} to <url>/schedules/record with the bearer; trailing slashes on the URL are tolerated", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    expect(await recordFiring({ url: "https://state//", token: "tok" }, firing, fetchSpy as never)).toEqual({ ok: true });
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://state/schedules/record");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body as string)).toEqual({ firing });
  });

  it("a non-2xx or a thrown fetch is reported, never thrown (best-effort telemetry)", async () => {
    expect(await recordFiring({ url: "https://state", token: "tok" }, firing, (async () => new Response("", { status: 503 })) as never)).toEqual({ ok: false, reason: "state Worker HTTP 503" });
    expect(
      await recordFiring(
        { url: "https://state", token: "tok" },
        firing,
        (async () => {
          throw new Error("ECONNRESET");
        }) as never,
      ),
    ).toEqual({ ok: false, reason: "ECONNRESET" });
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
    // Only the reply's FIRST line is the detail: the ranked list under the
    // friction head used to flatten into one 300-char run-on on the panel.
    const multi = JSON.stringify({ reply: "🔍 *Friction proposals* — 244 runs analyzed · 23 recurring patterns\n\n1. `slow_tool` — 22 runs", run: { id: "run-3", status: "completed" } });
    expect(interpretIngressResponse(selfImprovement, T0, 200, multi)).toMatchObject({ detail: "🔍 *Friction proposals* — 244 runs analyzed · 23 recurring patterns" });
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
