import { z } from "zod";
import { GithubIssueTracker, type IssueTracker } from "../../execution/githubIssues.js";
import { CommandError, commandDefiner, type CommandDef, type CommandRegistry, type JsonValue } from "../commandRegistry.js";
import type { FrictionLedger } from "../frictionLedger.js";
import { clusterFriction, type FrictionRunRecord } from "../frictionProposals.js";
import { countTruncatedInputs, formatSelfImprovementReport, runSelfImprovement, type SelfImprovementConfig, type SelfImprovementReport } from "../selfImprovement.js";

// The `friction.*` registrations (#157 R13 — Area 7b's on-demand trigger, re-homed
// on the registry): `friction.report` clusters the ledger's recent runs into
// ranked recurring patterns; `friction.propose` runs the whole self-improvement
// step (cluster → propose → dedupe → file labeled issues). Both delegate to the
// pure step in selfImprovement.ts / frictionProposals.ts; nothing about a
// pattern or a proposal is decided here. The JSON output is the
// `SelfImprovementReport`; `render` is the very text the chat command has always
// replied with (`formatSelfImprovementReport`), so migrating changed no reply.
//
// Gates (R13, unchanged): `report` is open in chat and needs `friction:read`
// elsewhere; `propose` files to GitHub, so chat keeps the fail-closed
// repo-management set (`repoManager` = admins ∪ permissions.repoManagement)
// and machine callers need `friction:write`. A channel-pinned caller (KTD10)
// analyzes only its channel's runs — the ledger enforces the pin, and a ledger
// of bare records (no run store) contributes nothing under one.
// Neither command starts an agent run (KTD16): `propose` opens issues for a
// human to triage; it never opens PRs or merges. In chat the dispatcher records
// each invocation as an inline run (#244) so a scheduled firing leaves a trace.

export interface FrictionCommandDeps {
  friction: {
    /** Absent → both commands are `unavailable` (no recent runs exist anywhere). */
    ledger?: FrictionLedger;
    /** Where `propose` files. Default: the GitHub REST tracker with the App token. */
    tracker?: IssueTracker;
    /** The live `selfImprovement` config section (read per call: config reloads). */
    config(): SelfImprovementConfig | undefined;
  };
}

const defineCommand = commandDefiner<FrictionCommandDeps>();

const positiveInt = z.coerce.number().int().positive();
/** `z.coerce.boolean()` would read the string "false" as true; text surfaces send strings. */
const flag = z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]);
const repoSlug = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name");

export const NO_LEDGER_MESSAGE = "The friction ledger isn't wired in this process, so there are no recent runs to analyze.";
export const NO_REPO_MESSAGE = "Set `selfImprovement.repo` (an `owner/name`) in config.yaml to tell `friction propose` where to file issues.";

/** The ledger's recent records. No ledger, or a ledger that cannot be read
 *  (the run store is down), is `unavailable` — the message names the cause, as
 *  the chat command has always shown it — never a masked `internal`. */
async function recentRecords(deps: FrictionCommandDeps, query: Parameters<FrictionLedger["recent"]>[0]): Promise<FrictionRunRecord[]> {
  if (!deps.friction.ledger) throw new CommandError("unavailable", NO_LEDGER_MESSAGE);
  try {
    return await deps.friction.ledger.recent(query);
  } catch (err) {
    throw new CommandError("unavailable", err instanceof Error ? err.message : String(err));
  }
}

const asJson = (r: SelfImprovementReport): JsonValue => r as unknown as JsonValue;
const render = (output: JsonValue): string => formatSelfImprovementReport(output as unknown as SelfImprovementReport);

export const frictionReport = defineCommand({
  id: "friction.report",
  input: z.object({
    /** Only runs finished at or after this epoch ms. */
    sinceMs: z.coerce.number().int().nonnegative().optional(),
    /** Newest n runs (default: the ledger's retained window). */
    limit: positiveInt.optional(),
    /** Distinct runs a pattern must recur in (default `selfImprovement.minRuns`, else 2). */
    minRuns: positiveInt.optional(),
  }),
  scope: "friction:read",
  chatGate: "open",
  effect: "read",
  describe: "Ranked recurring friction patterns across recent runs — read-only, GitHub never consulted.",
  render,
  handler: async ({ input, caller, deps }) => {
    const records = await recentRecords(deps, { sinceMs: input.sinceMs, limit: input.limit, channel: caller.channel });
    return asJson({
      runsAnalyzed: records.length,
      patterns: clusterFriction(records, { minRuns: input.minRuns ?? deps.friction.config()?.minRuns }),
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
  input: z.object({
    /** Compute and report everything, file nothing. */
    dryRun: flag.optional(),
    /** Proposals filed per pass (default `selfImprovement.top`, else 3). */
    top: positiveInt.optional(),
    minRuns: positiveInt.optional(),
    /** `owner/name` to dedupe against and file into (default `selfImprovement.repo`). */
    repo: repoSlug.optional(),
  }),
  scope: "friction:write",
  chatGate: "repoManager",
  effect: "write",
  describe: "Run the self-improvement step: cluster recent friction, dedupe against open issues, file the top proposals as labeled issues.",
  render,
  handler: async ({ input, caller, deps }) => {
    if (!deps.friction.ledger) throw new CommandError("unavailable", NO_LEDGER_MESSAGE);
    const cfg = deps.friction.config();
    const repo = input.repo ?? cfg?.repo;
    if (!repo) throw new CommandError("unavailable", NO_REPO_MESSAGE);
    try {
      return asJson(
        await runSelfImprovement({
          records: await recentRecords(deps, { channel: caller.channel }),
          tracker: deps.friction.tracker ?? new GithubIssueTracker(),
          repo,
          label: cfg?.label,
          top: input.top ?? cfg?.top,
          minRuns: input.minRuns ?? cfg?.minRuns,
          dryRun: input.dryRun ?? false,
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

export const frictionCommands: readonly CommandDef<FrictionCommandDeps, z.ZodType>[] = [frictionReport, frictionPropose];

export function registerFrictionCommands<D extends FrictionCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of frictionCommands) registry.register(cmd as unknown as CommandDef<D, z.ZodType>);
}
