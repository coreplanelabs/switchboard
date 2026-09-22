// The round's checks read, classified (record 0055, "The round verdict";
// docs/reference/specs/agent-ship.md item 9): the bot's `checks` step reads the
// check runs at the reviewed head with the merge door's own reading and hands
// the machine each failure with its conclusion, its URL and two judgements —
// whether it is a suspected flake, and whether only an operator can satisfy
// the failed precondition. The flake rule as the record states it: a
// test timeout or runner stall on a shard whose test files the pull request's
// changed paths never touch is re-run once before it becomes a finding; a
// second failure is the finding. The judgement here is conservative and
// provable: a failure is a suspect only when its output names the timeout or
// stall AND names test files, none of which the changed paths touch — anything
// less provable is a real failure, which errs toward the finding, never toward
// a silent re-run. Pure and node-free: the classification is testable without
// GitHub, and the machine (src/core/ship/coordinator.ts) decides what a
// suspect is worth.

import type { CheckFailure, RoundChecks } from "./coordinator.js";

/** One check run at a commit as GitHub reports it, flattened for the classifier:
 *  the name, the run's status/conclusion, its html URL and its output's words. */
export interface CheckRunDetail {
  name: string;
  /** GitHub's `status`: anything but `completed` is still pending. */
  status: string;
  conclusion?: string;
  url?: string;
  /** The GitHub App slug that created the run. Ownership comes from this
   *  identity and the repository's CI policy, never branch-required status. */
  app?: string;
  /** The run's output title, summary and text joined — where a timeout names
   *  the shard's test files or an operator precondition names its remedy. */
  output?: string;
}

const GREEN_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);
/** A test timeout or a runner stall, in the words CI runners use. */
const FLAKE_MARK = /\btimed?[\s-]?out\b|\btimeout\b|\bstall(?:ed)?\b|no output (?:has been )?received/i;
/** A test file the output names — the shard's reach, as far as it is provable. */
const TEST_FILE = /[\w@./-]+\.(?:test|spec)\.[cm]?[jt]sx?\b/g;
/** A remedy that lives outside the repository must read as an instruction,
 *  not merely contain a deployment-shaped word. This keeps script names and
 *  paths such as `deploy:check` and `deploy/worker/x.test.ts` ordinary CI
 *  failures while accepting commands such as "Run deploy secrets …". */
const INSTRUCTION_START = String.raw`(?:^[\t ]*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)?|[.!?;]\s+|\bto\s+fix\s+this,\s*)(?:please\s+)?`;
const DEPLOY_INSTRUCTION = new RegExp(String.raw`${INSTRUCTION_START}(?:run|execute)\s+[^\n.!?;]*\bdeploy\b`, "im");
const CONFIG_PUSH_INSTRUCTION = new RegExp(
  String.raw`${INSTRUCTION_START}(?:(?:run|execute)\s+[^\n.!?;]*\bconfig(?:uration)?\s+push\b|push\s+(?:the\s+)?config(?:uration)?\b)`,
  "im",
);
const SECRET_INSTRUCTION = new RegExp(
  String.raw`${INSTRUCTION_START}(?:(?:set|add|configure|provision|upload|create|rotate)|(?:run|execute))\s+[^\n.!?;]*(?:\bsecrets?\b|\b[A-Z][A-Z0-9_]{2,}_(?:KEY|TOKEN|SECRET)\b)`,
  "im",
);
const namesOperatorAction = (output: string): boolean =>
  DEPLOY_INSTRUCTION.test(output) || CONFIG_PUSH_INSTRUCTION.test(output) || SECRET_INSTRUCTION.test(output);

/** The repository's declared CI policy: its `ci / *` checks are created by
 *  Depot. A required context is only a merge gate and carries no ownership
 *  evidence; another App remains external even when branch protection names
 *  its check. */
const REPOSITORY_CI = [{ app: "depot", context: /^ci\s*\/\s*.+/i }] as const;

/** Ownership is decided before prose. Repository CI output can never turn the
 *  failure into an operator precondition. Missing App metadata is the legacy
 *  shape and stays child-owned. */
const isRepositoryOwned = (run: CheckRunDetail): boolean =>
  run.app === undefined || REPOSITORY_CI.some(({ app, context }) => run.app === app && context.test(run.name));

/** Whether one failed check is a suspected flake (record 0055's flake rule):
 *  a timeout/stall whose output names test files that the pull request's
 *  changed paths never touch. Unprovable — no marker, no named test files, or
 *  unknown changed paths — reads as a real failure. */
export function suspectedFlake(run: Pick<CheckRunDetail, "conclusion" | "output">, changedPaths?: string[]): boolean {
  if (changedPaths === undefined) return false;
  const text = run.output ?? "";
  const marked = run.conclusion === "timed_out" || FLAKE_MARK.test(text);
  if (!marked) return false;
  const shardFiles = [...new Set(text.match(TEST_FILE) ?? [])];
  if (shardFiles.length === 0) return false;
  // Paths in a runner's output may be repo-relative or deeper; a touch is a
  // suffix match either way.
  const touched = (file: string) => changedPaths.some((p) => p === file || p.endsWith(file) || file.endsWith(p));
  return !shardFiles.some(touched);
}

/** The check runs at the reviewed head as the machine's `checks` step return
 *  carries them: total, the pending names, and each failure with its
 *  conclusion, URL and flake judgement — the merge door's reading (a run not
 *  `completed` is pending; success, skipped and neutral are green) joined with
 *  the classifier's. `requiredContexts` — the base's required checks — adds
 *  `expected`: a required check no reported run answers yet (the repository's
 *  approve workflow whose run does not exist at the verdict instant, issue
 *  2063), which the machine's table reads exactly as a pending one. */
export function classifyRoundChecks(
  runs: CheckRunDetail[],
  changedPaths?: string[],
  requiredContexts?: string[],
): RoundChecks {
  const out: RoundChecks = { total: 0, pending: [], failed: [] };
  const reported = new Set(runs.map((r) => r.name));
  const required = requiredContexts ?? [];
  const expected = required.filter((name) => !reported.has(name));
  if (required.length > 0) out.required = required;
  if (expected.length > 0) out.expected = expected;
  for (const run of runs) {
    out.total++;
    if (run.status !== "completed") {
      out.pending.push(run.name);
      continue;
    }
    const conclusion = run.conclusion ?? "unknown";
    if (GREEN_CONCLUSIONS.has(conclusion)) continue;
    const repositoryOwned = isRepositoryOwned(run);
    const operatorPrecondition = !repositoryOwned && namesOperatorAction(run.output ?? "");
    const failure: CheckFailure = {
      name: run.name,
      conclusion,
      ...(run.url !== undefined ? { url: run.url } : {}),
      ...(suspectedFlake(run, changedPaths) ? { flakeSuspect: true } : {}),
      ...(operatorPrecondition
        ? {
            operatorPrecondition: true,
            ...(run.output !== undefined ? { output: run.output } : {}),
          }
        : {}),
    };
    out.failed.push(failure);
  }
  return out;
}
