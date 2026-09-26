// The authorize stage of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// the gates a resolved request passes before a model turn, each asked against
// the RESOLVED actor and agent (AGENTS.md invariant 3) — the agent allowlist,
// the repository gates (not onboarded or not visible, unverified, access), the
// PR head preflight and the attached-head guard. Each is a named refusal the thread
// sees, and the dispatch ends on it. The gates run where the pipeline reaches
// them: the agent gate before the thread is claimed, the repository gates once
// the target has landed and the ack card is up, the head gates around the
// workspace attach.
import type { ConfigStore } from "../../config.js";
import type { AgentDef } from "../../agents/registry.js";
import { chatActorOf } from "../authz/actor.js";
import type { BoundaryScope, ProfileRefusal, ProfileResolution, RunProfile } from "../../config/profile.js";
import type { RequestDirectives } from "../../directives.js";
import type { Capabilities } from "../capabilities.js";
import type { ExecutorSelection } from "../../execution/factory.js";
import { currentPrHeadSha, type RepoContext, type ResidentSlugs } from "../repoContext.js";
import { nearMatch } from "../nearMatch.js";
import { residentSlugsLister } from "../../execution/factory.js";
import { BASH_TIMEOUT_MAX_MS } from "../../execution/bashTimeout.js";
import { shellQuote } from "../../execution/shellQuote.js";
import { parseRevParseOutput } from "../reviewedHead.js";
import { checkPrHeadPreflight, guardAttachedHead } from "../reviewRound.js";
import type { CardShell } from "../statusCardFrame.js";
import type { Clock, Span } from "../trace/types.js";
import type { ChannelIO, IncomingMessage, StatusHandle } from "../types.js";
import type { ResumeContext } from "./admission.js";
import { refusalOf, type Guess, type Refusal } from "../refusal.js";
import { hasAction } from "../authz/authorize.js";
import type { Grants } from "../authz/types.js";
import { REFUSAL_SENTENCES } from "./reply.js";

/** What the gates read off the dispatcher's dependencies. `CoreDeps` extends
 *  this; a caller's shape is unchanged. */
export interface AuthorizeDeps {
  config: ConfigStore;
  /** What is on in this process (src/core/capabilities.ts): computed ONCE at
   *  startup from the config and the environment, read by every surface —
   *  the prompt blocks, the status card, the command catalogue, the web seed.
   *  Nothing below re-derives a capability from `config`. */
  capabilities: Capabilities;
  /**
   * The PR's head SHA as GitHub reports it right after a review was posted
   * (agent-review.md item 10): when it differs from the reviewed head — a push
   * landed mid-run — the thread gets a head-moved note. Default: one REST GET
   * via repoContext's `currentPrHeadSha`; undefined (or a throw) → no note.
   * Injectable so tests assert the note without a network call.
   */
  fetchPrHead?: (pr: { repo: string; number: number }) => Promise<string | undefined>;
  /**
   * The resident registry listing, for the not-onboarded gate's best guess
   * (record 0054): one bounded call — the probe's timeout, skipped inside a
   * probe-outage window — whose failure leaves the question without a guess.
   * Default: the production lister over the configured resident. Injectable so
   * tests assert the guess without a network call.
   */
  residentSlugs?: ResidentSlugs;
}

/** How a gate ended: the request goes on, or it was refused — the thread has
 *  been told why, and the dispatch is over. */
export type Gate<Reason extends string> = { kind: "allowed" } | { kind: "refused"; reason: Reason };

/** What every gate needs to refuse: the message, its channel handle, and the
 *  dispatch's refusal wrap (one `dispatch.refuse` span naming the outcome; the
 *  request ends refused). */
export interface GateContext {
  msg: IncomingMessage;
  io: ChannelIO;
  /** The dispatch's refusal wrap (record 0054): the site's `Refusal` stamped on
   *  the span, the root and the outcome, the side work (a card close, a
   *  release) run inside the span, and the sentence rendered in one place. */
  refuse: (refusal: Refusal, side?: () => Promise<void>) => Promise<void>;
}

/** The ack card a gate that runs after it closes with its reason before replying. */
export interface GateCard {
  card: StatusHandle;
  shell: CardShell;
  /** The card's shape and queued lines at a close (the dispatch's `closeLines`). */
  closeLines: (end: number, finished: boolean) => { shape?: string; queued?: string };
  clock: Clock;
}

