import {
  AnthropicCostReportSource,
  CloudflareGraphqlUsageSource,
  NullLlmCostSource,
  OpenAICostsSource,
  OpenRouterActivitySource,
  type CostReport,
  type CostsConfig,
  type LlmInvoiceSource,
} from "./costs.js";
import type { CostDimension, CostsByReport } from "./costsBy.js";
import {
  CostsSnapshotter,
  reportFromSnapshot,
  byReportFromSnapshot,
  type CostsSnapshotStamp,
  type CostsSnapshotStatus,
  type SnapshotterOptions,
} from "./costsSnapshot.js";
import { buildCostsSnapshotStore, type CostsSnapshot } from "./costsSnapshotStore.js";
import type { ProviderConfig } from "./provider.js";
import type { RunStore } from "./runStore.js";
import type { SecretReader, StateWorkerBlocks } from "./stateWorkerRef.js";

// The costs service (docs/reference/specs/costs.md): what the page, its JSON
// twins and the `costs` commands talk to. Every report is arithmetic over the
// one snapshot the `CostsSnapshotter` serves (item 6) — nothing here reads a
// billing source; the snapshotter does, on its interval or when asked through
// `snapshot(by)`. A process with no cost reporting hands the Null Object.

export interface CostsViewer {
  sub: string;
  email?: string;
}

export interface CostsService {
  groups(): string[];
  /** The group's daily report for `?days`, as of the snapshot. `NoCostsSnapshotError` before the first snapshot lands. */
  report(group: string, daysParam: string | null): Promise<CostReport>;
  /** Cost by user, thread, channel, agent or model for the same range (costs.md items 10–10a); on the
   *  user dimension the viewer's own run users are marked. `NoCostsSnapshotError` likewise. */
  byReport(
    group: string,
    daysParam: string | null,
    dimension: CostDimension,
    viewer: CostsViewer | undefined,
  ): Promise<CostsByReport>;
  /** The snapshot's status: the stamp, the take in flight, when the next one is due. */
  status(): CostsSnapshotStatus;
  /** Take a snapshot now — shared with a take already in flight — and answer its stamp. */
  snapshot(by: string): Promise<CostsSnapshotStamp>;
  /** Hear every status transition; the returned function stops it. */
  subscribe(listener: (status: CostsSnapshotStatus) => void): () => void;
}

/** What the by-user report reads beyond the snapshot. */
export interface CostsServiceDeps {
  /** The Slack email lookup (`resolveUserEmail`) the **me** toggle matches the viewer with; absent = nobody matches. */
  emailOfSlackUser?: (userId: string) => Promise<string | undefined>;
  /** The provider blocks and whether each names an invoice source — the billers of the
   *  daily tie-out (costs.md item 4d); absent leaves reports without one. */
  billers?: ReadonlyArray<{ name: string; invoice: boolean }>;
}

export const COSTS_OFF_MESSAGE =
  "Cost reporting isn't configured — set costs.cloudflareAccountId + costs.groups in config and the CF_ANALYTICS_TOKEN secret to enable this view.";

/** No snapshot has landed yet: the page and the twins say so and point at the status; nothing reads a source in the request. */
export class NoCostsSnapshotError extends Error {
  readonly name = "NoCostsSnapshotError";
  constructor() {
    super("no cost snapshot yet — the first one is taken within a minute of startup; see the page's snapshot status");
  }
}

const NULL_STATUS: CostsSnapshotStatus = Object.freeze({
  snapshot: null,
  inFlight: null,
  everyHours: 0,
  nextAt: null,
  lastFailure: null,
});

export class NullCostsService implements CostsService {
  groups(): string[] {
    return [];
  }
  report(_group: string, _daysParam: string | null): Promise<CostReport> {
    return Promise.reject(new Error(COSTS_OFF_MESSAGE));
  }
  byReport(
    _group: string,
    _daysParam: string | null,
    _dimension: CostDimension,
    _viewer: CostsViewer | undefined,
  ): Promise<CostsByReport> {
    return Promise.reject(new Error(COSTS_OFF_MESSAGE));
  }
  status(): CostsSnapshotStatus {
    return NULL_STATUS;
  }
  snapshot(_by: string): Promise<CostsSnapshotStamp> {
    return Promise.reject(new Error(COSTS_OFF_MESSAGE));
  }
  subscribe(): () => void {
    return () => undefined;
  }
}

