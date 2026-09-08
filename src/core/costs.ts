import { systemClock } from "./trace/clock.js";
// Spend report: what a group of deployed pieces ("switchboard" = the bot
// Worker + its containers, the resident/sandbox/memory Workers) costs per day,
// assembled from the providers' own billing datasets and priced at list.
//
// Two sources, both behind seams (AGENTS.md invariant 2 — ≥2 implementations):
//   - Cloudflare GraphQL Analytics: `containersUsageAdaptiveGroups` for
//     container CPU/memory/disk, `durableObjectsPeriodicGroups.duration` for
//     billable DO GB-s (per namespace), `durableObjectsInvocationsAdaptiveGroups`
//     for DO request counts — the datasets Cloudflare bills from. NOT summed
//     request wall time: concurrent long requests (SSE streams, exec) overlap,
//     so that sum runs ~2× above what is billed (audit 2026-08-29).
//   - Anthropic Admin API `GET /v1/organizations/cost_report` grouped by
//     workspace — LLM spend, attributed to a group by its Anthropic workspace.
// `buildCostReport` is pure and does every dollar of arithmetic, so the math is
// unit-tested against real rows and the sources only fetch + map.
//
// Pricing model (Cloudflare Containers): vCPU bills on ACTIVE seconds only;
// memory and disk bill on the PROVISIONED size for every awake second. That is
// why `cpuTimeSec` (actual) sits next to `allocatedMemory` (provisioned) in the
// same row, and why adding vCPU to an instance is free until it is used.

export interface CostGroupConfig {
  /** Display name; defaults to the group key. */
  label?: string;
  /** Cloudflare Worker script names whose Durable Objects belong to this group. */
  workers: string[];
  /** Cloudflare container application id → display label. */
  containerApps: Record<string, string>;
  /** Durable Object namespace id → display label (billable DO duration is
   *  reported per namespace, not per Worker). */
  durableObjectNamespaces: Record<string, string>;
  /** Anthropic workspace whose cost report is this group's LLM spend. Absent → no LLM line. */
  anthropicWorkspaceId?: string;
}

export interface CostsConfig {
  cloudflareAccountId: string;
  /** Env var holding a Cloudflare API token with Account Analytics:Read. */
  cloudflareTokenEnv: string;
  /** Env var holding an Anthropic Admin API key (sk-ant-admin…). Optional feature. */
  anthropicAdminKeyEnv: string;
  groups: Record<string, CostGroupConfig>;
}

const DEFAULT_CF_TOKEN_ENV = "CF_ANALYTICS_TOKEN";
const DEFAULT_ANTHROPIC_ADMIN_ENV = "ANTHROPIC_ADMIN_KEY";

/** Validates the `costs:` config block. Absent → undefined (feature off). A
 *  malformed block throws at startup rather than producing a half-wired page. */
export function parseCostsConfig(raw: unknown): CostsConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object") throw new Error("costs: must be a mapping");
  const r = raw as Record<string, unknown>;
  if (typeof r.cloudflareAccountId !== "string" || !r.cloudflareAccountId)
    throw new Error("costs.cloudflareAccountId is required");
  if (!r.groups || typeof r.groups !== "object")
    throw new Error("costs.groups must be a mapping of group → { workers, containerApps }");
  const groups: Record<string, CostGroupConfig> = {};
  for (const [name, g] of Object.entries(r.groups as Record<string, unknown>)) {
    if (!g || typeof g !== "object") throw new Error(`costs.groups.${name} must be a mapping`);
    const gg = g as Record<string, unknown>;
    if (!Array.isArray(gg.workers) || !gg.workers.every((w) => typeof w === "string"))
      throw new Error(`costs.groups.${name}.workers must be a list of Worker script names`);
    const apps = gg.containerApps ?? {};
    if (typeof apps !== "object" || Object.values(apps as object).some((v) => typeof v !== "string"))
      throw new Error(`costs.groups.${name}.containerApps must map application id → label`);
    const namespaces = gg.durableObjectNamespaces ?? {};
    if (typeof namespaces !== "object" || Object.values(namespaces as object).some((v) => typeof v !== "string"))
      throw new Error(`costs.groups.${name}.durableObjectNamespaces must map namespace id → label`);
    groups[name] = {
      label: typeof gg.label === "string" ? gg.label : undefined,
      workers: gg.workers as string[],
      containerApps: apps as Record<string, string>,
      durableObjectNamespaces: namespaces as Record<string, string>,
      anthropicWorkspaceId: typeof gg.anthropicWorkspaceId === "string" ? gg.anthropicWorkspaceId : undefined,
    };
  }
  return {
    cloudflareAccountId: r.cloudflareAccountId,
    cloudflareTokenEnv: typeof r.cloudflareTokenEnv === "string" ? r.cloudflareTokenEnv : DEFAULT_CF_TOKEN_ENV,
    anthropicAdminKeyEnv:
      typeof r.anthropicAdminKeyEnv === "string" ? r.anthropicAdminKeyEnv : DEFAULT_ANTHROPIC_ADMIN_ENV,
    groups,
  };
}