/**
 * The agent gate (docs/reference/specs/routing-and-config.md item 4): checked
 * against the RESOLVED agent and the invoking user, so no config layer
 * (directives, user or channel scope) bypasses it. Before the thread is
 * claimed — a follow-up's sender must be allowed to run the agent, exactly
 * like a first message.
 */
export async function authorizeAgent(
  deps: AuthorizeDeps,
  ctx: GateContext & { agentName: string },
): Promise<Gate<"agent_allowlist">> {
  const { msg, refuse, agentName } = ctx;
  // Authorization gate: checked against the *resolved* agent and invoking
  // user, so no config layer (directives, user or channel scope) bypasses it.
  if (!deps.config.canRunAgent(chatActorOf(deps.config, msg), agentName)) {
    await refuse(
      refusalOf(
        "agent_allowlist",
        REFUSAL_SENTENCES.agent_allowlist({ agent: agentName, adminsHint: deps.config.adminsHint() }),
      ),
    );
    return { kind: "refused", reason: "agent_allowlist" };
  }
  return { kind: "allowed" };
}

/** How the profile gate ended: the run goes on with its effective profile — a
 *  clipped budget carried on it — or it was refused. */
export type ProfileGate = { kind: "allowed"; profile: RunProfile } | { kind: "refused"; reason: "profile_bounded" };

/**
 * The profile gate (docs/reference/specs/routing-and-config.md item 4; record
 * 0026): beside the agent gate and before the thread is claimed, so a refused
 * profile leaves no card, no run, no row and no workspace. The resolve stage
 * already computed preset ∩ boundary; this gate turns a refusal — an identity
 * or a machine class above a boundary's cap, never clipped — into one named
 * reply: the axis, the cap, the scope that set it, and the resulting state. A
 * clipped budget is allowed; the clip rides the profile to the card and the
 * record.
 */
export async function authorizeProfile(
  deps: AuthorizeDeps,
  ctx: GateContext & { agent: AgentDef; resolution: ProfileResolution },
): Promise<ProfileGate> {
  const { msg, refuse, agent, resolution } = ctx;
  if (resolution.kind === "profile") return { kind: "allowed", profile: resolution.profile };
  const { refusal } = resolution;
  console.log(`[dispatch] ${msg.threadKey} not started: profile bounded (${agent.name}: ${refusalSummary(refusal)})`);
  await refuse(refusalOf("profile_bounded", profileRefusalReply(agent.name, refusal, deps.config.adminsHint())));
  return { kind: "refused", reason: "profile_bounded" };
}

/** `identity write > read (channel)` — the one-line log form of a refusal. */
function refusalSummary(refusal: ProfileRefusal): string {
  switch (refusal.axis) {
    case "identity":
      return `identity ${refusal.needs} > ${refusal.cap} (${refusal.scope})`;
    case "machine":
      return `machine ${refusal.needs} not in ${refusal.allowed.join(",")} (${refusal.scopes.join(",")})`;
    case "minutes":
      return `minutes ${refusal.have} < ${refusal.needs} (${refusal.scope})`;
  }
}

/** The scope a boundary came from, as the thread reads it. */
function boundaryOf(scope: BoundaryScope): string {
  switch (scope) {
    case "channel":
      return "this channel's boundary";
    case "user":
      return "your own boundary";
    case "defaults":
      return "the installation's default boundary";
    case "directive":
      return "this message's own budget";
    case "parent":
      return "the parent run's remaining budget";
  }
}

/** The unchanged state after a boundary refusal. The reply narrates what
 * Switchboard did instead of delegating the policy change to the person. */
function boundaryOutcome(scope: BoundaryScope): string {
  switch (scope) {
    case "channel":
      return "Switchboard left this channel's boundary unchanged";
    case "user":
      return "Switchboard left your boundary and overrides unchanged";
    case "defaults":
      return "Switchboard left the installation's default boundary unchanged";
    case "directive":
      return "Switchboard applied this message's budget directive";
    case "parent":
      return "Switchboard left the parent run's remaining budget unchanged";
  }
}

/** The 🚫 reply of a bounded profile, in record 0026's wording: what the preset
 * needs, what the boundary allows and whose it is, then the resulting state. */