/** The run user ids that ARE the signed-in viewer, for the **me** toggle: every
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
    // Only a person can be the viewer: an app nobody was found behind
    // (`slack:bot:<id>`, slack-channel.md item 13) has no email to look up.
    if (!id.startsWith("slack:") || id.startsWith("slack:bot:")) continue;
    // The lookup takes the platform-namespaced id as every other consumer of
    // the bot's email lookup does (`slack:U…`, the MCP connect ticket's
    // `resolveEmail`); the first version passed the bare `U…` and the lookup
    // answered nothing for anyone, so the toggle never matched a soul.
    // A known email is cached for the process; an unknown one is asked again
    // next time, since a lookup that failed quietly must not pin the user as
    // unmatchable for as long as the bot runs.
    let known = cache.get(id);
    if (known === undefined) {
      known = (await emailOfSlackUser(id))?.toLowerCase();
      if (known !== undefined) cache.set(id, known);
    }
    if (known === email) out.push(id);
  }
  return { userIds: out, matchedByEmail: true };
}

export function createCostsService(
  cfg: CostsConfig,
  snapshots: Pick<CostsSnapshotter, "current" | "refresh" | "status" | "subscribe">,
  deps: CostsServiceDeps = {},
): CostsService {
  const emailCache = new Map<string, string | undefined>();
  const meta = { accountId: cfg.cloudflareAccountId, accountName: cfg.cloudflareAccountName };
  const groupOf = (group: string) => {
    const g = cfg.groups[group];
    if (!g) throw new Error(`unknown cost group ${group}`);
    return g;
  };
  const snapshotOrThrow = async (): Promise<CostsSnapshot> => {
    const snapshot = await snapshots.current();
    if (!snapshot) throw new NoCostsSnapshotError();
    return snapshot;
  };
  return {
    groups: () => Object.keys(cfg.groups),
    async report(group, daysParam) {
      const g = groupOf(group);
      return reportFromSnapshot(await snapshotOrThrow(), group, g, daysParam, meta, deps.billers);
    },
    async byReport(group, daysParam, dimension, viewer) {
      const g = groupOf(group);
      const snapshot = await snapshotOrThrow();
      const daily = reportFromSnapshot(snapshot, group, g, daysParam, meta);
      // Only the user dimension has a "me": the email lookups are spent on it alone.
      const viewerIds =
        dimension === "user"
          ? await viewerRunUserIds(
              (snapshot.runUsage?.rows ?? []).map((r) => r.userId),
              viewer,
              deps.emailOfSlackUser,
              emailCache,
            )
          : undefined;
      return byReportFromSnapshot(snapshot, daily, dimension, {
        ...(viewerIds ? { viewer: viewerIds } : {}),
        prices: cfg.prices,
      });
    },
    status: () => snapshots.status(),
    async snapshot(by) {
      const taken = await snapshots.refresh(by);
      return { takenAt: taken.takenAt, takenBy: taken.takenBy, durationMs: taken.durationMs };
    },
    subscribe: (listener) => snapshots.subscribe(listener),
  };
}

export interface CostsFromConfigDeps {
  /** The process's credentials: the Cloudflare analytics token and, optionally, the Anthropic admin key. */
  secrets: SecretReader;
  /** The run history the by-user half reads; absent or the Null Object = history off. */
  runStore?: RunStore;
  emailOfSlackUser?: CostsServiceDeps["emailOfSlackUser"];
  /** Post a line to a platform-namespaced channel (`slack:C…`) — what `costs.snapshot.alertChannel`
   *  is told through; absent, or a namespace the process cannot post to (rejects), and the alert is a warning. */
  notify?: (channelId: string, text: string) => Promise<void>;
  warn: (message: string) => void;
  now?: () => Date;
}

/** The service, the snapshotter behind it, and whether the LLM line is on — or undefined when the
 *  Cloudflare token is unset (cost reporting off; the caller wires the Null Object). */
export interface CostsWiring {
  service: CostsService;
  snapshots: CostsSnapshotter;
  llmOn: boolean;
}