// ---- prices -------------------------------------------------------------------

/** Cloudflare list prices (USD), developers.cloudflare.com/containers/pricing and
 *  /durable-objects/platform/pricing, as of 2026-08-29. Gross: the Workers Paid
 *  plan's included allowance is not subtracted. */
export const CLOUDFLARE_PRICES = {
  vcpuSecond: 0.00002,
  memoryGibSecond: 0.0000025,
  diskGbSecond: 0.00000007,
  /** DO duration: $12.50 per million GB-s (Cloudflare meters 128 MB × active
   *  wall-clock seconds and reports the product as `duration`). */
  doDurationGbSecond: 12.5e-6,
  doRequestsPerMillion: 0.15,
} as const;

const GIB = 2 ** 30;
const GB = 1e9;

// ---- usage rows (what the sources return) -------------------------------------

export interface ContainerUsageRow {
  date: string; // YYYY-MM-DD (UTC)
  applicationId: string;
  cpuTimeSec: number;
  allocatedMemoryByteSec: number;
  allocatedDiskByteSec: number;
}
export interface DoRequestsRow {
  date: string;
  scriptName: string;
  requests: number;
}
export interface DoDurationRow {
  date: string;
  namespaceId: string;
  /** Billable GB-s as Cloudflare reports it (`durableObjectsPeriodicGroups.sum.duration`). */
  gbSeconds: number;
}
export interface CloudflareUsage {
  containers: ContainerUsageRow[];
  durableObjectRequests: DoRequestsRow[];
  durableObjectDuration: DoDurationRow[];
}
export interface LlmCostRow {
  date: string;
  /** null = the organization's default workspace. */
  workspaceId: string | null;
  amountUsd: number;
}

export interface DateRange {
  from: string;
  to: string;
  days: number;
  /** `to` is today (UTC): its figures are still accruing. */
  partialLastDay: boolean;
}

// ---- pricing math ---------------------------------------------------------------

export interface ContainerCost {
  cpu: number;
  memory: number;
  disk: number;
  total: number;
}

export function containerCostUsd(row: ContainerUsageRow): ContainerCost {
  const cpu = row.cpuTimeSec * CLOUDFLARE_PRICES.vcpuSecond;
  const memory = (row.allocatedMemoryByteSec / GIB) * CLOUDFLARE_PRICES.memoryGibSecond;
  const disk = (row.allocatedDiskByteSec / GB) * CLOUDFLARE_PRICES.diskGbSecond;
  return { cpu, memory, disk, total: cpu + memory + disk };
}

export function doDurationCostUsd(gbSeconds: number): number {
  return gbSeconds * CLOUDFLARE_PRICES.doDurationGbSecond;
}

export function doRequestsCostUsd(requests: number): number {
  return (requests / 1e6) * CLOUDFLARE_PRICES.doRequestsPerMillion;
}

// ---- the report -------------------------------------------------------------------

