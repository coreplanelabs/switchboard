import { describe, expect, it, vi } from "vitest";
import { EMPTY_USAGE, parseCostsConfig, resolveRange, type CloudflareUsage, type LlmCostRow } from "./costs.js";
import { ALERT_AFTER_FAILURES, CostsSnapshotter, SNAPSHOT_DAYS } from "./costsSnapshot.js";
import { InMemoryCostsSnapshotStore, type CostsSnapshot } from "./costsSnapshotStore.js";
import {
  COSTS_OFF_MESSAGE,
  costsFromConfig,
  createCostsService,
  NoCostsSnapshotError,
  NullCostsService,
} from "./costsService.js";
import type { RunStore } from "./runStore.js";
import type { RunUsageReport } from "./runUsage.js";

// Feature: docs/reference/specs/costs.md items 6 and 10a — the service over the
// snapshot: every report is arithmetic over it, none reads a source; before the
// first snapshot the reports say so; the viewer is matched to their run ids by
// email; `snapshot(by)` takes one now.

// ---- fixtures ---------------------------------------------------------------

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const AUG_1 = iso(2026, 8, 1);
const AUG_28 = iso(2026, 8, 28);
const AUG_29 = iso(2026, 8, 29);
const AUG_30 = iso(2026, 8, 30);
const midnight = (day: string) => `${day}T00:00:00Z`;
const T0 = Date.parse(midnight(AUG_30));

