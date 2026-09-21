// The child's turn a coordinator's brief names (docs/reference/specs/http-ingress.md
// item 9; docs/decisions/0031-the-coordinator-runs-a-plan-not-a-pull-request.md):
// the coordinator holds no plan text, no run record and no credential, so its
// spawn names WHAT the child's turn is made from — the unit, the pull request,
// the run ids whose records carry the prior round's findings and dispositions
// — and the bot composes the text here, from the repository at the base ref
// and the run history it already has. One composer for the three kinds so the
// coordinator's children are told exactly what a round of the ship pipeline
// is told: the unit's contract for round 0, the review turn with the prior
// round's findings and the coding run's dispositions for a re-review, and the
// findings step's message: the review's findings as the requester would paste
// them into the unit thread (docs/decisions/0034-one-agent-per-unit-a-run-continues-a-transcript.md),
// where the coding session continues with them. No composer briefs a fresh
// coding child from a review: the findings are a message, not a brief.

import { parseDirectives } from "../../directives.js";
import { DEFAULT_ADDRESS_SEVERITY, formatFinding, type Finding, type FindingDisposition } from "../reviewVerdict.js";
import { matchDispositions, type Brief } from "../ship/coordinator.js";
import {
  contractFromPlan,
  generatedUnit,
  parsePlanUnit,
  PLAN_MAX_CHARS,
  specItemRefs,
  type AgentRules,
  type ChildContract,
  type ContractUnit,
} from "../ship/contract.js";
import { shipTaskText, shipUnitText } from "../ship/preflight.js";
import { buildShipReviewTurn } from "../ship/reviewChild.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import type { Handoff } from "../ship/handoff.js";

/** What a child run's record tells the next brief: the review's findings, the coding run's dispositions, the child's final words. */
export interface ChildRunFacts {
  findings?: Finding[];
  dispositions?: FindingDisposition[];
  finalReply?: string;
  /** The coding run's typed handoff, when it submitted one (decision 0046: a continuation is briefed with it). */
  handoff?: Handoff;
}

export interface BriefReaders {
  /** A file of the target repository at the base ref (the plan, a spec, the
   *  rules file), or undefined when there is none: its text up to `opts.maxChars`
   *  (the tool clip when unset) and whether it was cut there. The plan is asked
   *  for up to `PLAN_MAX_CHARS` and a cut plan is refused, never parsed short. */
  readRepoFile(
    path: string,
    opts?: { maxChars?: number },
  ): Promise<{ content: string; truncated: boolean } | undefined>;
  /** A child run's typed facts by run id, or undefined for a run the history does not hold. */
  readRunFacts(runId: string): Promise<ChildRunFacts | undefined>;
  /** A generated plan's request text: the ship run's own record (`instance.runId`,
   *  its `input` event), or undefined when it cannot be read back. */
  readShipRequest(): Promise<string | undefined>;
}

/** The composed child: the preset's turn, the branch its thread binds to, and
 *  the contract both round-0 children hold. */
export interface ComposedChild {
  preset: "coding" | "review";
  prompt: string;
  /** The branch the coding child's thread binds to (`on branch <ref>`); a review child pins the pull request's head itself. */
  ref?: string;
  contract?: ChildContract;
}

const SPECS_DIR = "docs/reference/specs";
const RULES_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** A generated plan's instance: `plan` without a `path` — the mark the hand-off
 *  writes for a task request (agent-ship item 16). */
const isGenerated = (instance: CoordinatorInstance): boolean => instance.plan?.path === undefined;

/** A generated instance's one unit, from the ship run's record: the request
 *  text is the unit's whole section (a resume's names the pull request), built
 *  as a unit and never parsed back, so `contractFromPlan` is the one contract
 *  builder and a heading line in the request stays the request's own. */
async function generatedUnitOf(
  instance: CoordinatorInstance,
  unit: CoordinatorUnit,
  readers: BriefReaders,
): Promise<ContractUnit> {
  const resume = unit.resume;
  if (resume !== undefined) {
    const url = resume.url ?? `https://github.com/${instance.repo}/pull/${resume.pr}`;
    return generatedUnit(unit.unit, `Resume the review loop of ${url}`);
  }
  const request = await readers.readShipRequest();
  // The child's text is the request as written (urls kept, item 16); the
  // probe decides only whether the request carried a task at all.
  const written = request !== undefined ? parseDirectives(request).text : "";
  const task = shipTaskText(written, instance.repo) ? shipUnitText(written, instance.repo) : "";
  return generatedUnit(unit.unit, task || "Implement the task this thread's ship request describes.");
}

