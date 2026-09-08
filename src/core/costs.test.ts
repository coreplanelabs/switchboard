import { describe, expect, it } from "vitest";
import {
  AnthropicCostReportSource,
  CLOUDFLARE_PRICES,
  CloudflareGraphqlUsageSource,
  NullLlmCostSource,
  NullCostsService,
  COSTS_OFF_MESSAGE,
  buildCostReport,
  containerCostUsd,
  doDurationCostUsd,
  doRequestsCostUsd,
  parseCostsConfig,
  resolveRange,
  type CloudflareUsage,
  type CostGroupConfig,
  type LlmCostRow,
} from "./costs.js";

// ---- fixtures ---------------------------------------------------------------

/** A calendar day as the billing datasets spell it (YYYY-MM-DD, UTC). */
const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);

const AUG_1 = iso(2026, 8, 1);
const AUG_23 = iso(2026, 8, 23);
const AUG_27 = iso(2026, 8, 27);
const AUG_28 = iso(2026, 8, 28);
const AUG_29 = iso(2026, 8, 29);
const AUG_30 = iso(2026, 8, 30);
const JUL_31 = iso(2026, 7, 31);
const midnight = (day: string) => `${day}T00:00:00Z`;

const GROUP: CostGroupConfig = {
  label: "Switchboard",
  workers: ["switchboard", "switchboard-resident", "switchboard-sandbox", "switchboard-memory"],
  containerApps: {
    "app-bot": "bot",
    "app-resident": "resident",
    "app-sandbox": "sandbox",
  },
  durableObjectNamespaces: {
    "ns-bot": "bot DO",
    "ns-resident": "resident DOs",
  },
  anthropicWorkspaceId: "wrkspc_switchboard",
};

const GiB = 2 ** 30;
const GB = 1e9;

/** A resident's day, shaped like a row of Cloudflare's container billing dataset. */
const RESIDENT_DAY = {
  date: AUG_28,
  applicationId: "app-resident",
  cpuTimeSec: 2293,
  allocatedMemoryByteSec: 386600 * GiB,
  allocatedDiskByteSec: 773200 * GB,
};

const USAGE: CloudflareUsage = {
  containers: [
    RESIDENT_DAY,
    {
      date: AUG_28,
      applicationId: "app-bot",
      cpuTimeSec: 2429,
      allocatedMemoryByteSec: 87450 * GiB,
      allocatedDiskByteSec: 349799 * GB,
    },
    // other-tenant shares the account but is NOT in the group → must be ignored
    {
      date: AUG_28,
      applicationId: "app-other",
      cpuTimeSec: 2155,
      allocatedMemoryByteSec: 339642 * GiB,
      allocatedDiskByteSec: 679284 * GB,
    },
    {
      date: AUG_29,
      applicationId: "app-bot",
      cpuTimeSec: 1110,
      allocatedMemoryByteSec: 76855 * GiB,
      allocatedDiskByteSec: 307420 * GB,
    },
  ],
  durableObjectRequests: [
    { date: AUG_28, scriptName: "switchboard", requests: 2160 },
    { date: AUG_28, scriptName: "other-tenant", requests: 994 },
    { date: AUG_29, scriptName: "switchboard", requests: 2377 },
  ],
  // Rows shaped like durableObjectsPeriodicGroups: `duration` is Cloudflare's
  // billable GB-s (128 MB × active seconds), per namespace.
  durableObjectDuration: [
    { date: AUG_28, namespaceId: "ns-bot", gbSeconds: 11023.7 },
    { date: AUG_28, namespaceId: "ns-resident", gbSeconds: 12011.5 },
    { date: AUG_28, namespaceId: "ns-other", gbSeconds: 11032.6 }, // other-tenant — not ours
    { date: AUG_29, namespaceId: "ns-bot", gbSeconds: 11002.9 },
  ],
};

const LLM: LlmCostRow[] = [
  { date: AUG_28, workspaceId: "wrkspc_switchboard", amountUsd: 12.5 },
  { date: AUG_28, workspaceId: "wrkspc_other", amountUsd: 99 },
  { date: AUG_29, workspaceId: null, amountUsd: 3 },
];

// ---- pricing math -----------------------------------------------------------

describe("containerCostUsd", () => {
  it("bills vCPU on active seconds and memory/disk on provisioned byte-seconds at list price", () => {
    const c = containerCostUsd(RESIDENT_DAY);
    expect(c.cpu).toBeCloseTo(2293 * CLOUDFLARE_PRICES.vcpuSecond, 6);
    expect(c.memory).toBeCloseTo(386600 * CLOUDFLARE_PRICES.memoryGibSecond, 6);
    expect(c.disk).toBeCloseTo(773200 * CLOUDFLARE_PRICES.diskGbSecond, 6);
    // matches the figure on the provider's own invoice for a day this size
    expect(c.total).toBeCloseTo(1.066, 3);
  });

  it("is zero for an idle (never-awake) row", () => {
    expect(
      containerCostUsd({ ...RESIDENT_DAY, cpuTimeSec: 0, allocatedMemoryByteSec: 0, allocatedDiskByteSec: 0 }).total,
    ).toBe(0);
  });
});

