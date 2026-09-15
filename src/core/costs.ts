import { systemClock } from "./trace/clock.js";
import { buildUserCostReport, type UserCostReport } from "./costsByUser.js";
import { NullRunStore, type RunStore } from "./runStore.js";
import type { RunUsageReport } from "./runUsage.js";
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
  /** How the page names the account beside its share (the dashboard's account
   *  name, e.g. `acme-infra`); absent → the page prints the id's first eight hex. */
  cloudflareAccountName?: string;
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
  if (r.cloudflareAccountName !== undefined && typeof r.cloudflareAccountName !== "string")
    throw new Error("costs.cloudflareAccountName must be a string when given");
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
    ...(typeof r.cloudflareAccountName === "string" && r.cloudflareAccountName
      ? { cloudflareAccountName: r.cloudflareAccountName }
      : {}),
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
  /** true = the cost report had no bucket for this day yet (it closes a day
   *  some hours after midnight UTC and never has one for the open day), so the
   *  amount is the hourly usage report priced at `ANTHROPIC_PRICES`. Absent =
   *  the invoice-grade cost report. */
  estimated?: boolean;
  /** Tokens an estimate met under a model id `ANTHROPIC_PRICES` has no entry
   *  for — reported, never priced at $0 in silence. Absent on a cost-report row. */
  unpricedTokens?: number;
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
  /** true = `llmUsd` is the usage report priced at list, because the cost
   *  report has not closed this day (`LlmCostRow.estimated`). */
  llmEstimated: boolean;
  /** Tokens of the group's workspace the estimate could not price (unknown model id). */
  llmUnpricedTokens: number;
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
  /** When the report was assembled (epoch ms): the page scales the open day's
   *  figures to a full day by the fraction of the UTC day that had elapsed. */
  generatedAt: number;
  /** The whole account, every row priced the same way, grouped or not — the
   *  denominator of "our services vs everything else on this account" — with
   *  the id the page links to and the configured name it prints. */
  account: { id: string; name?: string; cloudUsd: number };
  attribution: CostAttribution;
}

/** What the report carries beyond the priced rows: the account behind the
 *  denominator and the clock the page scales the open day by. */
export interface CostReportMeta {
  /** The Cloudflare account the rows came from — required, since the page
   *  links to it and an empty id would link to the bare dashboard. */
  accountId: string;
  accountName?: string;
  /** Absent → the system clock, for callers that do not assemble a page. */
  generatedAt?: number;
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
  meta: CostReportMeta,
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
    const llmRows =
      llm && cfg.anthropicWorkspaceId
        ? llm.filter((r) => r.date === date && r.workspaceId === cfg.anthropicWorkspaceId)
        : [];
    const llmUsd = llmRows.reduce((s, r) => s + r.amountUsd, 0);
    const llmEstimated = llmRows.some((r) => r.estimated === true);
    const llmUnpricedTokens = llmRows.reduce((s, r) => s + (r.unpricedTokens ?? 0), 0);
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
      llmEstimated,
      llmUnpricedTokens,
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
    generatedAt: meta.generatedAt ?? systemClock(),
    account: {
      id: meta.accountId,
      ...(meta.accountName ? { name: meta.accountName } : {}),
      cloudUsd: accountCloudUsd,
    },
    attribution,
  };
}

// ---- Anthropic list prices ----------------------------------------------------------------

/** USD per million tokens of one kind, one model family. */
export interface AnthropicModelPrice {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
}

/** Anthropic list prices per model family (platform.claude.com/docs/en/about-claude/pricing;
 *  re-check when it moves). Keyed by the family id the usage report spells — a dated
 *  release (`claude-haiku-4-5-20251001`) resolves to its family through
 *  `anthropicPriceOf`. Only what the estimate needs: the open day priced at
 *  the rate it will bill at; the cost report remains the invoice. */
export const ANTHROPIC_PRICES: Record<string, AnthropicModelPrice> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  "claude-mythos-5": { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 },
  "claude-opus-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  "claude-opus-4-1": { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  "claude-haiku-3-5": { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 },
};