/** The snapshotter's alert: the configured channel through the process's poster. A channel with
 *  no poster in this process is a warning at wiring time and no alert — the status still says. */
function alertOf(
  channel: string | undefined,
  deps: Pick<CostsFromConfigDeps, "notify" | "warn">,
): Pick<SnapshotterOptions, "alert"> | undefined {
  if (channel === undefined) return undefined;
  if (!deps.notify) {
    deps.warn(
      `costs.snapshot.alertChannel ${channel} is set but this process cannot post to a channel; the status alone says when takes fail`,
    );
    return undefined;
  }
  const notify = deps.notify;
  return { alert: (text) => notify(channel, text) };
}

/** The production wiring from the `costs:` block and the env, shared by the bot (src/index.ts)
 *  and the CLI's command binding: both sources, the snapshot store behind whichever `*.worker`
 *  block names the state Worker, the snapshotter on `costs.snapshot.everyHours`, the service over
 *  it. Both keys are revealed into their source's constructor and held nowhere else here. */
export function costsFromConfig(
  cfg: CostsConfig,
  blocks: StateWorkerBlocks & { providers?: Record<string, ProviderConfig> },
  deps: CostsFromConfigDeps,
): CostsWiring | undefined {
  const cloudflareToken = deps.secrets.named(cfg.cloudflareTokenEnv);
  if (!cloudflareToken) return undefined;
  // One invoice source per provider block that names one (costs.md item 4d). A block
  // whose key env is unset is warned by name and ties out against nothing.
  const providers = blocks.providers ?? {};
  const invoiceSources: LlmInvoiceSource[] = [];
  let anthropic: AnthropicCostReportSource | undefined;
  for (const [name, block] of Object.entries(providers)) {
    if (!block.invoiceApi || !block.invoiceKeyEnv) continue;
    const key = deps.secrets.named(block.invoiceKeyEnv);
    if (!key) {
      deps.warn(`providers.${name}.invoiceKeyEnv ${block.invoiceKeyEnv} is unset — its tie-out reads "no invoice"`);
      continue;
    }
    if (block.invoiceApi === "anthropic-cost-report") {
      anthropic = new AnthropicCostReportSource({ adminKey: key.reveal(), biller: name });
      invoiceSources.push(anthropic);
    } else if (block.invoiceApi === "openrouter-activity") {
      invoiceSources.push(new OpenRouterActivitySource({ biller: name, managementKey: key.reveal() }));
    } else {
      invoiceSources.push(new OpenAICostsSource({ biller: name, adminKey: key.reveal() }));
    }
  }
  // The legacy `costs.anthropicAdminKeyEnv` still carries the cost report (the group's
  // LLM line, and the `anthropic` block's invoice) for one release after the key moved
  // under the block as `invoiceKeyEnv`.
  if (!anthropic) {
    const legacyKey = deps.secrets.named(cfg.anthropicAdminKeyEnv);
    if (legacyKey) {
      anthropic = new AnthropicCostReportSource({ adminKey: legacyKey.reveal() });
      if ("anthropic" in providers) invoiceSources.push(anthropic);
    }
  }
  const billers = Object.keys(providers).map((name) => ({
    name,
    invoice: invoiceSources.some((s) => s.biller === name),
  }));
  const snapshots = new CostsSnapshotter(
    {
      cloudflare: new CloudflareGraphqlUsageSource({
        accountId: cfg.cloudflareAccountId,
        token: cloudflareToken.reveal(),
      }),
      llm: anthropic ?? new NullLlmCostSource(),
      invoices: invoiceSources,
      ...(deps.runStore ? { runStore: deps.runStore } : {}),
    },
    buildCostsSnapshotStore(blocks, deps.secrets, deps.warn),
    {
      everyHours: cfg.snapshot.everyHours,
      warn: deps.warn,
      ...(deps.now ? { now: deps.now } : {}),
      ...(alertOf(cfg.snapshot.alertChannel, deps) ?? {}),
    },
  );
  return {
    service: createCostsService(cfg, snapshots, {
      ...(deps.emailOfSlackUser ? { emailOfSlackUser: deps.emailOfSlackUser } : {}),
      billers,
    }),
    snapshots,
    llmOn: anthropic !== undefined,
  };
}
