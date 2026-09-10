import { systemClock } from "./trace/clock.js";
// Spend report: what a group of deployed pieces ("switchboard" = the bot
// Worker + its containers, the resident/sandbox/memory Workers) costs per day,
// assembled from the providers' own billing datasets and priced at list — and
// what share of the whole account's Cloudflare spend that is, so a deployer
// can tell our services' cost from everything else on their account.
//
// Two sources, both behind seams (AGENTS.md invariant 2 — ≥2 implementations):
//   - Cloudflare GraphQL Analytics, every meter Cloudflare bills a Workers
//     deployment on: `containersUsageAdaptiveGroups` (container CPU/memory/disk),
//     `durableObjectsPeriodicGroups` (billable DO GB-s, SQLite rows read and
//     written, per namespace), `durableObjectsInvocationsAdaptiveGroups` (DO
//     requests, and which Worker hosts which namespace),
//     `durableObjectsSqlStorageGroups` (DO SQLite bytes stored),
//     `workersInvocationsAdaptive` (Worker requests and CPU time),
//     `r2StorageAdaptiveGroups` and `r2OperationsAdaptiveGroups` (R2 bytes stored
//     and class A/B operations), `workflowsAdaptiveGroups` (Workflow step
//     endings; the state bytes have no dataset). NOT summed request wall time for DO duration:
//     concurrent long requests (SSE streams, exec) overlap, so that sum runs ~2×
//     above what is billed.
//   - Anthropic Admin API `GET /v1/organizations/cost_report` grouped by
//     workspace — LLM spend, attributed to a group by its Anthropic workspace.
// `buildCostReport` is pure and does every dollar of arithmetic, so the math is
// unit-tested against dataset-shaped rows and the sources only fetch + map.
//
// Attribution is by Worker script name: a group names its Workers, and
// everything Cloudflare bills hangs off a script — a Durable Object namespace
// is attributed to the script that hosts it (the invocations dataset says
// which), an R2 bucket by the exact `<script>-cache` name the deploy templates
// give it, a Workflow by the exact `<script>-refresh` name they give it.
// Container applications carry no script in any dataset, so they stay a
// configured id → label map. A resource that appears in the account after the
// config was written is therefore counted, not silently dropped, as long as it
// belongs to a named Worker.
//
// Pricing model (Cloudflare Containers): vCPU bills on ACTIVE seconds only;
// memory and disk bill on the PROVISIONED size for every awake second. That is
// why `cpuTimeSec` (actual) sits next to `allocatedMemory` (provisioned) in the
// same row, and why adding vCPU to an instance is free until it is used.