export interface DailyCost {
  date: string;
  containers: Record<string, ContainerCost>;
  /** Billable DO duration cost per configured namespace label. Duration only — the
   *  full DO figure is this sum plus `doRequestsUsd` (`totals.byResource.durableObjects`). */
  durableObjects: Record<string, number>;
  /** DO request cost for the group's Workers (cents a day; not attributable to a namespace). */
  doRequestsUsd: number;
  cloudUsd: number;
  llmUsd: number;
  total: number;
}

export interface CostReport {
  group: string;
  label: string;
  range: DateRange;
  /** false = no LLM source configured; every llmUsd is 0 and means "unknown". */
  llmAvailable: boolean;
  days: DailyCost[];
  totals: {
    cloudUsd: number;
    llmUsd: number;
    total: number;
    byResource: { cpu: number; memory: number; disk: number; durableObjects: number };
  };
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Pure: prices the group's rows in the range. Rows for apps/workers/workspaces
 *  outside the group are dropped, days with no rows are zero-filled, `llm`
 *  null means no LLM source (reported as unavailable, not $0). */
export function buildCostReport(
  group: string,
  cfg: CostGroupConfig,
  usage: CloudflareUsage,
  llm: LlmCostRow[] | null,
  range: DateRange,
): CostReport {
  const workers = new Set(cfg.workers);
  const byResource = { cpu: 0, memory: 0, disk: 0, durableObjects: 0 };
  const days: DailyCost[] = eachDay(range).map((date) => {
    const containers: Record<string, ContainerCost> = {};
    for (const row of usage.containers) {
      if (row.date !== date) continue;
      const label = cfg.containerApps[row.applicationId];
      if (!label) continue;
      const c = containerCostUsd(row);
      const prev = containers[label];
      containers[label] = prev
        ? {
            cpu: prev.cpu + c.cpu,
            memory: prev.memory + c.memory,
            disk: prev.disk + c.disk,
            total: prev.total + c.total,
          }
        : c;
      byResource.cpu += c.cpu;
      byResource.memory += c.memory;
      byResource.disk += c.disk;
    }
    const durableObjects: Record<string, number> = {};
    for (const row of usage.durableObjectDuration) {
      if (row.date !== date) continue;
      const label = cfg.durableObjectNamespaces[row.namespaceId];
      if (!label) continue;
      const usd = doDurationCostUsd(row.gbSeconds);
      durableObjects[label] = (durableObjects[label] ?? 0) + usd;
      byResource.durableObjects += usd;
    }
    let doRequestsUsd = 0;
    for (const row of usage.durableObjectRequests) {
      if (row.date !== date || !workers.has(row.scriptName)) continue;
      doRequestsUsd += doRequestsCostUsd(row.requests);
    }
    byResource.durableObjects += doRequestsUsd;
    const llmUsd =
      llm && cfg.anthropicWorkspaceId
        ? llm
            .filter((r) => r.date === date && r.workspaceId === cfg.anthropicWorkspaceId)
            .reduce((s, r) => s + r.amountUsd, 0)
        : 0;
    const cloudUsd =
      Object.values(containers).reduce((s, c) => s + c.total, 0) +
      Object.values(durableObjects).reduce((s, v) => s + v, 0) +
      doRequestsUsd;
    return { date, containers, durableObjects, doRequestsUsd, cloudUsd, llmUsd, total: cloudUsd + llmUsd };
  });
  const cloudUsd = days.reduce((s, d) => s + d.cloudUsd, 0);
  const llmUsd = days.reduce((s, d) => s + d.llmUsd, 0);
  return {
    group,
    label: cfg.label ?? group,
    range,
    llmAvailable: llm !== null && !!cfg.anthropicWorkspaceId,
    days,
    totals: { cloudUsd, llmUsd, total: cloudUsd + llmUsd, byResource },
  };
}

// ---- range ----------------------------------------------------------------------------

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

/** `?days=N` → a UTC date range ending today. Garbage → default; clamped 1..90. */
export function resolveRange(daysParam: string | null, now: Date = new Date(systemClock())): DateRange {
  const parsed = daysParam === null ? NaN : Number(daysParam);
  const days = Number.isInteger(parsed) ? Math.min(MAX_DAYS, Math.max(1, parsed)) : DEFAULT_DAYS;
  const to = now.toISOString().slice(0, 10);
  return { from: addDays(to, -(days - 1)), to, days, partialLastDay: true };
}

// ---- sources ----------------------------------------------------------------------------

export interface CloudflareUsageSource {
  fetchUsage(range: DateRange): Promise<CloudflareUsage>;
}
export interface LlmCostSource {
  /** null = this source has nothing (not configured); [] = configured, no spend. */
  fetchDailyCost(range: DateRange): Promise<LlmCostRow[] | null>;
}

export class NullLlmCostSource implements LlmCostSource {
  fetchDailyCost(_range: DateRange): Promise<LlmCostRow[] | null> {
    return Promise.resolve(null);
  }
}

const CF_GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";
const CF_USAGE_QUERY = `query SwitchboardCosts($accountTag: String!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    containers: containersUsageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      sum { cpuTimeSec allocatedMemory allocatedDisk } dimensions { date applicationId } }
    durableObjectRequests: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      sum { requests } dimensions { date scriptName } }
    durableObjectDuration: durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      sum { duration } dimensions { date namespaceId } }
  } }
}`;

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Reads Cloudflare's billing datasets over GraphQL with a scoped API token
 *  (Account Analytics:Read). The token travels only in the Authorization header
 *  and never appears in errors. */
export class CloudflareGraphqlUsageSource implements CloudflareUsageSource {
  private readonly accountId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: { accountId: string; token: string; fetchImpl?: typeof fetch }) {
    this.accountId = opts.accountId;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchUsage(range: DateRange): Promise<CloudflareUsage> {
    const res = await this.fetchImpl(CF_GRAPHQL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: CF_USAGE_QUERY,
        variables: {
          accountTag: this.accountId,
          from: `${range.from}T00:00:00Z`,
          to: `${addDays(range.to, 1)}T00:00:00Z`,
        },
      }),
    });
    if (res.status !== 200) throw new Error(`cloudflare graphql ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { data?: unknown; errors?: { message?: string }[] | null };
    if (Array.isArray(body.errors) && body.errors.length > 0)
      throw new Error(`cloudflare graphql: ${body.errors.map((e) => e.message ?? "?").join("; ")}`);
    const account = ((body.data as { viewer?: { accounts?: unknown[] } })?.viewer?.accounts?.[0] ?? {}) as {
      containers?: { dimensions?: Record<string, unknown>; sum?: Record<string, unknown> }[];
      durableObjectRequests?: { dimensions?: Record<string, unknown>; sum?: Record<string, unknown> }[];
      durableObjectDuration?: { dimensions?: Record<string, unknown>; sum?: Record<string, unknown> }[];
    };
    return {
      containers: (account.containers ?? []).map((r) => ({
        date: str(r.dimensions?.date),
        applicationId: str(r.dimensions?.applicationId),
        cpuTimeSec: num(r.sum?.cpuTimeSec),
        allocatedMemoryByteSec: num(r.sum?.allocatedMemory),
        allocatedDiskByteSec: num(r.sum?.allocatedDisk),
      })),
      durableObjectRequests: (account.durableObjectRequests ?? []).map((r) => ({
        date: str(r.dimensions?.date),
        scriptName: str(r.dimensions?.scriptName),
        requests: num(r.sum?.requests),
      })),
      durableObjectDuration: (account.durableObjectDuration ?? []).map((r) => ({
        date: str(r.dimensions?.date),
        namespaceId: str(r.dimensions?.namespaceId),
        gbSeconds: num(r.sum?.duration),
      })),
    };
  }
}

const ANTHROPIC_COST_REPORT = "https://api.anthropic.com/v1/organizations/cost_report";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_COST_PAGES = 20;

/** Anthropic Admin API cost report, grouped by workspace, all pages. Amounts
 *  arrive as decimal strings in cents; we return dollars. Requires an Admin API
 *  key — a regular API key is rejected upstream (401). */
export class AnthropicCostReportSource implements LlmCostSource {
  private readonly adminKey: string;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: { adminKey: string; fetchImpl?: typeof fetch }) {
    this.adminKey = opts.adminKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchDailyCost(range: DateRange): Promise<LlmCostRow[]> {
    const rows: LlmCostRow[] = [];
    let page: string | null = null;
    for (let i = 0; ; i++) {
      // Like the non-USD check: refuse rather than mis-sum. A ≤90-day range at
      // limit=31 is at most 3 pages, so hitting the cap means the API changed.
      if (i >= MAX_COST_PAGES)
        throw new Error(
          `anthropic cost_report: more than ${MAX_COST_PAGES} pages; refusing to return a truncated total`,
        );
      const url = new URL(ANTHROPIC_COST_REPORT);
      url.searchParams.set("starting_at", `${range.from}T00:00:00Z`);
      url.searchParams.set("ending_at", `${addDays(range.to, 1)}T00:00:00Z`);
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.append("group_by[]", "workspace_id");
      url.searchParams.set("limit", "31");
      if (page) url.searchParams.set("page", page);
      const res = await this.fetchImpl(url.toString(), {
        headers: { "x-api-key": this.adminKey, "anthropic-version": ANTHROPIC_VERSION },
      });
      if (res.status !== 200)
        throw new Error(`anthropic cost_report ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as {
        data?: {
          starting_at?: string;
          results?: { amount?: string; currency?: string; workspace_id?: string | null }[];
        }[];
        has_more?: boolean;
        next_page?: string | null;
      };
      for (const bucket of body.data ?? []) {
        const date = str(bucket.starting_at).slice(0, 10);
        for (const r of bucket.results ?? []) {
          if (r.currency !== "USD") throw new Error(`anthropic cost_report: unexpected currency ${r.currency ?? "?"}`);
          const cents = Number(r.amount);
          if (!Number.isFinite(cents)) throw new Error("anthropic cost_report: non-numeric amount");
          rows.push({ date, workspaceId: r.workspace_id ?? null, amountUsd: cents / 100 });
        }
      }
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
    return rows;
  }
}