export function profileRefusalReply(agentName: string, refusal: ProfileRefusal, _adminsHint: string): string {
  if (refusal.axis === "identity") {
    const outcome = boundaryOutcome(refusal.scope);
    return `🚫 \`${agentName}\` needs a \`${refusal.needs}\` credential; ${boundaryOf(refusal.scope)} caps runs at \`${refusal.cap}\`. ${outcome} and did not start the run.`;
  }
  if (refusal.axis === "minutes") {
    const outcome = boundaryOutcome(refusal.scope);
    return `🚫 \`${agentName}\` needs at least ${refusal.needs} minutes — a turn, then its write-up and post-step — and ${boundaryOf(refusal.scope)} gives it ${refusal.have}. ${outcome} and did not start the run.`;
  }
  const scopes = refusal.scopes.map(boundaryOf);
  const who = scopes.length > 1 ? `${scopes.join(" and ")} allow` : `${scopes[0] ?? "the boundary"} allows`;
  const allowed = refusal.allowed.map((m) => `\`${m}\``).join(", ");
  const outcomes = refusal.scopes.map(boundaryOutcome).join("; ");
  return `🚫 \`${agentName}\` runs on a \`${refusal.needs}\` machine; ${who} only ${allowed}. ${outcomes}; it did not start the run.`;
}

/** Escape a literal for a regular expression. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The person's message with the rejected slug corrected — the line the
 *  question shows them to type. The whole token, case-insensitively; a message
 *  that does not carry the slug has no line to correct, so there is no guess. */
function correctedMessage(msg: IncomingMessage, slug: string, match: string): IncomingMessage | undefined {
  const pattern = new RegExp(`(^|[^A-Za-z0-9._/-])${escapeRegExp(slug)}(?![A-Za-z0-9._/-])`, "gi");
  const text = msg.text.replace(pattern, (_m, lead: string) => `${lead}${match}`);
  return text === msg.text ? undefined : { ...msg, text };
}

/**
 * The not-onboarded gate's best guess (record 0054): one registry call for the
 * resident list — bounded like the probe and skipped inside a probe-outage
 * window, both the lister's own — then one near-match pass. No list, no unique
 * match, or a message that does not carry the slug → no guess; the question
 * still stands without one.
 */
