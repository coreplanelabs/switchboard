import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Feature: features/live-view.md item 13 — the ScheduleDO: the durable
// record of scheduled firings behind the /runs "Scheduled" panel. The Worker
// shim writes one row per cron firing; the bot reads the newest per schedule.
// Runs in workerd against the real SQLite-backed Durable Object.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

// One ScheduleDO exists (named "schedules"); tests share it, so each uses
// unique schedule names to stay isolated.
let n = 0;
const name = () => `sched-${Date.now()}-${n++}`;

async function post(path: string, body: unknown, headers: Record<string, string> = AUTH) {
  const res = await SELF.fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON: leave {}
  }
  return { status: res.status, data };
}

const firing = (schedule: string, firedAt: number, over: Record<string, unknown> = {}) => ({
  schedule,
  firedAt,
  outcome: "completed",
  runId: `run-${firedAt}`,
  detail: "🔍 8 runs analyzed",
  ...over,
});

type Firing = { schedule: string; firedAt: number; runId?: string; outcome: string; detail?: string };
const latestOf = async (schedules: string[]) => {
  const { status, data } = await post("/schedules/latest", {});
  expect(status).toBe(200);
  return (data.firings as Firing[]).filter((f) => schedules.includes(f.schedule));
};

describe("schedule firing routes", () => {
  it("record → latest returns the newest firing per schedule, verbatim", async () => {
    const a = name();
    const b = name();
    expect((await post("/schedules/record", { firing: firing(a, 100) })).data).toEqual({ ok: true, retained: 1 });
    expect(
      (await post("/schedules/record", { firing: firing(a, 300, { outcome: "failed", detail: "🚫 restricted" }) }))
        .data,
    ).toEqual({ ok: true, retained: 2 });
    expect((await post("/schedules/record", { firing: firing(b, 200) })).data).toEqual({ ok: true, retained: 1 });
    // A late-arriving OLDER firing is kept but never becomes the latest.
    await post("/schedules/record", { firing: firing(a, 250) });
    const latest = await latestOf([a, b]);
    expect(latest).toHaveLength(2);
    expect(latest.find((f) => f.schedule === a)).toEqual(
      firing(a, 300, { outcome: "failed", detail: "🚫 restricted" }),
    );
    expect(latest.find((f) => f.schedule === b)).toEqual(firing(b, 200));
  });

  it("a firing without a run (misconfigured / ingress-error) is recorded with no runId", async () => {
    const s = name();
    const rec = { schedule: s, firedAt: 5, outcome: "ingress-error", detail: "HTTP 503 disabled" };
    expect((await post("/schedules/record", { firing: rec })).status).toBe(200);
    expect(await latestOf([s])).toEqual([rec]);
  });

  it("two firings at the same instant (a firing while the previous run is in flight): both kept, the later write is latest", async () => {
    const s = name();
    await post("/schedules/record", { firing: firing(s, 1000, { runId: "a" }) });
    await post("/schedules/record", { firing: firing(s, 1000, { runId: "b" }) });
    expect((await latestOf([s]))[0].runId).toBe("b");
  });

  it("is bounded per schedule: the oldest firings fall off past the cap", async () => {
    const s = name();
    let retained = 0;
    for (let i = 0; i < 105; i++) {
      retained = (await post("/schedules/record", { firing: firing(s, i) })).data.retained as number;
    }
    expect(retained).toBe(100);
    expect((await latestOf([s]))[0].firedAt).toBe(104);
  });

  it("400 on a malformed firing (shape, unknown outcome, oversize detail, overlong name)", async () => {
    for (const bad of [
      {},
      { firing: null },
      { firing: { schedule: "", firedAt: 1, outcome: "completed" } },
      { firing: { schedule: "s", firedAt: "1", outcome: "completed" } },
      { firing: { schedule: "s", firedAt: 1, outcome: "meh" } },
      { firing: { schedule: "s", firedAt: 1, outcome: "completed", detail: "x".repeat(301) } },
      { firing: { schedule: "s".repeat(201), firedAt: 1, outcome: "completed" } },
      { firing: { schedule: "s", firedAt: 1, outcome: "completed", runId: "r".repeat(201) } },
    ]) {
      const { status, data } = await post("/schedules/record", bad);
      expect(status, JSON.stringify(bad)).toBe(400);
      expect(typeof data.error).toBe("string");
    }
  });

  it("401 without the bearer, 405 on GET", async () => {
    expect((await post("/schedules/latest", {}, { "content-type": "application/json" })).status).toBe(401);
    expect(
      (
        await post(
          "/schedules/record",
          { firing: firing("s", 1) },
          { authorization: "Bearer nope", "content-type": "application/json" },
        )
      ).status,
    ).toBe(401);
    const res = await SELF.fetch(`${BASE}/schedules/latest`, { method: "GET", headers: AUTH });
    expect(res.status).toBe(405);
  });
});
