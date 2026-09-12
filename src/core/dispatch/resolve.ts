// The resolve stage of the dispatch pipeline (docs/decisions/0024-dispatcher-as-a-staged-pipeline.md):
// what this request is. The directives and the thread's history; the (agent,
// model, effort) triple through the layered configuration with thread
// stickiness; the provider behind the model ref; and the target repository,
// ref and pull request, started as a promise so the GitHub round trip overlaps
// the memory read and lands after the ack card. Pure resolution — the gates
// that judge the result are authorize.ts.
import type { ConfigStore, ResolvedRequest } from "../../config.js";
import { machineNeedsRepo, type AgentDef } from "../../agents/registry.js";
import { effectiveProfile, type ProfileResolution, type RunProfile } from "../../config/profile.js";
import {
  lastThreadDirectives,
  parseDirectives,
  type RequestDirectives,
  type ThreadDirectives,
} from "../../directives.js";
import { parseModelRef, type Provider } from "../../providers/types.js";
import type { ProviderRegistry } from "../../providers/registry.js";
import {
  githubTokenScopeFor,
  residentOnboardedProbe,
  residentSlugsLister,
  type ResidentExecutionConfig,
} from "../../execution/factory.js";
import { githubRepoProbe } from "../../execution/githubRepoProbe.js";
import { resolveRepoContext, type RepoContext, type RepoProbe, type ResidentSlugs } from "../repoContext.js";
import type { Span } from "../trace/types.js";
import type { ChannelIO, HistoryItem, IncomingMessage } from "../types.js";
import type { ResumeContext } from "./admission.js";

/** What the resolve stage reads off the dispatcher's dependencies. `CoreDeps`
 *  extends this; a caller's shape is unchanged. */
export interface ResolveDeps {
  config: ConfigStore;
  providers: ProviderRegistry;
  /**
   * Resolves the target repo/ref for a message (resident environments).
   * Defaults to the production resolver in repoContext.ts (explicit repo/PR/
   * branch signals in the message, then the thread-established repo from
   * history); injectable for tests. No repo signal → {} → the per-thread
   * executor path with no resident probe (total input contract).
   */
  resolveRepoContext?: (msg: IncomingMessage, history: HistoryItem[]) => Promise<RepoContext> | RepoContext;
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

/** The run this request resolves to: the thread's sticky directives and the
 *  (agent, model, effort) triple the config layers settled on. */
export interface ResolvedRun {
  sticky: ThreadDirectives;
  resolved: ResolvedRequest;
}

/**
 * The (agent, model, effort) triple for this request through the config layers
 * (docs/reference/specs/routing-and-config.md item 2): a request directive, else
 * the thread's sticky one, else the user, channel and default scopes.
 */
export function resolveRun(
  deps: ResolveDeps,
  ctx: { msg: IncomingMessage; directives: RequestDirectives; history: HistoryItem[] },
): ResolvedRun {
  const { msg, directives, history } = ctx;
  // Thread stickiness: a follow-up without explicit directives runs on the
  // agent/model this thread already established (last directive in the
  // thread's history), not the channel/global default — otherwise "continue"
  // in an agent:coding thread silently lands on the toolless default agent.
  // Derived from history on every message, never stored: restart-safe, and
  // consistent with how the Slack adapter re-derives thread participation.
  const sticky = lastThreadDirectives(history);
  const resolved = deps.config.resolve({
    channelId: msg.channelId,
    userId: msg.userId,
    request: {
      agent: directives.agent ?? sticky.agent,
      model: directives.model ?? sticky.model,
      effort: directives.effort ?? sticky.effort,
    },
  });
  return { sticky, resolved };
}

/**
 * The effective profile of this request (docs/reference/specs/routing-and-config.md
 * item 2; docs/decisions/0026-capability-profiles-and-request-routing.md):
 * preset ∩ boundary, computed once, here, once the preset is known — the
 * lookup stays after the agent gate, so a caller who may not run the agent is
 * refused before its preset is even read. Pure resolution: the profile gate
 * (`authorizeProfile`) judges the outcome. A resume keeps the profile its row
 * was admitted with — the clipped budget and what clipped it — rather than
 * re-reading the preset; the boundaries on the path today are still asked,
 * so an identity or class a tightened cap no longer allows refuses the resume
 * by name like a fresh request, while its budget is the row's. A row written
 * before profiles existed resolves like a fresh request.
 */
export function resolveProfile(ctx: {
  agent: AgentDef;
  resolved: ResolvedRequest;
  resume: ResumeContext | undefined;
}): ProfileResolution {
  const carried = ctx.resume?.row.meta.profile;
  const declared = carried
    ? { machine: carried.machine, identity: carried.identity, maxMinutes: carried.minutes }
    : ctx.agent;
  // Boundaries only ever narrow: a directive budget is the next unit's (none
  // is parsed yet), so the caller's own boundary is empty here.
  const resolution = effectiveProfile(declared, {}, ctx.resolved.boundary);
  if (resolution.kind === "profile" && carried?.boundedBy && !resolution.profile.boundedBy) {
    return { kind: "profile", profile: { ...resolution.profile, boundedBy: carried.boundedBy } };
  }
  return resolution;
}

/** The provider and model behind the resolved ref, whether the run's machine
 *  class carries a repository, and the target's resolution in flight. */
export interface ResolvedTarget {
  provider: Provider;
  model: string;
  needsRepo: boolean;
  repoCtxP: Promise<RepoContext>;
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
}

/**
 * The provider behind the model ref (an unknown provider throws here, before
 * any card), and the target repo/ref/PR resolution, STARTED — a promise the
 * caller awaits after the ack card, so the GitHub round trip overlaps the
 * memory read. A resume carries its repo context; a run whose machine class
 * carries no repository resolves none.
 */
export function resolveTarget(deps: ResolveDeps, ctx: ResolveTargetContext): ResolvedTarget {
  const { msg, history, profile, resolved, resume, root } = ctx;
  const { provider: providerName, model } = parseModelRef(resolved.modelRef);
  const provider = deps.providers.get(providerName);

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
              ? deps.resolveRepoContext(msg, history)
              : resolveRepoContext(msg, history, ...repoVetFor(profile, deps.config.config.execution?.resident)),
          ).then((ctx) => ctx ?? {})
        : Promise.resolve({}),
  );
  repoCtxP.catch(() => {});
  return { provider, model, needsRepo, repoCtxP };
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
