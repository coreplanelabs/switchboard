import type { ConfigStore } from "../config.js";
import { GithubIssueTracker, type IssueTracker } from "../execution/githubIssues.js";
import type { FrictionLedger } from "./frictionLedger.js";
import { clusterFriction } from "./frictionProposals.js";
import { formatSelfImprovementReport, runSelfImprovement } from "./selfImprovement.js";
import type { IncomingMessage } from "./types.js";

// The on-demand trigger of the self-improvement step (Area 7b / #84): the
// `friction report` / `friction propose [--dry-run] [--top N] [--min-runs N]`
// chat commands. Config-family: answered inline from the ledger, never a model
// turn, and channel-agnostic (Slack, CLI, HTTP, MCP all reach dispatch()).
// `report` is read-only and open to everyone (like `repo list`). `propose`
// writes to GitHub, so it sits behind the same FAIL-CLOSED gate as repo
// management (admins only when nothing is configured).

export type FrictionCommand =
  | { verb: "report" | "propose"; dryRun: boolean; top?: number; minRuns?: number }
  | { error: string };

/** Parses `friction report|propose [flags]`; null when the text is not a
 *  friction command (prose mentioning friction passes through to the model). */
export function parseFrictionCommand(text: string): FrictionCommand | null {
  const m = text.trim().match(/^friction\s+(report|propose)\b\s*(.*)$/is);
  if (!m) return null;
  const verb = m[1].toLowerCase() as "report" | "propose";
  const cmd: Extract<FrictionCommand, { verb: string }> = { verb, dryRun: false };
  const tokens = m[2].split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--dry-run") {
      cmd.dryRun = true;
      continue;
    }
    const flag = /^--(top|min-runs)(?:=(.*))?$/.exec(t);
    if (!flag) return { error: `Unknown option \`${t}\` — \`friction ${verb}\` accepts \`--dry-run\`, \`--top <n>\`, \`--min-runs <n>\`.` };
    const raw = flag[2] ?? tokens[++i];
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) return { error: `\`--${flag[1]}\` expects a positive integer, got \`${raw ?? ""}\`.` };
    if (flag[1] === "top") cmd.top = n;
    else cmd.minRuns = n;
  }
  return cmd;
}

export interface FrictionCommandDeps {
  ledger?: FrictionLedger;
  /** Defaults to the GitHub REST tracker with the App token. */
  tracker?: IssueTracker;
}

/** Handles a friction command, or returns null when `text` is not one. */
export async function handleFrictionCommand(
  config: ConfigStore,
  msg: IncomingMessage,
  deps: FrictionCommandDeps,
  cmd: FrictionCommand | null = parseFrictionCommand(msg.text),
): Promise<string | null> {
  if (!cmd) return null;
  if ("error" in cmd) return cmd.error;
  if (!deps.ledger) return "⚠️ The friction ledger isn't wired in this process, so there are no recent runs to analyze.";

  const cfg = config.config.selfImprovement;
  const minRuns = cmd.minRuns ?? cfg?.minRuns;
  const top = cmd.top ?? cfg?.top;

  if (cmd.verb === "report") {
    const records = await deps.ledger.recent();
    return formatSelfImprovementReport({
      runsAnalyzed: records.length,
      patterns: clusterFriction(records, { minRuns }),
      proposals: [],
      filed: [],
      duplicates: [],
      failed: [],
      dryRun: false,
    });
  }

  // propose: the fail-closed gate FIRST (a refused user must see why), then config.
  if (!config.canManageRepos(msg.userId)) {
    return `🚫 Filing friction proposals (\`friction propose\`) is restricted. Ask ${config.adminsHint()}.`;
  }
  if (!cfg?.repo) {
    return "⚠️ Set `selfImprovement.repo` (an `owner/name`) in config.yaml to tell `friction propose` where to file issues.";
  }
  try {
    const report = await runSelfImprovement({
      records: await deps.ledger.recent(),
      tracker: deps.tracker ?? new GithubIssueTracker(),
      repo: cfg.repo,
      label: cfg.label,
      top,
      minRuns,
      dryRun: cmd.dryRun,
    });
    return formatSelfImprovementReport(report);
  } catch (err) {
    return `⚠️ ${err instanceof Error ? err.message : String(err)}`;
  }
}