/** The unit's contract: from the plan at the base ref for a seeded unit, from
 *  the ship run's record for a generated one — the same object for the coding
 *  and the review child. */
export async function contractFor(
  instance: CoordinatorInstance,
  unit: CoordinatorUnit,
  readers: BriefReaders,
): Promise<ChildContract> {
  const rebase = { branch: unit.branch, onto: instance.base ?? "main" };
  const issue = unit.issue !== undefined ? { repo: instance.repo, number: unit.issue } : undefined;
  let source: { unit: ContractUnit } | { planMarkdown: string; unitId: string };
  if (isGenerated(instance)) {
    source = { unit: await generatedUnitOf(instance, unit, readers) };
  } else {
    const plan = await readers.readRepoFile(instance.plan!.path!, { maxChars: PLAN_MAX_CHARS });
    if (plan === undefined)
      throw new Error(`the plan ${instance.plan!.path} is not readable at ${rebase.onto} in ${instance.repo}`);
    if (plan.truncated)
      throw new Error(
        `the plan ${instance.plan!.path} is longer than ${PLAN_MAX_CHARS.toLocaleString("en-US")} characters at ${rebase.onto} in ${instance.repo}; a unit read from a cut plan could be briefed short, so none is`,
      );
    source = { planMarkdown: plan.content, unitId: unit.unit };
  }
  const section = ("unit" in source ? source.unit : parsePlanUnit(source.planMarkdown, unit.unit))?.section ?? "";
  const specs = new Map<string, string | undefined>();
  for (const spec of new Set(specItemRefs(section).map((r) => r.spec)))
    specs.set(spec, (await readers.readRepoFile(`${SPECS_DIR}/${spec}`))?.content);
  let agentRules: AgentRules | undefined;
  for (const file of RULES_FILES) {
    const text = (await readers.readRepoFile(file))?.content;
    if (text !== undefined) {
      agentRules = { file, text };
      break;
    }
  }
  return contractFromPlan({
    ...source,
    readSpec: (spec) => specs.get(spec),
    ...(agentRules ? { agentRules } : {}),
    rebase,
    ...(issue ? { issue } : {}),
  });
}

const prUrl = (repo: string, pr: number) => `https://github.com/${repo}/pull/${pr}`;

/** What a continuation is told before the unit's own request: which segment
 *  it is, the sha and branch it continues from, and the previous segment's
 *  write-up and handoff as the checkpoint to pick up — the unit's request
 *  follows unchanged, so the contract stays the contract. */
async function continuationPreface(
  cont: { segment: number; from?: string; previousRunId?: string; texts?: string[] },
  unit: CoordinatorUnit,
  readers: BriefReaders,
): Promise<string> {
  const previous = cont.previousRunId !== undefined ? await readers.readRunFacts(cont.previousRunId) : undefined;
  const lines = [
    `Segment ${cont.segment} of this unit: the previous segment ended at its lease with the unit unfinished. ` +
      `Continue from \`${unit.branch}\`${cont.from !== undefined ? ` at \`${cont.from.slice(0, 7)}\`` : ""} as it stands — a clean checkout of what was pushed — and finish the unit: what is done stays done, so do not redo it.`,
  ];
  if (previous?.finalReply !== undefined) lines.push(`The previous segment's write-up:\n${previous.finalReply}`);
  const h = previous?.handoff;
  if (h !== undefined) {
    const list = (items: string[]) => (items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : "- none");
    lines.push(
      `Its handoff — follow-ups still open:\n${list(h.followUps.map((f) => `${f.what} (${f.where})`))}\n` +
        `Deviations it recorded:\n${list(h.deviations.map((d) => `${d.from} → ${d.to}: ${d.why}`))}\n` +
        `Unproven:\n${list(h.unproven.map((u) => `${u.criterion}: ${u.why}`))}`,
    );
  }
  if (cont.texts !== undefined && cont.texts.length > 0)
    lines.push(`The replies that woke this segment, in arrival order:\n${cont.texts.join("\n\n")}`);
  return lines.join("\n\n");
}

