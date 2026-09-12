import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Feature: docs/reference/specs/delivery.md item 10 — the DeliveryDO: one
// repository's delivery snapshot (the merged pull requests' facts over the
// snapshot window, and when they were read), replaced whole on every put.
// Runs in workerd against the real SQLite-backed Durable Object.

const BASE = "https://memory.test";
const AUTH = { authorization: "Bearer test-token", "content-type": "application/json" };

// One DeliveryDO exists (named "delivery"); tests share it, so each uses a unique repository.
let n = 0;
const repo = () => `acme/repo-${Date.now().toString(36)}-${n++}`;

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

const pr = (number: number, mergedAt: string, over: Record<string, unknown> = {}) => ({
  number,
  title: `change ${number}`,
  author: "alice",
  createdAt: "2026-06-01T09:00:00Z",
  mergedAt,
  firstHeadSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
  ci: [
    {
      headSha: "28837ecbdc07dd578743919c3a071dcd3756a47a",
      trigger: "pull_request",
      conclusion: "success",
      attempt: 1,
      createdAt: "2026-06-01T09:05:00Z",
    },
  ],
  reviews: [
    {
      author: "acme-review[bot]",
      state: "commented",
      submittedAt: "2026-06-01T10:00:00Z",
      body: "Changes requested.\n- [blocking] F1 a.ts — the bug",
    },
  ],
  pushes: [
    { actor: "alice", at: "2026-06-01T11:00:00Z", kind: "force", coauthors: ["Claude <noreply@anthropic.com>"] },
  ],
  ...over,
});

const snapshot = (r: string, over: Record<string, unknown> = {}) => ({
  repo: r,
  snapshotAt: "2026-09-12T14:00:00Z",
  range: { since: "2026-06-15T00:00:00Z".slice(0, 10), until: "2026-09-12T00:00:00Z".slice(0, 10), weeks: 13 },
  prs: [
    pr(2, "2026-09-11T12:00:00Z"),
    pr(1, "2026-06-20T12:00:00Z", { issue: { number: 9, createdAt: "2026-06-10T00:00:00Z" } }),
  ],
  truncated: false,
  completeFrom: "2026-06-15T00:00:00Z",
  ...over,
});

describe("DeliveryDO routes", () => {
  it("advertises the feature; refuses unauthenticated and non-POST", async () => {
    const health = await SELF.fetch(`${BASE}/healthz`);
    expect(((await health.json()) as { features: string[] }).features).toContain("delivery");
    expect((await post("/delivery/get", { repo: "acme/api" }, { "content-type": "application/json" })).status).toBe(
      401,
    );
    expect((await SELF.fetch(`${BASE}/delivery/get`, { method: "GET" })).status).toBe(405);
  });

  it("get of an unknown repository is null; put stores the snapshot and get returns it verbatim, pull requests in number order; a later put replaces it whole", async () => {
    const r = repo();
    expect((await post("/delivery/get", { repo: r })).data).toEqual({ snapshot: null });
    const first = snapshot(r);
    expect((await post("/delivery/put", { snapshot: first })).data).toEqual({ ok: true, prs: 2 });
    expect((await post("/delivery/get", { repo: r })).data).toEqual({
      snapshot: { ...first, prs: [first.prs[1], first.prs[0]] },
    });
    const second = snapshot(r, {
      snapshotAt: "2026-09-12T15:00:00Z",
      prs: [pr(3, "2026-09-12T14:30:00Z")],
      truncated: true,
    });
    expect((await post("/delivery/put", { snapshot: second })).data).toEqual({ ok: true, prs: 1 });
    expect((await post("/delivery/get", { repo: r })).data).toEqual({ snapshot: second });
    // Another repository's snapshot is untouched.
    const other = repo();
    await post("/delivery/put", { snapshot: snapshot(other, { prs: [] }) });
    expect((await post("/delivery/get", { repo: r })).data).toEqual({ snapshot: second });
    expect(((await post("/delivery/get", { repo: other })).data.snapshot as { prs: unknown[] }).prs).toEqual([]);
  });

  it("validates: a malformed snapshot, a repository that is not owner/name and a bad get are 400; an oversize body is 413; an unknown route 404", async () => {
    expect((await post("/delivery/put", { snapshot: { repo: repo() } })).status).toBe(400);
    expect((await post("/delivery/put", { snapshot: snapshot("../etc") })).status).toBe(400);
    expect((await post("/delivery/put", { snapshot: snapshot(repo(), { prs: [{ number: 1 }] }) })).status).toBe(400);
    expect((await post("/delivery/get", {})).status).toBe(400);
    expect((await post("/delivery/get", { repo: "not a slug" })).status).toBe(400);
    const huge = snapshot(repo(), {
      prs: Array.from({ length: 40 }, (_, i) =>
        pr(i + 1, "2026-09-11T12:00:00Z", {
          reviews: [
            { author: "a", state: "commented", submittedAt: "2026-06-01T10:00:00Z", body: "x".repeat(220 * 1024) },
          ],
        }),
      ),
    });
    expect((await post("/delivery/put", { snapshot: huge })).status).toBe(413);
    expect((await post("/delivery/nope", { repo: repo() })).status).toBe(404);
  });
});
