// The resolve stage of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// what this request is. The directives and the thread's history; the (agent,
// model, effort) triple through the layered configuration with thread
// stickiness; the provider the model ref names, checked against the config;
// and the target repository, ref and pull request, started as a promise so the
// GitHub round trip overlaps the memory read and lands after the ack card.
// Pure resolution — the gates that judge the result are authorize.ts.
import { refusalOf, RefusalError } from "../refusal.js";
import { leaseMinimum } from "../budgets.js";
import type { ConfigStore, ResolvedRequest } from "../../config.js";
import { machineNeedsRepo, type AgentDef } from "../../agents/registry.js";
import { boundedByParent, effectiveProfile, type ProfileResolution, type RunProfile } from "../../config/profile.js";
import {
  lastThreadDirectives,
  parseDirectives,
  type RequestDirectives,
  type ThreadDirectives,
} from "../../directives.js";
import { parseModelRef } from "../provider.js";
import { decideControls, resolveModelCard, type ControlDecision, type ModelCard } from "../modelCard.js";
import { installedModelRegistry } from "../installedModelRegistry.js";
import {
  githubTokenScopeFor,
  residentOnboardedProbe,
  residentSlugsLister,
  type ResidentExecutionConfig,
} from "../../execution/factory.js";
import { githubRepoProbe } from "../../execution/githubRepoProbe.js";
import {
  resolveRepoContext,
  type RepoContext,
  type RepoProbe,
  type ResidentSlugs,
  type RunRecordSignals,
} from "../repoContext.js";
import type { AgentSource } from "../runEvents.js";
import type { Span } from "../trace/types.js";
import type { ChannelIO, HistoryItem, IncomingMessage } from "../types.js";
import type { ResumeContext } from "./admission.js";

/** What the resolve stage reads off the dispatcher's dependencies. `CoreDeps`
 *  extends this; a caller's shape is unchanged. */
export interface ResolveDeps {
  config: ConfigStore;
  /**
   * Resolves the target repo/ref for a message (resident environments).
   * Defaults to the production resolver in repoContext.ts (explicit repo/PR/
   * branch signals in the message, then the thread-established repo from
   * history, then the PR the thread's newest run opened — `records`, off the
   * run record, resident-repos item 29); injectable for tests. No repo signal
   * → {} → the per-thread executor path with no resident probe (total input
   * contract).
   */
  resolveRepoContext?: (
    msg: IncomingMessage,
    history: HistoryItem[],
    records?: RunRecordSignals,
  ) => Promise<RepoContext> | RepoContext;
}

/** What `readRequest` reads off the dispatch. */
export interface ReadRequestContext {
  msg: IncomingMessage;
  io: ChannelIO;
  root: Span;
}

/** The request as the model will see it: its directives parsed and stripped
 *  from the text, and the thread's history — fetched under its own span, after
 *  the chat fast path (a command never pays for it) and before the op fast
 *  path (which reads it). */
export async function readRequest(
  ctx: ReadRequestContext,
): Promise<{ directives: RequestDirectives; history: HistoryItem[] }> {
  const { msg, io, root } = ctx;
  const directives = parseDirectives(msg.text);
  const history = await root.span("dispatch.history", () => io.history());
  return { directives, history };
}

/** The run this request resolves to: the thread's sticky directives, the
 *  (agent, model, effort) triple the config layers settled on, and how the
 *  agent was chosen — the route stage runs only for `default`, and the record's
 *  `run_meta` carries it. */
export interface ResolvedRun {
  sticky: ThreadDirectives;
  resolved: ResolvedRequest;
  agentSource: AgentSource;
}

/**
 * The (agent, model, effort) triple for this request through the config layers
 * (docs/reference/specs/routing-and-config.md item 2): a request directive, else
 * the thread's sticky one, else the user, channel and default scopes.
 */
