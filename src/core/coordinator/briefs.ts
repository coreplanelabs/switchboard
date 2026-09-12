// The child's turn a coordinator's brief names (docs/reference/specs/http-ingress.md
// item 9; docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md):
// the coordinator holds no plan text, no run record and no credential, so its
// spawn names WHAT the child's turn is made from — the unit, the pull request,
// the run ids whose records carry the prior round's findings and dispositions
// — and the bot composes the text here, from the repository at the base ref
// and the run history it already has. One composer for the three kinds so the
// coordinator's children are told exactly what the in-process pipeline's
// rounds are told: the unit's contract for round 0, the review turn with the
// prior round's findings and dispositions for a re-review, the fix turn with
// the findings for a fix round.

import { parseDirectives } from "../../directives.js";
import type { Finding, FindingDisposition } from "../reviewVerdict.js";
import type { Brief } from "../ship/coordinator.js";
import { buildShipFixTurn } from "../ship/codingChild.js";
import {
  contractFromPlan,
  contractFromTask,
  parsePlanUnit,
  specItemRefs,
  type AgentRules,
  type ChildContract,
} from "../ship/contract.js";
import { shipTaskText } from "../ship/preflight.js";
import { buildShipReviewTurn } from "../ship/reviewChild.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";

/** What a child run's record tells the next brief: the review's findings, the fix round's dispositions, the child's final words. */
export interface ChildRunFacts {
  findings?: Finding[];
  dispositions?: FindingDisposition[];
  finalReply?: string;
}

export interface BriefReaders {
  /** A file of the target repository at the base ref (the plan, a spec, the rules file), or undefined when there is none. */
  readRepoFile(path: string): Promise<string | undefined>;
  /** A child run's typed facts by run id, or undefined for a run the history does not hold. */
  readRunFacts(runId: string): Promise<ChildRunFacts | undefined>;
  /** A task-string unit's task: the ship request as the requesting thread carried it, or undefined when it cannot be read back. */
  readShipRequest(): Promise<string | undefined>;
}

/** The composed child: the preset's turn, the branch its thread binds to, the
 *  contract both children hold, and the finding ids a fix round answers. */
export interface ComposedChild {
  preset: "coding" | "review";
  prompt: string;
  /** The branch the coding child's thread binds to (`on branch <ref>`); a review child pins the pull request's head itself. */
  ref?: string;
  contract?: ChildContract;
  fixRound?: { findingIds: string[] };
}

const SPECS_DIR = "docs/reference/specs";
const RULES_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** The unit id a task-string instance's one unit carries. */
export const TASK_UNIT = "task";

/** The unit's contract: from the plan at the base ref for a plan unit, from the
 *  ship request's task for a task-string unit — the same object for the coding
 *  and the review child. */
export async function contractFor(
  instance: CoordinatorInstance,
  unit: CoordinatorUnit,
  readers: BriefReaders,
): Promise<ChildContract> {
  const rebase = { branch: unit.branch, onto: instance.base ?? "main" };
  const issue = unit.issue !== undefined ? { repo: instance.repo, number: unit.issue } : undefined;
  if (unit.unit === TASK_UNIT || instance.plan === undefined) {
    const request = await readers.readShipRequest();
    const task = request !== undefined ? shipTaskText(parseDirectives(request).text, instance.repo) : "";
    return contractFromTask({
      task: task || "Implement the task this thread's ship request describes.",
      rebase,
      ...(issue ? { issue } : {}),
    });
  }
  const planMarkdown = await readers.readRepoFile(instance.plan.path);
  if (planMarkdown === undefined)
    throw new Error(`the plan ${instance.plan.path} is not readable at ${rebase.onto} in ${instance.repo}`);
  const section = parsePlanUnit(planMarkdown, unit.unit)?.section ?? "";
  const specs = new Map<string, string | undefined>();
  for (const spec of new Set(specItemRefs(section).map((r) => r.spec)))
    specs.set(spec, await readers.readRepoFile(`${SPECS_DIR}/${spec}`));
  let agentRules: AgentRules | undefined;
  for (const file of RULES_FILES) {
    const text = await readers.readRepoFile(file);
    if (text !== undefined) {
      agentRules = { file, text };
      break;
    }
  }
  return contractFromPlan({
    planMarkdown,
    unitId: unit.unit,
    readSpec: (spec) => specs.get(spec),
    ...(agentRules ? { agentRules } : {}),
    rebase,
    ...(issue ? { issue } : {}),
  });
}

const prUrl = (repo: string, pr: number) => `https://github.com/${repo}/pull/${pr}`;

/** The child a brief names, composed from what the bot holds. Throws when a
 *  run the brief names is not in the history or the plan cannot be read — the
 *  spawn route answers by name and the coordinator's retry meets the same
 *  answer until a person looks. */
export async function composeChild(
  brief: Brief,
  instance: CoordinatorInstance,
  unit: CoordinatorUnit,
  readers: BriefReaders,
): Promise<ComposedChild> {
  const where = `${instance.repo}#${"pr" in brief ? brief.pr : ""}`;
  switch (brief.kind) {
    case "contract": {
      const contract = await contractFor(instance, unit, readers);
      const prompt =
        contract.unit.id === TASK_UNIT
          ? contract.unit.section
          : `Implement unit ${contract.unit.id} — ${contract.unit.title} — of ${instance.plan?.path ?? "the plan"}: the contract below is the unit. Do its first instruction first, then add every test scenario it lists, update every spec row it names and weaken no guard.`;
      return { preset: "coding", prompt, ref: unit.branch, contract };
    }
    case "review": {
      const prior =
        brief.prior !== undefined
          ? {
              findings: (await facts(readers, brief.prior.reviewRunId)).findings ?? [],
              dispositions:
                brief.prior.fixRunId !== undefined
                  ? ((await facts(readers, brief.prior.fixRunId)).dispositions ?? [])
                  : [],
            }
          : undefined;
      const turn = buildShipReviewTurn({
        where,
        round: brief.round,
        ...(brief.headSha !== undefined ? { headSha: brief.headSha } : {}),
        ...(prior ? { prior } : {}),
      });
      const contract = await contractFor(instance, unit, readers);
      return { preset: "review", prompt: `${prUrl(instance.repo, brief.pr)}\n\n${turn}`, contract };
    }
    case "fix": {
      const review = await facts(readers, brief.reviewRunId);
      const findings = review.findings ?? [];
      return {
        preset: "coding",
        prompt: buildShipFixTurn({ where, findings, review: review.finalReply ?? "" }),
        ref: unit.branch,
        fixRound: { findingIds: findings.map((f) => f.id) },
      };
    }
  }
}

async function facts(readers: BriefReaders, runId: string): Promise<ChildRunFacts> {
  const read = await readers.readRunFacts(runId);
  if (!read) throw new Error(`run ${runId} is not in the run history`);
  return read;
}
