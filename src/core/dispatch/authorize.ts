// The authorize stage of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// the gates a resolved request passes before a model turn, each asked against
// the RESOLVED actor and agent (AGENTS.md invariant 3) — the agent allowlist,
// the repository gates (not onboarded, unverified, access), the PR head
// preflight and the attached-head guard. Each is a named refusal the thread
// sees, and the dispatch ends on it. The gates run where the pipeline reaches
// them: the agent gate before the thread is claimed, the repository gates once
// the target has landed and the ack card is up, the head gates around the
// workspace attach.
import type { ConfigStore } from "../../config.js";
import type { AgentDef } from "../../agents/registry.js";
import type { RequestDirectives } from "../../directives.js";
import type { Capabilities } from "../capabilities.js";
import type { ExecutorSelection } from "../../execution/factory.js";
import { currentPrHeadSha, type RepoContext } from "../repoContext.js";
import { checkPrHeadPreflight, guardAttachedHead } from "../reviewRound.js";
import type { CardShell } from "../statusCardFrame.js";
import type { Clock, Span } from "../trace/types.js";
import type { ChannelIO, IncomingMessage, StatusHandle } from "../types.js";
import type { ResumeContext } from "./admission.js";

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
  refuse: <T>(outcome: string, fn: () => Promise<T>) => Promise<T>;
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
  const { msg, io, refuse, agentName } = ctx;
  // Authorization gate: checked against the *resolved* agent and invoking
  // user, so no config layer (directives, user or channel scope) bypasses it.
  if (!deps.config.canRunAgent(msg.userId, agentName)) {
    await refuse("agent_allowlist", () =>
      io.reply(
        `🚫 You're not on the allowlist for the \`${agentName}\` agent. Ask ${deps.config.adminsHint()} for access.`,
      ),
    );
    return { kind: "refused", reason: "agent_allowlist" };
  }
  return { kind: "allowed" };
}

/**
 * The repository gates, once the target has landed and the ack card is up: a
 * repo-needing agent whose bare slug the resident registry refused (not
 * onboarded) or could not answer for (unverified), and a restricted repository
 * the user holds no grant for (access). Each closes the card with its reason
 * and replies by name — never a silent per-thread fallback.
 */
export async function authorizeRepo(
  deps: AuthorizeDeps,
  ctx: GateContext & GateCard & { agent: AgentDef; needsRepo: boolean; repoCtx: RepoContext },
): Promise<Gate<"repo_not_onboarded" | "repo_unverified" | "repo_access">> {
  const { msg, io, refuse, card, shell, closeLines, clock, agent, needsRepo, repoCtx } = ctx;
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
    const onboardHint = deps.config.canManageRepos(msg.userId)
      ? `Onboard it (\`repo onboard ${slug}\`)`
      : `Ask ${deps.config.adminsHint()} to onboard it (\`repo onboard ${slug}\`)`;
    await refuse("repo_not_onboarded", async () => {
      await card.done(
        shell.close({ kind: "not_started", icon: "📦", reason: "repo not onboarded", ...closeLines(clock(), false) }),
      );
      await io.reply(
        `📦 \`${slug}\` is not onboarded as a resident, so I did not start a *${agent.name}* run for it. ` +
          `${onboardHint} for a warm, deps-ready environment, or name the repository by URL ` +
          `(https://github.com/${slug}) to run in a cold per-thread sandbox.`,
      );
    });
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
    await refuse("repo_unverified", async () => {
      await card.done(
        shell.close({
          kind: "not_started",
          icon: "📦",
          reason: "repo could not be verified",
          ...closeLines(clock(), false),
        }),
      );
      await io.reply(
        `⚠️ I couldn't verify that \`${slug}\` is an onboarded repo — the resident registry didn't answer — so I did not start a *${agent.name}* run rather than guess which repo you meant. ` +
          `Try again in a minute, or name the repository by URL (https://github.com/${slug}) to run in a cold per-thread sandbox.`,
      );
    });
    return { kind: "refused", reason: "repo_unverified" };
  }

  // Per-repo access gate: open unless `restrict.repos` names the repo;
  // a restricted repo refuses a user without a `repos` grant BY NAME — a
  // refused user must see why, never get a silent per-thread fallback.
  if (needsRepo && repoCtx.repo && !deps.config.canUseRepo(msg.userId, repoCtx.repo)) {
    const repo = repoCtx.repo;
    await refuse("repo_access", async () => {
      await card.done(
        shell.close({ kind: "not_started", icon: "🚫", reason: "repo access", ...closeLines(clock(), false) }),
      );
      await io.reply(
        `🚫 You're not on the allowlist for the \`${repo}\` repo environment. Ask ${deps.config.adminsHint()} for access.`,
      );
    });
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
  const { msg, io, refuse, card, shell, closeLines, clock, agent, directives, repoCtx } = ctx;
  // Unknown-head check (docs/reference/specs/agent-review.md item 11): a review whose PR
  // head could not be resolved is a guaranteed refusal downstream — not
  // started instead, before any attach, one named reply (the decision and
  // the reply live in `checkPrHeadPreflight`; otherwise a minute and a
  // model turn are spent on a Slack-only "cannot review").
  const preflight = checkPrHeadPreflight({ agent, requestText: directives.text, repoCtx });
  if (!preflight.ok) {
    console.log(`[review] ${msg.threadKey} not started: PR head unknown (${preflight.where})`);
    await refuse("pr_head_unknown", async () => {
      await card.done(
        shell.close({ kind: "not_started", icon: "🔀", reason: "PR head unknown", ...closeLines(clock(), false) }),
      );
      await io.reply(preflight.reply);
    });
    return { kind: "refused", reason: "pr_head_unknown" };
  }
  return { kind: "allowed" };
}

