import { describe, expect, it } from "vitest";
import {
  AnthropicCostReportSource,
  CLOUDFLARE_PRICES,
  COSTS_SNAPSHOT_EVERY_HOURS,
  CloudflareGraphqlUsageSource,
  NullLlmCostSource,
  OPENAI_COSTS_URL,
  OPENROUTER_ACTIVITY_URL,
  OpenAICostsSource,
  OpenRouterActivitySource,
  buildBillerTieOuts,
  buildCostReport,
  containerCostUsd,
  DAYS_PER_MONTH,
  doDurationCostUsd,
  doRequestsCostUsd,
  doRowsCostUsd,
  EMPTY_USAGE,
  MAX_ESTIMATED_DAYS,
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

/** The account behind the rows — required: the page links to it. */
const META = { accountId: "acct-example" };

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
  const report = buildCostReport("switchboard", GROUP, USAGE, LLM, range, META);

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
      META,
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

  it("flags a day whose LLM figure is an estimate from the usage report, and carries the tokens the estimate could not price", () => {
    const rows: LlmCostRow[] = [
      ...LLM,
      { date: AUG_29, workspaceId: "wrkspc_switchboard", amountUsd: 4.25, estimated: true, unpricedTokens: 500 },
      { date: AUG_29, workspaceId: "wrkspc_other", amountUsd: 1, estimated: true, unpricedTokens: 9000 },
    ];
    const r = buildCostReport("switchboard", GROUP, USAGE, rows, range, META);
    const closed = r.days.find((x) => x.date === AUG_28)!;
    const open = r.days.find((x) => x.date === AUG_29)!;
    expect(closed.llmEstimated).toBe(false);
    expect(closed.llmUnpricedTokens).toBe(0);
    expect(open.llmUsd).toBe(4.25);
    expect(open.llmEstimated).toBe(true);
    expect(open.llmUnpricedTokens).toBe(500); // the other workspace's unpriced tokens are not ours
    expect(r.totals.llmUsd).toBe(12.5 + 4.25);
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
      EMPTY_USAGE,
      [],
      { from: AUG_27, to: AUG_29, days: 3, partialLastDay: false },
      META,
    );
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
    const r = buildCostReport("switchboard", GROUP, USAGE, null, range, META);
    expect(r.llmAvailable).toBe(false);
    expect(r.days.every((d) => d.llmUsd === 0)).toBe(true);
  });

  it("names the account it priced (id, optional name) and when it was generated, so the page can link out and scale the open day", () => {
    const r = buildCostReport("switchboard", GROUP, USAGE, LLM, range, {
      accountId: "acct-example",
      accountName: "acme-infra",
      generatedAt: Date.parse(`${AUG_29}T12:00:00Z`),
    });
    expect(r.account.id).toBe("acct-example");
    expect(r.account.name).toBe("acme-infra");
    expect(r.generatedAt).toBe(Date.parse(`${AUG_29}T12:00:00Z`));
    // No name configured → absent, never an empty string the page would print.
    const bare = buildCostReport("switchboard", GROUP, USAGE, LLM, range, { accountId: "acc", generatedAt: 1 });
    expect(bare.account.name).toBeUndefined();
    expect(JSON.stringify(bare.account)).not.toContain('"name"');
  });
});

// ---- range ------------------------------------------------------------------------