async function onboardedGuess(deps: AuthorizeDeps, msg: IncomingMessage, slug: string): Promise<Guess | undefined> {
  const list = deps.residentSlugs ?? residentSlugsLister(deps.config.config.execution?.resident);
  const candidates = await list?.().catch(() => undefined);
  if (!candidates || candidates.length === 0) return undefined;
  const near = nearMatch(slug, candidates);
  if (!near.guess) return undefined;
  const proposal = correctedMessage(msg, slug, near.guess);
  if (!proposal) return undefined;
  return { proposal, line: proposal.text, evidence: `${near.reason ?? `\`${near.guess}\``}, which is onboarded` };
}

/**
 * The repository gates, once the target has landed and the ack card is up: a
 * repo-needing agent whose bare slug its vet refused — the resident registry's
 * "not onboarded" for a `repo-resident` run, GitHub's 404 ("not visible") for
 * a `repo-cold` one — or could not answer for (unverified), and a restricted
 * repository the user holds no grant for (access). Each closes the card with
 * its reason and replies by name — never a silent per-thread fallback.
 */
export async function authorizeRepo(
  deps: AuthorizeDeps,
  ctx: GateContext & GateCard & { agent: AgentDef; profile: RunProfile; needsRepo: boolean; repoCtx: RepoContext },
): Promise<Gate<"pr_target_conflict" | "repo_not_onboarded" | "repo_not_visible" | "repo_unverified" | "repo_access">> {
  const { msg, refuse, card, shell, closeLines, clock, agent, profile, needsRepo, repoCtx } = ctx;
  if (needsRepo && repoCtx.prConflict) {
    const { target, cited } = repoCtx.prConflict;
    await refuse(refusalOf("pr_target_conflict", REFUSAL_SENTENCES.pr_target_conflict({ target, cited })), () =>
      card.done(
        shell.close({
          kind: "not_started",
          icon: "⚠️",
          reason: "conflicting pull requests",
          ...closeLines(clock(), false),
        }),
      ),
    );
    return { kind: "refused", reason: "pr_target_conflict" };
  }
  // A `repo-cold` run's vet was GitHub's, not the registry's
  // (docs/reference/specs/execution.md item 18): a refused slug is a repository
  // this installation cannot see — a resident fleet, or its absence, has
  // nothing to do with it — and an unanswered one is GitHub's silence. Both
  // stop by name before any executor exists; neither ever mentions onboarding.
  if (profile.machine === "repo-cold" && needsRepo && !repoCtx.repo) {
    if (repoCtx.rejectedRepo) {
      const slug = repoCtx.rejectedRepo;
      console.log(`[dispatch] ${msg.threadKey} not started: repo not visible (${slug}: GitHub answered 404)`);
      await refuse(refusalOf("repo_not_visible", REFUSAL_SENTENCES.repo_not_visible({ slug, agent: agent.name })), () =>
        card.done(
          shell.close({ kind: "not_started", icon: "📦", reason: "repo not visible", ...closeLines(clock(), false) }),
        ),
      );
      return { kind: "refused", reason: "repo_not_visible" };
    }
    if (repoCtx.unverifiedRepo) {
      const slug = repoCtx.unverifiedRepo;
      console.log(
        `[dispatch] ${msg.threadKey} not started: repo could not be verified (${slug}: GitHub did not answer)`,
      );
      await refuse(
        refusalOf("repo_unverified", REFUSAL_SENTENCES.repo_unverified({ slug, agent: agent.name, via: "github" })),
        () =>
          card.done(
            shell.close({
              kind: "not_started",
              icon: "📦",
              reason: "repo could not be verified",
              ...closeLines(clock(), false),
            }),
          ),
      );
      return { kind: "refused", reason: "repo_unverified" };
    }
  }
  // Not-onboarded gate: the thread has no repo, and the only reason
  // is that its bare `owner/name` slug was refused by the resident registry
  // (item 29's probe). A repo-needing agent would otherwise start with an
  // EMPTY workspace and report `fatal: not a git repository` — say why
  // instead, before any
  // attach or model turn. A thread that already has a repo never reaches
  // here with `rejectedRepo` (prose slugs there are never probed), so
  // the silence that fix bought is untouched. Only where residents exist
  // (`capabilities.residents`): without a fleet there is nothing to onboard,
  // and a note inviting `repo onboard` would point at a command this
  // installation does not have.
  if (deps.capabilities.residents && needsRepo && !repoCtx.repo && repoCtx.rejectedRepo) {
    const slug = repoCtx.rejectedRepo;
    console.log(`[dispatch] ${msg.threadKey} not started: repo not onboarded (${slug})`);
    // `repo onboard` is admin-gated (canManageRepos, fail-closed): only tell
    // someone to run it if they can; everyone else is pointed at who can.
    const onboardHint = deps.config.canManageRepos(chatActorOf(deps.config, msg))
      ? `Onboard it (\`repo onboard ${slug}\`)`
      : `Ask ${deps.config.adminsHint()} to onboard it (\`repo onboard ${slug}\`)`;
    const guess = await onboardedGuess(deps, msg, slug);
    await refuse(
      refusalOf(
        "repo_not_onboarded",
        REFUSAL_SENTENCES.repo_not_onboarded({ slug, agent: agent.name, onboardHint }),
        guess ? { guess } : undefined,
      ),
      () =>
        card.done(
          shell.close({ kind: "not_started", icon: "📦", reason: "repo not onboarded", ...closeLines(clock(), false) }),
        ),
    );
    return { kind: "refused", reason: "repo_not_onboarded" };
  }

  // Unverified gate (item 29): the registry did not ANSWER
  // for the repo this message addressed (or, in a fresh thread, for its only
  // candidate). Running anyway would mean guessing a repo — in a bound
  // thread, the thread's OLD one: exactly the wrong-repo run addressing
  // exists to end. Say so and stop; the user retries in a minute or names
  // the repo by URL.
  if (needsRepo && !repoCtx.repo && repoCtx.unverifiedRepo) {
    const slug = repoCtx.unverifiedRepo;
    console.log(
      `[dispatch] ${msg.threadKey} not started: repo could not be verified (${slug}: resident registry unreachable)`,
    );
    await refuse(
      refusalOf("repo_unverified", REFUSAL_SENTENCES.repo_unverified({ slug, agent: agent.name, via: "registry" })),
      () =>
        card.done(
          shell.close({
            kind: "not_started",
            icon: "📦",
            reason: "repo could not be verified",
            ...closeLines(clock(), false),
          }),
        ),
    );
    return { kind: "refused", reason: "repo_unverified" };
  }

  // Per-repo access gate: open unless `restrict.repos` names the repo;
  // a restricted repo refuses a user without a `repos` grant BY NAME — a
  // refused user must see why, never get a silent per-thread fallback.
  if (needsRepo && repoCtx.repo && !deps.config.canUseRepo(chatActorOf(deps.config, msg), repoCtx.repo)) {
    const repo = repoCtx.repo;
    await refuse(
      refusalOf("repo_access", REFUSAL_SENTENCES.repo_access({ repo, adminsHint: deps.config.adminsHint() })),
      () =>
        card.done(
          shell.close({ kind: "not_started", icon: "🚫", reason: "repo access", ...closeLines(clock(), false) }),
        ),
    );
    return { kind: "refused", reason: "repo_access" };
  }
  return { kind: "allowed" };
}