const DATED_RELEASE_SUFFIX = /^-\d{8}$/;

/** The family prices of a model id: the id itself, or the id less a dated
 *  release suffix (`-YYYYMMDD`). Nothing else counts as "the same family" —
 *  `claude-fable-5-1` is not `claude-fable-5` with a suffix, and its cache
 *  reads bill differently. Unknown → undefined, never a guess. */
export function anthropicPriceOf(modelId: string): AnthropicModelPrice | undefined {
  const exact = ANTHROPIC_PRICES[modelId];
  if (exact) return exact;
  for (const family of Object.keys(ANTHROPIC_PRICES)) {
    if (modelId.startsWith(family) && DATED_RELEASE_SUFFIX.test(modelId.slice(family.length)))
      return ANTHROPIC_PRICES[family];
  }
  return undefined;
}

/** Token counts of one usage-report row, in the report's own kinds. */
export interface AnthropicTokens {
  uncachedInput: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** What those tokens cost at the family's list prices; undefined for a model
 *  the table does not know (the caller reports the tokens, never $0). */
export function anthropicTokensCostUsd(modelId: string, t: AnthropicTokens): number | undefined {
  const p = anthropicPriceOf(modelId);
  if (!p) return undefined;
  return (
    (t.uncachedInput * p.input +
      t.output * p.output +
      t.cacheRead * p.cacheRead +
      t.cacheWrite5m * p.cacheWrite5m +
      t.cacheWrite1h * p.cacheWrite1h) /
    1_000_000
  );
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
    const key = `${r.date} ${r.workflowName}`;
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
const ANTHROPIC_USAGE_REPORT = "https://api.anthropic.com/v1/organizations/usage_report/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_COST_PAGES = 20;
/** The open day plus two days of cost-report lag; older days without a bucket are not estimated. */
export const MAX_ESTIMATED_DAYS = 3;

type UsageReportBody = {
  data?: {
    starting_at?: string;
    results?: {
      workspace_id?: string | null;
      model?: string;
      uncached_input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    }[];
  }[];
  has_more?: boolean;
  next_page?: string | null;
};

/** Anthropic Admin API cost report, grouped by workspace, all pages. Amounts
 *  arrive as decimal strings in cents; we return dollars. Requires an Admin API
 *  key — a regular API key is rejected upstream (401).
 *
 *  The cost report is the invoice, and the invoice closes late: a day gets its
 *  bucket some hours after midnight UTC and the open day never has one (nor
 *  does the usage report at `1d`). So the days after the report's last bucket
 *  are priced from the HOURLY usage report at `ANTHROPIC_PRICES` and flagged
 *  `estimated` — the page can then show today, and a 1-day range means
 *  something. Read live when this was written: fourteen hourly buckets for the
 *  open day, none at `1d`; the cost report's last bucket was the day before. */
export class AnthropicCostReportSource implements LlmCostSource {
  private readonly adminKey: string;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: { adminKey: string; fetchImpl?: typeof fetch }) {
    this.adminKey = opts.adminKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchDailyCost(range: DateRange): Promise<LlmCostRow[]> {
    const report = await this.fetchCostReport(range);
    // A bucket with no results is still a closed day: track buckets, not rows.
    // Only the trailing MAX_ESTIMATED_DAYS are ever estimated: the report lags
    // a day at most, so an older day with no bucket had no spend (a new
    // workspace, a new organization) — and a page load must not turn into
    // ninety live usage reads because the report answered nothing.
    const open = eachDay(range).filter((date) => report.closedThrough === null || date > report.closedThrough);
    const estimated = await Promise.all(open.slice(-MAX_ESTIMATED_DAYS).map((date) => this.estimateDay(date)));
    return [...report.rows, ...estimated.flat()];
  }

  /** The hourly usage report for one day, summed per workspace × model and
   *  priced at list; one row per workspace, `estimated`, with the tokens of
   *  any model the price table does not know reported as `unpricedTokens`. */
  private async estimateDay(date: string): Promise<LlmCostRow[]> {
    const perWorkspace = new Map<string | null, Map<string, AnthropicTokens>>();
    let page: string | null = null;
    for (let i = 0; ; i++) {
      // ≤24 hourly buckets a day at limit=24: a second page is the API's
      // pagination quirk at most, twenty is the API having changed.
      if (i >= MAX_COST_PAGES)
        throw new Error(
          `anthropic usage_report: more than ${MAX_COST_PAGES} pages for ${date}; refusing a truncated estimate`,
        );
      const url = new URL(ANTHROPIC_USAGE_REPORT);
      url.searchParams.set("starting_at", `${date}T00:00:00Z`);
      url.searchParams.set("ending_at", `${addDays(date, 1)}T00:00:00Z`);
      url.searchParams.set("bucket_width", "1h");
      url.searchParams.append("group_by[]", "workspace_id");
      url.searchParams.append("group_by[]", "model");
      url.searchParams.set("limit", "24");
      if (page) url.searchParams.set("page", page);
      const res = await this.fetchImpl(url.toString(), {
        headers: { "x-api-key": this.adminKey, "anthropic-version": ANTHROPIC_VERSION },
      });
      if (res.status !== 200)
        throw new Error(`anthropic usage_report ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as UsageReportBody;
      for (const bucket of body.data ?? []) {
        for (const r of bucket.results ?? []) {
          const ws = r.workspace_id ?? null;
          const byModel = perWorkspace.get(ws) ?? new Map<string, AnthropicTokens>();
          const model = str(r.model);
          const t = byModel.get(model) ?? {
            uncachedInput: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite5m: 0,
            cacheWrite1h: 0,
          };
          t.uncachedInput += num(r.uncached_input_tokens);
          t.output += num(r.output_tokens);
          t.cacheRead += num(r.cache_read_input_tokens);
          t.cacheWrite5m += num(r.cache_creation?.ephemeral_5m_input_tokens);
          t.cacheWrite1h += num(r.cache_creation?.ephemeral_1h_input_tokens);
          byModel.set(model, t);
          perWorkspace.set(ws, byModel);
        }
      }
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
    const out: LlmCostRow[] = [];
    for (const [workspaceId, byModel] of perWorkspace) {
      let amountUsd = 0;
      let unpricedTokens = 0;
      for (const [model, t] of byModel) {
        const usd = anthropicTokensCostUsd(model, t);
        if (usd === undefined)
          unpricedTokens += t.uncachedInput + t.output + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
        else amountUsd += usd;
      }
      out.push({ date, workspaceId, amountUsd, estimated: true, unpricedTokens });
    }
    return out;
  }

  /** Every page of the cost report for the range, plus the last day it has a
   *  bucket for (null when it has none in the range). */
  private async fetchCostReport(range: DateRange): Promise<{ rows: LlmCostRow[]; closedThrough: string | null }> {
    const rows: LlmCostRow[] = [];
    let closedThrough: string | null = null;
    // The cost report never holds the open day, and the API refuses a range
    // that begins there (400 "ending date must be after starting date", seen
    // live on `?days=1`): the query ends at the open day's start, exclusive,
    // and a range that is only the open day asks the cost report nothing.
    const endExclusive = range.partialLastDay ? range.to : addDays(range.to, 1);
    if (range.from >= endExclusive) return { rows, closedThrough };
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
      url.searchParams.set("ending_at", `${endExclusive}T00:00:00Z`);
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
        if (closedThrough === null || date > closedThrough) closedThrough = date;
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
    return { rows, closedThrough };
  }
}

// ---- service (what the view talks to) ---------------------------------------------------

export interface CostsService {
  groups(): string[];
  /** Live read of both sources for one group; throws on upstream failure. */
  report(group: string, daysParam: string | null): Promise<CostReport>;
  /** Cost by user (costs.md item 10): the group's daily report plus the run
   *  history's per-user usage for the same range, and the signed-in viewer's
   *  run ids for the **me** toggle (matched by email through the Slack lookup
   *  when one is wired). Throws on upstream failure like `report`. */
  usersReport(group: string, daysParam: string | null, viewer: CostsViewer | undefined): Promise<UserCostReport>;
}

/** Who is looking: the Access identity's fields the viewer match needs. */
export interface CostsViewer {
  sub: string;
  email?: string;
}

/** What the by-user report reads beyond the two billing sources. */
export interface CostsServiceDeps {
  /** The run history; absent (or the null store) → the by-user report is empty and says history is off. */
  runStore?: RunStore;
  /** A Slack user id (`U…`) → its email, when the app can read it — how the
   *  viewer's Access email is matched to the run ids the history bills. */
  emailOfSlackUser?: (userId: string) => Promise<string | undefined>;
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
  usersReport(_group: string, _daysParam: string | null, _viewer: CostsViewer | undefined): Promise<UserCostReport> {
    return Promise.reject(new Error(COSTS_OFF_MESSAGE));
  }
}

/** The run ids the history bills that belong to the viewer: every `slack:U…`
 *  user in the report whose Slack email equals the viewer's Access email. One
 *  lookup per distinct user, cached for the process (an email does not move). */
export async function viewerRunUserIds(
  userIds: readonly string[],
  viewer: CostsViewer | undefined,
  emailOfSlackUser: ((userId: string) => Promise<string | undefined>) | undefined,
  cache: Map<string, string | undefined>,
): Promise<{ userIds: string[]; matchedByEmail: boolean }> {
  const email = viewer?.email?.toLowerCase();
  if (!email || !emailOfSlackUser) return { userIds: [], matchedByEmail: false };
  const out: string[] = [];
  for (const id of new Set(userIds)) {
    if (!id.startsWith("slack:")) continue;
    const slackId = id.slice("slack:".length);
    // A known email is cached for the process; an unknown one is asked again
    // next time, since a lookup that failed quietly must not pin the user as
    // unmatchable for as long as the bot runs.
    let known = cache.get(slackId);
    if (known === undefined) {
      known = (await emailOfSlackUser(slackId))?.toLowerCase();
      if (known !== undefined) cache.set(slackId, known);
    }
    if (known === email) out.push(id);
  }
  return { userIds: out, matchedByEmail: true };
}

export function createCostsService(
  cfg: CostsConfig,
  cloudflare: CloudflareUsageSource,
  llm: LlmCostSource,
  now: () => Date = () => new Date(systemClock()),
  deps: CostsServiceDeps = {},
): CostsService {
  const emailCache = new Map<string, string | undefined>();
  const report = async (group: string, daysParam: string | null, at: Date): Promise<CostReport> => {
    const g = cfg.groups[group];
    if (!g) throw new Error(`unknown cost group ${group}`);
    const range = resolveRange(daysParam, at);
    const [usage, llmRows] = await Promise.all([cloudflare.fetchUsage(range), llm.fetchDailyCost(range)]);
    return buildCostReport(group, g, usage, llmRows, range, {
      accountId: cfg.cloudflareAccountId,
      accountName: cfg.cloudflareAccountName,
      generatedAt: at.getTime(),
    });
  };
  return {
    groups: () => Object.keys(cfg.groups),
    report: (group, daysParam) => report(group, daysParam, now()),
    async usersReport(group, daysParam, viewer) {
      const at = now();
      const store = deps.runStore instanceof NullRunStore ? undefined : deps.runStore;
      const daily = await report(group, daysParam, at);
      const usage: RunUsageReport = store
        ? await store.usageByUser({
            sinceMs: Date.parse(`${daily.range.from}T00:00:00Z`),
            untilMs: Date.parse(`${daily.range.to}T00:00:00Z`) + 86_400_000,
          })
        : { rows: [], pending: 0, retentionDays: 0 };
      const viewerIds = await viewerRunUserIds(
        usage.rows.map((r) => r.userId),
        viewer,
        deps.emailOfSlackUser,
        emailCache,
      );
      return buildUserCostReport({
        group,
        range: daily.range,
        usage,
        days: daily.days,
        historyOn: store !== undefined,
        viewerUserIds: viewerIds.userIds,
        matchedByEmail: viewerIds.matchedByEmail,
        generatedAt: at.getTime(),
      });
    },
  };
}
