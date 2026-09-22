import { z } from "zod";
import {
  CommandError,
  commandDefiner,
  type CommandDef,
  type CommandRegistry,
  type JsonObject,
  type JsonValue,
} from "../commandRegistry.js";
import { parsePullReference } from "./pulls.js";

// The merge door as registry commands (record 0070, criteria 4 and 6;
// docs/reference/specs/orchestration-plane.md item 13): `pulls merge` and
// `pulls enqueue` put the two acts that used to ride `gh` from a terminal
// behind the one fenced door, so the orchestrator thread — and every other
// chat surface — binds a sentence to a command the policy table authorizes
// against the PERSON, never a service actor's standing credential. Both are
// destructive (`merge:write`: a grant, never a baseline) and both refuse by
// reason: an unapproved head, a red or unfinished check, a person with no
// GitHub binding (record 0062 — the App credential never merges as nobody),
// and the release pull request, whose merge stays a person's click — that
// refusal answers the handoff card (record 0064's *Handed* phase), not an
// error. The commands call GitHub through the seam below; the wiring fills it
// from the merge door's own reads and writes (src/execution/githubPulls.ts).

/** The pull request facts the door decides over — the merge door's own read
 *  (`fetchPullRequestFacts`), narrowed to what the fences need. */
export interface MergeDoorFacts {
  state: "open" | "closed";
  headSha?: string;
  /** Head branch name: `release-please--…` marks the release pull request. */
  headRef?: string;
  /** The title — the squash commit's title, and the release's second marker. */
  title?: string;
  htmlUrl?: string;
}

export interface MergeDoorService {
  facts(pr: { repo: string; number: number }): Promise<MergeDoorFacts | undefined>;
  checks(repo: string, sha: string): Promise<{ total: number; pending: string[]; failed: string[] } | undefined>;
  reviews(pr: {
    repo: string;
    number: number;
  }): Promise<Array<{ state: string; commitId?: string; author?: { login?: string; id?: number } }> | undefined>;
  /** The squash at exactly `sha`; `mergedBy` lands as the commit message's
   *  `Merged-by:` trailer, so the person's name is on the merge itself. */
  merge(
    pr: { repo: string; number: number },
    opts: { sha: string; title: string; mergedBy?: string },
  ): Promise<{ ok: true; sha: string } | { ok: false; status: number; reason: string }>;
  /** Enqueue only while GitHub still has the reviewed `sha` at the head. */
  enqueue(
    pr: { repo: string; number: number },
    opts: { sha: string },
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The caller's bound GitHub login (record 0062's binding, `config set user
   *  --github`); undefined for a person nobody bound. */
  githubLogin(userId: string): Promise<string | undefined>;
}

export interface MergeCommandDeps {
  /** Absent where no GitHub credential is wired: the commands answer `unavailable`. */
  merge?: {
    service(): Promise<MergeDoorService>;
  };
}

const defineCommand = commandDefiner<MergeCommandDeps>();

