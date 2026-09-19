import {
  anthropicTokensCostUsd,
  parseModelPrices,
  type AnthropicTokens,
  type ModelPriceTable,
} from "./modelPricing.js";
import { parseModelRef } from "./provider.js";
import type { RunUsage } from "./runUsage.js";
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
  /** How the page names the account beside its share (the dashboard's account
   *  name, e.g. `acme-infra`); absent → the page prints the id's first eight hex. */
  cloudflareAccountName?: string;
  /** Env var holding a Cloudflare API token with Account Analytics:Read. */
  cloudflareTokenEnv: string;
  /** Env var holding an Anthropic Admin API key (sk-ant-admin…). Optional feature. */
  anthropicAdminKeyEnv: string;
  groups: Record<string, CostGroupConfig>;
  /** `costs.prices`: the operator's per-million rates by `<provider>/<model>`, over the Anthropic list (item 4b). */
  prices: ModelPriceTable;
  /** The snapshot the page and the twins serve (src/core/costsSnapshot.ts). */
  snapshot: {
    /** Hours between two reads of the billing sources. */
    everyHours: number;
    /** The platform-namespaced channel (`slack:C…`) told when takes keep failing and when they
     *  land again (`ALERT_AFTER_FAILURES` in a row); absent → the status alone says so. */
    alertChannel?: string;
  };
}

const DEFAULT_CF_TOKEN_ENV = "CF_ANALYTICS_TOKEN";
const DEFAULT_ANTHROPIC_ADMIN_ENV = "ANTHROPIC_ADMIN_KEY";

/** `costs.snapshot.everyHours`: the default and the bounds a value must keep. Daily by
 *  default — both sources bucket by UTC day, and the page is read about as often. */
export const COSTS_SNAPSHOT_EVERY_HOURS = Object.freeze({ default: 24, min: 1, max: 168 });

/** `costs.snapshot`: absent → the default interval and no alert channel; a value outside the
 *  bounds or not a whole number throws by name; `alertChannel`, when given, is a platform-namespaced id. */
function snapshotConfig(raw: unknown): CostsConfig["snapshot"] {
  if (raw === undefined) return { everyHours: COSTS_SNAPSHOT_EVERY_HOURS.default };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("costs.snapshot must be a mapping");
  const r = raw as Record<string, unknown>;
  // `undefined` alone defaults: a bare `everyHours:` key (null) is a malformed value, refused below by name.
  const every = r.everyHours === undefined ? COSTS_SNAPSHOT_EVERY_HOURS.default : r.everyHours;
  if (
    typeof every !== "number" ||
    !Number.isInteger(every) ||
    every < COSTS_SNAPSHOT_EVERY_HOURS.min ||
    every > COSTS_SNAPSHOT_EVERY_HOURS.max
  )
    throw new Error(
      `costs.snapshot.everyHours must be a whole number of hours between ${COSTS_SNAPSHOT_EVERY_HOURS.min} and ${COSTS_SNAPSHOT_EVERY_HOURS.max}`,
    );
  if (r.alertChannel === undefined) return { everyHours: every };
  if (typeof r.alertChannel !== "string" || !/^[a-z]+:.+$/.test(r.alertChannel))
    throw new Error("costs.snapshot.alertChannel must be a platform-namespaced channel id (`slack:C…`)");
  return { everyHours: every, alertChannel: r.alertChannel };
}

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
    prices: parseModelPrices(r.prices),
    snapshot: snapshotConfig(r.snapshot),
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
  /** The snapshot the report was built from (src/core/costsSnapshot.ts): when it was
   *  taken, by whom, how long the read took. Absent on a report built straight from the sources. */
  snapshot?: { takenAt: string; takenBy: string; durationMs: number };
  /** Each biller's daily invoice tie-out (item 4d); absent when no provider block is known
   *  (a report built without the wiring) or run history is off. */
  billers?: BillerTieOut[];
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

// ---- range ----------------------------------------------------------------------------

const DEFAULT_DAYS = 30;
/** The widest range the page offers — and the window a costs snapshot is read for.
 *  Cloudflare's analytics on a Workers account answer no range wider than 4w4d
 *  (32 days) and hold no data older than that (`cannot request a time range
 *  wider than 4w4d`, `cannot request data older than 4w4d` — measured live), so
 *  a wider window is a refused read, not more history: 31 UTC days is the most
 *  a take can ask for. */
export const MAX_DAYS = 31;

/** `?days=N` → a UTC date range ending today. Garbage → default; clamped 1..31. */
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

// ---- invoices per biller (costs.md item 4d) ---------------------------------------------

/** One day of a biller's invoice, as its own billing API reports it. */
export interface InvoiceDay {
  date: string;
  /** The biller's invoiced dollars for the day (an aggregator's fee + BYOK upstream). */
  usd: number;
  /** An aggregator's own charge (OpenRouter's `usage`) — what the summed `feeUsd` ties against. */
  feeUsd?: number;
  /** An aggregator's BYOK upstream half (`byok_usage_inference`) — what the remainder ties against. */
  byokUsd?: number;
}