/**
 * The PR head preflight (docs/reference/specs/agent-review.md item 11): a review
 * whose PR head could not be resolved is a guaranteed refusal downstream — not
 * started instead, before any attach, with one named reply (the decision and
 * the reply live in `checkPrHeadPreflight`).
 */
export async function authorizePrHead(
  ctx: GateContext & GateCard & { agent: AgentDef; directives: RequestDirectives; repoCtx: RepoContext },
): Promise<Gate<"pr_head_unknown">> {
  const { msg, refuse, card, shell, closeLines, clock, agent, directives, repoCtx } = ctx;
  // Unknown-head check (docs/reference/specs/agent-review.md item 11): a review whose PR
  // head could not be resolved is a guaranteed refusal downstream — not
  // started instead, before any attach, one named reply (the decision and
  // the reply live in `checkPrHeadPreflight`; otherwise a minute and a
  // model turn are spent on a Slack-only "cannot review").
  const preflight = checkPrHeadPreflight({ agent, requestText: directives.text, repoCtx });
  if (!preflight.ok) {
    console.log(`[review] ${msg.threadKey} not started: PR head unknown (${preflight.where})`);
    await refuse(refusalOf("pr_head_unknown", preflight.reply), () =>
      card.done(
        shell.close({ kind: "not_started", icon: "🔀", reason: "PR head unknown", ...closeLines(clock(), false) }),
      ),
    );
    return { kind: "refused", reason: "pr_head_unknown" };
  }
  return { kind: "allowed" };
}

/** How the attached-head guard ended: the run goes on with the repo context it
 *  should review (the PR's current head when the attach adopted it) and whether
 *  the attach verified the worktree is at that head — or it was refused. */
export type AttachedHeadGate =
  | { kind: "allowed"; repoCtx: RepoContext; verifiedAtAttach: boolean; headAdopted: boolean }
  | { kind: "refused"; reason: "workspace_head_mismatch" };

/**
 * A cold review starts in an empty per-thread workspace. Provision the exact
 * pull-request checkout there before the attached-head gate observes it: the
 * model never owns clone/checkout, and therefore never gets a first turn in an
 * empty directory. The fetch uses the run's injected credential through git's
 * env-backed helper; no token enters this command text. `origin/HEAD` and the
 * resolved base are fetched beside the PR head because the review prompt diffs
 * against those remote-tracking refs.
 */
function reviewCheckoutFacts(repoCtx: RepoContext & { repo: string; pr: number }): {
  remote: string;
  helper: string;
  refspecs: string[];
} {
  return {
    remote: `https://github.com/${repoCtx.repo}.git`,
    helper: `!f() { test -n "$GH_TOKEN" || exit 1; printf '%s\\n' 'username=x-access-token' "password=$GH_TOKEN"; }; f`,
    refspecs: [
      "+HEAD:refs/remotes/origin/HEAD",
      `+refs/pull/${repoCtx.pr}/head:refs/remotes/origin/pull/${repoCtx.pr}/head`,
      ...(repoCtx.baseRef ? [`+refs/heads/${repoCtx.baseRef}:refs/remotes/origin/${repoCtx.baseRef}`] : []),
    ],
  };
}