// ---- service (what the view talks to) ---------------------------------------------------

export interface CostsService {
  groups(): string[];
  /** Live read of both sources for one group; throws on upstream failure. */
  report(group: string, daysParam: string | null): Promise<CostReport>;
}

/** Why there is no spend report, when the config has no `costs` block or the
 *  Cloudflare analytics token is not in the env. */
export const COSTS_OFF_MESSAGE =
  "Cost reporting isn't configured — set costs.cloudflareAccountId + costs.groups in config and the CF_ANALYTICS_TOKEN secret to enable this view.";

/** The service of a process without cost reporting (a Null Object, routing-and-
 *  config item 16): no group exists, and a report of one is refused with the
 *  reason — the view renders that instead of branching on a missing service. */
export class NullCostsService implements CostsService {
  groups(): string[] {
    return [];
  }
  report(_group: string, _daysParam: string | null): Promise<CostReport> {
    return Promise.reject(new Error(COSTS_OFF_MESSAGE));
  }
}

export function createCostsService(
  cfg: CostsConfig,
  cloudflare: CloudflareUsageSource,
  llm: LlmCostSource,
  now: () => Date = () => new Date(systemClock()),
): CostsService {
  return {
    groups: () => Object.keys(cfg.groups),
    async report(group, daysParam) {
      const g = cfg.groups[group];
      if (!g) throw new Error(`unknown cost group ${group}`);
      const range = resolveRange(daysParam, now());
      const [usage, llmRows] = await Promise.all([cloudflare.fetchUsage(range), llm.fetchDailyCost(range)]);
      return buildCostReport(group, g, usage, llmRows, range);
    },
  };
}
