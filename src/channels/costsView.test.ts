import { describe, expect, it } from "vitest";
import type { CostReport } from "../core/costs.js";
import type { CostsByReport } from "../core/costsBy.js";
import type { CostsSnapshotStatus } from "../core/costsSnapshot.js";
import { NoCostsSnapshotError, NullCostsService, type CostsService } from "../core/costsService.js";
import { ACTORS } from "../core/authz/testing.js";
import { createCostsViewHandler, parseCostsRoute, type CostsViewContext } from "./costsView.js";
import { makeShellRenderer } from "./webShell.js";
import { ALL_CAPABILITIES } from "../core/capabilities.js";
import { SEED_ELEMENT_ID, type CostsSeed } from "./webSeed.js";

// The costs dash handler: routing, the snapshot-backed reads and the status the seed carries, error statuses,
// the JSON twin, and the seed the shell carries. Rendering is tested in
// web/src/pages/costs.test.ts.

// ---- fixtures ---------------------------------------------------------------

function report(over: Partial<CostReport> = {}): CostReport {
  const day = (date: string, bot: number, llm: number) => ({
    date,
    containers: { bot: { cpu: bot * 0.1, memory: bot * 0.8, disk: bot * 0.1, total: bot } },
    durableObjects: { "bot DO": 0.2 },
    doRequestsUsd: 0.05,
    doRowsUsd: 0,
    doStorageUsd: 0,
    workersUsd: 0,
    r2Usd: 0,
    workflowsUsd: 0,
    cloudUsd: bot + 0.25,
    llmUsd: llm,
    llmEstimated: false,
    llmUnpricedTokens: 0,
    total: bot + 0.25 + llm,
  });
  const days = [day("2026-08-27", 0.3, 4), day("2026-08-28", 1.3, 12.5), day("2026-08-29", 0.9, 3)];
  const cloudUsd = days.reduce((s, d) => s + d.cloudUsd, 0);
  return {
    group: "switchboard",
    label: "Switchboard <b>",
    range: { from: "2026-08-27", to: "2026-08-29", days: 3, partialLastDay: true },
    llmAvailable: true,
    days,
    totals: {
      cloudUsd,
      llmUsd: 19.5,
      total: days.reduce((s, d) => s + d.total, 0),
      byResource: {
        cpu: 0.25,
        memory: 2.0,
        disk: 0.25,
        durableObjects: 0.75,
        workers: 0,
        doRows: 0,
        doStorage: 0,
        r2: 0,
        workflows: 0,
      },
    },
    generatedAt: Date.parse("2026-08-29T12:00:00Z"),
    account: { id: "acct-example", cloudUsd },
    attribution: {
      workers: ["switchboard"],
      containerApps: {},
      durableObjectNamespaces: {},
      r2Buckets: {},
      workflows: {},
    },
    ...over,
  };
}

const shell = makeShellRenderer({ js: "/assets/main-test.js", css: [] }, ALL_CAPABILITIES);