const REPO_SLUG = /^(?!\.+\/)[\w.-]+\/(?!\.+$)[\w.-]+$/;
/** A pull request as a person spells it: `42`, `#42`, `owner/name#42`, or its URL. */
const PR_REF = /^(#?\d+|[\w.-]+\/[\w.-]+#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)$/;

/** The release pull request — release-please's, which deploys — is always a
 *  person's merge (record 0064's *Handed* phase). The one copy of the two
 *  markers: the plan runner's door (src/channels/adminCoordinator.ts) imports
 *  this same fence. */
export function isReleasePullRequest(facts: Pick<MergeDoorFacts, "headRef" | "title">): boolean {
  return (
    (facts.headRef?.startsWith("release-please--") ?? false) || /^chore\(main\): release\b/.test(facts.title ?? "")
  );
}

/** What the door answered: the act, or the release handoff card. */
export type MergeDoorReport =
  | { kind: "merged"; repo: string; number: number; sha: string; by: { user: string; login: string } }
  | { kind: "enqueued"; repo: string; number: number; by: { user: string; login: string } }
  | { kind: "handed"; repo: string; number: number; title?: string; url?: string };

const shortSha = (sha: string) => sha.slice(0, 7);

/** The handoff card (record 0064's *Handed* phase): the release pull request
 *  by name, "this deploys production", and no merge called — the click stays
 *  a person's, on GitHub. */
export function renderHandoffCard(report: Extract<MergeDoorReport, { kind: "handed" }>): string {
  return [
    `Release pull request ${report.repo}#${report.number}${report.title !== undefined ? ` — ${report.title}` : ""}.`,
    "This deploys production, so its merge stays a person's click — nothing was merged.",
    ...(report.url !== undefined ? [report.url] : []),
  ].join("\n");
}

export function renderMergeReport(output: JsonValue): string {
  const report = output as unknown as MergeDoorReport;
  if (report.kind === "handed") return renderHandoffCard(report);
  if (report.kind === "enqueued")
    return `Enqueued ${report.repo}#${report.number} for the merge queue — asked by ${report.by.login} (${report.by.user}).`;
  return `Merged ${report.repo}#${report.number} (squash \`${shortSha(report.sha)}\`) — merged by ${report.by.login} (${report.by.user}).`;
}

interface FencedTarget {
  repo: string;
  number: number;
  facts: MergeDoorFacts;
  headSha: string;
  login: string;
}

/** The verdict standing per reviewer at exactly the head: GitHub lists reviews
 *  oldest first, so the last APPROVED or CHANGES_REQUESTED each reviewer left
 *  at the head is their word (a dismissal rewrites the review's own state, so
 *  a dismissed request drops out). A review with no author is its own voice —
 *  the door refuses on it rather than assume two anonymous rows are one. */
function reviewVerdictsAtHead(
  reviews: Array<{ state: string; commitId?: string; author?: { login?: string; id?: number } }>,
  headSha: string,
): string[] {
  const latest = new Map<string, string>();
  reviews.forEach((r, i) => {
    if (r.commitId !== headSha) return;
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") return;
    latest.set(r.author?.login ?? (r.author?.id !== undefined ? `#${r.author.id}` : `?${i}`), r.state);
  });
  return [...latest.values()];
}

/** The fences both acts share, in the order a person can act on: the person's
 *  binding first (nothing is read for a caller the door would refuse), then
 *  the facts, the release handoff, the open state, the approval at the head
 *  (a standing changes-requested there refuses even beside an approval) and
 *  the checks — red, still running (the merge), or none reported yet (the
 *  merge: record 0055's fresh-head window, where CI has not registered its
 *  first check and an empty list would sail through unverified). Answers the
 *  handoff card as a report; every other refusal is a `CommandError` with its
 *  reason. */
async function fencedTarget(args: {
  door: MergeDoorService;
  repo: string;
  number: number;
  userId: string;
  /** Whether a check still running refuses (the merge waits for green; the
   *  queue exists to run them). */
  refusePending: boolean;
}): Promise<FencedTarget | Extract<MergeDoorReport, { kind: "handed" }>> {
  const { door, repo, number } = args;
  const name = `${repo}#${number}`;
  const login = await door.githubLogin(args.userId);
  if (login === undefined)
    throw new CommandError(
      "conflict",
      `no GitHub login is bound to you, so the door cannot say who this act is for — an identity admin binds one with \`config set user --user <id> --github <login>\``,
    );
  const facts = await door.facts({ repo, number });
  if (facts === undefined)
    throw new CommandError("unavailable", `${name} could not be read from GitHub — nothing was done`);
  if (isReleasePullRequest(facts))
    return {
      kind: "handed",
      repo,
      number,
      ...(facts.title !== undefined ? { title: facts.title } : {}),
      ...(facts.htmlUrl !== undefined ? { url: facts.htmlUrl } : {}),
    };
  if (facts.state !== "open") throw new CommandError("conflict", `${name} is not open — nothing was done`);
  if (facts.headSha === undefined)
    throw new CommandError("unavailable", `${name} has no readable head — nothing was done`);
  const reviews = await door.reviews({ repo, number });
  const verdicts = reviewVerdictsAtHead(reviews ?? [], facts.headSha);
  if (!verdicts.includes("APPROVED"))
    throw new CommandError(
      "conflict",
      `no review approves the head \`${shortSha(facts.headSha)}\` of ${name} — nothing was done`,
    );
  if (verdicts.includes("CHANGES_REQUESTED"))
    throw new CommandError(
      "conflict",
      `a review requests changes at the head \`${shortSha(facts.headSha)}\` of ${name} — nothing was done`,
    );
  const checks = await door.checks(repo, facts.headSha);
  if (checks === undefined)
    throw new CommandError("unavailable", `the checks at the head of ${name} could not be read — nothing was done`);
  if (args.refusePending && checks.total === 0)
    throw new CommandError(
      "conflict",
      `no check reported at the head of ${name} — nothing was done; retry once CI registers (a repository with no CI stays a person's click on GitHub)`,
    );
  if (checks.failed.length > 0)
    throw new CommandError(
      "conflict",
      `red check at the head of ${name}: ${checks.failed.join(", ")} — nothing was done`,
    );
  if (args.refusePending && checks.pending.length > 0)
    throw new CommandError(
      "conflict",
      `checks still running at the head of ${name}: ${checks.pending.join(", ")} — nothing was done`,
    );
  return { repo, number, facts, headSha: facts.headSha, login };
}

/** The repo (from the reference, `--repo`, or the thread's binding) and number. */
async function resolveTarget(args: {
  pr: string;
  repo?: string;
  originRepo?: () => Promise<string | undefined> | string | undefined;
}): Promise<{ repo: string; number: number }> {
  const ref = parsePullReference(args.pr);
  const repo = ref.repo ?? args.repo ?? (await args.originRepo?.());
  if (repo === undefined)
    throw new CommandError(
      "invalid_input",
      "name a repository: `--repo owner/name`, a full pull request reference, or ask from a thread bound to one",
    );
  return { repo, number: ref.number };
}

const PR_ARG = {
  name: "pr",
  schema: z.string().regex(PR_REF),
  describe: "the pull request — a number, `#N`, `owner/name#N` or its GitHub URL",
} as const;

const REPO_OPTIONS = z.object({
  repo: z
    .string()
    .regex(REPO_SLUG)
    .optional()
    .describe("the repository (`owner/name`); default: the pull request's own, else the thread's bound repository"),
});

const doorOf = async (deps: MergeCommandDeps): Promise<MergeDoorService> => {
  if (deps.merge === undefined)
    throw new CommandError("unavailable", "no merge door is wired in this process — ask the bot to run it");
  return deps.merge.service();
};

export const pullsMerge = defineCommand({
  id: "pulls.merge",
  args: [PR_ARG] as const,
  options: REPO_OPTIONS,
  action: "merge:write",
  effect: "write",
  enabledWhen: (caps) => caps.github,
  annotations: {
    // A squash lands on the base branch for good: not undone by any command here.
    destructive: true,
    risk: (input) => {
      const pr = Array.isArray(input.args) ? input.args[0] : undefined;
      return `squash-merges pull request ${typeof pr === "string" && pr !== "" ? pr : "?"} at its approved head onto its base`;
    },
  },
  describe:
    "Squash-merge one approved pull request at exactly its reviewed head, under your own name: refused when no review approves the head, when a review there requests changes, when a check at it is red, still running or none has reported yet, and for the release pull request, which is answered with its card — that merge stays a person's click.",
  render: renderMergeReport,
  handler: async ({ args, options, caller, deps }) => {
    const door = await doorOf(deps);
    const target = await resolveTarget({ pr: args.pr, repo: options.repo, originRepo: () => caller.origin?.repo?.() });
    const fenced = await fencedTarget({ door, ...target, userId: caller.id, refusePending: true });
    if ("kind" in fenced) return fenced as unknown as JsonObject;
    const merged = await door.merge(
      { repo: fenced.repo, number: fenced.number },
      {
        sha: fenced.headSha,
        title: fenced.facts.title ?? `merge ${fenced.repo}#${fenced.number}`,
        mergedBy: fenced.login,
      },
    );
    if (!merged.ok)
      throw new CommandError(
        "conflict",
        `GitHub refused the merge of ${fenced.repo}#${fenced.number}: ${merged.reason}`,
      );
    const report: MergeDoorReport = {
      kind: "merged",
      repo: fenced.repo,
      number: fenced.number,
      sha: merged.sha,
      by: { user: caller.id, login: fenced.login },
    };
    return report as unknown as JsonObject;
  },
});

export const pullsEnqueue = defineCommand({
  id: "pulls.enqueue",
  args: [PR_ARG] as const,
  options: REPO_OPTIONS,
  action: "merge:write",
  effect: "write",
  enabledWhen: (caps) => caps.github,
  annotations: {
    // The queue merges on green without asking again: not undone by any command here.
    destructive: true,
    risk: (input) => {
      const pr = Array.isArray(input.args) ? input.args[0] : undefined;
      return `puts pull request ${typeof pr === "string" && pr !== "" ? pr : "?"} at its approved head in the merge queue, which merges it once its checks pass`;
    },
  },
  describe:
    "Put one approved pull request at exactly its reviewed head in the base branch's merge queue, recorded under your own name: refused when no review approves the head, when a review there requests changes, when a check at it is red, or when the head moves before enqueue, and for the release pull request, which is answered with its card — that merge stays a person's click; the queue runs the still-pending checks itself.",
  render: renderMergeReport,
  handler: async ({ args, options, caller, deps }) => {
    const door = await doorOf(deps);
    const target = await resolveTarget({ pr: args.pr, repo: options.repo, originRepo: () => caller.origin?.repo?.() });
    // A check still running passes here: running the checks is the queue's job.
    const fenced = await fencedTarget({ door, ...target, userId: caller.id, refusePending: false });
    if ("kind" in fenced) return fenced as unknown as JsonObject;
    const queued = await door.enqueue({ repo: fenced.repo, number: fenced.number }, { sha: fenced.headSha });
    if (!queued.ok)
      throw new CommandError("conflict", `GitHub refused to enqueue ${fenced.repo}#${fenced.number}: ${queued.reason}`);
    const report: MergeDoorReport = {
      kind: "enqueued",
      repo: fenced.repo,
      number: fenced.number,
      by: { user: caller.id, login: fenced.login },
    };
    return report as unknown as JsonObject;
  },
});

export const mergeCommands: readonly CommandDef<MergeCommandDeps>[] = [
  pullsMerge,
  pullsEnqueue,
] as unknown as CommandDef<MergeCommandDeps>[];

export function registerMergeCommands<D extends MergeCommandDeps>(registry: CommandRegistry<D>): void {
  for (const cmd of mergeCommands) registry.register(cmd as unknown as CommandDef<D>);
}