/** The findings step's message (agent-ship item 7): the review's findings as
 *  the requester would paste them into the unit thread, with the review's own
 *  words and the ask: every finding gets a disposition, the description is
 *  resubmitted, the branch is pushed. The `address-review-findings` skill
 *  carries the craft. */
function findingsRequest(input: { where: string; findings: Finding[]; review: string }): string {
  const findings =
    input.findings.map(formatFinding).join("\n") || "(the review listed no structured findings, address its prose)";
  return (
    `The review of ${input.where} requested changes. Load the \`address-review-findings\` skill and address every finding below, nits included: ` +
    `record one disposition per finding with submit_dispositions (fixed or declined, with a note), squash to coherent commits, ` +
    `resubmit the pull request description with submit_pr_description, and push the branch. Never merge and never approve.\n\n` +
    `Findings:\n${findings}\n\nReview:\n${input.review}`
  );
}

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
      // A generated unit's prompt is the request text itself — the section
      // minus the one-unit heading the markdown rendering added.
      const task = isGenerated(instance)
        ? contract.unit.section.split("\n").slice(1).join("\n").trim()
        : `Implement unit ${contract.unit.id} — ${contract.unit.title} — of ${instance.plan?.path ?? "the plan"}: the contract below is the unit. Do its first instruction first, then add every test scenario it lists, update every spec row it names and weaken no guard.`;
      // A renewal's segment (decision 0046): the continuation is a run, not a
      // resume — it starts from the recorded sha in a clean tree, and its
      // request is the previous segment's write-up and handoff, never the
      // person's message again.
      const prompt =
        brief.continue !== undefined ? `${await continuationPreface(brief.continue, unit, readers)}\n\n${task}` : task;
      return { preset: "coding", prompt, ref: unit.branch, contract };
    }
    case "review": {
      // A re-review reads the prior review's findings and the coding run's
      // dispositions from their records; the match to the review's ids is the
      // runner's (agent-ship item 6), and an id the review never issued is
      // named to the reviewer as dropped.
      let prior: { findings: Finding[]; dispositions: FindingDisposition[]; dropped: string[] } | undefined;
      if (brief.prior !== undefined) {
        // The prior round's check findings ride the brief by value (record
        // 0055): they sit on no run's record, so they join the review run's
        // own findings here — the coding run's dispositions match them by id
        // exactly as a reviewer's.
        const findings = [...((await facts(readers, brief.prior.reviewRunId)).findings ?? []), ...(brief.checks ?? [])];
        const recorded =
          brief.prior.codingRunId !== undefined
            ? ((await facts(readers, brief.prior.codingRunId)).dispositions ?? [])
            : [];
        const { matched, dropped } = matchDispositions(findings, recorded);
        prior = { findings, dispositions: matched, dropped };
      }
      const turn = buildShipReviewTurn({
        where,
        round: brief.round,
        ...(brief.headSha !== undefined ? { headSha: brief.headSha } : {}),
        ...(prior ? { prior } : {}),
      });
      const contract = await contractFor(instance, unit, readers);
      // The instance's severity to address rides the child's request as its
      // `severity:` directive (agent-review.md item 5a), so the child's verdict
      // parser holds the approve to the level the hand-off resolved — the
      // runner's own gate (agent-ship item 9) then reads a verdict already held
      // to it, never one parsed at the review thread's scope.
      const severity = `severity:${instance.addressSeverity ?? DEFAULT_ADDRESS_SEVERITY}`;
      return { preset: "review", prompt: `${prUrl(instance.repo, brief.pr)} ${severity}\n\n${turn}`, contract };
    }
    case "findings": {
      const review = await facts(readers, brief.reviewRunId);
      // The round's check findings (record 0055) join the reviewer's: they sit
      // on no run's record, so the brief carries them by value and the coding
      // session answers them with dispositions exactly as a reviewer's.
      return {
        preset: "coding",
        prompt: findingsRequest({
          where,
          findings: [...(review.findings ?? []), ...(brief.checks ?? [])],
          review: review.finalReply ?? "",
        }),
        ref: unit.branch,
      };
    }
    default: {
      const unknown: never = brief;
      throw new Error(`unknown brief kind ${JSON.stringify((unknown as { kind?: unknown }).kind)}`);
    }
  }
}

async function facts(readers: BriefReaders, runId: string): Promise<ChildRunFacts> {
  const read = await readers.readRunFacts(runId);
  if (!read) throw new Error(`run ${runId} is not in the run history`);
  return read;
}
