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
  DAYS_PER_MONTH,
  doDurationCostUsd,
  doRequestsCostUsd,
  doRowsCostUsd,
  EMPTY_USAGE,
  parseCostsConfig,
  r2OperationClass,
  r2OperationsCostUsd,
  resolveRange,
  storageDayCostUsd,
  workersCostUsd,
  workflowsCostUsd,
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
  // Only the bot's namespace is labelled by hand; the resident's is attributed
  // through the invocations join (hosted by `switchboard-resident`).
  durableObjectNamespaces: {
    "ns-bot": "bot DO",
  },
  r2Buckets: {},
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
  // Rows shaped like durableObjectsInvocationsAdaptiveGroups: requests per
  // namespace, and the join that says which Worker hosts which namespace.
  durableObjectRequests: [
    { date: AUG_28, scriptName: "switchboard", namespaceId: "ns-bot", requests: 2160 },
    { date: AUG_28, scriptName: "switchboard-resident", namespaceId: "ns-resident", requests: 1000 },
    { date: AUG_28, scriptName: "other-tenant", namespaceId: "ns-other", requests: 994 },
    { date: AUG_29, scriptName: "switchboard", namespaceId: "ns-bot", requests: 2377 },
  ],
  // Rows shaped like durableObjectsPeriodicGroups: `duration` is Cloudflare's
  // billable GB-s (128 MB × active seconds), per namespace, plus SQLite rows.
  durableObjectDays: [
    { date: AUG_28, namespaceId: "ns-bot", gbSeconds: 11023.7, rowsRead: 1_000_000, rowsWritten: 100_000 },
    { date: AUG_28, namespaceId: "ns-resident", gbSeconds: 12011.5, rowsRead: 0, rowsWritten: 0 },
    { date: AUG_28, namespaceId: "ns-other", gbSeconds: 11032.6, rowsRead: 5_000_000, rowsWritten: 5_000_000 }, // other-tenant — not ours
    { date: AUG_29, namespaceId: "ns-bot", gbSeconds: 11002.9, rowsRead: 0, rowsWritten: 0 },
  ],
  // durableObjectsSqlStorageGroups: the day's peak bytes per namespace.
  durableObjectStorage: [
    { date: AUG_28, namespaceId: "ns-bot", storedBytes: 30.4375 * GB }, // exactly one GB-month-day → $0.20 × 1
    { date: AUG_28, namespaceId: "ns-other", storedBytes: 100 * GB },
  ],
  // workersInvocationsAdaptive: requests and CPU per script.
  workers: [
    { date: AUG_28, scriptName: "switchboard", requests: 1_000_000, cpuTimeUs: 1_000_000_000 }, // $0.30 + $0.02
    { date: AUG_28, scriptName: "other-tenant", requests: 9_000_000, cpuTimeUs: 0 },
  ],
  // r2StorageAdaptiveGroups / r2OperationsAdaptiveGroups: the resident's cache
  // bucket is named `<worker>-cache` by the deploy template — attributed by
  // that exact name, never listed in config; the tfstate bucket is someone else's.
  r2Storage: [
    { date: AUG_28, bucketName: "switchboard-resident-cache", bytes: 30.4375 * GB }, // $0.015 × 1
    { date: AUG_28, bucketName: "other-tenant-tfstate", bytes: 1 * GB },
    // Shares a Worker's name as a PREFIX but is not the template's `<worker>-cache`: someone else's.
    { date: AUG_28, bucketName: "switchboard-2-tfstate", bytes: 1 * GB },
  ],
  r2Operations: [
    { date: AUG_28, bucketName: "switchboard-resident-cache", actionType: "PutObject", requests: 1_000_000 }, // class A $4.50
    { date: AUG_28, bucketName: "switchboard-resident-cache", actionType: "GetObject", requests: 1_000_000 }, // class B $0.36
    { date: AUG_28, bucketName: "switchboard-resident-cache", actionType: "DeleteObjects", requests: 1_000_000 }, // free
    { date: AUG_28, bucketName: "other-tenant-tfstate", actionType: "PutObject", requests: 1_000_000 },
  ],
  // workflowsAdaptiveGroups: the resident Worker's refresh Workflow is named
  // `<worker>-refresh` by the deploy template — attributed by that exact name,
  // like the bucket; the other tenant's Workflow shares the suffix only.
  workflows: [
    { date: AUG_28, workflowName: "switchboard-resident-refresh", steps: 100_000, stateBytes: 30.4375 * GB }, // $0.80 + $0.20
    { date: AUG_28, workflowName: "other-tenant-refresh", steps: 1_000_000, stateBytes: 0 },
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

describe("the other meters Cloudflare bills a Workers deployment on", () => {
  it("SQLite rows: $0.001 per million read, $1.00 per million written", () => {
    expect(doRowsCostUsd(1_000_000, 0)).toBeCloseTo(0.001, 9);
    expect(doRowsCostUsd(0, 1_000_000)).toBeCloseTo(1, 9);
  });
  it("storage: a GB-month rate prorated per day over the mean month (30.4375 days) on the day's peak bytes", () => {
    expect(DAYS_PER_MONTH).toBe(365.25 / 12);
    expect(storageDayCostUsd(1e9, CLOUDFLARE_PRICES.doStorageGbMonth)).toBeCloseTo(0.2 / 30.4375, 12);
    expect(storageDayCostUsd(1e9, CLOUDFLARE_PRICES.r2StorageGbMonth)).toBeCloseTo(0.015 / 30.4375, 12);
    expect(storageDayCostUsd(0, 1)).toBe(0);
  });
  it("Workers: $0.30 per million requests plus $0.02 per million CPU-milliseconds (the dataset reports microseconds)", () => {
    expect(workersCostUsd(1_000_000, 0)).toBeCloseTo(0.3, 9);
    expect(workersCostUsd(0, 1_000_000_000)).toBeCloseTo(0.02, 9); // 1e9 µs = 1e6 ms
  });
  it("Workflows: $0.80 per 100,000 steps plus state at $0.20 per GB-month prorated per day; CPU and requests are not here — they ride the hosting Worker's own row", () => {
    expect(CLOUDFLARE_PRICES.workflowStepsPer100k).toBe(0.8);
    expect(CLOUDFLARE_PRICES.workflowStorageGbMonth).toBe(0.2);
    expect(workflowsCostUsd(100_000, 0)).toBeCloseTo(0.8, 12);
    expect(workflowsCostUsd(0, 30.4375 * GB)).toBeCloseTo(0.2, 12); // one GB-month-day of state
    expect(workflowsCostUsd(0, 0)).toBe(0);
    // Six steps a cycle, one cycle every ten minutes, one resident: 864 steps a day ≈ 0.7 cents.
    expect(workflowsCostUsd(6 * 144, 0)).toBeCloseTo(0.006912, 12);
  });

  it("R2 operations: class A mutates or lists ($4.50/M), class B reads ($0.36/M), deletes and aborts are free; an unknown action is classed by its verb", () => {
    for (const a of [
      "PutObject",
      "ListObjects",
      "UploadPart",
      "CompleteMultipartUpload",
      "CreateMultipartUpload",
      "PutBucket",
    ])
      expect(r2OperationClass(a)).toBe("A");
    for (const b of ["GetObject", "HeadObject", "HeadBucket", "GetBucketNotificationConfiguration", "UsageSummary"])
      expect(r2OperationClass(b)).toBe("B");
    for (const f of ["DeleteObject", "DeleteObjects", "DeleteBucket", "AbortMultipartUpload"])
      expect(r2OperationClass(f)).toBe("free");
    expect(r2OperationClass("PutBucketSomethingNew")).toBe("A");
    expect(r2OperationClass("GetSomethingNew")).toBe("B");
    expect(r2OperationClass("Frobnicate")).toBe("A"); // unknown verb: priced, not dropped
    expect(r2OperationsCostUsd("PutObject", 1_000_000)).toBeCloseTo(4.5, 9);
    expect(r2OperationsCostUsd("GetObject", 1_000_000)).toBeCloseTo(0.36, 9);
    expect(r2OperationsCostUsd("DeleteObject", 1_000_000)).toBe(0);
  });
});

describe("buildCostReport", () => {
  const range = { from: AUG_28, to: AUG_29, days: 2, partialLastDay: true };
  const report = buildCostReport("switchboard", GROUP, USAGE, LLM, range);

  it("keeps only the group's container apps, DO namespaces and workers; a namespace is attributed through the Worker that hosts it, labelled from config when given, else by its Worker", () => {
    const d = report.days.find((x) => x.date === AUG_28)!;
    expect(Object.keys(d.containers).sort()).toEqual(["bot", "resident"]);
    expect(Object.keys(d.durableObjects).sort()).toEqual(["bot DO", "switchboard-resident"]);
    expect(d.durableObjects["bot DO"]).toBeCloseTo(0.1378, 4);
    expect(d.doRequestsUsd).toBeCloseTo(0.000474, 9); // bot 2160 + resident 1000, not other-tenant's 994
    expect(report.attribution.durableObjectNamespaces).toEqual({
      "ns-bot": "bot DO",
      "ns-resident": "switchboard-resident",
    });
    expect(JSON.stringify(report.days)).not.toContain("other-tenant");
    expect(JSON.stringify(report)).not.toContain("ns-other");
    expect(JSON.stringify(report)).not.toContain("tfstate");
  });

  it("attributes an R2 bucket by the exact `<worker>-cache` name the deploy gives it — a foreign bucket that merely shares the prefix is not claimed — and prices storage per GB-month-day plus class A/B operations (deletes free)", () => {
    const d = report.days.find((x) => x.date === AUG_28)!;
    expect(report.attribution.r2Buckets).toEqual({ "switchboard-resident-cache": "switchboard-resident-cache" });
    expect(JSON.stringify(report.attribution)).not.toContain("switchboard-2-tfstate");
    expect(d.r2Usd).toBeCloseTo(0.015 + 4.5 + 0.36, 9);
    // An explicit entry attributes a bucket named any other way.
    const explicit = buildCostReport(
      "switchboard",
      { ...GROUP, r2Buckets: { "switchboard-2-tfstate": "state" } },
      USAGE,
      LLM,
      range,
    );
    expect(explicit.attribution.r2Buckets).toEqual({
      "switchboard-2-tfstate": "state",
      "switchboard-resident-cache": "switchboard-resident-cache",
    });
    expect(explicit.days.find((x) => x.date === AUG_28)!.r2Usd).toBeCloseTo(
      0.015 + 4.5 + 0.36 + (1 / 30.4375) * 0.015,
      9,
    );
  });

  it("prices the group's Workers (requests + CPU), SQLite rows and SQLite storage, and nothing of the other tenant's", () => {
    const d = report.days.find((x) => x.date === AUG_28)!;
    expect(d.workersUsd).toBeCloseTo(0.3 + 0.02, 9); // 1M requests + 1e9 µs = 1M CPU-ms
    expect(d.doRowsUsd).toBeCloseTo(0.001 + 0.1, 9); // 1M reads + 100k writes
    expect(d.doStorageUsd).toBeCloseTo(0.2, 9); // 30.4375 GB for one day = one GB-month
  });

  it("attributes a Workflow by the exact `<worker>-refresh` name the deploy gives it and prices its steps and state into the group's own meter, leaving the hosting Worker's request and CPU figures untouched", () => {
    const d = report.days.find((x) => x.date === AUG_28)!;
    expect(d.workflowsUsd).toBeCloseTo(0.8 + 0.2, 9); // 100k steps + one GB-month-day of state; the other tenant's 1M steps are not ours
    expect(report.attribution.workflows).toEqual({ "switchboard-resident-refresh": "switchboard-resident" });
    expect(d.workersUsd).toBeCloseTo(0.3 + 0.02, 9); // the Worker row is what it was: nothing re-metered
    expect(report.totals.byResource.workflows).toBeCloseTo(1.0, 9);
    expect(d.cloudUsd).toBeCloseTo(
      d.containers.resident.total +
        d.containers.bot.total +
        d.durableObjects["bot DO"] +
        d.durableObjects["switchboard-resident"] +
        d.doRequestsUsd +
        d.doRowsUsd +
        d.doStorageUsd +
        d.workersUsd +
        d.r2Usd +
        d.workflowsUsd,
      9,
    );
  });

  it("prices the whole account the same way so the group's share of it is honest — the other tenant's rows count there and only there", () => {
    const d = report.days.find((x) => x.date === AUG_28)!;
    const otherWorkers = 9 * 0.3;
    const otherRows = 5 * 0.001 + 5 * 1;
    const otherStorage = (100 / 30.4375) * 0.2;
    const otherR2 = (1 / 30.4375) * 0.015 + 4.5 + (1 / 30.4375) * 0.015; // tfstate storage + its PutObjects + the prefix-sharing bucket
    const otherDo = 11032.6 * 12.5e-6 + (994 / 1e6) * 0.15;
    const otherContainer = containerCostUsd(USAGE.containers[2]).total;
    const otherWorkflows = 10 * 0.8; // the other tenant's 1M steps
    expect(report.account.cloudUsd).toBeCloseTo(
      report.totals.cloudUsd +
        otherWorkers +
        otherRows +
        otherStorage +
        otherR2 +
        otherDo +
        otherContainer +
        otherWorkflows,
      6,
    );
    expect(report.account.cloudUsd).toBeGreaterThan(d.cloudUsd);
  });

  it("keeps only the group's Anthropic workspace for LLM spend", () => {
    expect(report.days.find((x) => x.date === AUG_28)!.llmUsd).toBe(12.5);
    // null workspace = the org default workspace, which is NOT this group's
    expect(report.days.find((x) => x.date === AUG_29)!.llmUsd).toBe(0);
  });

  it("emits one row per day in range, oldest first, with zero-filled gaps", () => {
    const r = buildCostReport("switchboard", GROUP, EMPTY_USAGE, [], {
      from: AUG_27,
      to: AUG_29,
      days: 3,
      partialLastDay: false,
    });
    expect(r.days.map((d) => d.date)).toEqual([AUG_27, AUG_28, AUG_29]);
    expect(r.days.every((d) => d.total === 0)).toBe(true);
    expect(r.totals.total).toBe(0);
  });

  it("totals per day and across the range, and splits cloud vs LLM", () => {
    const d = report.days.find((x) => x.date === AUG_28)!;
    const containers = d.containers.bot.total + d.containers.resident.total;
    const dos = d.durableObjects["bot DO"] + d.durableObjects["switchboard-resident"] + d.doRequestsUsd;
    const rest = d.doRowsUsd + d.doStorageUsd + d.workersUsd + d.r2Usd + d.workflowsUsd;
    expect(d.cloudUsd).toBeCloseTo(containers + dos + rest, 9);
    expect(d.total).toBeCloseTo(containers + dos + rest + 12.5, 9);
    expect(report.totals.total).toBeCloseTo(
      report.days.reduce((s, x) => s + x.total, 0),
      9,
    );
    expect(report.totals.llmUsd).toBe(12.5);
  });

  it("splits cloud spend by billed resource so the 'what a dollar buys' view is exact", () => {
    const split = report.totals.byResource;
    expect(
      split.cpu +
        split.memory +
        split.disk +
        split.durableObjects +
        split.doRows +
        split.doStorage +
        split.workers +
        split.r2 +
        split.workflows,
    ).toBeCloseTo(report.totals.cloudUsd, 9);
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
    expect(c?.groups.switchboard.r2Buckets).toEqual({}); // optional: buckets are attributed by name
    expect(c?.anthropicAdminKeyEnv).toBe("ANTHROPIC_ADMIN_KEY");
    expect(c?.groups.switchboard.workers).toEqual(["switchboard"]);
  });
  it("accepts a group with only workers — namespaces and buckets are attributed through them", () => {
    const c = parseCostsConfig({ cloudflareAccountId: "3c7b", groups: { g: { workers: ["w"] } } });
    expect(c?.groups.g).toEqual({
      label: undefined,
      workers: ["w"],
      containerApps: {},
      durableObjectNamespaces: {},
      r2Buckets: {},
      anthropicWorkspaceId: undefined,
    });
    expect(() =>
      parseCostsConfig({ cloudflareAccountId: "x", groups: { g: { workers: [], r2Buckets: { b: 1 } } } }),
    ).toThrow(/r2Buckets/);
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
            durableObjectRequests: [
              { dimensions: { date: AUG_28, scriptName: "switchboard", namespaceId: "ns1" }, sum: { requests: 5 } },
            ],
            durableObjectDays: [
              {
                dimensions: { date: AUG_28, namespaceId: "ns1" },
                sum: { duration: 7.5, rowsRead: 40, rowsWritten: 2 },
              },
            ],
            durableObjectStorage: [{ dimensions: { date: AUG_28, namespaceId: "ns1" }, max: { storedBytes: 4096 } }],
            workers: [
              { dimensions: { date: AUG_28, scriptName: "switchboard" }, sum: { requests: 9, cpuTimeUs: 1500 } },
            ],
            r2Storage: [
              {
                dimensions: { date: AUG_28, bucketName: "switchboard-cache" },
                max: { payloadSize: 1000, metadataSize: 24 },
              },
            ],
            r2Operations: [
              {
                dimensions: { date: AUG_28, bucketName: "switchboard-cache", actionType: "GetObject" },
                sum: { requests: 3 },
              },
            ],
            // One row per event type: only the step endings are billable steps
            // (the pricing page: "Step count does not include rollback handlers
            // or retries"), so the attempts and the instance events fold away.
            workflows: [
              {
                dimensions: { date: AUG_28, workflowName: "switchboard-resident-refresh", eventType: "STEP_SUCCESS" },
                count: 4,
              },
              {
                dimensions: { date: AUG_28, workflowName: "switchboard-resident-refresh", eventType: "STEP_FAILURE" },
                count: 1,
              },
              {
                dimensions: { date: AUG_28, workflowName: "switchboard-resident-refresh", eventType: "ATTEMPT_START" },
                count: 9,
              },
              {
                dimensions: {
                  date: AUG_28,
                  workflowName: "switchboard-resident-refresh",
                  eventType: "WORKFLOW_SUCCESS",
                },
                count: 1,
              },
            ],
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
    expect(usage.durableObjectRequests).toEqual([
      { date: AUG_28, scriptName: "switchboard", namespaceId: "ns1", requests: 5 },
    ]);
    expect(usage.durableObjectDays).toEqual([
      { date: AUG_28, namespaceId: "ns1", gbSeconds: 7.5, rowsRead: 40, rowsWritten: 2 },
    ]);
    expect(usage.durableObjectStorage).toEqual([{ date: AUG_28, namespaceId: "ns1", storedBytes: 4096 }]);
    expect(usage.workers).toEqual([{ date: AUG_28, scriptName: "switchboard", requests: 9, cpuTimeUs: 1500 }]);
    expect(usage.r2Storage).toEqual([{ date: AUG_28, bucketName: "switchboard-cache", bytes: 1024 }]); // payload + metadata
    expect(usage.r2Operations).toEqual([
      { date: AUG_28, bucketName: "switchboard-cache", actionType: "GetObject", requests: 3 },
    ]);
    // Steps are the step endings summed per Workflow per day; the state
    // bytes have no dataset, so the source answers 0 and the meter prices what it can see.
    expect(usage.workflows).toEqual([
      { date: AUG_28, workflowName: "switchboard-resident-refresh", steps: 5, stateBytes: 0 },
    ]);
    // Every dataset Cloudflare bills a Workers deployment on, in one request.
    for (const dataset of [
      "containersUsageAdaptiveGroups",
      "durableObjectsInvocationsAdaptiveGroups",
      "durableObjectsPeriodicGroups", // the billable-duration dataset, not summed request wall time
      "durableObjectsSqlStorageGroups",
      "workersInvocationsAdaptive",
      "r2StorageAdaptiveGroups",
      "r2OperationsAdaptiveGroups",
      "workflowsAdaptiveGroups",
    ])
      expect(body.query).toContain(dataset);
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

// Feature: docs/reference/specs/routing-and-config.md item 16 — the Null Object a process
// without cost reporting is wired with.
describe("NullCostsService — the service of a process without cost reporting", () => {
  it("has no groups, and refuses a report with the reason the view shows", async () => {
    const service = new NullCostsService();
    expect(service.groups()).toEqual([]);
    await expect(service.report("switchboard", null)).rejects.toThrow(COSTS_OFF_MESSAGE);
    expect(COSTS_OFF_MESSAGE).toContain("CF_ANALYTICS_TOKEN");
  });
});
