import { z } from "zod";
import {
  CommandError,
  commandDefiner,
  type Caller,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import { MAX_DAYS } from "../costs.js";
import { COST_DIMENSIONS } from "../costsBy.js";
import { COSTS_OFF_MESSAGE, NoCostsSnapshotError, type CostsService, type CostsViewer } from "../costsService.js";

// `costs.snapshot` (docs/reference/specs/costs.md item 6): take the costs
// snapshot now — both billing sources and the run history read once over the
// page's widest range, stored, and served to every reader from then on. The
// refresh loop takes one on its interval by itself; this is the on-demand
// take, the same single-flighted read (a caller arriving while one runs shares
// it). Derived forms: `costs snapshot` in chat and on the CLI,
// `/api/costs.snapshot` (what the page's button posts), the `costs_snapshot`
// MCP tool. Action `costs:write`: held by the admins' `all` and by whoever a
// `grants` entry names — a take costs two provider reads and replaces what
// every viewer sees, so it is never a baseline.

export interface CostsCommandDeps {
  costs: {
    /** The service; a process without cost reporting hands the Null Object, whose take is `unavailable`. */
    service(): Promise<CostsService>;
  };
}

const defineCommand = commandDefiner<CostsCommandDeps>();

/** What a take answers: the stamp, and where the next scheduled one falls. */
export interface CostsSnapshotTaken {
  takenAt: string;
  takenBy: string;
  durationMs: number;
  nextAt: string | null;
}

/** Who a take is credited to in the stamp: the linked person's name (a dashboard session), else the
 *  name the caller's adapter resolved (a Slack profile name), else the caller's id — never `slack:U…`
 *  when Slack knew the person's name. */
export function takerLabel(caller: { id: string; name?: string; actor: { asUser?: { name?: string } } }): string {
  return caller.actor.asUser?.name ?? caller.name ?? caller.id;
}

function renderTaken(output: JsonValue): string {
  const o = output as JsonObject;
  const seconds = (Number(o.durationMs) / 1000).toFixed(1);
  const next = typeof o.nextAt === "string" ? ` · next scheduled ${o.nextAt.slice(0, 16).replace("T", " ")} UTC` : "";
  return `Costs snapshot taken ${String(o.takenAt).slice(0, 16).replace("T", " ")} UTC by ${String(o.takenBy)} in ${seconds} s${next}`;
}

export const costsSnapshot = defineCommand({
  id: "costs.snapshot",
  action: "costs:write",
  effect: "write",
  // The next snapshot rewrites this one, so it is reversible but not idempotent.
  annotations: { destructive: false, risk: () => "rewrites the snapshot" },
  enabledWhen: (caps) => caps.costs,
  describe:
    "Take the costs snapshot now: read both billing sources and the run history once over the page's widest range, store the result, and serve it to every reader of the costs page from then on.",
  render: renderTaken,
  handler: async ({ caller, deps }) => {
    const service = await deps.costs.service();
    try {
      const stamp = await service.snapshot(takerLabel(caller));
      const taken: CostsSnapshotTaken = { ...stamp, nextAt: service.status().nextAt };
      return taken as unknown as JsonValue;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Off is `unavailable`; a take that failed is `busy` — the same 503 over
      // HTTP, but the previous snapshot keeps serving and the loop's next
      // tick retries by itself, so the reply narrates that recovery.
      if (message === COSTS_OFF_MESSAGE) throw new CommandError("unavailable", message);
      throw new CommandError(
        "busy",
        `costs snapshot not taken: ${message} — the previous snapshot still serves, and the scheduled loop will take the next snapshot`,
      );
    }
  },
});

// `costs.by` (docs/reference/specs/costs.md items 10–10a): what the runs cost
// by user, thread, channel, agent or model over the range, from the snapshot —
// the same arithmetic the page's tabs and their JSON twins are, on every
// surface. Action `costs:read` (a browser session's baseline; a grant for a
// Slack user or a token), effect read: nothing is taken or written.

const dimensionArg = {
  name: "dimension",
  schema: z.enum(COST_DIMENSIONS),
  describe: "what to lay the runs against: user, thread, channel, agent or model",
} as const;

/** The signed-in viewer, for the user dimension's `viewer.userIds` (the **me** rows); nobody on the other surfaces. */
const viewerOf = (caller: Caller): CostsViewer | undefined =>
  caller.kind === "access" ? { sub: caller.id, ...(caller.email ? { email: caller.email } : {}) } : undefined;

const money = (v: unknown): string => (typeof v === "number" ? `$${v.toFixed(2)}` : "-");

/** The text surfaces' report: a header naming the dimension, the group, the range and the snapshot; one line per
 *  row (largest first); the coverage and the tie-out. Chat gets ` · `-joined bullets (columns collapse in a
 *  proportional font); the terminal gets aligned columns. */
function renderCostsBy(output: JsonValue, surface: "chat" | "text" = "text"): string {
  const o = output as JsonObject;
  const rows = (Array.isArray(o.rows) ? o.rows : []) as JsonObject[];
  const range = (o.range ?? {}) as JsonObject;
  const rec = (o.reconciliation ?? {}) as JsonObject;
  const coverage = (o.coverage ?? {}) as JsonObject;
  const snapshot = (o.snapshot ?? {}) as JsonObject;
  const cloud = o.cloudAllocated === true;
  const count = o.dimension === "model" ? "turns" : "runs";
  const total = rows.reduce((s, r) => s + (typeof r.totalUsd === "number" ? r.totalUsd : 0), 0);
  const share = (r: JsonObject) =>
    total > 0 && typeof r.totalUsd === "number" ? Math.round((r.totalUsd / total) * 100) : 0;
  const head =
    `costs by ${String(o.dimension)} · ${String(o.group)} · ${String(range.from)} → ${String(range.to)} (${String(range.days)}d)` +
    (typeof snapshot.takenAt === "string" ? ` · snapshot ${snapshot.takenAt.slice(0, 16).replace("T", " ")} UTC` : "");
  const name = (r: JsonObject) => (typeof r.label === "string" ? `${r.label} (${String(r.key)})` : String(r.key));
  const line = (r: JsonObject) => {
    const n = typeof r[count] === "number" ? String(r[count]) : "0";
    const unpriced = typeof r.unpricedTokens === "number" && r.unpricedTokens > 0 ? " · unpriced tokens" : "";
    if (surface === "chat")
      return `• ${name(r)} — ${n} ${count} · LLM ${money(r.llmUsd)}${cloud ? ` · cloud ${money(r.cloudUsd)}` : ""} · total ${money(r.totalUsd)} (${share(r)}%)${unpriced}`;
    return `${name(r).padEnd(40)} ${n.padStart(6)} ${money(r.llmUsd).padStart(10)}${cloud ? money(r.cloudUsd).padStart(10) : ""} ${money(r.totalUsd).padStart(10)} ${String(share(r)).padStart(4)}%${unpriced}`;
  };
  const columns =
    surface === "chat"
      ? []
      : [
          `${String(o.dimension).padEnd(40)} ${count.padStart(6)} ${"LLM".padStart(10)}${cloud ? "cloud".padStart(10) : ""} ${"total".padStart(10)} share`,
        ];
  const where =
    coverage.historyOn === false
      ? "history is off — no runs to attribute"
      : `runs from ${String(coverage.from)}${coverage.clamped === true ? ` (earlier days are past the history's ${String(coverage.retentionDays)}-day window)` : ""}${typeof o.pending === "number" && o.pending > 0 ? ` · ${o.pending} run(s) still being priced` : ""}`;
  const tieOut =
    typeof rec.comparedDays === "number" && rec.comparedDays > 0
      ? `LLM attributed ${money(rec.attributedLlmUsd)} of ${money(rec.workspaceLlmUsd)} on the workspace over ${rec.comparedDays} day(s)` +
        (typeof rec.unattributedLlmUsd === "number" && rec.unattributedLlmUsd < 0
          ? ` · ${money(-rec.unattributedLlmUsd)} more attributed than the workspace figure`
          : ` · ${money(rec.unattributedLlmUsd)} unattributed`)
      : "no day in range has a workspace LLM figure to compare against";
  const cloudLine = cloud
    ? ` · cloud allocated ${money(rec.cloudAllocatedUsd)}${typeof rec.cloudUnallocatedUsd === "number" && rec.cloudUnallocatedUsd > 0 ? ` · ${money(rec.cloudUnallocatedUsd)} on days with no runs` : ""}`
    : "";
  return [
    head,
    ...columns,
    ...(rows.length === 0 ? ["(no runs in this range)"] : rows.map(line)),
    where,
    `${tieOut}${cloudLine}`,
  ].join("\n");
}

export const costsBy = defineCommand({
  id: "costs.by",
  args: [dimensionArg],
  options: z.object({
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_DAYS)
      .optional()
      .describe(`the range in UTC days ending on the snapshot's day (default 30, at most ${MAX_DAYS})`),
    group: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
      .optional()
      .describe("the cost group under `costs.groups`; default: the first configured"),
  }),
  action: "costs:read",
  effect: "read",
  enabledWhen: (caps) => caps.costs,
  describe:
    "What the runs cost by user, thread, channel, agent or model over the range — LLM from their tokens through the price table, cloud allocated by run wall-clock — the costs page's tabs as text or JSON, from the snapshot; nothing written.",
  render: (output) => renderCostsBy(output, "text"),
  renderChat: (output) => renderCostsBy(output, "chat"),
  handler: async ({ args, options, caller, deps }) => {
    const service = await deps.costs.service();
    const groups = service.groups();
    if (groups.length === 0) throw new CommandError("unavailable", COSTS_OFF_MESSAGE);
    const group = options.group ?? groups[0];
    if (!groups.includes(group)) throw new CommandError("not_found", `no cost group named ${group}`);
    try {
      const report = await service.byReport(
        group,
        options.days === undefined ? null : String(options.days),
        args.dimension,
        viewerOf(caller),
      );
      return report as unknown as JsonValue;
    } catch (err) {
      // Before the first snapshot lands the report is a minute away: retry, not "not here".
      if (err instanceof NoCostsSnapshotError) throw new CommandError("busy", err.message);
      throw new CommandError(
        "unavailable",
        `cost report unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
});

export const costsCommands: readonly CommandDef<CostsCommandDeps>[] = [
  costsBy,
  costsSnapshot,
] as unknown as CommandDef<CostsCommandDeps>[];

export function registerCostsCommands<D extends CostsCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of costsCommands) registry.register(cmd as unknown as CommandDef<D>);
}