describe("durable object pricing", () => {
  it("prices billable GB-s at $12.50 per million — an always-on DO is 86400 s × 128 MB ≈ $0.135/day", () => {
    expect(doDurationCostUsd(1_000_000)).toBeCloseTo(12.5, 9);
    expect(doDurationCostUsd(86400 * 0.125)).toBeCloseTo(0.135, 3);
    // the fixture's bot DO row
    expect(doDurationCostUsd(11023.7)).toBeCloseTo(0.1378, 4);
  });
  it("prices requests at $0.15 per million", () => {
    expect(doRequestsCostUsd(1_000_000)).toBeCloseTo(0.15, 9);
    expect(doRequestsCostUsd(2160)).toBeCloseTo(0.000324, 9);
  });
});

// ---- report assembly ----------------------------------------------------------

describe("buildCostReport", () => {
  const range = { from: AUG_28, to: AUG_29, days: 2, partialLastDay: true };
  const report = buildCostReport("switchboard", GROUP, USAGE, LLM, range);

  it("keeps only the group's container apps, DO namespaces and workers, labelled from config", () => {
    const d = report.days.find((x) => x.date === AUG_28)!;
    expect(Object.keys(d.containers).sort()).toEqual(["bot", "resident"]);
    expect(Object.keys(d.durableObjects).sort()).toEqual(["bot DO", "resident DOs"]);
    expect(d.durableObjects["bot DO"]).toBeCloseTo(0.1378, 4);
    expect(d.doRequestsUsd).toBeCloseTo(0.000324, 9); // switchboard only, not other-tenant's 994
    expect(JSON.stringify(report)).not.toContain("other-tenant");
    expect(JSON.stringify(report)).not.toContain("ns-other");
  });

  it("keeps only the group's Anthropic workspace for LLM spend", () => {
    expect(report.days.find((x) => x.date === AUG_28)!.llmUsd).toBe(12.5);
    // null workspace = the org default workspace, which is NOT this group's
    expect(report.days.find((x) => x.date === AUG_29)!.llmUsd).toBe(0);
  });

  it("emits one row per day in range, oldest first, with zero-filled gaps", () => {
    const r = buildCostReport(
      "switchboard",
      GROUP,
      { containers: [], durableObjectRequests: [], durableObjectDuration: [] },
      [],
      { from: AUG_27, to: AUG_29, days: 3, partialLastDay: false },
    );
    expect(r.days.map((d) => d.date)).toEqual([AUG_27, AUG_28, AUG_29]);
    expect(r.days.every((d) => d.total === 0)).toBe(true);
    expect(r.totals.total).toBe(0);
  });

  it("totals per day and across the range, and splits cloud vs LLM", () => {
    const d = report.days.find((x) => x.date === AUG_28)!;
    const containers = d.containers.bot.total + d.containers.resident.total;
    const dos = d.durableObjects["bot DO"] + d.durableObjects["resident DOs"] + d.doRequestsUsd;
    expect(d.cloudUsd).toBeCloseTo(containers + dos, 9);
    expect(d.total).toBeCloseTo(containers + dos + 12.5, 9);
    expect(report.totals.total).toBeCloseTo(
      report.days.reduce((s, x) => s + x.total, 0),
      9,
    );
    expect(report.totals.llmUsd).toBe(12.5);
  });

  it("splits cloud spend by billed resource so the 'what a dollar buys' view is exact", () => {
    const split = report.totals.byResource;
    expect(split.cpu + split.memory + split.disk + split.durableObjects).toBeCloseTo(report.totals.cloudUsd, 9);
    expect(split.memory).toBeGreaterThan(split.cpu); // provisioned memory dominates
  });

  it("carries the range and the partial-last-day flag through", () => {
    expect(report.range).toEqual(range);
    expect(report.group).toBe("switchboard");
    expect(report.label).toBe("Switchboard");
  });

  it("reports llm as unavailable (not zero) when there is no LLM source", () => {
    const r = buildCostReport("switchboard", GROUP, USAGE, null, range);
    expect(r.llmAvailable).toBe(false);
    expect(r.days.every((d) => d.llmUsd === 0)).toBe(true);
  });
});

// ---- range ------------------------------------------------------------------------