/** One invoice source per provider block that names an invoice API and an
 *  `invoiceKeyEnv`: the biller's own billing figures, per UTC day. */
export interface LlmInvoiceSource {
  /** The provider block this invoice bills — the `biller` its `model.turn` rows carry. */
  readonly biller: string;
  fetchInvoice(range: DateRange): Promise<InvoiceDay[]>;
}

/** One day of a biller's tie-out: its invoice beside the summed `model.turn` rows. */
export interface BillerTieOutDay {
  date: string;
  /** The biller's invoiced dollars; absent when the block names no source. */
  invoiceUsd?: number;
  invoiceFeeUsd?: number;
  invoiceByokUsd?: number;
  /** The summed `model.turn` dollars whose ref names this block. */
  attributedUsd: number;
  /** The summed BYOK fees — the half an aggregator's `usage` ties against. */
  attributedFeeUsd?: number;
  /** `attributedUsd − attributedFeeUsd` — the half `byok_usage_inference` ties against. */
  attributedUpstreamUsd?: number;
}

/** One biller's daily tie-out over the range. */
export interface BillerTieOut {
  biller: string;
  /** false = the block names no invoice source: it ties out against nothing and the page says "no invoice". */
  invoice: boolean;
  days: BillerTieOutDay[];
  totals: { invoiceUsd: number; attributedUsd: number };
}

/** The block a ref bills to, or undefined for a ref that names none (`unknown`). */
const billerOfRef = (ref: string): string | undefined => (ref.includes("/") ? parseModelRef(ref).provider : undefined);

/**
 * Pure: each biller's invoice compared with the summed `model.turn` rows whose
 * ref names that block, per UTC day of the range. An aggregator's invoice
 * halves (`feeUsd`, `byokUsd`) sit beside the summed fees and the remainder. A
 * model whose `usd` is null or absent (unpriced, or from before the meter row)
 * contributes nothing to `attributedUsd` — an understated side is honest, an
 * invented one is not, so a day the source returned no row for keeps its
 * invoice side absent (the page renders —): the source holds closed days only,
 * and a trailing uninvoiced day beside real spend is not a $0 invoice. A day
 * with neither an invoice row nor a nonzero attributed figure is dropped; a
 * biller without a source (`invoice: false`) ties out against nothing.
 */
export function buildBillerTieOuts(
  billers: ReadonlyArray<{ name: string; invoice: boolean }>,
  invoices: Readonly<Record<string, InvoiceDay[]>>,
  cells: ReadonlyArray<{ day: string; usage: RunUsage }>,
  range: DateRange,
): BillerTieOut[] {
  return billers.map(({ name, invoice }) => {
    const attributed = new Map<string, { usd: number; fee: number; hasFee: boolean }>();
    for (const cell of cells) {
      if (cell.day < range.from || cell.day > range.to) continue;
      for (const [ref, m] of Object.entries(cell.usage.byModel)) {
        if (billerOfRef(ref) !== name) continue;
        const day = attributed.get(cell.day) ?? { usd: 0, fee: 0, hasFee: false };
        if (typeof m.usd === "number") day.usd += m.usd;
        if (m.feeUsd !== undefined) {
          day.fee += m.feeUsd;
          day.hasFee = true;
        }
        attributed.set(cell.day, day);
      }
    }
    const invoiced = new Map<string, InvoiceDay>();
    if (invoice)
      for (const d of invoices[name] ?? []) if (d.date >= range.from && d.date <= range.to) invoiced.set(d.date, d);
    const dates = [...new Set([...attributed.keys(), ...invoiced.keys()])].sort().filter((date) => {
      const a = attributed.get(date);
      return invoiced.has(date) || (a !== undefined && (a.usd !== 0 || a.hasFee));
    });
    const days: BillerTieOutDay[] = dates.map((date) => {
      const a = attributed.get(date);
      const inv = invoiced.get(date);
      return {
        date,
        ...(inv ? { invoiceUsd: inv.usd } : {}),
        ...(inv?.feeUsd !== undefined ? { invoiceFeeUsd: inv.feeUsd } : {}),
        ...(inv?.byokUsd !== undefined ? { invoiceByokUsd: inv.byokUsd } : {}),
        attributedUsd: a?.usd ?? 0,
        ...(a?.hasFee ? { attributedFeeUsd: a.fee, attributedUpstreamUsd: a.usd - a.fee } : {}),
      };
    });
    return {
      biller: name,
      invoice,
      days,
      totals: {
        invoiceUsd: days.reduce((s, d) => s + (d.invoiceUsd ?? 0), 0),
        attributedUsd: days.reduce((s, d) => s + d.attributedUsd, 0),
      },
    };
  });
}