const cfg = parseCostsConfig({
  cloudflareAccountId: "acct-example",
  groups: { switchboard: { workers: ["switchboard"], containerApps: { "app-bot": "bot" } } },
})!;
const USAGE: CloudflareUsage = {
  ...EMPTY_USAGE,
  containers: [
    {
      date: AUG_28,
      applicationId: "app-bot",
      cpuTimeSec: 3600,
      allocatedMemoryByteSec: 2 ** 30,
      allocatedDiskByteSec: 1e9,
    },
    {
      date: AUG_29,
      applicationId: "app-bot",
      cpuTimeSec: 1800,
      allocatedMemoryByteSec: 2 ** 30,
      allocatedDiskByteSec: 1e9,
    },
  ],
};
const LLM: LlmCostRow[] = [{ date: AUG_28, workspaceId: null, amountUsd: 40 }];
/** The one thread every Slack cell of the fixture is in. */
const WHERE = { threadKey: "slack:C1:1.0", channelId: "slack:C1", agent: "general" };
const usageReport: RunUsageReport = {
  rows: [
    {
      userId: "slack:UALICE",
      userName: "alice",
      day: AUG_28,
      ...WHERE,
      runs: 2,
      wallMs: 3_600_000,
      usage: {
        turns: 1,
        byModel: {
          "anthropic/claude-haiku-4-5": {
            turns: 1,
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
        },
      },
    },
    {
      userId: "slack:UBOB",
      userName: "bob",
      day: AUG_28,
      ...WHERE,
      runs: 1,
      wallMs: 3_600_000,
      usage: { turns: 0, byModel: {} },
    },
    {
      userId: "http:ops",
      day: AUG_29,
      threadKey: "http:ops:1",
      channelId: "http:ops",
      agent: "general",
      runs: 1,
      wallMs: 1_000,
      usage: { turns: 0, byModel: {} },
    },
    // An app nobody was found behind (slack-channel.md item 13): a requester, never a viewer.
    {
      userId: "slack:bot:B0CLAUDE",
      userName: "Claude [ci]",
      day: AUG_29,
      ...WHERE,
      runs: 1,
      wallMs: 1_000,
      usage: { turns: 0, byModel: {} },
    },
  ],
  pending: 1,
  earliestFinishedAt: Date.parse(midnight(AUG_1)),
  retentionDays: 30,
};

function snapshotterWith(runUsage: RunUsageReport | null = usageReport, at = T0) {
  const runStore = runUsage ? ({ usage: async () => runUsage } as unknown as RunStore) : undefined;
  return new CostsSnapshotter(
    {
      cloudflare: { fetchUsage: async () => USAGE },
      llm: { fetchDailyCost: async () => LLM },
      ...(runStore ? { runStore } : {}),
    },
    new InMemoryCostsSnapshotStore(),
    { everyHours: 24, now: () => new Date(at) },
  );
}

describe("NullCostsService — the service of a process without cost reporting", () => {
  it("has no groups, and refuses a report or a snapshot with the reason the view shows; its status is empty", async () => {
    const service = new NullCostsService();
    expect(service.groups()).toEqual([]);
    await expect(service.report("switchboard", null)).rejects.toThrow(COSTS_OFF_MESSAGE);
    await expect(service.byReport("switchboard", null, "user", undefined)).rejects.toThrow(COSTS_OFF_MESSAGE);
    await expect(service.snapshot("casey")).rejects.toThrow(COSTS_OFF_MESSAGE);
    expect(service.status()).toEqual({
      snapshot: null,
      inFlight: null,
      everyHours: 0,
      nextAt: null,
      lastFailure: null,
    });
    expect(COSTS_OFF_MESSAGE).toContain("CF_ANALYTICS_TOKEN");
  });
});

describe("createCostsService", () => {
  it("before the first snapshot lands both reports refuse with NoCostsSnapshotError — nothing reads a source in the request — and the status says none", async () => {
    const service = createCostsService(cfg, snapshotterWith());
    await expect(service.report("switchboard", "7")).rejects.toBeInstanceOf(NoCostsSnapshotError);
    await expect(service.byReport("switchboard", "7", "user", undefined)).rejects.toThrow(/no cost snapshot yet/);
    expect(service.status().snapshot).toBeNull();
    await expect(service.report("nope", null)).rejects.toThrow(/unknown cost group/);
  });

  it("snapshot(by) takes one now and answers its stamp; every report after is arithmetic over that snapshot for the asked range, `today` its take day, stamped", async () => {
    const snapshots = snapshotterWith();
    const service = createCostsService(cfg, snapshots);
    const heard: string[] = [];
    service.subscribe((s) => heard.push(s.inFlight ? "started" : "done"));
    const stamp = await service.snapshot("casey");
    expect(stamp).toEqual({ takenAt: new Date(T0).toISOString(), takenBy: "casey", durationMs: 0 });
    expect(heard).toEqual(["started", "done"]);
    expect(service.status()).toMatchObject({
      snapshot: stamp,
      inFlight: null,
      nextAt: new Date(T0 + 86_400_000).toISOString(),
    });
    const r = await service.report("switchboard", "3");
    expect(r.range).toEqual({ from: AUG_28, to: AUG_30, days: 3, partialLastDay: true });
    expect(r.snapshot).toEqual(stamp);
    expect(r.days.map((d) => d.date)).toEqual([AUG_28, AUG_29, AUG_30]);
    expect(r.totals.llmUsd).toBe(0); // the org default workspace (null) is never attributed to a group
    const week = await service.report("switchboard", "7");
    expect(week.range.days).toBe(7);
    expect(week.range.to).toBe(AUG_30);
  });

  it("the by-user report prices and allocates over the snapshot's run usage for the range and matches the viewer to their run ids by email (one lookup per distinct Slack user, cached)", async () => {
    const looked: string[] = [];
    // Bob's email is unknown on the first read (a lookup that failed quietly) and known on the next.
    const emails: Record<string, string | undefined> = { "slack:UALICE": "Alice@Example.com", "slack:UBOB": undefined };
    const snapshots = snapshotterWith();
    await snapshots.refresh("schedule");
    const service = createCostsService(cfg, snapshots, {
      emailOfSlackUser: async (id) => (looked.push(id), emails[id]),
    });
    const r = await service.byReport("switchboard", "3", "user", { sub: "s1", email: "alice@example.com" });
    expect(r.range).toEqual({ from: AUG_28, to: AUG_30, days: 3, partialLastDay: true });
    expect(r.coverage).toMatchObject({ from: AUG_28, historyOn: true, retentionDays: 30, clamped: false });
    expect(r.rows.map((u) => u.key)).toEqual(["slack:UALICE", "slack:UBOB", "http:ops", "slack:bot:B0CLAUDE"]);
    expect(r.rows[0].llmUsd).toBeCloseTo(1, 9); // 1M haiku input at $1/MTok
    expect(r.pending).toBe(1);
    expect(r.viewer).toEqual({ userIds: ["slack:UALICE"], matchedByEmail: true });
    expect(r.snapshot?.takenBy).toBe("schedule");
    expect(looked.sort()).toEqual(["slack:UALICE", "slack:UBOB"]); // the whole namespaced id; the HTTP subject and the app (`slack:bot:…`) are never looked up
    // A second read looks up only the user whose email was unknown: a known
    // email is cached for the process, an unknown one is never pinned.
    emails["slack:UBOB"] = "bob@example.com";
    const again = await service.byReport("switchboard", "3", "user", { sub: "s2", email: "bob@example.com" });
    expect(looked.sort()).toEqual(["slack:UALICE", "slack:UBOB", "slack:UBOB"]);
    expect(again.viewer).toEqual({ userIds: ["slack:UBOB"], matchedByEmail: true });
  });

  // costs.md item 10a: the other dimensions are the same snapshot keyed differently; no viewer, no lookups.
  it("the thread, channel, agent and model reports come from the same snapshot keyed by the dimension, with no viewer and no email lookup spent", async () => {
    const looked: string[] = [];
    const snapshots = snapshotterWith();
    await snapshots.refresh("schedule");
    const service = createCostsService(cfg, snapshots, {
      emailOfSlackUser: async (id) => (looked.push(id), "alice@example.com"),
    });
    const byThread = await service.byReport("switchboard", "3", "thread", { sub: "s1", email: "alice@example.com" });
    expect(byThread.dimension).toBe("thread");
    expect(byThread.rows.map((r) => r.key)).toEqual(["slack:C1:1.0", "http:ops:1"]);
    expect(byThread.viewer).toBeUndefined();
    expect(looked).toEqual([]);
    const byChannel = await service.byReport("switchboard", "3", "channel", undefined);
    expect(byChannel.rows.map((r) => r.key)).toEqual(["slack:C1", "http:ops"]);
    const byAgent = await service.byReport("switchboard", "3", "agent", undefined);
    expect(byAgent.rows.map((r) => r.key)).toEqual(["general"]);
    const byModel = await service.byReport("switchboard", "3", "model", undefined);
    expect(byModel.cloudAllocated).toBe(false);
    expect(byModel.rows.map((r) => [r.key, r.turns, r.llmUsd])).toEqual([["anthropic/claude-haiku-4-5", 1, 1]]);
    expect(byModel.snapshot?.takenBy).toBe("schedule");
  });

  it("with no viewer email, or no lookup wired, nothing is matched and the report says so; with run history off the report is empty and says so", async () => {
    const snapshots = snapshotterWith();
    await snapshots.refresh("schedule");
    const noLookup = createCostsService(cfg, snapshots);
    expect(
      (await noLookup.byReport("switchboard", null, "user", { sub: "s1", email: "alice@example.com" })).viewer,
    ).toEqual({
      userIds: [],
      matchedByEmail: false,
    });
    const withLookup = createCostsService(cfg, snapshots, { emailOfSlackUser: async () => "x@y" });
    expect((await withLookup.byReport("switchboard", null, "user", { sub: "svc" })).viewer).toEqual({
      userIds: [],
      matchedByEmail: false,
    });
    const offSnapshots = snapshotterWith(null);
    await offSnapshots.refresh("schedule");
    const r = await createCostsService(cfg, offSnapshots).byReport("switchboard", null, "user", undefined);
    expect(r.rows).toEqual([]);
    expect(r.coverage.historyOn).toBe(false);
  });

  // costs.md item 4b: the by-user report prices through the configured table.
  it("prices the by-user report at `costs.prices` where the table names a ref, the list elsewhere", async () => {
    const priced = parseCostsConfig({
      cloudflareAccountId: "acct-example",
      groups: { switchboard: { workers: ["switchboard"], containerApps: { "app-bot": "bot" } } },
      prices: { "anthropic/claude-haiku-4-5": { input: 2, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
    })!;
    const snapshots = snapshotterWith();
    await snapshots.refresh("schedule");
    const r = await createCostsService(priced, snapshots).byReport("switchboard", "3", "user", undefined);
    expect(r.rows[0].llmUsd).toBeCloseTo(2, 9); // 1M haiku input at the configured $2/MTok, not the list's $1
    const list = await createCostsService(cfg, snapshots).byReport("switchboard", "3", "user", undefined);
    expect(list.rows[0].llmUsd).toBeCloseTo(1, 9);
  });

  it("costsFromConfig: the production wiring from the block and the env — off without the Cloudflare token, the LLM line on with the admin key, the snapshot kept in memory (with a warning) when no `*.worker` block names the state Worker", () => {
    const secrets = (names: Record<string, string>) => ({
      named: (n: string) => (names[n] !== undefined ? { reveal: () => names[n] } : undefined),
    });
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(costsFromConfig(cfg, {}, { secrets: secrets({}), warn })).toBeUndefined();
    const cloudOnly = costsFromConfig(cfg, {}, { secrets: secrets({ CF_ANALYTICS_TOKEN: "cf" }), warn });
    expect(cloudOnly?.llmOn).toBe(false);
    expect(cloudOnly?.service.groups()).toEqual(["switchboard"]);
    expect(cloudOnly?.service.status()).toMatchObject({ snapshot: null, everyHours: 24 });
    expect(warnings[0]).toContain("costs snapshot is kept in memory");
    const both = costsFromConfig(
      cfg,
      { runHistory: { worker: { baseUrl: "https://state.example.com" } } },
      { secrets: secrets({ CF_ANALYTICS_TOKEN: "cf", ANTHROPIC_ADMIN_KEY: "sk-ant-admin", MEMORY_TOKEN: "t" }), warn },
    );
    expect(both?.llmOn).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it("costsFromConfig: the Admin key moved under the block — `providers.anthropic.invoiceKeyEnv` wins, `costs.anthropicAdminKeyEnv` keeps loading for one release; a further block's invoiceKeyEnv wires its biller's invoice API, a missing env or an unknown biller warns by name and ties out against nothing", () => {
    const secrets = (names: Record<string, string>) => ({
      named: (n: string) => (names[n] !== undefined ? { reveal: () => names[n] } : undefined),
    });
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    // The block names the env; the legacy default (ANTHROPIC_ADMIN_KEY) is not set and the LLM line is still on.
    const moved = costsFromConfig(
      cfg,
      { providers: { anthropic: { invoiceKeyEnv: "MY_ADMIN_KEY" } } },
      { secrets: secrets({ CF_ANALYTICS_TOKEN: "cf", MY_ADMIN_KEY: "sk-ant-admin" }), warn },
    );
    expect(moved?.llmOn).toBe(true);
    // The legacy `costs.anthropicAdminKeyEnv` still loads when the block names none.
    const legacy = costsFromConfig(
      cfg,
      { providers: { anthropic: {} } },
      { secrets: secrets({ CF_ANALYTICS_TOKEN: "cf", ANTHROPIC_ADMIN_KEY: "sk-ant-admin" }), warn },
    );
    expect(legacy?.llmOn).toBe(true);
    // A block whose biller has no invoice API, and one whose env is unset, warn by name; a good one wires quietly.
    const wired = costsFromConfig(
      cfg,
      {
        providers: {
          openrouter: { invoiceKeyEnv: "OPENROUTER_MGMT_KEY" },
          openai: { invoiceKeyEnv: "OPENAI_ADMIN_KEY" },
          groq: { invoiceKeyEnv: "GROQ_KEY" },
        },
      },
      { secrets: secrets({ CF_ANALYTICS_TOKEN: "cf", OPENROUTER_MGMT_KEY: "sk-or", GROQ_KEY: "gk" }), warn },
    );
    expect(wired).toBeDefined();
    expect(warnings.some((w) => w.includes("providers.groq.invoiceKeyEnv") && w.includes("no invoice API"))).toBe(true);
    expect(warnings.some((w) => w.includes("providers.openai.invoiceKeyEnv") && w.includes("OPENAI_ADMIN_KEY"))).toBe(
      true,
    );
    // The anthropic block's own env, when unset, warns by name too (item 4d) — the LLM line turns off, said, not silent.
    const unset = costsFromConfig(
      cfg,
      { providers: { anthropic: { invoiceKeyEnv: "MISSING_ADMIN_KEY" } } },
      { secrets: secrets({ CF_ANALYTICS_TOKEN: "cf" }), warn },
    );
    expect(unset?.llmOn).toBe(false);
    expect(
      warnings.some((w) => w.includes("providers.anthropic.invoiceKeyEnv") && w.includes("MISSING_ADMIN_KEY")),
    ).toBe(true);
  });

  it("costsFromConfig: `snapshot.alertChannel` is told through the process's poster after the failures in a row the snapshotter counts; a channel with no poster is a warning at wiring time and no alert", async () => {
    const secrets = { named: (n: string) => (n === "CF_ANALYTICS_TOKEN" ? { reveal: () => "cf" } : undefined) };
    const alertCfg = { ...cfg, snapshot: { everyHours: 24, alertChannel: "slack:COPS" } };
    const posted: Array<[string, string]> = [];
    const warnings: string[] = [];
    // The wired snapshotter's alert is the poster on the configured channel: drive it through failures
    // with the network stubbed out (the sources bind `fetch` when built) — every take fails offline,
    // which is what the alert is for.
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    try {
      const wired = costsFromConfig(
        alertCfg,
        {},
        {
          secrets,
          notify: async (channel, text) => void posted.push([channel, text]),
          warn: (m) => warnings.push(m),
        },
      );
      for (let i = 0; i < ALERT_AFTER_FAILURES; i++)
        await expect(wired?.snapshots.refresh("schedule")).rejects.toThrow("offline");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(posted).toHaveLength(1);
    expect(posted[0]?.[0]).toBe("slack:COPS");
    expect(posted[0]?.[1]).toMatch(
      /^Costs snapshot: 3 takes in a row have failed since .*offline.*No snapshot serves yet\.$/,
    );

    const noPoster = costsFromConfig(alertCfg, {}, { secrets, warn: (m) => warnings.push(m) });
    expect(noPoster).toBeDefined();
    expect(
      warnings.some((w) => w.includes("costs.snapshot.alertChannel slack:COPS is set but this process cannot post")),
    ).toBe(true);
  });

  it("reads the snapshot the store holds after a restart: a service over a fresh snapshotter and the same store serves without a take", async () => {
    const store = new InMemoryCostsSnapshotStore();
    const stored: CostsSnapshot = {
      takenAt: new Date(T0).toISOString(),
      takenBy: "schedule",
      durationMs: 5,
      range: resolveRange(String(SNAPSHOT_DAYS), new Date(T0)),
      usage: USAGE,
      llm: LLM,
      runUsage: null,
    };
    await store.put(stored);
    let reads = 0;
    const restarted = new CostsSnapshotter(
      {
        cloudflare: {
          fetchUsage: async () => {
            reads += 1;
            return USAGE;
          },
        },
        llm: { fetchDailyCost: async () => LLM },
      },
      store,
      { everyHours: 24, now: () => new Date(T0 + 3_600_000) },
    );
    const service = createCostsService(cfg, restarted);
    expect((await service.report("switchboard", "7")).snapshot).toEqual({
      takenAt: stored.takenAt,
      takenBy: "schedule",
      durationMs: 5,
    });
    expect(reads).toBe(0);
  });
});
