import { createHash } from "node:crypto";
import { selfIdsOf } from "../authz/authorize.js";
import type { Actor } from "../authz/types.js";
import { shipPreflight, type ShipPreflightInput } from "../ship/preflight.js";
import type { ShipCaps } from "../ship/coordinator.js";
import type { IncomingMessage } from "../types.js";
import { handOffToCoordinator, type HandOffDeps } from "./handOff.js";
import { isMainTaskKey, type StoredWorkBriefDraft, type WorkBriefIssue } from "./contract.js";
import { isMainTaskAuthority, type MainTaskAuthority } from "./requesterAuthority.js";

/** Trusted dispatch context supplies the actor, message, gates and runner seams.
 * The model supplies only a repository and bounded evidence for one change. */
export interface MainStartDeps extends HandOffDeps {
  repoInfo: ShipPreflightInput["repoInfo"];
  canUseRepo: (actor: Actor, repo: string) => boolean;
  canRunAgent: (actor: Actor, name: string) => boolean;
  adminsHint: () => string;
  /** True only when private worker IO is configured for this channel. */
  privateWorkerAvailable: boolean;
  caps: ShipCaps;
  clock: () => number;
}

export interface MainStartInput {
  actor: Actor;
  msg: IncomingMessage;
  mainRunId: string;
  /** A trusted run fence checked again after async preflight and before start. */
  stillLive: () => boolean;
  /** Freshly proves the original Slack DM is still a one-person internal audience. */
  stillPrivate: () => Promise<boolean>;
  repo: string;
  /** Resolved from the person's delivered request, never from tool input. */
  authorizedRepo: string;
  /** Private durable requester revision, never supplied by the model. */
  authority?: MainTaskAuthority;
  brief: StoredWorkBriefDraft;
}

export type MainStartResult =
  | { kind: "accepted"; actId: string; instanceId: string; reply: string }
  | { kind: "refused"; reply: string; issues?: WorkBriefIssue[] };

const refuse = (reply: string): MainStartResult => ({ kind: "refused", reply });

export function createMainTaskStarter(deps: MainStartDeps) {
  return async (input: MainStartInput): Promise<MainStartResult> => {
    const { actor, msg, brief } = input;
    const stillLive = () => {
      if (typeof input.stillLive !== "function") return false;
      try {
        return input.stillLive() === true;
      } catch {
        return false;
      }
    };
    // A message id survives process restarts. One user request owns one act,
    // even if the model repeats this tool call with different wording.
    if (
      msg.directAudience?.kind !== "slack-unshared-im" ||
      msg.directAudience.channelId !== msg.channelId ||
      msg.directAudience.userId !== msg.userId ||
      msg.directAudience.threadKey !== msg.threadKey ||
      actor.viewingAs ||
      (actor.kind !== "user" && actor.kind !== "agent") ||
      actor.origin?.channelId !== msg.channelId ||
      actor.origin.threadKey !== msg.threadKey ||
      !selfIdsOf(actor).includes(msg.userId) ||
      !msg.messageId ||
      !isMainTaskAuthority(input.authority) ||
      input.authority.requesterId !== msg.userId ||
      input.authority.sourceMessageId !== msg.messageId ||
      !deps.privateWorkerAvailable ||
      !deps.privateWorkerLog
    )
      return refuse("I can't start private work from this conversation right now.");
    if (!stillLive())
      return refuse("I couldn't confirm this main run is active, so no work started. Ask me again here.");
    if (typeof brief?.requestedChange !== "string" || brief.requestedChange.trim().length === 0)
      return {
        kind: "refused",
        reply: "The requested change is missing; no worker started.",
        issues: [{ code: "change_required", path: "requestedChange" }],
      };
    const actId = `m_${createHash("sha256").update(`${msg.threadKey}\n${msg.messageId}`).digest("hex").slice(0, 32)}`;
    const mainTaskKey = { mainThreadKey: msg.threadKey, actId };
    if (!isMainTaskKey(mainTaskKey)) return refuse("I can't identify this conversation's work safely.");
    const repo = input.repo.trim();
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ||
      typeof input.authorizedRepo !== "string" ||
      repo.toLowerCase() !== input.authorizedRepo.toLowerCase() ||
      repo.toLowerCase() !== input.authority.repo.toLowerCase()
    )
      return refuse("I need you to name the repository for this change before starting work.");
    if (!deps.canUseRepo(actor, repo)) return refuse("I can't start work in that repository with your access.");
    const pre = await shipPreflight({
      channelId: msg.channelId,
      threadKey: msg.threadKey,
      canOpenThread: deps.privateWorkerAvailable,
      requestText: brief.requestedChange,
      // The main tool always creates a fresh unit. Links in its evidence do
      // not bind a PR or branch as a publication target.
      repoCtx: { repo },
      gates: { canRunAgent: (name) => deps.canRunAgent(actor, name), adminsHint: deps.adminsHint },
      repoInfo: deps.repoInfo,
      prFacts: async () => undefined,
    });
    if (!pre.ok) return refuse(pre.reply);
    if (!stillLive()) return refuse("The main run stopped, so no work started.");
    try {
      if (!(await input.stillPrivate())) return refuse("This is no longer a private conversation; no work started.");
    } catch {
      return refuse("I couldn't verify this private conversation; no work started.");
    }
    if (!pre.entry.base) return refuse("I can't verify the repository's base branch, so no worker started.");
    try {
      const out = await handOffToCoordinator(deps, {
        entry: pre.entry,
        requestText: brief.requestedChange,
        mainTask: { ...mainTaskKey, brief, authority: input.authority },
        privateWorkerReady: deps.privateWorkerAvailable,
        msg,
        runId: input.mainRunId,
        label: `main agent · ${repo}`,
        caps: deps.caps,
        now: deps.clock(),
        stillLive,
        stillPrivate: input.stillPrivate,
      });
      return out.status === "completed" && out.instanceId
        ? { kind: "accepted", actId, instanceId: out.instanceId, reply: out.reply }
        : { ...refuse(out.reply), ...(out.issues ? { issues: out.issues } : {}) };
    } catch {
      return refuse("I couldn't confirm whether the worker started. I kept its task identity for a safe retry.");
    }
  };
}
