import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Feature: features/self-improvement.md — the FrictionDO (#84): the durable
// friction ledger behind the bot's WorkerFrictionLedger. Runs in workerd
// against the real SQLite-backed Durable Object.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

let n = 0;
const ledger = () => `friction:test-${Date.now()}-${n++}`;

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

const ZERO = { count: 0, durationMs: 0 };
const diagnosis = (verdict = "no friction detected") => ({
  eventCount: 0,
  toolCalls: 0,
  hasTimings: false,
  byCategory: {
    slow_tool: ZERO,
    failed_tool: ZERO,
    retry: ZERO,
    setup_install: ZERO,
    wrap_up: ZERO,
    budget_hit: ZERO,
    infra_failure: ZERO,
  },
  findings: [],
  verdict,
});
const rec = (runId: string, finishedAt: number, over: Record<string, unknown> = {}) => ({
  runId,
  agent: "review",
  label: `review · o/r · "${runId}"`,
  finishedAt,
  diagnosis: diagnosis(),
  ...over,
});

describe("friction ledger routes", () => {
  it("record → recent round-trips records oldest-first, isolated per ledger key", async () => {
    const key = ledger();
    expect((await post("/friction/record", { ledgerKey: key, record: rec("b", 200) })).data).toEqual({ ok: true, retained: 1 });
    expect((await post("/friction/record", { ledgerKey: key, record: rec("a", 100) })).data).toEqual({ ok: true, retained: 2 });
    const { status, data } = await post("/friction/recent", { ledgerKey: key });
    expect(status).toBe(200);
    expect((data.records as Array<{ runId: string }>).map((r) => r.runId)).toEqual(["a", "b"]);
    expect((data.records as unknown[])[0]).toEqual(rec("a", 100));
    expect((await post("/friction/recent", { ledgerKey: ledger() })).data).toEqual({ records: [] });
  });

  it("re-recording a run id replaces it (idempotent retries), and limit/sinceMs filter", async () => {
    const key = ledger();
    for (let i = 1; i <= 5; i++) await post("/friction/record", { ledgerKey: key, record: rec(`r${i}`, i * 100) });
    await post("/friction/record", { ledgerKey: key, record: rec("r3", 300, { diagnosis: diagnosis("replaced") }) });
    const all = (await post("/friction/recent", { ledgerKey: key })).data.records as Array<{ runId: string; diagnosis: { verdict: string } }>;
    expect(all.map((r) => r.runId)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(all[2].diagnosis.verdict).toBe("replaced");
    const limited = (await post("/friction/recent", { ledgerKey: key, limit: 2 })).data.records as Array<{ runId: string }>;
    expect(limited.map((r) => r.runId)).toEqual(["r4", "r5"]);
    const since = (await post("/friction/recent", { ledgerKey: key, sinceMs: 300 })).data.records as Array<{ runId: string }>;
    expect(since.map((r) => r.runId)).toEqual(["r3", "r4", "r5"]);
  });

  it("is bounded: beyond 500 runs the oldest fall off", async () => {
    const key = ledger();
    // Record 505 runs; the DO trims on every write so the table never exceeds 500.
    let retained = 0;
    for (let i = 1; i <= 505; i++) {
      retained = (await post("/friction/record", { ledgerKey: key, record: rec(`r${String(i).padStart(4, "0")}`, i) })).data.retained as number;
    }
    expect(retained).toBe(500);
    const all = (await post("/friction/recent", { ledgerKey: key })).data.records as Array<{ runId: string }>;
    expect(all).toHaveLength(500);
    expect(all[0].runId).toBe("r0006");
    expect(all.at(-1)?.runId).toBe("r0505");
  }, 60_000);

  it("validates: bad ledger key, malformed record, oversized record, bad limit/sinceMs → 400", async () => {
    const key = ledger();
    expect((await post("/friction/record", { ledgerKey: "has space", record: rec("a", 1) })).status).toBe(400);
    expect((await post("/friction/record", { ledgerKey: key, record: { runId: "a" } })).data).toEqual({
      error: "record must be a FrictionRunRecord (runId, finishedAt, diagnosis)",
    });
    expect((await post("/friction/record", { ledgerKey: key, record: rec("a", "1" as unknown as number) })).status).toBe(400);
    expect((await post("/friction/record", { ledgerKey: key, record: rec("", 1) })).status).toBe(400); // empty run id: no PK identity
    const huge = rec("a", 1, { label: "x".repeat(70_000) });
    expect((await post("/friction/record", { ledgerKey: key, record: huge })).status).toBe(400);
    expect((await post("/friction/recent", { ledgerKey: key, limit: 0 })).status).toBe(400);
    expect((await post("/friction/recent", { ledgerKey: key, limit: 5000 })).status).toBe(400);
    expect((await post("/friction/recent", { ledgerKey: key, sinceMs: -1 })).status).toBe(400);
    expect((await post("/friction/recent", { ledgerKey: key })).data).toEqual({ records: [] }); // nothing landed
  });

  it("refuses without the bearer, and non-POST is 405", async () => {
    const key = ledger();
    expect((await post("/friction/record", { ledgerKey: key, record: rec("a", 1) }, { "content-type": "application/json" })).status).toBe(401);
    expect((await post("/friction/recent", { ledgerKey: key }, { ...AUTH, authorization: "Bearer wrong" })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/friction/recent`, { headers: AUTH })).status).toBe(405);
  });
});
