import { z } from "zod";
import { GithubIssueTracker, type IssueTracker } from "../../execution/githubIssues.js";
import { predicateFor } from "../authz/predicate.js";
import {
  CommandError,
  commandDefiner,
  flag,
  type Caller,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import type { FrictionLedger } from "../frictionLedger.js";
import { clusterFriction, type FrictionRunRecord } from "../frictionProposals.js";
import { parseRunEventLines } from "../runEventLines.js";
import { analyzeRunFriction, formatFrictionReport, type FrictionDiagnosis } from "../runFriction.js";
import {
  countTruncatedInputs,
  formatSelfImprovementReport,
  runSelfImprovement,
  type SelfImprovementConfig,
  type SelfImprovementReport,
} from "../selfImprovement.js";

// The `friction.*` registrations (#157 R13 — Area 7b's on-demand trigger, re-homed
// on the registry): `friction.report` clusters the ledger's recent runs into
// ranked recurring patterns; `friction.propose` runs the whole self-improvement
// step (cluster → propose → dedupe → file labeled issues). Both delegate to the
// pure step in selfImprovement.ts / frictionProposals.ts; nothing about a
// pattern or a proposal is decided here. The JSON output is the
// `SelfImprovementReport`; `render` is the text the chat command has always
// replied with (`formatSelfImprovementReport`).
//
// Surface forms (derived from the options): `friction report [--since-ms n]
// [--limit n] [--min-runs n]`, `friction propose [--dry-run] [--top n]
// [--min-runs n] [--repo owner/name]` — the very flags the pre-registry chat
// command took, now ONE grammar shared with the CLI (KTD21). `friction analyze
// [source] [--slow-ms n] [--in-progress]` (CLI only) is the read-only diagnosis
// of a SAVED run stream — the former standalone frictionCli (phase 4b).
//
// Gates (R13, unchanged): `report` is open in chat and needs `friction:read`
// elsewhere; `propose` files to GitHub, so chat keeps the fail-closed
// repo-management set (`repoManager` = admins ∪ permissions.repoManagement)
// and machine callers need `friction:write`. WHAT either analyzes is the
// authorization policy (authorization.md item 6, OQ2): the runs the actor may
// read — `predicateFor(actor, "runs:read", "run")` handed to the ledger, which
// pushes it into the run store; an `all-channels` holder (an admin, the
// self-improvement schedule) analyzes the fleet, a token its granted channels,
// and a ledger of bare records (no run store) contributes nothing under any
// narrower predicate. No channel is compared here.
// Neither command starts an agent run (KTD16): `propose` opens issues for a
// human to triage; it never opens PRs or merges. In chat the dispatcher records
// each invocation as an inline run (#244) so a scheduled firing leaves a trace.

export interface FrictionCommandDeps {
  friction: {
    /** Absent → both commands are `unavailable` (no recent runs exist anywhere). */
    ledger(): Promise<FrictionLedger | undefined>;
    /** Where `propose` files. Default: the GitHub REST tracker with the App token. */
    tracker?: IssueTracker;
    /** The live `selfImprovement` config section (read per call: config reloads). */
    config(): Promise<SelfImprovementConfig | undefined>;
    /** `friction analyze`'s input: the text at a path, or stdin for `-`. */
    readSource(source: string): Promise<string>;
  };
}

const defineCommand = commandDefiner<FrictionCommandDeps>();

const positiveInt = z.coerce.number().int().positive();
const repoSlug = z.string().refine((s) => /^[\w.-]+\/[\w.-]+$/.test(s), "expected an owner/name slug");

export const NO_LEDGER_MESSAGE =
  "Run history is not configured in this deployment (`runHistory`), so there are no recent runs to analyze.";
export const NO_REPO_MESSAGE =
  "Set `selfImprovement.repo` (an `owner/name`) in config.yaml to tell `friction propose` where to file issues.";

/** The ledger, resolved ONCE per invocation. No ledger, or an accessor that
 *  throws (the run store's config could not be opened), is `unavailable` — the
 *  message names the cause. */
async function ledgerOf(deps: FrictionCommandDeps): Promise<FrictionLedger> {
  let ledger: FrictionLedger | undefined;
  try {
    ledger = await deps.friction.ledger();
  } catch (err) {
    throw new CommandError("unavailable", err instanceof Error ? err.message : String(err));
  }
  if (!ledger) throw new CommandError("unavailable", NO_LEDGER_MESSAGE);
  return ledger;
}

/** The ledger's recent records. A ledger that cannot be read (the run store is
 *  down) is `unavailable` — the message names the cause, as the chat command
 *  has always shown it — never a masked `internal`. */
async function recentRecords(
  ledger: FrictionLedger,
  query: Parameters<FrictionLedger["recent"]>[0],
): Promise<FrictionRunRecord[]> {
  try {
    return await ledger.recent(query);
  } catch (err) {
    throw new CommandError("unavailable", err instanceof Error ? err.message : String(err));
  }
}

const asJson = (r: SelfImprovementReport): JsonValue => r as unknown as JsonValue;
const render = (output: JsonValue): string => formatSelfImprovementReport(output as unknown as SelfImprovementReport);

/** The runs this caller may analyze: its run-read predicate (a `friction`
 *  report is a read of runs, whatever surface asks). */
const visibleRuns = (caller: Caller) => predicateFor(caller.actor, "runs:read", "run");

export const frictionReport = defineCommand({
  id: "friction.report",
  options: z.object({
    sinceMs: z.coerce.number().int().nonnegative().optional().describe("only runs finished at or after this epoch ms"),
    limit: positiveInt.optional().describe("newest n runs (default: the ledger's retained window)"),
    minRuns: positiveInt
      .optional()
      .describe("distinct runs a pattern must recur in (default selfImprovement.minRuns, else 2)"),
  }),
  action: "friction:read",
  effect: "read",
  describe: "Ranked recurring friction patterns across recent runs — read-only, GitHub never consulted.",
  render,
  handler: async ({ options, caller, deps }) => {
    const records = await recentRecords(await ledgerOf(deps), {
      sinceMs: options.sinceMs,
      limit: options.limit,
      visibleTo: visibleRuns(caller),
    });
    return asJson({
      runsAnalyzed: records.length,
      patterns: clusterFriction(records, { minRuns: options.minRuns ?? (await deps.friction.config())?.minRuns }),
      proposals: [],
      filed: [],
      duplicates: [],
      failed: [],
      dryRun: false,
      truncatedRuns: countTruncatedInputs(records),
    });
  },
});

export const frictionPropose = defineCommand({
  id: "friction.propose",
  options: z.object({
    dryRun: flag.optional().describe("compute and report everything, file nothing"),
    top: positiveInt.optional().describe("proposals filed per pass (default selfImprovement.top, else 3)"),
    minRuns: positiveInt
      .optional()
      .describe("distinct runs a pattern must recur in (default selfImprovement.minRuns, else 2)"),
    repo: repoSlug.optional().describe("owner/name to dedupe against and file into (default selfImprovement.repo)"),
  }),
  action: "friction:write",
  effect: "write",
  describe:
    "Run the self-improvement step: cluster recent friction, dedupe against open issues, file the top proposals as labeled issues.",
  render,
  handler: async ({ options, caller, deps }) => {
    const ledger = await ledgerOf(deps);
    const cfg = await deps.friction.config();
    const repo = options.repo ?? cfg?.repo;
    if (!repo) throw new CommandError("unavailable", NO_REPO_MESSAGE);
    try {
      return asJson(
        await runSelfImprovement({
          records: await recentRecords(ledger, { visibleTo: visibleRuns(caller) }),
          tracker: deps.friction.tracker ?? new GithubIssueTracker(),
          repo,
          label: cfg?.label,
          top: options.top ?? cfg?.top,
          minRuns: options.minRuns ?? cfg?.minRuns,
          dryRun: options.dryRun ?? false,
        }),
      );
    } catch (err) {
      // The tracker (GitHub) is the one dependency that can fail here; its
      // message names the cause (missing credential, HTTP status) and is what
      // the chat command has always shown.
      throw new CommandError("unavailable", err instanceof Error ? err.message : String(err));
    }
  },
});

// ---- friction analyze (CLI only) ---------------------------------------------------

/** The stderr hint for the most likely misuse: a live `curl` capture analyzed
 *  with the default `finished:true`, so its trailing in-flight call is blamed
 *  as a dead run. Only when that specific finding is present and the flag was
 *  not given; `undefined` otherwise. */
export function inProgressHint(diagnosis: FrictionDiagnosis, finished: boolean): string | undefined {
  if (!finished) return undefined;
  const midTool = diagnosis.findings.some(
    (f) => f.category === "infra_failure" && f.summary.includes("run ended mid-tool"),
  );
  return midTool
    ? "(hint: the stream ends on a tool call with no result — if this capture was taken mid-run, pass --in-progress)"
    : undefined;
}

export const frictionAnalyze = defineCommand({
  id: "friction.analyze",
  args: [
    {
      name: "source",
      schema: z.string().optional(),
      describe:
        "a saved run stream: JSON lines of run events or a curl'ed /runs/:id/events SSE capture (default: stdin)",
    },
  ],
  options: z.object({
    slowMs: z.coerce
      .number()
      .nonnegative()
      .optional()
      .describe("a tool call slower than this many ms is a slow-tool finding"),
    inProgress: flag
      .optional()
      .describe("the capture was taken mid-run: a trailing call without a result is still executing, not a dead run"),
  }),
  action: "friction:read",
  effect: "read",
  surfaces: { chat: false, mcp: false, http: false },
  describe:
    "Read-only friction diagnosis of a saved run-event stream (JSONL or an SSE capture) — the former frictionCli.",
  render: (output) => {
    const o = output as JsonObject;
    const lines = [formatFrictionReport(o.diagnosis as unknown as FrictionDiagnosis)];
    const skipped = typeof o.skipped === "number" ? o.skipped : 0;
    if (skipped > 0) lines.push(`(skipped ${skipped} unparseable line${skipped === 1 ? "" : "s"})`);
    if (typeof o.hint === "string") lines.push(o.hint);
    return lines.join("\n");
  },
  handler: async ({ args, options, deps }) => {
    const source = args.source ?? "-";
    let text: string;
    try {
      text = await deps.friction.readSource(source);
    } catch (err) {
      throw new CommandError(
        "not_found",
        `${source === "-" ? "stdin" : source}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const { events, skipped } = parseRunEventLines(text);
    if (events.length === 0)
      throw new CommandError(
        "invalid_input",
        `no run events found in ${source === "-" ? "stdin" : source}${skipped ? ` (${skipped} unparseable lines)` : ""}`,
      );
    const finished = !(options.inProgress ?? false);
    const diagnosis = analyzeRunFriction(events, { slowToolMs: options.slowMs, finished });
    const hint = inProgressHint(diagnosis, finished);
    return {
      source,
      events: events.length,
      skipped,
      diagnosis: diagnosis as unknown as JsonValue,
      ...(hint !== undefined ? { hint } : {}),
    };
  },
});

export const frictionCommands: readonly CommandDef<FrictionCommandDeps>[] = [
  frictionReport,
  frictionPropose,
  frictionAnalyze,
] as unknown as CommandDef<FrictionCommandDeps>[];

export function registerFrictionCommands<D extends FrictionCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of frictionCommands) registry.register(cmd as unknown as CommandDef<D>);
}
