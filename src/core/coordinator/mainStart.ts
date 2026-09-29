import { createHash } from "node:crypto";
import { selfIdsOf } from "../authz/authorize.js";
import type { Actor } from "../authz/types.js";
import { shipPreflight, type ShipPreflightInput } from "../ship/preflight.js";
import type { ShipCaps } from "../ship/coordinator.js";
import type { IncomingMessage } from "../types.js";
import { handOffToCoordinator, type HandOffDeps } from "./handOff.js";
import { isMainTaskKey, isWorkBrief, type WorkBrief } from "./contract.js";

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
  stillLive?: () => boolean;
  /** Freshly proves the original Slack DM is still a one-person internal audience. */
  stillPrivate: () => Promise<boolean>;
  repo: string;
  brief: Omit<WorkBrief, "requesterId" | "mainThreadKey" | "actId" | "repo" | "base">;
}

export type MainStartResult =
  { kind: "accepted"; actId: string; instanceId: string; reply: string } | { kind: "refused"; reply: string };

const refuse = (reply: string): MainStartResult => ({ kind: "refused", reply });

export function createMainTaskStarter(deps: MainStartDeps) {
  return async (input: MainStartInput): Promise<MainStartResult> => {
    const { actor, msg, brief } = input;
    // A message id survives process restarts. One user request owns one act,
    // even if the model repeats this tool call with different wording.
    if (
      actor.viewingAs ||
      (actor.kind !== "user" && actor.kind !== "agent") ||
      actor.origin?.channelId !== msg.channelId ||
      actor.origin.threadKey !== msg.threadKey ||
      !selfIdsOf(actor).includes(msg.userId) ||
      !msg.messageId ||
      !deps.privateWorkerAvailable
    )
      return refuse("I can't start private work from this conversation right now.");
    if (typeof brief?.requestedChange !== "string" || brief.requestedChange.trim().length === 0)
      return refuse("I need a clear change to make before starting the fix.");
    const actId = `m_${createHash("sha256").update(`${msg.threadKey}\n${msg.messageId}`).digest("hex").slice(0, 32)}`;
    const mainTaskKey = { mainThreadKey: msg.threadKey, actId };
    if (!isMainTaskKey(mainTaskKey)) return refuse("I can't identify this conversation's work safely.");
    const repo = input.repo.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !deps.canUseRepo(actor, repo))
      return refuse("I can't start work in that repository with your access.");
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
    if (input.stillLive?.() === false) return refuse("The main run stopped, so no work started.");
    try {
      if (!(await input.stillPrivate())) return refuse("This is no longer a private conversation; no work started.");
    } catch {
      return refuse("I couldn't verify this private conversation; no work started.");
    }
    if (!pre.entry.base) return refuse("I can't verify the repository's base branch, so no worker started.");
    if (
      !isWorkBrief({
        ...brief,
        requesterId: msg.userId,
        mainThreadKey: msg.threadKey,
        actId,
        repo,
        base: pre.entry.base,
      })
    )
      return refuse("I need a shorter, clear task and source evidence before starting the fix.");
    try {
      const out = await handOffToCoordinator(deps, {
        entry: pre.entry,
        requestText: brief.requestedChange,
        mainTask: { ...mainTaskKey, brief },
        privateWorkerReady: deps.privateWorkerAvailable,
        msg,
        runId: input.mainRunId,
        label: `main agent · ${repo}`,
        caps: deps.caps,
        now: deps.clock(),
        ...(input.stillLive ? { stillLive: input.stillLive } : {}),
        stillPrivate: input.stillPrivate,
      });
      return out.status === "completed" && out.instanceId
        ? { kind: "accepted", actId, instanceId: out.instanceId, reply: out.reply }
        : refuse(out.reply);
    } catch {
      return refuse("I couldn't confirm whether the worker started. I kept its task identity for a safe retry.");
    }
  };
}