/** How the attached-head guard ended: the run goes on with the repo context it
 *  should review (the PR's current head when the attach adopted it) and whether
 *  the attach verified the worktree is at that head — or it was refused. */
export type AttachedHeadGate =
  | { kind: "allowed"; repoCtx: RepoContext; verifiedAtAttach: boolean; headAdopted: boolean }
  | { kind: "refused"; reason: "branch_moved" };

/**
 * The attached-head guard (docs/reference/specs/agent-review.md item 10): for a
 * PR review on the resident path, the sha the resident ATTACHED the worktree at
 * against the PR head resolved before, decided before any model turn.
 * Verified; adopted (a push raced the request and the worktree sits at the PR's
 * head NOW — the repo context takes it); or refused (the branch moved while the
 * worktree was being attached): the pool user released, one named reply.
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
  const { msg, io, refuse, card, shell, closeLines, clock, agent, resume, selection, root } = ctx;
  const { executor, resident, binding } = selection;
  let repoCtx = ctx.repoCtx;
  // Attach-head check (docs/reference/specs/agent-review.md item 10): for a PR
  // review on the resident path, the sha the resident ATTACHED the worktree
  // at is compared with the PR head resolved above — before any model turn
  // (the comparison, the current-head second lookup and the refusal reply
  // live in `guardAttachedHead`). "adopted" means a push raced the request
  // and the worktree sits at the PR's head NOW: RepoContext adopts it and
  // the block says it was verified. "refused" means the branch moved while
  // the worktree was being attached: not started — one named reply, the
  // pool user released, no provider call.
  let verifiedAtAttach = false;
  let headAdopted = false;
  if (!resume && agent.name === "review" && resident && repoCtx.pr !== undefined && repoCtx.repo) {
    const pr = { repo: repoCtx.repo, number: repoCtx.pr };
    const guard = await root.span("dispatch.gate.attached_head", async (span) => {
      const g = await guardAttachedHead({
        pr,
        expectedHeadSha: repoCtx.headSha,
        attached: { sha: binding?.sha, ref: binding?.ref },
        fallbackRef: repoCtx.ref,
        fetchPrHead: deps.fetchPrHead ?? currentPrHeadSha,
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
      const reply = guard.reply;
      await refuse("branch_moved", async () => {
        if (executor.release) await executor.release("always").catch(() => {});
        await card.done(
          shell.close({ kind: "not_started", icon: "🔀", reason: "branch moved", ...closeLines(clock(), false) }),
        );
        await io.reply(reply);
      });
      return { kind: "refused", reason: "branch_moved" };
    }
  }
  return { kind: "allowed", repoCtx, verifiedAtAttach, headAdopted };
}