/** OpenRouter's activity endpoint (`GET /api/v1/activity`, a management key —
 *  never the inference key): per-day, per-model rows whose `usage` is the
 *  aggregator's own charge and `byok_usage_inference` the BYOK upstream cost.
 *  Summed per day; the key travels only in the Authorization header and never
 *  appears in errors. The endpoint holds roughly the last 30 days, one short of
 *  the 31-day snapshot range: the oldest window day may come back with no row,
 *  and the tie-out then leaves that day's invoice side absent (rendered —),
 *  never an invented $0. */
export const OPENROUTER_ACTIVITY_URL = "https://openrouter.ai/api/v1/activity";
export class OpenRouterActivitySource implements LlmInvoiceSource {
  readonly biller: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: { biller: string; managementKey: string; fetchImpl?: typeof fetch }) {
    this.biller = opts.biller;
    this.key = opts.managementKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchInvoice(range: DateRange): Promise<InvoiceDay[]> {
    const res = await this.fetchImpl(OPENROUTER_ACTIVITY_URL, {
      headers: { authorization: `Bearer ${this.key}` },
    });
    if (res.status !== 200) throw new Error(`openrouter activity ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as {
      data?: { date?: string; usage?: number; byok_usage_inference?: number }[];
    };
    const byDay = new Map<string, { fee: number; byok: number }>();
    for (const r of body.data ?? []) {
      const date = str(r.date).slice(0, 10);
      if (!date || date < range.from || date > range.to) continue;
      const d = byDay.get(date) ?? { fee: 0, byok: 0 };
      d.fee += num(r.usage);
      d.byok += num(r.byok_usage_inference);
      byDay.set(date, d);
    }
    return [...byDay]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, d]) => ({ date, usd: d.fee + d.byok, feeUsd: d.fee, byokUsd: d.byok }));
  }
}

/** OpenAI's organization costs (`GET /v1/organization/costs`, an admin key):
 *  daily buckets whose results carry `amount.value` dollars. Paginated like the
 *  Anthropic report, a non-USD row refused the same way, the key never in errors. */
export const OPENAI_COSTS_URL = "https://api.openai.com/v1/organization/costs";
export class OpenAICostsSource implements LlmInvoiceSource {
  readonly biller: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: { biller: string; adminKey: string; fetchImpl?: typeof fetch }) {
    this.biller = opts.biller;
    this.key = opts.adminKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async fetchInvoice(range: DateRange): Promise<InvoiceDay[]> {
    const byDay = new Map<string, number>();
    let page: string | null = null;
    for (let i = 0; ; i++) {
      if (i >= MAX_COST_PAGES)
        throw new Error(`openai organization costs: more than ${MAX_COST_PAGES} pages; refusing a truncated total`);
      const url = new URL(OPENAI_COSTS_URL);
      url.searchParams.set("start_time", String(Date.parse(`${range.from}T00:00:00Z`) / 1000));
      url.searchParams.set("end_time", String(Date.parse(`${addDays(range.to, 1)}T00:00:00Z`) / 1000));
      url.searchParams.set("limit", String(MAX_DAYS));
      if (page) url.searchParams.set("page", page);
      const res = await this.fetchImpl(url.toString(), { headers: { authorization: `Bearer ${this.key}` } });
      if (res.status !== 200)
        throw new Error(`openai organization costs ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as {
        data?: { start_time?: number; results?: { amount?: { value?: number; currency?: string } }[] }[];
        has_more?: boolean;
        next_page?: string | null;
      };
      for (const bucket of body.data ?? []) {
        const date = new Date(num(bucket.start_time) * 1000).toISOString().slice(0, 10);
        for (const r of bucket.results ?? []) {
          const currency = str(r.amount?.currency).toLowerCase();
          if (currency !== "usd") throw new Error(`openai organization costs: unexpected currency ${currency || "?"}`);
          byDay.set(date, (byDay.get(date) ?? 0) + num(r.amount?.value));
        }
      }
      if (!body.has_more || !body.next_page) break;
      page = body.next_page;
    }
    return [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, usd]) => ({ date, usd }));
  }
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
export class AnthropicCostReportSource implements LlmCostSource, LlmInvoiceSource {
  /** The provider block this cost report bills; `anthropic` unless a block renames it. */
  readonly biller: string;
  private readonly adminKey: string;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: { adminKey: string; biller?: string; fetchImpl?: typeof fetch }) {
    this.biller = opts.biller ?? "anthropic";
    this.adminKey = opts.adminKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The biller's invoice per day: the cost report's closed days summed across
   *  workspaces — the invoice, never the estimate (costs.md item 4d). */
  async fetchInvoice(range: DateRange): Promise<InvoiceDay[]> {
    const report = await this.fetchCostReport(range);
    const byDay = new Map<string, number>();
    for (const r of report.rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.amountUsd);
    return [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, usd]) => ({ date, usd }));
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
      // Like the non-USD check: refuse rather than mis-sum. A ≤31-day range at
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