describe("resolveRange", () => {
  const now = new Date(Date.UTC(2026, 7, 29, 21, 35));
  it("defaults to 30 days ending today (UTC), today flagged partial", () => {
    const r = resolveRange(null, now);
    expect(r).toEqual({ from: JUL_31, to: AUG_29, days: 30, partialLastDay: true });
  });
  it("clamps ?days to 1..90 and rejects garbage", () => {
    expect(resolveRange("7", now).from).toBe(AUG_23);
    expect(resolveRange("0", now).days).toBe(1);
    expect(resolveRange("9999", now).days).toBe(90);
    expect(resolveRange("abc", now).days).toBe(30);
  });
});

// ---- config -----------------------------------------------------------------------

describe("parseCostsConfig", () => {
  it("accepts a well-formed block and applies env-name defaults", () => {
    const c = parseCostsConfig({
      cloudflareAccountId: "3c7b",
      groups: {
        switchboard: {
          workers: ["switchboard"],
          containerApps: { a: "bot" },
          durableObjectNamespaces: { n1: "bot DO" },
        },
      },
    });
    expect(c?.cloudflareTokenEnv).toBe("CF_ANALYTICS_TOKEN");
    expect(c?.groups.switchboard.durableObjectNamespaces).toEqual({ n1: "bot DO" });
    expect(c?.anthropicAdminKeyEnv).toBe("ANTHROPIC_ADMIN_KEY");
    expect(c?.groups.switchboard.workers).toEqual(["switchboard"]);
  });
  it("returns undefined for absent config and throws on a malformed one (never a silent half-config)", () => {
    expect(parseCostsConfig(undefined)).toBeUndefined();
    expect(() => parseCostsConfig({ groups: {} })).toThrow(/cloudflareAccountId/);
    expect(() => parseCostsConfig({ cloudflareAccountId: "x", groups: { g: { workers: "nope" } } })).toThrow(/workers/);
    expect(() =>
      parseCostsConfig({ cloudflareAccountId: "x", groups: { g: { workers: [], durableObjectNamespaces: { n: 1 } } } }),
    ).toThrow(/durableObjectNamespaces/);
  });
});

// ---- sources ------------------------------------------------------------------------

function fakeFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = handler(url, init ?? {});
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("CloudflareGraphqlUsageSource", () => {
  const GQL_OK = {
    data: {
      viewer: {
        accounts: [
          {
            containers: [
              {
                dimensions: { date: AUG_28, applicationId: "app1" },
                sum: { cpuTimeSec: 10, allocatedMemory: 20, allocatedDisk: 30 },
              },
            ],
            durableObjectRequests: [{ dimensions: { date: AUG_28, scriptName: "switchboard" }, sum: { requests: 5 } }],
            durableObjectDuration: [{ dimensions: { date: AUG_28, namespaceId: "ns1" }, sum: { duration: 7.5 } }],
          },
        ],
      },
    },
    errors: null,
  };

  it("POSTs a bearer-authed GraphQL query scoped to the account and maps rows", async () => {
    const f = fakeFetch(() => ({ status: 200, body: GQL_OK }));
    const src = new CloudflareGraphqlUsageSource({ accountId: "acct", token: "tok", fetchImpl: f.fetchImpl });
    const usage = await src.fetchUsage({ from: AUG_1, to: AUG_28, days: 28, partialLastDay: true });
    expect(f.calls[0].url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer tok");
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body.variables.accountTag).toBe("acct");
    expect(body.variables.from).toBe(midnight(AUG_1));
    expect(body.variables.to).toBe(midnight(AUG_29)); // exclusive end: the whole last day
    expect(usage.containers).toEqual([
      {
        date: AUG_28,
        applicationId: "app1",
        cpuTimeSec: 10,
        allocatedMemoryByteSec: 20,
        allocatedDiskByteSec: 30,
      },
    ]);
    expect(usage.durableObjectRequests).toEqual([{ date: AUG_28, scriptName: "switchboard", requests: 5 }]);
    expect(usage.durableObjectDuration).toEqual([{ date: AUG_28, namespaceId: "ns1", gbSeconds: 7.5 }]);
    expect(body.query).toContain("durableObjectsPeriodicGroups"); // the billable-duration dataset, not summed request wall time
  });

  it("throws on a non-200 and on GraphQL-level errors (the API returns 200 for those)", async () => {
    const bad = fakeFetch(() => ({ status: 403, body: { errors: [{ message: "denied" }] } }));
    await expect(
      new CloudflareGraphqlUsageSource({ accountId: "a", token: "t", fetchImpl: bad.fetchImpl }).fetchUsage(RANGE),
    ).rejects.toThrow(/403/);
    const gqlErr = fakeFetch(() => ({ status: 200, body: { data: null, errors: [{ message: "unknown field" }] } }));
    await expect(
      new CloudflareGraphqlUsageSource({ accountId: "a", token: "t", fetchImpl: gqlErr.fetchImpl }).fetchUsage(RANGE),
    ).rejects.toThrow(/unknown field/);
  });

  it("never puts the token in the URL or the error message", async () => {
    const bad = fakeFetch(() => ({ status: 500, body: {} }));
    const src = new CloudflareGraphqlUsageSource({ accountId: "a", token: "SECRET", fetchImpl: bad.fetchImpl });
    const err = await src.fetchUsage(RANGE).catch((e: Error) => e);
    expect(String(err)).not.toContain("SECRET");
    expect(bad.calls[0].url).not.toContain("SECRET");
  });
});