export interface CostGroupConfig {
  /** Display name; defaults to the group key. */
  label?: string;
  /** Cloudflare Worker script names — the attribution root: their Durable Object
   *  namespaces, their requests and CPU, and the R2 buckets named after them. */
  workers: string[];
  /** Cloudflare container application id → display label (no dataset ties an
   *  application to its Worker, so this stays explicit). */
  containerApps: Record<string, string>;
  /** Durable Object namespace id → display label. Optional: a namespace hosted
   *  by one of `workers` is attributed anyway (labelled by its Worker); a listed
   *  one is attributed even when the range shows it no invocation to join on. */
  durableObjectNamespaces: Record<string, string>;
  /** R2 bucket name → display label. Optional: a bucket named the way the deploy
   *  templates name a Worker's (`<worker>-cache`) is attributed anyway. */
  r2Buckets: Record<string, string>;
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

function labelMap(raw: unknown, what: string): Record<string, string> {
  const m = raw ?? {};
  if (typeof m !== "object" || Array.isArray(m) || Object.values(m as object).some((v) => typeof v !== "string"))
    throw new Error(what);
  return m as Record<string, string>;
}

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
    groups[name] = {
      label: typeof gg.label === "string" ? gg.label : undefined,
      workers: gg.workers as string[],
      containerApps: labelMap(gg.containerApps, `costs.groups.${name}.containerApps must map application id → label`),
      durableObjectNamespaces: labelMap(
        gg.durableObjectNamespaces,
        `costs.groups.${name}.durableObjectNamespaces must map namespace id → label`,
      ),
      r2Buckets: labelMap(gg.r2Buckets, `costs.groups.${name}.r2Buckets must map bucket name → label`),
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

/** Cloudflare list prices (USD), developers.cloudflare.com/containers/pricing,
 *  /durable-objects/platform/pricing, /workers/platform/pricing, /r2/pricing
 *  and /workflows/reference/pricing. Gross: the Workers Paid plan's fee and
 *  included allowances are not subtracted — the page prices what was used, at
 *  the rate it would bill at. */
export const CLOUDFLARE_PRICES = {
  vcpuSecond: 0.00002,
  memoryGibSecond: 0.0000025,
  diskGbSecond: 0.00000007,
  /** DO duration: $12.50 per million GB-s (Cloudflare meters 128 MB × active
   *  wall-clock seconds and reports the product as `duration`). */
  doDurationGbSecond: 12.5e-6,
  doRequestsPerMillion: 0.15,
  /** SQLite-backed Durable Objects: rows read $0.001/M, rows written $1.00/M, storage $0.20/GB-month. */
  doRowsReadPerMillion: 0.001,
  doRowsWrittenPerMillion: 1.0,
  doStorageGbMonth: 0.2,
  /** Workers: $0.30 per million requests, $0.02 per million CPU-milliseconds. */
  workersRequestsPerMillion: 0.3,
  workersCpuPerMillionMs: 0.02,
  /** R2 Standard: storage $0.015/GB-month, class A $4.50/M, class B $0.36/M, egress free. */
  r2StorageGbMonth: 0.015,
  r2ClassAPerMillion: 4.5,
  r2ClassBPerMillion: 0.36,
  /** Workflows (developers.cloudflare.com/workflows/reference/pricing, Workers
   *  Paid): steps "500,000 included per month + $0.80/ additional 100,000",
   *  storage "1 GB-month included + $0.20/ GB-month". The other two line items,
   *  requests and CPU time, "use Workers Standard pricing" and land on the
   *  hosting Worker's own `workersInvocationsAdaptive` row — never re-metered here. */
  workflowStepsPer100k: 0.8,
  workflowStorageGbMonth: 0.2,
} as const;

const GIB = 2 ** 30;
const GB = 1e9;
/** A GB-month is prorated per day over the mean Gregorian month (365.25 ÷ 12). */
export const DAYS_PER_MONTH = 30.4375;

// ---- usage rows (what the sources return) -------------------------------------

export interface ContainerUsageRow {
  date: string; // YYYY-MM-DD (UTC)
  applicationId: string;
  cpuTimeSec: number;
  allocatedMemoryByteSec: number;
  allocatedDiskByteSec: number;
}
/** `durableObjectsInvocationsAdaptiveGroups`: requests per namespace per day,
 *  and the join that says which Worker hosts which namespace. */
export interface DoRequestsRow {
  date: string;
  scriptName: string;
  namespaceId: string;
  requests: number;
}
/** `durableObjectsPeriodicGroups`: one namespace's day — billable GB-s as
 *  Cloudflare reports it (`sum.duration`) and the SQLite rows it read and wrote. */
export interface DoNamespaceDayRow {
  date: string;
  namespaceId: string;
  gbSeconds: number;
  rowsRead: number;
  rowsWritten: number;
}
/** `durableObjectsSqlStorageGroups`: the day's peak bytes stored per namespace. */
export interface DoStorageRow {
  date: string;
  namespaceId: string;
  storedBytes: number;
}
/** `workersInvocationsAdaptive`: a Worker's requests and CPU time per day. */
export interface WorkerUsageRow {
  date: string;
  scriptName: string;
  requests: number;
  cpuTimeUs: number;
}
/** `r2StorageAdaptiveGroups`: the day's peak bytes (payload + metadata) per bucket. */
export interface R2StorageRow {
  date: string;
  bucketName: string;
  bytes: number;
}
/** `r2OperationsAdaptiveGroups`: operations per bucket per action per day. */
export interface R2OperationsRow {
  date: string;
  bucketName: string;
  actionType: string;
  requests: number;
}
/** `workflowsAdaptiveGroups`: a Workflow's billable steps per day — the step
 *  endings (`STEP_SUCCESS` + `STEP_FAILURE` events; attempts are retries and
 *  the pricing page excludes retries and rollback handlers from the count) —
 *  and its persisted state. No analytics dataset reports the state bytes, so
 *  the GraphQL source answers 0 there and only a source that knows them
 *  (none yet) prices the storage line. */
export interface WorkflowUsageRow {
  date: string;
  workflowName: string;
  steps: number;
  /** The day's peak bytes of persisted instance state; 0 when the source has no figure. */
  stateBytes: number;
}
export interface CloudflareUsage {
  containers: ContainerUsageRow[];
  durableObjectRequests: DoRequestsRow[];
  durableObjectDays: DoNamespaceDayRow[];
  durableObjectStorage: DoStorageRow[];
  workers: WorkerUsageRow[];
  r2Storage: R2StorageRow[];
  r2Operations: R2OperationsRow[];
  workflows: WorkflowUsageRow[];
}
export const EMPTY_USAGE: CloudflareUsage = {
  containers: [],
  durableObjectRequests: [],
  durableObjectDays: [],
  durableObjectStorage: [],
  workers: [],
  r2Storage: [],
  r2Operations: [],
  workflows: [],
};
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

export function doRowsCostUsd(rowsRead: number, rowsWritten: number): number {
  return (
    (rowsRead / 1e6) * CLOUDFLARE_PRICES.doRowsReadPerMillion +
    (rowsWritten / 1e6) * CLOUDFLARE_PRICES.doRowsWrittenPerMillion
  );
}

/** One day of storage at a GB-month rate: the day's peak bytes, prorated. */
export function storageDayCostUsd(bytes: number, perGbMonth: number): number {
  return ((bytes / GB) * perGbMonth) / DAYS_PER_MONTH;
}

export function workersCostUsd(requests: number, cpuTimeUs: number): number {
  return (
    (requests / 1e6) * CLOUDFLARE_PRICES.workersRequestsPerMillion +
    (cpuTimeUs / 1000 / 1e6) * CLOUDFLARE_PRICES.workersCpuPerMillionMs
  );
}

export type R2OperationClass = "A" | "B" | "free";

/** Cloudflare's classes: A mutates or lists, B reads, deletes are free. Named
 *  operations first; an operation this table has not met is classed by its
 *  verb, so a new API action is priced rather than dropped. */
export function r2OperationClass(actionType: string): R2OperationClass {
  const a = actionType.trim();
  if (/^(Delete|Abort)/.test(a)) return "free";
  if (/^(Get|Head|Usage)/.test(a)) return "B";
  return "A";
}

/** Workflows: steps at the per-100,000 rate plus one day of the state's GB-month rate. */
export function workflowsCostUsd(steps: number, stateBytes: number): number {
  return (
    (steps / 100_000) * CLOUDFLARE_PRICES.workflowStepsPer100k +
    storageDayCostUsd(stateBytes, CLOUDFLARE_PRICES.workflowStorageGbMonth)
  );
}

export function r2OperationsCostUsd(actionType: string, requests: number): number {
  const cls = r2OperationClass(actionType);
  if (cls === "free") return 0;
  return (requests / 1e6) * (cls === "A" ? CLOUDFLARE_PRICES.r2ClassAPerMillion : CLOUDFLARE_PRICES.r2ClassBPerMillion);
}

// ---- attribution ----------------------------------------------------------------

/** What of the account the group's config plus the datasets' joins attribute
 *  to it — reported on the page so a reader can see what was counted. */
export interface CostAttribution {
  workers: string[];
  containerApps: Record<string, string>;
  /** namespace id → label (a configured label, else the hosting Worker's name). */
  durableObjectNamespaces: Record<string, string>;
  /** bucket name → label (a configured label, else the bucket's name). */
  r2Buckets: Record<string, string>;
  /** Workflow name → the Worker that hosts it (the deploy template's `<worker>-refresh`). */
  workflows: Record<string, string>;
}

/** The bucket names the deploy templates give a Worker's buckets (`{{script}}-cache`
 *  in deploy/cloudflare-resident/wrangler.template.jsonc). Exact shapes, not a
 *  prefix: on a shared account `switchboard-2-tfstate` must not become
 *  `switchboard`'s. A bucket named any other way is attributed by `r2Buckets`. */
const TEMPLATE_BUCKET_NAMES: ReadonlyArray<(worker: string) => string> = [(w) => `${w}-cache`];

/** The Workflow names the deploy templates give a Worker's Workflows
 *  (`{{script}}-refresh`, the resident's refresh cycle). The analytics dataset
 *  carries no script name, so the name is the only join — exact, like the buckets'. */
const TEMPLATE_WORKFLOW_NAMES: ReadonlyArray<(worker: string) => string> = [(w) => `${w}-refresh`];

/** Namespace → hosting script, from every invocation row (any date in range). */
function namespaceHosts(usage: CloudflareUsage): Map<string, string> {
  const hosts = new Map<string, string>();
  for (const r of usage.durableObjectRequests)
    if (r.namespaceId && r.scriptName) hosts.set(r.namespaceId, r.scriptName);
  return hosts;
}

export function attributionOf(cfg: CostGroupConfig, usage: CloudflareUsage): CostAttribution {
  const workers = new Set(cfg.workers);
  const durableObjectNamespaces: Record<string, string> = { ...cfg.durableObjectNamespaces };
  for (const [ns, script] of namespaceHosts(usage))
    if (workers.has(script) && !(ns in durableObjectNamespaces)) durableObjectNamespaces[ns] = script;
  const r2Buckets: Record<string, string> = { ...cfg.r2Buckets };
  const bucketNames = new Set([...usage.r2Storage, ...usage.r2Operations].map((r) => r.bucketName).filter(Boolean));
  for (const name of bucketNames)
    if (!(name in r2Buckets) && cfg.workers.some((w) => TEMPLATE_BUCKET_NAMES.some((shape) => shape(w) === name)))
      r2Buckets[name] = name;
  const workflows: Record<string, string> = {};
  for (const name of new Set(usage.workflows.map((r) => r.workflowName).filter(Boolean))) {
    const host = cfg.workers.find((w) => TEMPLATE_WORKFLOW_NAMES.some((shape) => shape(w) === name));
    if (host) workflows[name] = host;
  }
  return {
    workers: [...cfg.workers],
    containerApps: { ...cfg.containerApps },
    durableObjectNamespaces,
    r2Buckets,
    workflows,
  };
}

// ---- the report -------------------------------------------------------------------

export interface DailyCost {
  date: string;
  containers: Record<string, ContainerCost>;
  /** Billable DO duration cost per attributed namespace label. Duration only — the
   *  full DO figure is this sum plus `doRequestsUsd` (`totals.byResource.durableObjects`). */
  durableObjects: Record<string, number>;
  /** DO request cost for the group's namespaces (cents a day). */
  doRequestsUsd: number;
  /** SQLite rows read and written by the group's namespaces. */
  doRowsUsd: number;
  /** SQLite bytes stored by the group's namespaces, one day of the GB-month rate. */
  doStorageUsd: number;
  /** The group's Workers: requests and CPU time. */
  workersUsd: number;
  /** The group's R2 buckets: one day of storage plus class A/B operations. */
  r2Usd: number;
  /** The group's Workflows: steps plus one day of persisted state. */
  workflowsUsd: number;
  cloudUsd: number;
  llmUsd: number;
  total: number;
}

export interface ResourceSplit {
  cpu: number;
  memory: number;
  disk: number;
  /** DO duration + requests. */
  durableObjects: number;
  doRows: number;
  doStorage: number;
  workers: number;
  r2: number;
  /** Workflow steps + state. */
  workflows: number;
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
    byResource: ResourceSplit;
  };
  /** The whole account, every row priced the same way, grouped or not — the
   *  denominator of "our services vs everything else on this account". */
  account: { cloudUsd: number };
  attribution: CostAttribution;
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

const emptySplit = (): ResourceSplit => ({
  cpu: 0,
  memory: 0,
  disk: 0,
  durableObjects: 0,
  doRows: 0,
  doStorage: 0,
  workers: 0,
  r2: 0,
  workflows: 0,
});

/** Pure: prices the group's rows in the range. Rows for apps/namespaces/
 *  workers/buckets/workspaces outside the group are dropped from the group's
 *  figures (and counted in `account`), days with no rows are zero-filled, `llm`
 *  null means no LLM source (reported as unavailable, not $0). */
export function buildCostReport(
  group: string,
  cfg: CostGroupConfig,
  usage: CloudflareUsage,
  llm: LlmCostRow[] | null,
  range: DateRange,
): CostReport {
  const attribution = attributionOf(cfg, usage);
  const workers = new Set(cfg.workers);
  const namespaces = attribution.durableObjectNamespaces;
  const buckets = attribution.r2Buckets;
  const workflowNames = attribution.workflows;
  const byResource = emptySplit();
  let accountCloudUsd = 0;
  const days: DailyCost[] = eachDay(range).map((date) => {
    const containers: Record<string, ContainerCost> = {};
    for (const row of usage.containers) {
      if (row.date !== date) continue;
      const c = containerCostUsd(row);
      accountCloudUsd += c.total;
      const label = cfg.containerApps[row.applicationId];
      if (!label) continue;
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
    let doRowsUsd = 0;
    for (const row of usage.durableObjectDays) {
      if (row.date !== date) continue;
      const duration = doDurationCostUsd(row.gbSeconds);
      const rows = doRowsCostUsd(row.rowsRead, row.rowsWritten);
      accountCloudUsd += duration + rows;
      const label = namespaces[row.namespaceId];
      if (!label) continue;
      durableObjects[label] = (durableObjects[label] ?? 0) + duration;
      byResource.durableObjects += duration;
      doRowsUsd += rows;
    }
    byResource.doRows += doRowsUsd;
    let doRequestsUsd = 0;
    for (const row of usage.durableObjectRequests) {
      if (row.date !== date) continue;
      const usd = doRequestsCostUsd(row.requests);
      accountCloudUsd += usd;
      if (row.namespaceId in namespaces || (!row.namespaceId && workers.has(row.scriptName))) doRequestsUsd += usd;
    }
    byResource.durableObjects += doRequestsUsd;
    let doStorageUsd = 0;
    for (const row of usage.durableObjectStorage) {
      if (row.date !== date) continue;
      const usd = storageDayCostUsd(row.storedBytes, CLOUDFLARE_PRICES.doStorageGbMonth);
      accountCloudUsd += usd;
      if (row.namespaceId in namespaces) doStorageUsd += usd;
    }
    byResource.doStorage += doStorageUsd;
    let workersUsd = 0;
    for (const row of usage.workers) {
      if (row.date !== date) continue;
      const usd = workersCostUsd(row.requests, row.cpuTimeUs);
      accountCloudUsd += usd;
      if (workers.has(row.scriptName)) workersUsd += usd;
    }
    byResource.workers += workersUsd;
    let r2Usd = 0;
    for (const row of usage.r2Storage) {
      if (row.date !== date) continue;
      const usd = storageDayCostUsd(row.bytes, CLOUDFLARE_PRICES.r2StorageGbMonth);
      accountCloudUsd += usd;
      if (row.bucketName in buckets) r2Usd += usd;
    }
    for (const row of usage.r2Operations) {
      if (row.date !== date) continue;
      const usd = r2OperationsCostUsd(row.actionType, row.requests);
      accountCloudUsd += usd;
      if (row.bucketName in buckets) r2Usd += usd;
    }
    byResource.r2 += r2Usd;
    let workflowsUsd = 0;
    for (const row of usage.workflows) {
      if (row.date !== date) continue;
      const usd = workflowsCostUsd(row.steps, row.stateBytes);
      accountCloudUsd += usd;
      if (row.workflowName in workflowNames) workflowsUsd += usd;
    }
    byResource.workflows += workflowsUsd;
    const llmUsd =
      llm && cfg.anthropicWorkspaceId
        ? llm
            .filter((r) => r.date === date && r.workspaceId === cfg.anthropicWorkspaceId)
            .reduce((s, r) => s + r.amountUsd, 0)
        : 0;
    const cloudUsd =
      Object.values(containers).reduce((s, c) => s + c.total, 0) +
      Object.values(durableObjects).reduce((s, v) => s + v, 0) +
      doRequestsUsd +
      doRowsUsd +
      doStorageUsd +
      workersUsd +
      r2Usd +
      workflowsUsd;
    return {
      date,
      containers,
      durableObjects,
      doRequestsUsd,
      doRowsUsd,
      doStorageUsd,
      workersUsd,
      r2Usd,
      workflowsUsd,
      cloudUsd,
      llmUsd,
      total: cloudUsd + llmUsd,
    };
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
    account: { cloudUsd: accountCloudUsd },
    attribution,
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
/** One request, every meter: the datasets Cloudflare bills a Workers deployment on. */
export const CF_USAGE_QUERY = `query SwitchboardCosts($accountTag: String!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    containers: containersUsageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      sum { cpuTimeSec allocatedMemory allocatedDisk } dimensions { date applicationId } }
    durableObjectRequests: durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      sum { requests } dimensions { date scriptName namespaceId } }
    durableObjectDays: durableObjectsPeriodicGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      sum { duration rowsRead rowsWritten } dimensions { date namespaceId } }
    durableObjectStorage: durableObjectsSqlStorageGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      max { storedBytes } dimensions { date namespaceId } }
    workers: workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      sum { requests cpuTimeUs } dimensions { date scriptName } }
    r2Storage: r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      max { payloadSize metadataSize } dimensions { date bucketName } }
    r2Operations: r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $from, datetime_lt: $to }) {
      sum { requests } dimensions { date bucketName actionType } }
    workflows: workflowsAdaptiveGroups(limit: 10000, filter: { datetimeHour_geq: $from, datetimeHour_lt: $to }) {
      count dimensions { date workflowName eventType } }
  } }
}`;

/** The `workflowsAdaptiveGroups` events that are billable steps: one per step
 *  ending. `ATTEMPT_*` are the retries inside a step and `WORKFLOW_*` the
 *  instance's own lifecycle — neither is a step on the bill. */
export const WORKFLOW_STEP_EVENTS: ReadonlySet<string> = new Set(["STEP_SUCCESS", "STEP_FAILURE"]);

/** Fold the dataset's per-event rows into one steps figure per Workflow per day. */
export function workflowStepsFromEvents(
  rows: ReadonlyArray<{ date: string; workflowName: string; eventType: string; count: number }>,
): WorkflowUsageRow[] {
  const byKey = new Map<string, WorkflowUsageRow>();
  for (const r of rows) {
    if (!WORKFLOW_STEP_EVENTS.has(r.eventType) || !r.workflowName) continue;
    const key = `${r.date} ${r.workflowName}`;
    const row = byKey.get(key) ?? { date: r.date, workflowName: r.workflowName, steps: 0, stateBytes: 0 };
    row.steps += r.count;
    byKey.set(key, row);
  }
  return [...byKey.values()];
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

type GqlGroup = {
  dimensions?: Record<string, unknown>;
  sum?: Record<string, unknown>;
  max?: Record<string, unknown>;
  count?: unknown;
};

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
      containers?: GqlGroup[];
      durableObjectRequests?: GqlGroup[];
      durableObjectDays?: GqlGroup[];
      durableObjectStorage?: GqlGroup[];
      workers?: GqlGroup[];
      r2Storage?: GqlGroup[];
      r2Operations?: GqlGroup[];
      workflows?: GqlGroup[];
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
        namespaceId: str(r.dimensions?.namespaceId),
        requests: num(r.sum?.requests),
      })),
      durableObjectDays: (account.durableObjectDays ?? []).map((r) => ({
        date: str(r.dimensions?.date),
        namespaceId: str(r.dimensions?.namespaceId),
        gbSeconds: num(r.sum?.duration),
        rowsRead: num(r.sum?.rowsRead),
        rowsWritten: num(r.sum?.rowsWritten),
      })),
      durableObjectStorage: (account.durableObjectStorage ?? []).map((r) => ({
        date: str(r.dimensions?.date),
        namespaceId: str(r.dimensions?.namespaceId),
        storedBytes: num(r.max?.storedBytes),
      })),
      workers: (account.workers ?? []).map((r) => ({
        date: str(r.dimensions?.date),
        scriptName: str(r.dimensions?.scriptName),
        requests: num(r.sum?.requests),
        cpuTimeUs: num(r.sum?.cpuTimeUs),
      })),
      r2Storage: (account.r2Storage ?? []).map((r) => ({
        date: str(r.dimensions?.date),
        bucketName: str(r.dimensions?.bucketName),
        bytes: num(r.max?.payloadSize) + num(r.max?.metadataSize),
      })),
      r2Operations: (account.r2Operations ?? []).map((r) => ({
        date: str(r.dimensions?.date),
        bucketName: str(r.dimensions?.bucketName),
        actionType: str(r.dimensions?.actionType),
        requests: num(r.sum?.requests),
      })),
      workflows: workflowStepsFromEvents(
        (account.workflows ?? []).map((r) => ({
          date: str(r.dimensions?.date),
          workflowName: str(r.dimensions?.workflowName),
          eventType: str(r.dimensions?.eventType),
          count: num(r.count),
        })),
      ),
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