describe("resolveRange", () => {
  const now = new Date(Date.UTC(2026, 7, 29, 21, 35));
  it("defaults to 30 days ending today (UTC), today flagged partial", () => {
    const r = resolveRange(null, now);
    expect(r).toEqual({ from: JUL_31, to: AUG_29, days: 30, partialLastDay: true });
  });
  it("clamps ?days to 1..31 — the widest range Cloudflare answers — and rejects garbage", () => {
    expect(resolveRange("7", now).from).toBe(AUG_23);
    expect(resolveRange("0", now).days).toBe(1);
    expect(resolveRange("9999", now).days).toBe(31);
    expect(resolveRange("90", now).days).toBe(31);
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
    expect(c?.cloudflareAccountName).toBeUndefined();
  });
  it("carries an optional account name for the page to print beside the account's share", () => {
    const c = parseCostsConfig({
      cloudflareAccountId: "3c7b",
      cloudflareAccountName: "acme-infra",
      groups: { g: { workers: ["w"] } },
    });
    expect(c?.cloudflareAccountName).toBe("acme-infra");
    expect(() =>
      parseCostsConfig({ cloudflareAccountId: "3c7b", cloudflareAccountName: 7, groups: { g: { workers: ["w"] } } }),
    ).toThrow(/cloudflareAccountName/);
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
  it("snapshot.everyHours is daily by default, must be a whole number of hours within the bounds, and a malformed value or block throws by name", () => {
    const base = { cloudflareAccountId: "3c7b", groups: { g: { workers: ["w"] } } };
    expect(parseCostsConfig(base)?.snapshot).toEqual({ everyHours: COSTS_SNAPSHOT_EVERY_HOURS.default });
    expect(COSTS_SNAPSHOT_EVERY_HOURS).toEqual({ default: 24, min: 1, max: 168 });
    expect(parseCostsConfig({ ...base, snapshot: {} })?.snapshot).toEqual({ everyHours: 24 });
    expect(parseCostsConfig({ ...base, snapshot: { everyHours: 6 } })?.snapshot).toEqual({ everyHours: 6 });
    for (const everyHours of [0, 169, 1.5, "24", null])
      expect(() => parseCostsConfig({ ...base, snapshot: { everyHours } })).toThrow(
        /costs\.snapshot\.everyHours must be a whole number of hours between 1 and 168/,
      );
    expect(() => parseCostsConfig({ ...base, snapshot: [] })).toThrow(/costs\.snapshot must be a mapping/);
  });
  it("snapshot.alertChannel is optional, a platform-namespaced channel id when given, anything else refused by name", () => {
    const base = { cloudflareAccountId: "3c7b", groups: { g: { workers: ["w"] } } };
    expect(parseCostsConfig({ ...base, snapshot: { alertChannel: "slack:COPS" } })?.snapshot).toEqual({
      everyHours: 24,
      alertChannel: "slack:COPS",
    });
    expect(parseCostsConfig({ ...base, snapshot: { everyHours: 6 } })?.snapshot).not.toHaveProperty("alertChannel");
    for (const alertChannel of ["COPS", "", 7, null])
      expect(() => parseCostsConfig({ ...base, snapshot: { alertChannel } })).toThrow(
        /costs\.snapshot\.alertChannel must be a platform-namespaced channel id/,
      );
  });
  // costs.md item 4b: the operator's price table rides the block and is validated with it.
  it("prices is the empty table when absent, a table of per-million rates keyed by provider/model when given, and a malformed one is refused by name", () => {
    const base = { cloudflareAccountId: "x", groups: { g: { workers: ["w"] } } };
    expect(parseCostsConfig(base)?.prices).toEqual({});
    const gpt = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 };
    expect(parseCostsConfig({ ...base, prices: { "openai/gpt-5": gpt } })?.prices).toEqual({ "openai/gpt-5": gpt });
    expect(() => parseCostsConfig({ ...base, prices: { "openai/gpt-5": { input: 1 } } })).toThrow(
      /costs\.prices\.openai\/gpt-5\.output must be/,
    );
    expect(() => parseCostsConfig({ ...base, prices: "cheap" })).toThrow(/costs\.prices must be a mapping/);
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
  /** One hourly usage bucket of the Admin usage report, as the API spells it. */
  const usageBucket = (
    startIso: string,
    results: Array<{
      workspace_id: string | null;
      model: string;
      uncached_input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      c5?: number;
      c1?: number;
    }>,
  ) => ({
    starting_at: startIso,
    ending_at: startIso,
    results: results.map((r) => ({
      workspace_id: r.workspace_id,
      model: r.model,
      uncached_input_tokens: r.uncached_input_tokens,
      output_tokens: r.output_tokens,
      cache_read_input_tokens: r.cache_read_input_tokens,
      cache_creation: { ephemeral_5m_input_tokens: r.c5 ?? 0, ephemeral_1h_input_tokens: r.c1 ?? 0 },
      service_tier: null,
    })),
  });

  it("prices the open day from the hourly usage report at list when the cost report has no bucket for it yet, one estimated row per workspace", async () => {
    const range = { from: AUG_28, to: AUG_29, days: 2, partialLastDay: true };
    const costReport = {
      data: [
        {
          starting_at: midnight(AUG_28),
          ending_at: midnight(AUG_29),
          results: [{ amount: "1250", currency: "USD", workspace_id: "wrkspc_a" }],
        },
      ],
      has_more: false,
      next_page: null,
    };
    const usagePages: Record<string, unknown> = {
      first: {
        data: [
          usageBucket(`${AUG_29}T05:00:00Z`, [
            {
              workspace_id: "wrkspc_a",
              model: "claude-fable-5",
              uncached_input_tokens: 1000,
              output_tokens: 2000,
              cache_read_input_tokens: 3000,
              c5: 4000,
            },
            {
              workspace_id: null,
              model: "claude-haiku-4-5-20251001",
              uncached_input_tokens: 1_000_000,
              output_tokens: 0,
              cache_read_input_tokens: 0,
            },
          ]),
        ],
        has_more: true,
        next_page: "u2",
      },
      u2: {
        data: [
          usageBucket(`${AUG_29}T06:00:00Z`, [
            {
              workspace_id: "wrkspc_a",
              model: "claude-fable-5",
              uncached_input_tokens: 1000,
              output_tokens: 0,
              cache_read_input_tokens: 0,
            },
          ]),
        ],
        has_more: false,
        next_page: null,
      },
    };
    const f = fakeFetch((url) => {
      const u = new URL(url);
      if (u.pathname === "/v1/organizations/cost_report") return { status: 200, body: costReport };
      return { status: 200, body: usagePages[u.searchParams.get("page") ?? "first"] };
    });
    const rows = await new AnthropicCostReportSource({
      adminKey: "sk-ant-admin",
      fetchImpl: f.fetchImpl,
    }).fetchDailyCost(range);
    // fable-5 over both hours: 2000 in × $10 + 2000 out × $50 + 3000 reads × $1 + 4000 5m-writes × $12.50, per MTok.
    const fableUsd = (2000 * 10 + 2000 * 50 + 3000 * 1 + 4000 * 12.5) / 1_000_000;
    expect(rows).toEqual([
      { date: AUG_28, workspaceId: "wrkspc_a", amountUsd: 12.5 },
      { date: AUG_29, workspaceId: "wrkspc_a", amountUsd: fableUsd, estimated: true, unpricedTokens: 0 },
      { date: AUG_29, workspaceId: null, amountUsd: 1, estimated: true, unpricedTokens: 0 },
    ]);
    const usageCalls = f.calls.filter((c) => new URL(c.url).pathname === "/v1/organizations/usage_report/messages");
    expect(usageCalls.length).toBe(2);
    const u = new URL(usageCalls[0].url);
    expect(u.searchParams.get("starting_at")).toBe(midnight(AUG_29));
    expect(u.searchParams.get("ending_at")).toBe(midnight(AUG_30));
    expect(u.searchParams.get("bucket_width")).toBe("1h");
    expect(u.searchParams.getAll("group_by[]")).toEqual(["workspace_id", "model"]);
    expect(u.searchParams.get("limit")).toBe("24");
    expect((usageCalls[0].init.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-admin");
    expect(new URL(usageCalls[1].url).searchParams.get("page")).toBe("u2");
  });

  it("never asks the cost report for the open day: a partial range ends the cost query at that day's start, and a one-day range skips it entirely — the API rejects a range that starts today", async () => {
    // The live failure: `?days=1` → cost_report 400 "ending date must be after starting date".
    const today = { from: AUG_29, to: AUG_29, days: 1, partialLastDay: true };
    const f = fakeFetch(() => ({ status: 200, body: { data: [], has_more: false, next_page: null } }));
    const rows = await new AnthropicCostReportSource({ adminKey: "k", fetchImpl: f.fetchImpl }).fetchDailyCost(today);
    const paths = f.calls.map((c) => new URL(c.url).pathname);
    expect(paths).toEqual(["/v1/organizations/usage_report/messages"]);
    expect(rows).toEqual([]);

    const week = { from: AUG_23, to: AUG_29, days: 7, partialLastDay: true };
    const g = fakeFetch(() => ({ status: 200, body: { data: [], has_more: false, next_page: null } }));
    await new AnthropicCostReportSource({ adminKey: "k", fetchImpl: g.fetchImpl }).fetchDailyCost(week);
    const cost = g.calls.find((c) => new URL(c.url).pathname === "/v1/organizations/cost_report");
    expect(cost).toBeDefined();
    expect(new URL(cost!.url).searchParams.get("starting_at")).toBe(midnight(AUG_23));
    expect(new URL(cost!.url).searchParams.get("ending_at")).toBe(midnight(AUG_29)); // exclusive: the open day is not asked for

    // A closed range (no partial day) still asks through the end of `to`.
    const closed = { from: AUG_27, to: AUG_28, days: 2, partialLastDay: false };
    const h = fakeFetch(() => ({ status: 200, body: { data: [], has_more: false, next_page: null } }));
    await new AnthropicCostReportSource({ adminKey: "k", fetchImpl: h.fetchImpl }).fetchDailyCost(closed);
    const closedCost = h.calls.find((c) => new URL(c.url).pathname === "/v1/organizations/cost_report");
    expect(new URL(closedCost!.url).searchParams.get("ending_at")).toBe(midnight(AUG_29));
  });

  it("estimates every trailing day the cost report has not closed, and none it has", async () => {
    // The cost report answers only the first of three days: the two after it are open.
    const range = { from: AUG_27, to: AUG_29, days: 3, partialLastDay: true };
    const f = fakeFetch((url) => {
      const u = new URL(url);
      if (u.pathname === "/v1/organizations/cost_report")
        return {
          status: 200,
          body: {
            data: [{ starting_at: midnight(AUG_27), ending_at: midnight(AUG_28), results: [] }],
            has_more: false,
            next_page: null,
          },
        };
      return { status: 200, body: { data: [], has_more: false, next_page: null } };
    });
    await new AnthropicCostReportSource({ adminKey: "k", fetchImpl: f.fetchImpl }).fetchDailyCost(range);
    const starts = f.calls
      .filter((c) => new URL(c.url).pathname === "/v1/organizations/usage_report/messages")
      .map((c) => new URL(c.url).searchParams.get("starting_at"))
      .sort(); // the open days are read concurrently; order is not the contract
    expect(starts).toEqual([midnight(AUG_28), midnight(AUG_29)]);
  });

  it("estimates at most the trailing three days when the cost report has closed nothing — never one live read per day of a long range", async () => {
    const range = { from: AUG_1, to: AUG_29, days: 29, partialLastDay: true };
    const f = fakeFetch((url) => {
      const u = new URL(url);
      if (u.pathname === "/v1/organizations/cost_report")
        return { status: 200, body: { data: [], has_more: false, next_page: null } };
      return { status: 200, body: { data: [], has_more: false, next_page: null } };
    });
    await new AnthropicCostReportSource({ adminKey: "k", fetchImpl: f.fetchImpl }).fetchDailyCost(range);
    const starts = f.calls
      .filter((c) => new URL(c.url).pathname === "/v1/organizations/usage_report/messages")
      .map((c) => new URL(c.url).searchParams.get("starting_at"))
      .sort();
    expect(starts).toEqual([midnight(AUG_27), midnight(AUG_28), midnight(AUG_29)]);
    expect(MAX_ESTIMATED_DAYS).toBe(3);
  });

  it("reports the tokens of a model it has no price for as unpriced on the workspace's row, rather than pricing them at $0 in silence or failing the page", async () => {
    const range = { from: AUG_29, to: AUG_29, days: 1, partialLastDay: true };
    const f = fakeFetch((url) => {
      const u = new URL(url);
      if (u.pathname === "/v1/organizations/cost_report")
        return { status: 200, body: { data: [], has_more: false, next_page: null } };
      return {
        status: 200,
        body: {
          data: [
            usageBucket(`${AUG_29}T01:00:00Z`, [
              {
                workspace_id: "wrkspc_a",
                model: "claude-future-9",
                uncached_input_tokens: 100,
                output_tokens: 20,
                cache_read_input_tokens: 30,
                c5: 5,
                c1: 1,
              },
              {
                workspace_id: "wrkspc_a",
                model: "claude-haiku-4-5-20251001",
                uncached_input_tokens: 1_000_000,
                output_tokens: 0,
                cache_read_input_tokens: 0,
              },
            ]),
          ],
          has_more: false,
          next_page: null,
        },
      };
    });
    const rows = await new AnthropicCostReportSource({ adminKey: "k", fetchImpl: f.fetchImpl }).fetchDailyCost(range);
    expect(rows).toEqual([
      { date: AUG_29, workspaceId: "wrkspc_a", amountUsd: 1, estimated: true, unpricedTokens: 156 },
    ]);
  });

  it("a failing usage report fails the read by status, without the key", async () => {
    const range = { from: AUG_29, to: AUG_29, days: 1, partialLastDay: true };
    const f = fakeFetch((url) => {
      const u = new URL(url);
      if (u.pathname === "/v1/organizations/cost_report")
        return { status: 200, body: { data: [], has_more: false, next_page: null } };
      return { status: 429, body: { error: { message: "rate limited" } } };
    });
    const err = await new AnthropicCostReportSource({ adminKey: "sk-ant-admin-SECRET", fetchImpl: f.fetchImpl })
      .fetchDailyCost(range)
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/usage_report 429/);
    expect(String(err)).not.toContain("SECRET");
  });

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
    // ≤31-day range at limit=31, so this is the guard that makes it loud if it ever isn't.
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

// ---- invoices per biller and the tie-out (item 4d) --------------------------------------

const SEP_17 = iso(2026, 9, 17);
const SEP_18 = iso(2026, 9, 18);
const SEP_19 = iso(2026, 9, 19);

describe("invoice sources per biller", () => {
  const RANGE_SEPT = { from: SEP_17, to: SEP_19, days: 3, partialLastDay: false };

  it("OpenRouterActivitySource sums the activity rows' usage and byok_usage_inference per day in range, bearer only in the header, a failure by status without the key", async () => {
    const f = fakeFetch(() => ({
      status: 200,
      body: {
        data: [
          { date: SEP_18, usage: 0.03, byok_usage_inference: 0.4 },
          { date: SEP_18, usage: 0.02, byok_usage_inference: 0.1 },
          { date: SEP_19, usage: 0.05, byok_usage_inference: 0 },
          { date: AUG_1, usage: 9, byok_usage_inference: 9 }, // outside the range: dropped
        ],
      },
    }));
    const src = new OpenRouterActivitySource({
      biller: "openrouter",
      managementKey: "or-mgmt-SECRET",
      fetchImpl: f.fetchImpl,
    });
    expect(src.biller).toBe("openrouter");
    const days = await src.fetchInvoice(RANGE_SEPT);
    expect(days).toEqual([
      { date: SEP_18, usd: 0.55, feeUsd: 0.05, byokUsd: 0.5 },
      { date: SEP_19, usd: 0.05, feeUsd: 0.05, byokUsd: 0 },
    ]);
    expect(f.calls[0].url).toBe(OPENROUTER_ACTIVITY_URL);
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer or-mgmt-SECRET");
    const bad = fakeFetch(() => ({ status: 401, body: { error: "nope" } }));
    const err = await new OpenRouterActivitySource({
      biller: "openrouter",
      managementKey: "or-mgmt-SECRET",
      fetchImpl: bad.fetchImpl,
    })
      .fetchInvoice(RANGE_SEPT)
      .catch((e: unknown) => e as Error);
    expect(String(err)).toMatch(/openrouter activity 401/);
    expect(String(err)).not.toContain("SECRET");
  });

  it("OpenAICostsSource sums the daily buckets' amounts, paginates via next_page, and refuses a non-USD row rather than mis-summing", async () => {
    const bucket = (day: string, value: number, currency = "usd") => ({
      start_time: Date.parse(`${day}T00:00:00Z`) / 1000,
      results: [{ amount: { value, currency } }],
    });
    const f = fakeFetch((url) => {
      const page = new URL(url).searchParams.get("page");
      return page === null
        ? { status: 200, body: { data: [bucket(SEP_17, 1.5)], has_more: true, next_page: "p2" } }
        : { status: 200, body: { data: [bucket(SEP_18, 2.25)], has_more: false, next_page: null } };
    });
    const src = new OpenAICostsSource({ biller: "openai", adminKey: "sk-admin-SECRET", fetchImpl: f.fetchImpl });
    expect(await src.fetchInvoice(RANGE_SEPT)).toEqual([
      { date: SEP_17, usd: 1.5 },
      { date: SEP_18, usd: 2.25 },
    ]);
    expect(f.calls[0].url).toContain(OPENAI_COSTS_URL);
    expect(f.calls[0].url).not.toContain("SECRET");
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe("Bearer sk-admin-SECRET");
    const eur = fakeFetch(() => ({ status: 200, body: { data: [bucket(SEP_17, 3, "eur")] } }));
    await expect(
      new OpenAICostsSource({ biller: "openai", adminKey: "k", fetchImpl: eur.fetchImpl }).fetchInvoice(RANGE_SEPT),
    ).rejects.toThrow(/unexpected currency eur/);
  });

  it("OpenAICostsSource skips a bucket whose start_time is missing, non-finite or out of range — never a 1970-01-01 day", async () => {
    const results = [{ amount: { value: 9, currency: "usd" } }];
    const f = fakeFetch(() => ({
      status: 200,
      body: {
        data: [
          {
            start_time: Date.parse(`${SEP_17}T00:00:00Z`) / 1000,
            results: [{ amount: { value: 1.5, currency: "usd" } }],
          },
          { results }, // no start_time — would otherwise date to epoch 0
          { start_time: null, results }, // non-finite (what NaN serializes to)
          { start_time: Date.parse(`${AUG_1}T00:00:00Z`) / 1000, results }, // out of range
        ],
        has_more: false,
      },
    }));
    const src = new OpenAICostsSource({ biller: "openai", adminKey: "k", fetchImpl: f.fetchImpl });
    expect(await src.fetchInvoice(RANGE_SEPT)).toEqual([{ date: SEP_17, usd: 1.5 }]);
  });

  it("AnthropicCostReportSource.fetchInvoice sums the cost report's closed days across workspaces — the invoice, never the estimate", async () => {
    const f = fakeFetch((url) =>
      url.startsWith("https://api.anthropic.com/v1/organizations/cost_report")
        ? {
            status: 200,
            body: {
              data: [
                {
                  starting_at: midnight(SEP_17),
                  results: [
                    { amount: "150", currency: "USD", workspace_id: "w1" },
                    { amount: "50", currency: "USD", workspace_id: "w2" },
                  ],
                },
              ],
              has_more: false,
            },
          }
        : { status: 200, body: { data: [], has_more: false } },
    );
    const src = new AnthropicCostReportSource({ adminKey: "k", fetchImpl: f.fetchImpl });
    expect(src.biller).toBe("anthropic");
    expect(await src.fetchInvoice(RANGE_SEPT)).toEqual([{ date: SEP_17, usd: 2 }]);
    // the invoice read asks the cost report alone — never the hourly usage estimate
    expect(f.calls.every((c) => c.url.includes("cost_report"))).toBe(true);
  });
});

describe("buildBillerTieOuts", () => {
  const range = { from: SEP_18, to: SEP_18, days: 1, partialLastDay: false };
  const model = (usd: number | null, feeUsd?: number) => ({
    turns: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(usd === null ? { usd: null } : { usd }),
    ...(feeUsd !== undefined ? { feeUsd } : {}),
  });
  const cell = (day: string, byModel: Record<string, ReturnType<typeof model>>) => ({
    day,
    usage: { turns: 1, byModel },
  });

  it("three billers on one day tie out independently, each invoice against the summed rows whose ref names its block", () => {
    const cells = [
      cell(SEP_18, {
        "anthropic/claude-fable-5": model(1.2),
        "openai/gpt-5": model(0.8),
        "openrouter/deepseek/deepseek-v4.1-flash": model(0.5, 0.05),
      }),
    ];
    const invoices = {
      anthropic: [{ date: SEP_18, usd: 1.25 }],
      openai: [{ date: SEP_18, usd: 0.8 }],
      openrouter: [{ date: SEP_18, usd: 0.55, feeUsd: 0.05, byokUsd: 0.5 }],
    };
    const out = buildBillerTieOuts(
      [
        { name: "anthropic", invoice: true },
        { name: "openai", invoice: true },
        { name: "openrouter", invoice: true },
      ],
      invoices,
      cells,
      range,
    );
    expect(out.map((t) => t.biller)).toEqual(["anthropic", "openai", "openrouter"]);
    expect(out[0].days).toEqual([{ date: SEP_18, invoiceUsd: 1.25, attributedUsd: 1.2 }]);
    expect(out[0].totals).toEqual({ invoiceUsd: 1.25, attributedUsd: 1.2 });
    expect(out[1].days[0]).toEqual({ date: SEP_18, invoiceUsd: 0.8, attributedUsd: 0.8 });
    expect(out[2].totals.attributedUsd).toBe(0.5);
  });

  it("a BYOK day splits fee and upstream: the invoice's usage beside the summed feeUsd, byok_usage_inference beside the remainder", () => {
    const cells = [cell(SEP_18, { "openrouter/anthropic/claude-fable-5": model(0.55, 0.05) })];
    const out = buildBillerTieOuts(
      [{ name: "openrouter", invoice: true }],
      { openrouter: [{ date: SEP_18, usd: 0.57, feeUsd: 0.06, byokUsd: 0.51 }] },
      cells,
      range,
    );
    expect(out[0].days[0]).toEqual({
      date: SEP_18,
      invoiceUsd: 0.57,
      invoiceFeeUsd: 0.06,
      invoiceByokUsd: 0.51,
      attributedUsd: 0.55,
      attributedFeeUsd: 0.05,
      attributedUpstreamUsd: 0.5,
    });
  });

  it("a sourced biller's day with attributed spend but no invoice row keeps its invoice side absent — never an invented $0 — and the totals sum the present invoices alone", () => {
    const cells = [
      cell(SEP_17, { "anthropic/claude-fable-5": model(1.2) }),
      cell(SEP_18, { "anthropic/claude-fable-5": model(0.9) }),
    ];
    const out = buildBillerTieOuts(
      [{ name: "anthropic", invoice: true }],
      { anthropic: [{ date: SEP_17, usd: 1.25 }] },
      cells,
      { from: SEP_17, to: SEP_18, days: 2, partialLastDay: false },
    );
    expect(out[0].days).toEqual([
      { date: SEP_17, invoiceUsd: 1.25, attributedUsd: 1.2 },
      { date: SEP_18, attributedUsd: 0.9 },
    ]);
    expect(out[0].days[1]).not.toHaveProperty("invoiceUsd");
    expect(out[0].totals).toEqual({ invoiceUsd: 1.25, attributedUsd: 2.1 });
  });

  it("a day with no invoice row, no nonzero attributed figure and no unpriced tokens is dropped, but purely unpriced spend keeps its day so the token count renders", () => {
    // $0 priced spend, nothing unpriced: no invoice row, so the day is dropped.
    const zero = buildBillerTieOuts(
      [{ name: "anthropic", invoice: true }],
      {},
      [cell(SEP_18, { "anthropic/claude-fable-5": model(0) })],
      range,
    );
    expect(zero[0].days).toEqual([]);
    // Purely unpriced spend: the day stays alive to carry its token count.
    const cells = [cell(SEP_18, { "anthropic/claude-fable-5": model(null) })];
    const out = buildBillerTieOuts([{ name: "anthropic", invoice: true }], {}, cells, range);
    expect(out[0].days).toEqual([{ date: SEP_18, attributedUsd: 0, unpricedTokens: 2 }]);
  });

  it("an unpriced model's feeUsd is skipped with its usd — attributedUpstreamUsd never goes negative on an unpriced+fee row", () => {
    const cells = [cell(SEP_18, { "openrouter/unpriced": model(null, 0.05), "openrouter/priced": model(0.55, 0.05) })];
    const out = buildBillerTieOuts([{ name: "openrouter", invoice: true }], {}, cells, range);
    expect(out[0].days[0]).toEqual({
      date: SEP_18,
      attributedUsd: 0.55,
      attributedFeeUsd: 0.05,
      attributedUpstreamUsd: 0.5,
      unpricedTokens: 2,
    });
    // a day that is only unpriced+fee rows carries no dollar figures — the fee
    // is skipped with the usd — but stays for its unpriced token count
    const only = buildBillerTieOuts(
      [{ name: "openrouter", invoice: true }],
      {},
      [cell(SEP_18, { "openrouter/unpriced": model(null, 0.05) })],
      range,
    );
    expect(only[0].days).toEqual([{ date: SEP_18, attributedUsd: 0, unpricedTokens: 2 }]);
  });

  it("counts the tokens of turns that carried no usd as the day's unpricedTokens, per biller and per day, beside the meter-charged attributed figure; a fully priced day carries none", () => {
    const unpriced = (tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }) => ({
      turns: 1,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      cacheWriteTokens: tokens.cacheWrite,
      usd: null,
    });
    const cells = [
      // SEP_17: one priced and one unpriced model on the same biller — the priced
      // dollars and the unpriced tokens sit beside each other on the same day.
      cell(SEP_17, {
        "anthropic/claude-fable-5": model(1.2),
        "anthropic/claude-old": unpriced({ input: 100, output: 40, cacheRead: 10, cacheWrite: 5 }),
        // another biller's unpriced model never leaks into this biller's count
        "openai/gpt-5": unpriced({ input: 999, output: 0, cacheRead: 0, cacheWrite: 0 }),
      }),
      // SEP_18: priced turns only — the day carries no unpricedTokens field.
      cell(SEP_18, { "anthropic/claude-fable-5": model(0.9) }),
    ];
    const out = buildBillerTieOuts(
      [
        { name: "anthropic", invoice: true },
        { name: "openai", invoice: true },
      ],
      { anthropic: [{ date: SEP_17, usd: 1.6 }], openai: [{ date: SEP_17, usd: 0.4 }] },
      cells,
      { from: SEP_17, to: SEP_18, days: 2, partialLastDay: false },
    );
    expect(out[0].days).toEqual([
      { date: SEP_17, invoiceUsd: 1.6, attributedUsd: 1.2, unpricedTokens: 155 },
      { date: SEP_18, attributedUsd: 0.9 },
    ]);
    expect(out[0].days[1]).not.toHaveProperty("unpricedTokens");
    // the openai biller's day counts its own unpriced tokens alone
    expect(out[1].days).toEqual([{ date: SEP_17, invoiceUsd: 0.4, attributedUsd: 0, unpricedTokens: 999 }]);
  });

  it("a biller without a source ties out against nothing (invoice: false, no invoice figures); a model whose usd is null or absent contributes nothing; days outside the range and refs without a block are dropped", () => {
    const cells = [
      cell(SEP_18, { "groq/kimi-k2": model(0.3), "groq/other": model(null), unknown: model(9) }),
      cell(AUG_1, { "groq/kimi-k2": model(4) }),
    ];
    const out = buildBillerTieOuts([{ name: "groq", invoice: false }], {}, cells, range);
    expect(out).toEqual([
      {
        biller: "groq",
        invoice: false,
        days: [{ date: SEP_18, attributedUsd: 0.3, unpricedTokens: 2 }],
        totals: { invoiceUsd: 0, attributedUsd: 0.3 },
      },
    ]);
  });
});