const RANGE = { from: AUG_1, to: AUG_28, days: 28, partialLastDay: true };

describe("AnthropicCostReportSource", () => {
  it("walks every page of the Admin cost report grouped by workspace and converts cents to dollars", async () => {
    const pages: Record<string, unknown> = {
      first: {
        data: [
          {
            starting_at: midnight(AUG_28),
            ending_at: midnight(AUG_29),
            results: [
              { amount: "1250.5", currency: "USD", workspace_id: "wrkspc_a" },
              { amount: "300", currency: "USD", workspace_id: null },
            ],
          },
        ],
        has_more: true,
        next_page: "p2",
      },
      p2: {
        data: [
          {
            starting_at: midnight(AUG_29),
            ending_at: midnight(AUG_30),
            results: [{ amount: "10", currency: "USD", workspace_id: "wrkspc_a" }],
          },
        ],
        has_more: false,
        next_page: null,
      },
    };
    const f = fakeFetch((url) => ({ status: 200, body: pages[new URL(url).searchParams.get("page") ?? "first"] }));
    const src = new AnthropicCostReportSource({ adminKey: "sk-ant-admin", fetchImpl: f.fetchImpl });
    const rows = await src.fetchDailyCost(RANGE);
    expect(rows).toEqual([
      { date: AUG_28, workspaceId: "wrkspc_a", amountUsd: 12.505 },
      { date: AUG_28, workspaceId: null, amountUsd: 3 },
      { date: AUG_29, workspaceId: "wrkspc_a", amountUsd: 0.1 },
    ]);
    const u = new URL(f.calls[0].url);
    expect(u.pathname).toBe("/v1/organizations/cost_report");
    expect(u.searchParams.getAll("group_by[]")).toEqual(["workspace_id"]);
    expect(u.searchParams.get("limit")).toBe("31");
    const h = f.calls[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("sk-ant-admin");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(f.calls[1].url).toContain("page=p2");
  });

  it("throws on a non-200 without leaking the key", async () => {
    const f = fakeFetch(() => ({ status: 401, body: { error: { message: "invalid x-api-key" } } }));
    const err = await new AnthropicCostReportSource({ adminKey: "sk-ant-admin-SECRET", fetchImpl: f.fetchImpl })
      .fetchDailyCost(RANGE)
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/401/);
    expect(String(err)).not.toContain("SECRET");
  });

  it("refuses a non-USD amount rather than mis-summing currencies", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: {
        data: [
          {
            starting_at: midnight(AUG_28),
            ending_at: "x",
            results: [{ amount: "1", currency: "EUR", workspace_id: null }],
          },
        ],
        has_more: false,
        next_page: null,
      },
    }));
    await expect(
      new AnthropicCostReportSource({ adminKey: "k", fetchImpl: f.fetchImpl }).fetchDailyCost(RANGE),
    ).rejects.toThrow(/EUR/);
  });

  it("refuses a report that still has more pages past the page cap rather than returning a truncated total", async () => {
    // Every page claims another one follows: an endless report. Unreachable for a
    // ≤90-day range at limit=31, so this is the guard that makes it loud if it ever isn't.
    const f = fakeFetch(() => ({ status: 200, body: { data: [], has_more: true, next_page: "again" } }));
    await expect(
      new AnthropicCostReportSource({ adminKey: "k", fetchImpl: f.fetchImpl }).fetchDailyCost(RANGE),
    ).rejects.toThrow(/20 pages/);
    expect(f.calls.length).toBe(20);
  });
});

describe("NullLlmCostSource", () => {
  it("answers null so the report can say 'not configured' instead of $0", async () => {
    expect(await new NullLlmCostSource().fetchDailyCost(RANGE)).toBeNull();
  });
});

// Feature: features/routing-and-config.md item 16 — the Null Object a process
// without cost reporting is wired with.
describe("NullCostsService — the service of a process without cost reporting", () => {
  it("has no groups, and refuses a report with the reason the view shows", async () => {
    const service = new NullCostsService();
    expect(service.groups()).toEqual([]);
    await expect(service.report("switchboard", null)).rejects.toThrow(COSTS_OFF_MESSAGE);
    expect(COSTS_OFF_MESSAGE).toContain("CF_ANALYTICS_TOKEN");
  });
});