function coldReviewCheckoutCommand(repoCtx: RepoContext & { repo: string; pr: number; headSha: string }): string {
  const { remote, helper, refspecs } = reviewCheckoutFacts(repoCtx);
  return [
    "set -eu",
    "find . -mindepth 1 -maxdepth 1 ! -name attachments -exec rm -rf -- {} +",
    "git init -q .",
    `git remote add origin ${shellQuote(remote)}`,
    `git -c credential.helper= -c credential.helper=${shellQuote(helper)} fetch --force --no-tags origin ${refspecs.map(shellQuote).join(" ")}`,
    `git checkout --detach --force ${shellQuote(repoCtx.headSha)}`,
  ].join("\n");
}

/** Refresh an already-seeded review checkout at the same expected head. */
function seededReviewCheckoutCommand(
  repoCtx: RepoContext & { repo: string; pr: number; headSha: string },
  workspace: string,
): string {
  const { helper, refspecs } = reviewCheckoutFacts(repoCtx);
  const git = `git -C ${shellQuote(workspace)}`;
  return [
    "set -eu",
    `${git} -c credential.helper= -c credential.helper=${shellQuote(helper)} fetch --force --no-tags origin ${refspecs.map(shellQuote).join(" ")}`,
    `${git} checkout --detach --force ${shellQuote(repoCtx.headSha)}`,
  ].join("\n");
}

/**
 * The attached-head guard (docs/reference/specs/agent-review.md item 10): every
 * PR review is at its resolved head before any model turn. Cold backends are
 * provisioned first; seeded and resident backends are observed through their
 * executor. Verified; adopted (a push raced the request and the workspace is
 * at the PR's head now); or refused (mismatch or unreadable): the workspace is
 * released and one named reply is sent.
 */
export async function authorizeAttachedHead(
  deps: AuthorizeDeps,
  ctx: GateContext &
    GateCard & {
      agent: AgentDef;
      resume: ResumeContext | undefined;
      /** The attach's answer: the executor to release on a refusal, the resident flag, the binding's sha and ref. */
      selection: ExecutorSelection;
      repoCtx: RepoContext;
      root: Span;
    },
): Promise<AttachedHeadGate> {
  const { msg, refuse, card, shell, closeLines, clock, agent, resume, selection, root } = ctx;
  const { executor, resident, binding } = selection;
  let repoCtx = ctx.repoCtx;
  // Attach-head check (docs/reference/specs/agent-review.md item 10): every PR
  // review proves the workspace's HEAD before any model turn. Every backend,
  // including a resident whose attach returned SHA metadata, is observed
  // directly in the checkout. Unknown is a refusal, not permission for the
  // model to turn an infrastructure failure into a finding.
  let verifiedAtAttach = false;
  let headAdopted = false;
  if (!resume && agent.name === "review" && repoCtx.pr !== undefined && repoCtx.repo) {
    const pr = { repo: repoCtx.repo, number: repoCtx.pr };
    const expectedHeadSha = repoCtx.headSha;
    const guard = await root.span("dispatch.gate.attached_head", async (span) => {
      const command = selection.seeded?.workspace
        ? `git -C ${shellQuote(selection.seeded.workspace)} rev-parse HEAD`
        : "git rev-parse HEAD";
      if (!resident && selection.seeded === undefined && expectedHeadSha !== undefined) {
        await executor.exec(
          coldReviewCheckoutCommand({ ...repoCtx, repo: pr.repo, pr: pr.number, headSha: expectedHeadSha }),
          { timeoutMs: BASH_TIMEOUT_MAX_MS },
        );
      }
      const observeHead = () =>
        executor
          .exec(command, { timeoutMs: 30_000, span })
          .then(parseRevParseOutput)
          .catch(() => undefined);
      const sha = await observeHead();
      const g = await guardAttachedHead({
        pr,
        expectedHeadSha,
        attached: { sha, ref: binding?.ref ?? repoCtx.ref, source: "workspace-observed" },
        fallbackRef: repoCtx.ref,
        fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
        reprovision: async (headSha) => {
          if (executor.moveTo) {
            await executor.moveTo(headSha, { span });
            const observedSha = await observeHead();
            if (selection.binding && observedSha !== undefined) {
              selection.binding = {
                ...selection.binding,
                ref: repoCtx.ref ?? selection.binding.ref,
                sha: observedSha,
              };
            }
            return {
              sha: observedSha,
              ref: repoCtx.ref,
              source: "workspace-observed" as const,
            };
          }
          if (selection.seeded?.workspace) {
            await executor.exec(
              seededReviewCheckoutCommand(
                { ...repoCtx, repo: pr.repo, pr: pr.number, headSha },
                selection.seeded.workspace,
              ),
              { timeoutMs: BASH_TIMEOUT_MAX_MS, span },
            );
          } else {
            await executor.exec(coldReviewCheckoutCommand({ ...repoCtx, repo: pr.repo, pr: pr.number, headSha }), {
              timeoutMs: BASH_TIMEOUT_MAX_MS,
              span,
            });
          }
          const retried = await observeHead();
          return { sha: retried, ref: repoCtx.ref, source: "workspace-observed" as const };
        },
        logKey: msg.threadKey,
      });
      span.setAttrs({ outcome: g.outcome });
      return g;
    });
    if (guard.outcome === "verified") {
      verifiedAtAttach = true;
    } else if (guard.outcome === "adopted") {
      repoCtx = { ...repoCtx, headSha: guard.headSha };
      verifiedAtAttach = true;
      headAdopted = true;
    } else if (guard.outcome === "refused") {
      await refuse(refusalOf("workspace_head_mismatch", guard.reply), async () => {
        if (executor.release) await executor.release("always").catch(() => {});
        await card.done(
          shell.close({
            kind: "not_started",
            icon: "🔀",
            reason: "workspace head mismatch",
            ...closeLines(clock(), false),
          }),
        );
      });
      return { kind: "refused", reason: "workspace_head_mismatch" };
    }
  }
  return { kind: "allowed", repoCtx, verifiedAtAttach, headAdopted };
}