function seedOf(html: string): CostsSeed {
  const m = new RegExp(`<script type="application/json" id="${SEED_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!m) throw new Error("no seed island in the page");
  return JSON.parse(m[1]) as CostsSeed;
}

/** The status a snapshot-serving service reports: taken on schedule, the next one due a day later. */
const STATUS: CostsSnapshotStatus = {
  snapshot: { takenAt: "2026-08-29T06:15:00.000Z", takenBy: "schedule", durationMs: 31_000 },
  inFlight: null,
  everyHours: 24,
  nextAt: "2026-08-30T06:15:00.000Z",
  lastFailure: null,
};
const NONE_YET: CostsSnapshotStatus = {
  snapshot: null,
  inFlight: null,
  everyHours: 24,
  nextAt: null,
  lastFailure: null,
};

function fakeService(
  impl: (group: string, days: string | null) => Promise<CostReport>,
  groups = ["switchboard"],
  byReport: CostsService["byReport"] = () => Promise.reject(new Error("no by-user report in this test")),
  status: CostsSnapshotStatus = STATUS,
): CostsService {
  return {
    groups: () => groups,
    report: impl,
    byReport,
    status: () => status,
    snapshot: () => Promise.reject(new Error("no take in this test")),
    subscribe: () => () => undefined,
  };
}

/** A by-user report shaped like the builder's, small. */
function byReport(): CostsByReport {
  const r = report();
  return {
    group: r.group,
    range: r.range,
    coverage: { from: r.range.from, retentionDays: 30, clamped: false, historyOn: true },
    users: [
      {
        userId: "slack:UALICE",
        userName: "alice",
        runs: 3,
        wallMs: 60_000,
        llmUsd: 12,
        cloudUsd: 1,
        totalUsd: 13,
        unpricedTokens: 0,
        byModel: {},
      },
    ],
    days: [],
    pending: 0,
    reconciliation: {
      attributedLlmUsd: 12,
      workspaceLlmUsd: 19.5,
      unattributedLlmUsd: 7.5,
      comparedDays: 3,
      uncomparedDays: 0,
      uncomparedLlmUsd: 0,
      cloudAllocatedUsd: 1,
      cloudUnallocatedUsd: 2.4,
    },
    viewer: { userIds: ["slack:UALICE"], matchedByEmail: true },
    generatedAt: r.generatedAt,
  };
}

function fakeReqRes(method: string, url: string) {
  let status = 0;
  let outHeaders: Record<string, string> = {};
  const chunks: string[] = [];
  const closers: Array<() => void> = [];
  const req = {
    method,
    url,
    headers: {},
    on: (event: string, cb: () => void) => {
      if (event === "close") closers.push(cb);
    },
  };
  const res = {
    writeHead: (s: number, h?: Record<string, string>) => {
      status = s;
      outHeaders = h ?? {};
    },
    write: (c: string) => void chunks.push(c),
    end: (c?: string) => {
      if (c) chunks.push(c);
    },
  };
  return {
    req: req as unknown as Parameters<ReturnType<typeof createCostsViewHandler>>[0],
    res: res as unknown as Parameters<ReturnType<typeof createCostsViewHandler>>[1],
    get status() {
      return status;
    },
    get headers() {
      return outHeaders;
    },
    body: () => chunks.join(""),
    /** The client leaving: what node:http fires `close` for. */
    close: () => closers.forEach((cb) => cb()),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- routing ----------------------------------------------------------------

describe("parseCostsRoute", () => {
  it("matches the bare index, a group page, and a group's JSON twin", () => {
    expect(parseCostsRoute("/costs")).toEqual({ kind: "page", group: null, view: "daily" });
    expect(parseCostsRoute("/costs/")).toEqual({ kind: "page", group: null, view: "daily" });
    expect(parseCostsRoute("/costs/switchboard")).toEqual({ kind: "page", group: "switchboard", view: "daily" });
    expect(parseCostsRoute("/costs/switchboard.json")).toEqual({ kind: "json", group: "switchboard", view: "daily" });
    expect(parseCostsRoute("/costs.json")).toEqual({ kind: "json", group: null, view: "daily" });
  });
  // costs.md item 10: the by-user tab and its twin.
  it("matches the by-user tab (?view=users) and its JSON twin /costs/<group>/users.json; a twin never has a view", () => {
    expect(parseCostsRoute("/costs/switchboard", "?view=users&days=7")).toEqual({
      kind: "page",
      group: "switchboard",
      view: "users",
    });
    expect(parseCostsRoute("/costs", "?view=users")).toEqual({ kind: "page", group: null, view: "users" });
    expect(parseCostsRoute("/costs/switchboard", "?view=bogus")).toEqual({
      kind: "page",
      group: "switchboard",
      view: "daily",
    });
    expect(parseCostsRoute("/costs/switchboard/users.json")).toEqual({
      kind: "users-json",
      group: "switchboard",
      view: "users",
    });
    expect(parseCostsRoute("/costs/switchboard.json", "?view=users")).toEqual({
      kind: "json",
      group: "switchboard",
      view: "daily",
    });
    expect(parseCostsRoute("/costs/../users.json")).toBeNull();
    expect(parseCostsRoute("/costs/switchboard/other.json")).toBeNull();
  });
  // costs.md item 8b: the status feed rides the page route with `?stream=1`.
  it("matches the status feed (?stream=1) on the bare index and a group page; a twin never streams", () => {
    expect(parseCostsRoute("/costs", "?stream=1")).toEqual({ kind: "stream", group: null, view: "daily" });
    expect(parseCostsRoute("/costs/switchboard", "?stream=1&view=users")).toEqual({
      kind: "stream",
      group: "switchboard",
      view: "users",
    });
    expect(parseCostsRoute("/costs/switchboard", "?stream=0")).toEqual({
      kind: "page",
      group: "switchboard",
      view: "daily",
    });
    expect(parseCostsRoute("/costs/switchboard.json", "?stream=1")).toEqual({
      kind: "json",
      group: "switchboard",
      view: "daily",
    });
  });
  it("rejects anything else, including traversal-shaped and over-long slugs", () => {
    expect(parseCostsRoute("/costsX")).toBeNull();
    expect(parseCostsRoute("/costs/a/b")).toBeNull();
    expect(parseCostsRoute("/costs/../x")).toBeNull();
    expect(parseCostsRoute("/costs/" + "a".repeat(80))).toBeNull();
    expect(parseCostsRoute("/runs")).toBeNull();
  });
});

// ---- handler ----------------------------------------------------------------------

describe("createCostsViewHandler", () => {
  it("ignores paths it does not own", () => {
    const h = createCostsViewHandler(
      fakeService(() => Promise.resolve(report())),
      shell,
    );
    const io = fakeReqRes("GET", "/runs");
    expect(h(io.req, io.res)).toBe(false);
    expect(io.status).toBe(0);
  });

  it("503s with a pointer to the config when the process has no cost reporting (the null service has no groups)", () => {
    const h = createCostsViewHandler(new NullCostsService(), shell);
    const io = fakeReqRes("GET", "/costs");
    expect(h(io.req, io.res)).toBe(true);
    expect(io.status).toBe(503);
    expect(io.body()).toContain("costs.cloudflareAccountId");
    expect(io.body()).toContain("CF_ANALYTICS_TOKEN");
  });

  it("405s non-GET", () => {
    const h = createCostsViewHandler(
      fakeService(() => Promise.resolve(report())),
      shell,
    );
    const io = fakeReqRes("POST", "/costs");
    expect(h(io.req, io.res)).toBe(true);
    expect(io.status).toBe(405);
    expect(io.headers.allow).toBe("GET");
  });

  it("serves the first group on the bare index — the service asked on every request — with the hardened page headers and the report, the groups and the snapshot's status as the seed", async () => {
    let calls = 0;
    const h = createCostsViewHandler(
      fakeService(
        (group, days) => {
          calls++;
          expect(group).toBe("switchboard");
          expect(days).toBeNull();
          return Promise.resolve(report());
        },
        ["switchboard", "other"],
      ),
      shell,
    );
    for (let i = 0; i < 2; i++) {
      const io = fakeReqRes("GET", "/costs");
      expect(h(io.req, io.res)).toBe(true);
      await tick();
      expect(io.status).toBe(200);
      expect(io.headers["content-type"]).toContain("text/html");
      expect(io.headers["cache-control"]).toBe("no-store");
      expect(io.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(io.headers["x-frame-options"]).toBe("DENY");
      const seed = seedOf(io.body());
      expect(seed.page).toBe("costs");
      expect(seed.group).toBe("switchboard");
      expect(seed.report).toEqual(report());
      expect(seed.groups).toEqual(["switchboard", "other"]);
      expect(seed.snapshot).toEqual(STATUS);
      // the title interpolation escapes the hostile label; the seed keeps it as data
      expect(io.body()).toContain("<title>Switchboard &lt;b&gt; spend</title>");
      expect(io.body()).not.toContain("<title>Switchboard <b>");
    }
    expect(calls).toBe(2);
  });

  // costs.md item 10: the by-user tab reads one more report, only when asked
  // for, with the verified viewer; its twin serves exactly that report.
  it("?view=users seeds the by-user report beside the daily one and hands the viewer through; the twin serves the report; the daily page reads no by-user report", async () => {
    const calls: Array<{ group: string; days: string | null; viewer: unknown }> = [];
    const h = createCostsViewHandler(
      fakeService(
        () => Promise.resolve(report()),
        ["switchboard"],
        (group, days, viewer) => {
          calls.push({ group, days, viewer });
          return Promise.resolve(byReport());
        },
      ),
      shell,
    );
    const identity = { sub: "access-sub-1", email: "alice@example.com" };
    const page = fakeReqRes("GET", "/costs/switchboard?view=users&days=7");
    h(page.req, page.res, { identity });
    await tick();
    expect(page.status).toBe(200);
    const seed = seedOf(page.body());
    expect(seed.view).toBe("users");
    expect(seed.users).toEqual(byReport());
    expect(seed.report).toEqual(report());
    expect(calls).toEqual([{ group: "switchboard", days: "7", viewer: identity }]);

    const twin = fakeReqRes("GET", "/costs/switchboard/users.json?days=7");
    h(twin.req, twin.res, { identity });
    await tick();
    expect(twin.status).toBe(200);
    expect(twin.headers["content-type"]).toContain("application/json");
    expect(twin.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(twin.body())).toEqual(byReport());
    expect(calls).toHaveLength(2);

    const daily = fakeReqRes("GET", "/costs/switchboard");
    h(daily.req, daily.res, { identity });
    await tick();
    expect(seedOf(daily.body()).view).toBe("daily");
    expect(seedOf(daily.body()).users).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("a by-user read that fails upstream is a capped 502 like the daily one", async () => {
    const h = createCostsViewHandler(
      fakeService(
        () => Promise.resolve(report()),
        ["switchboard"],
        () => Promise.reject(new Error("run history unreachable " + "x".repeat(600))),
      ),
      shell,
    );
    const io = fakeReqRes("GET", "/costs/switchboard/users.json");
    h(io.req, io.res, {});
    await tick();
    expect(io.status).toBe(502);
    expect(io.body()).toContain("cost report unavailable: run history unreachable");
    expect(io.body().length).toBeLessThan(450);
  });

  // costs.md item 6: before the first snapshot lands nothing reads a source in
  // the request — the page shows the status alone, the twins say come back.
  it("before the first snapshot: the page is served with no report and the status (none yet, nothing in flight), a twin is a 503 with Retry-After — never a live read, never a 500", async () => {
    let taking: CostsSnapshotStatus = NONE_YET;
    const h = createCostsViewHandler(
      {
        groups: () => ["switchboard"],
        report: () => Promise.reject(new NoCostsSnapshotError()),
        byReport: () => Promise.reject(new NoCostsSnapshotError()),
        status: () => taking,
        snapshot: () => Promise.reject(new Error("no take in this test")),
        subscribe: () => () => undefined,
      },
      shell,
    );
    const page = fakeReqRes("GET", "/costs/switchboard?view=users&days=7");
    h(page.req, page.res, { identity: { sub: "s" } });
    await tick();
    expect(page.status).toBe(200);
    expect(page.body()).toContain("<title>switchboard spend</title>");
    const seed = seedOf(page.body());
    expect(seed).toMatchObject({
      page: "costs",
      group: "switchboard",
      report: null,
      view: "users",
      snapshot: NONE_YET,
    });
    expect(seed.users).toBeUndefined();

    // A take in flight rides the same status field.
    taking = { ...NONE_YET, inFlight: { startedAt: "2026-08-29T06:15:00.000Z", by: "casey" } };
    const again = fakeReqRes("GET", "/costs");
    h(again.req, again.res);
    await tick();
    expect(seedOf(again.body()).snapshot.inFlight).toEqual({ startedAt: "2026-08-29T06:15:00.000Z", by: "casey" });

    for (const path of ["/costs/switchboard.json", "/costs/switchboard/users.json", "/costs.json"]) {
      const twin = fakeReqRes("GET", path);
      h(twin.req, twin.res);
      await tick();
      expect(twin.status).toBe(503);
      expect(twin.headers["retry-after"]).toBe("60");
      expect(twin.body()).toContain("no cost snapshot yet");
    }
  });

  // costs.md item 8b: the seed says whether the viewer may take a snapshot — the
  // same `costs:write` row `/api/costs.snapshot` decides on — and the feed
  // streams the status, the current one first, then every transition.
  it("seeds canSnapshot from the viewer's actor: true for a `costs:write` holder, false for a member and for no actor", async () => {
    const h = createCostsViewHandler(
      fakeService(() => Promise.resolve(report())),
      shell,
    );
    const seedFor = async (actor: CostsViewContext["actor"]) => {
      const io = fakeReqRes("GET", "/costs");
      h(io.req, io.res, { identity: { sub: "s" }, ...(actor ? { actor } : {}) });
      await tick();
      return seedOf(io.body()).canSnapshot;
    };
    expect(await seedFor(ACTORS.admin)).toBe(true);
    expect(await seedFor(ACTORS.member)).toBe(false);
    expect(await seedFor(ACTORS.browser)).toBe(false);
    expect(await seedFor(undefined)).toBe(false);
  });

  it("?stream=1 serves the status feed: SSE headers, the current status as the first frame, then one frame per transition until the client leaves", async () => {
    const listeners = new Set<(s: CostsSnapshotStatus) => void>();
    const service: CostsService = {
      ...fakeService(() => Promise.resolve(report())),
      subscribe: (l) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
    };
    const h = createCostsViewHandler(service, shell);
    const io = fakeReqRes("GET", "/costs/switchboard?stream=1");
    expect(h(io.req, io.res)).toBe(true);
    expect(io.status).toBe(200);
    expect(io.headers["content-type"]).toContain("text/event-stream");
    const frames = () =>
      io
        .body()
        .split("\n\n")
        .filter((f) => f.startsWith("data: "))
        .map((f) => JSON.parse(f.slice("data: ".length)) as Record<string, unknown>);
    expect(frames()).toEqual([{ type: "status", ...STATUS }]);
    expect(listeners.size).toBe(1);
    const taking = { ...STATUS, inFlight: { startedAt: "2026-08-29T21:30:00.000Z", by: "casey" } };
    for (const l of listeners) l(taking);
    expect(frames()).toHaveLength(2);
    expect(frames()[1]).toEqual({ type: "status", ...taking });
    // The client leaving unsubscribes: nothing more is written.
    io.close();
    expect(listeners.size).toBe(0);
  });

  it("passes ?days through and 404s an unknown group", async () => {
    const h = createCostsViewHandler(
      fakeService((_g, days) =>
        Promise.resolve(report({ range: { from: "x", to: "y", days: Number(days), partialLastDay: false } })),
      ),
      shell,
    );
    const ok = fakeReqRes("GET", "/costs/switchboard?days=7");
    h(ok.req, ok.res);
    await tick();
    expect(ok.status).toBe(200);
    expect(seedOf(ok.body()).report?.range.days).toBe(7);

    const miss = fakeReqRes("GET", "/costs/nope");
    expect(h(miss.req, miss.res)).toBe(true);
    expect(miss.status).toBe(404);
  });

  it("serves the JSON twin for agents with no-store", async () => {
    const h = createCostsViewHandler(
      fakeService(() => Promise.resolve(report())),
      shell,
    );
    const io = fakeReqRes("GET", "/costs/switchboard.json");
    h(io.req, io.res);
    await tick();
    expect(io.status).toBe(200);
    expect(io.headers["content-type"]).toContain("application/json");
    expect(io.headers["cache-control"]).toBe("no-store");
    const parsed = JSON.parse(io.body()) as CostReport;
    expect(parsed.group).toBe("switchboard");
    expect(parsed.days).toHaveLength(3);
  });

  it("502s (never 500s, never leaks) when an upstream source fails", async () => {
    const h = createCostsViewHandler(
      fakeService(() => Promise.reject(new Error("cloudflare graphql 403: denied " + "x".repeat(2000)))),
      shell,
    );
    const io = fakeReqRes("GET", "/costs");
    h(io.req, io.res);
    await tick();
    expect(io.status).toBe(502);
    expect(io.body()).toContain("cloudflare graphql 403");
    expect(io.body().length).toBeLessThan(600);
  });
});