export function resolveRun(
  deps: ResolveDeps,
  ctx: {
    msg: IncomingMessage;
    directives: RequestDirectives;
    history: HistoryItem[];
    /** The thread's sticky agent by transcript (item 3; dispatch/thread.ts):
     *  the agent of the thread's newest finished run with a session log, the
     *  one the caller read. The model and the effort are the user turns'. */
    stickyAgent?: string;
  },
): ResolvedRun {
  const { msg, directives, history } = ctx;
  // Thread stickiness (item 3): a follow-up without explicit directives runs
  // on the agent/model this thread already established, not the channel or
  // global default — otherwise "continue" in a coding thread silently lands
  // on the toolless default agent. The agent is the thread's by transcript
  // (the caller read the thread's runs); the model and the effort come from
  // the last directive in the thread's user turns. Derived on every message,
  // never stored: restart-safe, and consistent with how the Slack adapter
  // re-derives thread participation.
  const fromTurns = lastThreadDirectives(history);
  const sticky: ThreadDirectives = ctx.stickyAgent !== undefined ? { ...fromTurns, agent: ctx.stickyAgent } : fromTurns;
  const resolved = deps.config.resolve({
    channelId: msg.channelId,
    userId: msg.userId,
    request: {
      agent: directives.agent ?? sticky.agent,
      model: directives.model ?? sticky.model,
      effort: directives.effort ?? sticky.effort,
    },
  });
  // The layer that set the agent, told apart at the request layer: the
  // message's own directive or the thread's sticky one — both the requester's
  // typing, which the replay harness reads as a label.
  const agentSource: AgentSource =
    resolved.agentLayer === "request" ? (directives.agent !== undefined ? "directive" : "sticky") : resolved.agentLayer;
  return { sticky, resolved, agentSource };
}

/**
 * The effective profile of this request (docs/reference/specs/routing-and-config.md
 * item 2; docs/decisions/0026-capability-profiles-and-request-routing.md):
 * preset ∩ directives ∩ boundary, computed once, here, once the preset is
 * known — the lookup stays after the agent gate, so a caller who may not run
 * the agent is refused before its preset is even read. The request's
 * `budget:` directive enters as the caller's own boundary on this run: it
 * narrows the minutes and never widens them. Pure resolution: the profile gate
 * (`authorizeProfile`) judges the outcome. A resume keeps the profile its row
 * was admitted with — the clipped budget and what clipped it — rather than
 * re-reading the preset; the boundaries on the path today are still asked,
 * so an identity or class a tightened cap no longer allows refuses the resume
 * by name like a fresh request, while its budget is the row's. A row written
 * before profiles existed resolves like a fresh request. A spawned child
 * (item 20) takes the wall clock its parent had left as one more boundary on
 * the minutes — `boundedBy: "parent"` when that was the tightest cap — and
 * nothing on the other two axes: a parent hands a child time, never a
 * credential or a machine.
 */
export function resolveProfile(ctx: {
  agent: AgentDef;
  resolved: ResolvedRequest;
  resume: ResumeContext | undefined;
  /** The request's `budget:` directive, in minutes; absent when it sent none. */
  budget?: number;
  /** For a spawned child: the parent's remaining wall clock at the spawn, in ms. */
  parentRemainingMs?: number;
}): ProfileResolution {
  const carried = ctx.resume?.row.meta.profile;
  const declared = carried
    ? { machine: carried.machine, identity: carried.identity, maxMinutes: carried.minutes }
    : ctx.agent;
  const boundary =
    ctx.parentRemainingMs !== undefined
      ? boundedByParent(ctx.resolved.boundary, ctx.parentRemainingMs)
      : ctx.resolved.boundary;
  // The lease minimum (decision 0046; `leaseMinimum`): a lease clipped under
  // the write-up, the post-step and one turn is refused here by name, never
  // started to report a budget it never had.
  const resolution = effectiveProfile(
    declared,
    ctx.budget !== undefined ? { budget: ctx.budget } : {},
    boundary,
    leaseMinimum(ctx.agent.name),
  );
  if (resolution.kind === "profile" && carried?.boundedBy && !resolution.profile.boundedBy) {
    return { kind: "profile", profile: { ...resolution.profile, boundedBy: carried.boundedBy } };
  }
  return resolution;
}

/** Whether the run's machine class carries a repository, the target's
 *  resolution in flight, and the model card resolved beside the block check
 *  (record 0052) with every control decided against it. */
export interface ResolvedTarget {
  needsRepo: boolean;
  repoCtxP: Promise<RepoContext>;
  /** The card resolved before the first call; the run records it. */
  modelCard: ModelCard;
  /** Every control's decision — the degraded ones become notes on the record
   *  before the first turn; a refused one throws above. */
  decisions: ControlDecision[];
}

/** What `resolveTarget` reads off the dispatch. */
export interface ResolveTargetContext {
  msg: IncomingMessage;
  history: HistoryItem[];
  agent: AgentDef;
  /** The run's effective profile: its class decides whether a repository is
   *  resolved, its identity which credential vets a bare slug. */
  profile: RunProfile;
  resolved: ResolvedRequest;
  resume: ResumeContext | undefined;
  root: Span;
  /** What the thread's run records say (resident-repos item 29): the pull
   *  request its newest finished run opened, from the dispatcher's one read
   *  of the thread's runs; absent for a message that starts a thread. */
  records?: RunRecordSignals;
}

