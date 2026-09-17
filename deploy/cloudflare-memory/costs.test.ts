import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Feature: docs/reference/specs/costs.md item 6 — the CostsSnapshotDO: the
// installation's one costs snapshot (both billing sources' rows over the page's
// widest range, the run history's per-user usage, and when they were read),
// stored as one row per part and replaced whole on every put. Runs in workerd
// against the real SQLite-backed Durable Object.

const BASE = "https://memory.test";
/** A calendar day as the billing datasets spell it (YYYY-MM-DD, UTC). */
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const AUG_17 = iso(2026, 8, 17);
const SEP_16 = iso(2026, 9, 16);
const SEP_17 = iso(2026, 9, 17);
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

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

const snapshot = (over: Record<string, unknown> = {}) => ({
  takenAt: `${SEP_16}T06:15:00.000Z`,
  takenBy: "schedule",
  durationMs: 31_000,
  range: { from: AUG_17, to: SEP_16, days: 31, partialLastDay: true },
  usage: {
    containers: [
      {
        date: SEP_16,
        applicationId: "app-bot",
        cpuTimeSec: 3600,
        allocatedMemoryByteSec: 2 ** 30,
        allocatedDiskByteSec: 1e9,
      },
    ],
    durableObjectRequests: [{ date: SEP_16, scriptName: "switchboard", namespaceId: "ns-1", requests: 100 }],
    durableObjectDays: [{ date: SEP_16, namespaceId: "ns-1", gbSeconds: 12, rowsRead: 5, rowsWritten: 2 }],
    durableObjectStorage: [{ date: SEP_16, namespaceId: "ns-1", storedBytes: 4096 }],
    workers: [{ date: SEP_16, scriptName: "switchboard", requests: 1000, cpuTimeUs: 50_000 }],
    r2Storage: [],
    r2Operations: [],
    workflows: [],
  },
  llm: [{ date: SEP_16, workspaceId: "ws_1", amountUsd: 12.5, estimated: true }],
  runUsage: {
    rows: [
      {
        userId: "slack:UALICE",
        userName: "alice",
        day: SEP_16,
        threadKey: "slack:C1:1.0",
        channelId: "slack:C1",
        agent: "general",
        runs: 2,
        wallMs: 60_000,
        usage: {
          turns: 1,
          byModel: {
            "anthropic/claude-haiku-4-5": {
              turns: 1,
              inputTokens: 1000,
              outputTokens: 10,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        },
      },
    ],
    pending: 0,
    retentionDays: 30,
  },
  ...over,
});

// One CostsSnapshotDO exists (named "costs") and the tests share it, so they run in one
// serial block: each put replaces what the previous one stored.
describe.sequential("CostsSnapshotDO routes", () => {
  it("advertises the feature; refuses unauthenticated and non-POST", async () => {
    const health = await SELF.fetch(`${BASE}/healthz`);
    expect(((await health.json()) as { features: string[] }).features).toContain("costs");
    expect((await post("/costs/snapshot/get", {}, { "content-type": "application/json" })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/costs/snapshot/get`, { method: "GET" })).status).toBe(405);
  });

  it("put stores the snapshot and get returns it verbatim — LLM rows and run usage included — and a later put replaces it whole", async () => {
    const first = snapshot();
    expect((await post("/costs/snapshot/put", { snapshot: first })).data).toEqual({ ok: true });
    expect((await post("/costs/snapshot/get", {})).data).toEqual({ snapshot: first });
    const second = snapshot({ takenAt: `${SEP_17}T06:15:00.000Z`, takenBy: "casey", llm: null, runUsage: null });
    expect((await post("/costs/snapshot/put", { snapshot: second })).data).toEqual({ ok: true });
    expect((await post("/costs/snapshot/get", {})).data).toEqual({ snapshot: second });
  });

  it("refuses a body that is not a costs snapshot by shape (400) and leaves the stored one alone", async () => {
    const before = (await post("/costs/snapshot/get", {})).data;
    for (const bad of [
      {},
      { snapshot: { takenAt: `${SEP_17}T06:15:00.000Z` } },
      { snapshot: snapshot({ usage: { containers: [] } }) },
      { snapshot: snapshot({ llm: [{ date: SEP_16, workspaceId: "ws" }] }) },
    ]) {
      const res = await post("/costs/snapshot/put", bad);
      expect(res.status).toBe(400);
      expect(String(res.data.error)).toContain("snapshot must be a CostsSnapshot");
    }
    expect((await post("/costs/snapshot/get", {})).data).toEqual(before);
  });

  it("a put larger than the ordinary body fence is accepted: the snapshot route has the snapshot ceiling", async () => {
    const wide = snapshot({
      usage: {
        ...snapshot().usage,
        workers: Array.from({ length: 6000 }, (_, i) => ({
          date: SEP_16,
          scriptName: `worker-${i}-${"x".repeat(80)}`,
          requests: i,
          cpuTimeUs: i,
        })),
      },
    });
    expect(JSON.stringify(wide).length).toBeGreaterThan(512 * 1024);
    expect((await post("/costs/snapshot/put", { snapshot: wide })).data).toEqual({ ok: true });
    const read = (await post("/costs/snapshot/get", {})).data.snapshot as { usage: { workers: unknown[] } };
    expect(read.usage.workers).toHaveLength(6000);
  });
});