/** How the steer owner rule ended: refused for not being the run's requester
 *  (nor holding the grant), or — for a run's own steer — for naming a run
 *  outside its lineage. */
export type SteerOwnerGate =
  { kind: "allowed" } | { kind: "refused"; reason: "steer_not_requester" | "steer_outside_instance" };

/**
 * The steer owner rule (docs/reference/specs/authorization.md item 16a; the
 * one-door plan's admission unit). A bind of `steer` — and any destructive
 * bind aimed at a run — is a person reaching into work someone requested, so
 * it is authorized against the TARGET run, not only the command: the author
 * must be that run's requester (any id the identity record links to them), or
 * hold the `runs:write` grant. A run authoring a steer (`from` set — the
 * runner standing in for the plan's requester) reaches ONLY runs its own
 * lineage names: its direct child (`target.parentRunId` is the sender), its
 * own parent (`from.parentRunId` is the target — a child telling its parent of
 * a reply in its thread), or a run of its own plan instance
 * (`target.parentInstanceId` equals the sender's instance). The borrowed
 * requester's grants lend a run's steer nothing, and the stand-in reaches no
 * destructive bind (R2: every other bind the runner authors is authorized as
 * the runner itself). Fail closed: a target with no requester on record
 * admits nobody but a grant holder.
 */
export function authorizeSteerOwner(input: {
  /** The author, resolved: every id that means "me" (`Actor.self`) and the effective grants. */
  caller: { ids: readonly string[]; grants: Grants };
  /** The run the bind names. */
  target: { runId?: string; requesterId?: string; parentInstanceId?: string; parentRunId?: string };
  /** Set when a RUN authored the bind (a steer's `from`): its id, its own
   *  parent when it has one, and its plan instance when it runs under one. */
  from?: { runId: string; parentRunId?: string; instanceId?: string };
  /** The bind's kind: the run stand-in reaches only a bind of `steer`. */
  bind?: "steer" | "destructive";
}): SteerOwnerGate {
  const bind = input.bind ?? "steer";
  if (input.from) {
    if (bind !== "steer") return { kind: "refused", reason: "steer_not_requester" };
    const { from, target } = input;
    const ownChild = target.parentRunId !== undefined && target.parentRunId === from.runId;
    const ownParent = from.parentRunId !== undefined && from.parentRunId === target.runId;
    const ownInstance = from.instanceId !== undefined && from.instanceId === target.parentInstanceId;
    return ownChild || ownParent || ownInstance
      ? { kind: "allowed" }
      : { kind: "refused", reason: "steer_outside_instance" };
  }
  const requester = input.target.requesterId;
  if (requester !== undefined && input.caller.ids.includes(requester)) return { kind: "allowed" };
  if (hasAction(input.caller.grants.actions, "runs:write")) return { kind: "allowed" };
  return { kind: "refused", reason: "steer_not_requester" };
}