/**
 * The provider the model ref names, checked against the config's `providers`
 * (an unknown one throws here, before any card — the run's pi would only find
 * out at its first model call), and the target repo/ref/PR resolution,
 * STARTED — a promise the caller awaits after the ack card, so the GitHub
 * round trip overlaps the memory read. A resume carries its repo context; a
 * run whose machine class carries no repository resolves none.
 */
export function resolveTarget(deps: ResolveDeps, ctx: ResolveTargetContext): ResolvedTarget {
  const { msg, history, profile, resolved, resume, root } = ctx;
  const { provider: providerName } = parseModelRef(resolved.modelRef);
  const providers = deps.config.config.providers;
  if (!providers[providerName]) {
    throw new RefusalError(
      refusalOf(
        "provider_unknown",
        `Unknown provider "${providerName}". Configured providers: ${Object.keys(providers).join(", ")}`,
      ),
    );
  }

  // The model card (record 0052): resolved once, here, where the block is
  // checked, and decided before any card or span opens. A control the card
  // refuses ends the run with a reply naming the model and what it takes, the
  // same shape as the unknown-provider refusal above.
  const modelCard = resolveModelCard(resolved.modelRef, providers, installedModelRegistry);
  const decisions = decideControls(modelCard, {
    ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
    ...(msg.images ? { images: msg.images.length } : {}),
    ...(msg.documents ? { documents: msg.documents.length } : {}),
  });
  const refused = decisions.find((d) => d.outcome === "refused");
  if (refused) {
    throw new RefusalError(
      refusalOf(
        "model_card_refused",
        `Model "${resolved.modelRef}" refuses ${refused.control}${refused.asked !== undefined ? ` "${refused.asked}"` : ""}: ${refused.why}`,
      ),
    );
  }

  // Target repo/ref for resident environments, resolved BEFORE the model
  // turn: explicit signals in the message, else the repo this thread
  // already established (from history — restart-safe, never stored). The
  // gate belongs with the machine class: a run whose class carries no
  // checkout (`none`, the general default) never resolves or gates a repo, so
  // a workspace-less follow-up in a repo-mentioning thread is not wrongly
  // refused and a PR-URL never triggers a wasted GitHub REST call for it.
  // The production resolver vets bare `owner/name` tokens against the vet
  // the machine class names (`repoVetFor`) so prose shaped like a slug can
  // never bind a repo; an injected resolver (tests) is called as before.
  // STARTED here (a promise) so the GitHub round trip overlaps the memory
  // read below; awaited after the ack.
  const needsRepo = machineNeedsRepo(profile.machine);
  const repoCtxP: Promise<RepoContext> = root.span("dispatch.repo_context", () =>
    resume
      ? Promise.resolve(resume.repoCtx)
      : needsRepo
        ? Promise.resolve(
            deps.resolveRepoContext
              ? deps.resolveRepoContext(msg, history, ctx.records)
              : resolveRepoContext(
                  msg,
                  history,
                  ...repoVetFor(profile, deps.config.config.execution?.resident),
                  ctx.records,
                ),
          ).then((ctx) => ctx ?? {})
        : Promise.resolve({}),
  );
  repoCtxP.catch(() => {});
  return { needsRepo, repoCtxP, modelCard, decisions };
}

/**
 * The vet a bare `owner/name` gets, by machine class (docs/reference/specs/execution.md
 * item 18). `repo-resident` asks the resident registry: the onboarded probe,
 * and the listing that resolves a bare `in <name>`. `repo-cold` asks GitHub
 * with the run's own credential — the profile's identity; `none` vets
 * anonymously — and never the registry, so a registry outage can neither
 * refuse nor delay it; bare names cannot be resolved without the listing and
 * stay prose.
 */
function repoVetFor(
  profile: RunProfile,
  resident: ResidentExecutionConfig | undefined,
): [probe: RepoProbe | undefined, slugs: ResidentSlugs | undefined] {
  if (profile.machine === "repo-cold")
    return [githubRepoProbe({ scope: githubTokenScopeFor(profile.identity) }), undefined];
  return [residentOnboardedProbe(resident), residentSlugsLister(resident)];
}
