import { createHash } from "node:crypto";
import type { Actor, ChannelVisibility } from "../core/authz/types.js";
import { MAIN_TASK_ACT_ID_PATTERN, type WorkflowSender } from "../core/coordinator/contract.js";
import { createMainTaskActions } from "../core/coordinator/mainActions.js";
import type { CoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import type { PlaneService } from "../core/planeService.js";
import type { IncomingMessage } from "../core/types.js";
import type { RunnableTool } from "./runnableTool.js";

type Actions = ReturnType<typeof createMainTaskActions>;

/** Slack's fresh channel lookup, stamped by the adapter on one unshared IM. */
export interface DirectAudience {
  kind: "slack-unshared-im";
  channelId: string;
  userId: string;
  threadKey: string;
}

export interface MainWorkAudience {
  agentName: string;
  actor: Actor;
  message: Pick<IncomingMessage, "channelId" | "threadKey" | "userId" | "postedBy" | "authenticatedAs"> & {
    directAudience?: DirectAudience;
  };
  channelVisibility: ChannelVisibility;
}

/** Tool calls and results enter the run log. Only a verified, unshared Slack
 * IM with this requester can expose linked-work tools. */
export function mainWorkAudienceAllowed({ agentName, actor, message, channelVisibility }: MainWorkAudience): boolean {
  const audience = message.directAudience;
  return (
    agentName === "orchestrator" &&
    channelVisibility === "dm" &&
    /^slack:D[A-Z0-9]+$/.test(message.channelId) &&
    /^slack:[UW][A-Z0-9]+$/.test(message.userId) &&
    message.threadKey.startsWith(`${message.channelId}:`) &&
    audience?.kind === "slack-unshared-im" &&
    audience.channelId === message.channelId &&
    audience.userId === message.userId &&
    audience.threadKey === message.threadKey &&
    message.postedBy === undefined &&
    message.authenticatedAs === undefined &&
    actor.kind === "user" &&
    actor.id === message.userId &&
    actor.onBehalfOf === undefined &&
    actor.viewingAs === undefined &&
    actor.origin?.channelId === message.channelId &&
    actor.origin.threadKey === message.threadKey
  );
}

/** The run has already fixed the requester, current thread and run id. Model
 * input supplies only an act address and the words to add. */
export interface MainWorkCapability {
  status(actId: string): ReturnType<Actions["status"]>;
  steer(actId: string, words: string, toolCallId: string): ReturnType<Actions["steer"]>;
  stop(actId: string): ReturnType<Actions["stop"]>;
}

export interface MainWorkEffectGate {
  run<T>(effect: () => Promise<T>): Promise<T | undefined>;
  revoke(): Promise<void>;
}

/** A follow-up closes admission immediately, then waits for the already
 * admitted effect before changing the run's authority. */
export function createMainWorkEffectGate(): MainWorkEffectGate {
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  return {
    async run(effect) {
      if (closed) return undefined;
      let done!: () => void;
      const current = new Promise<void>((resolve) => (done = resolve));
      const previous = tail;
      tail = previous.then(() => current);
      await previous;
      if (closed) {
        done();
        return undefined;
      }
      try {
        return await effect();
      } finally {
        done();
      }
    },
    async revoke() {
      closed = true;
      await tail;
    },
  };
}

export function mainWorkForRun(
  deps: MainWorkAudience & {
    runId: string;
    instances?: CoordinatorInstanceStore;
    workflow?: WorkflowSender;
    plane?: () => Promise<Pick<PlaneService, "stop">>;
    clock: () => number;
    effectGate: MainWorkEffectGate;
    trusted?: () => boolean;
    verifiedAtOpen?: boolean;
    verify?: (audience: DirectAudience) => Promise<boolean>;
  },
): MainWorkCapability | undefined {
  if (
    !mainWorkAudienceAllowed(deps) ||
    !deps.instances ||
    !deps.plane ||
    !deps.trusted ||
    !deps.verifiedAtOpen ||
    !deps.verify ||
    !deps.message.directAudience
  )
    return undefined;
  const trusted = deps.trusted;
  const verify = deps.verify;
  const audience = deps.message.directAudience;
  const canAct = async () => {
    if (!trusted()) return false;
    try {
      return (await verify(audience)) && trusted();
    } catch {
      return false;
    }
  };
  const actions = createMainTaskActions({
    instances: deps.instances,
    ...(deps.workflow ? { workflow: deps.workflow } : {}),
    plane: {
      stop: async (id, actor, visibleTo, binding) => {
        const plane = await deps.plane!();
        if (!(await canAct()) || !trusted())
          return { kind: "unavailable" as const, reason: "direct audience changed before stop" };
        return plane.stop(id, actor, visibleTo, binding);
      },
    },
    clock: deps.clock,
    liveAuthority: { verify: canAct, active: trusted },
  });
  return {
    status: async (actId) => {
      if (!(await canAct())) return { kind: "unavailable" as const };
      const result = await actions.status(deps.actor, actId);
      return (await canAct()) ? result : { kind: "unavailable" as const };
    },
    steer: async (actId, words, toolCallId) => {
      if (!(await canAct())) return { kind: "unavailable" as const };
      // A provider call id may repeat in another run. Both durable identities
      // enter the hash so one call replays once and a later call stays distinct.
      const eventId = createHash("sha256").update(deps.runId).update("\0").update(toolCallId).digest("hex");
      return (
        (await deps.effectGate.run(() => actions.steer(deps.actor, { actId, words, eventId }))) ?? {
          kind: "unavailable" as const,
        }
      );
    },
    stop: async (actId) => {
      if (!(await canAct())) return { kind: "unavailable" as const };
      return (await deps.effectGate.run(() => actions.stop(deps.actor, actId))) ?? { kind: "unavailable" as const };
    },
  };
}

const UNAVAILABLE = "error: Saved work is unavailable in this deployment. Try again shortly; nothing changed.";
const NOT_FOUND = "error: I couldn't find that work in this conversation. Check the original thread; nothing changed.";
const FORBIDDEN = "error: This requester cannot access or change that work. Nothing changed.";

function actIdOf(input: Record<string, unknown>): string | undefined {
  return typeof input.actId === "string" && MAIN_TASK_ACT_ID_PATTERN.test(input.actId) ? input.actId : undefined;
}

export const workStatusTool: RunnableTool = {
  name: "work_status",
  description:
    "Check the current status of work this main conversation started. Use the actId from its handoff; never invent one.",
  inputSchema: {
    type: "object",
    properties: {
      actId: { type: "string", description: "The stable act id returned when this conversation started the work" },
    },
    required: ["actId"],
    additionalProperties: false,
  },
  sideEffectFree: true,
  failsInText: true,
  async run(input, ctx) {
    if (!ctx.mainWork) return UNAVAILABLE;
    const actId = actIdOf(input);
    if (!actId) return "error: I need the work id from the earlier handoff to check its status.";
    const result = await ctx.mainWork.status(actId);
    switch (result.kind) {
      case "found":
        return JSON.stringify(result.unit);
      case "not_found":
        return NOT_FOUND;
      case "forbidden":
        return FORBIDDEN;
      case "unavailable":
        return UNAVAILABLE;
    }
  },
};

export const workSteerTool: RunnableTool = {
  name: "work_steer",
  description:
    "Add the person's plain-language update to work started in this main conversation. It is queued for the same Ship unit; the current coding child may read it only at a later step.",
  inputSchema: {
    type: "object",
    properties: {
      actId: { type: "string", description: "The stable act id returned when this conversation started the work" },
      words: { type: "string", description: "The person's update, clarification or added scope" },
    },
    required: ["actId", "words"],
    additionalProperties: false,
  },
  failsInText: true,
  async run(input, ctx) {
    if (!ctx.mainWork) return UNAVAILABLE;
    const actId = actIdOf(input);
    if (!actId) return "error: I need the work id from the earlier handoff before adding an update.";
    if (typeof input.words !== "string" || input.words.trim().length === 0 || input.words.length > 12_000)
      return "error: The update needs 1 to 12,000 characters. Shorten it and try again.";
    if (!ctx.callId) return "error: I couldn't safely identify this update. Please try again; nothing changed.";
    const result = await ctx.mainWork.steer(actId, input.words, ctx.callId);
    switch (result.kind) {
      case "queued":
        return result.nudge === "sent"
          ? "Update queued for the same work. The coordinator was notified and will read it at its next step."
          : "error: Update queued, but the coordinator could not be notified yet. Check its status before assuming it read the update.";
      case "not_found":
        return NOT_FOUND;
      case "forbidden":
        return FORBIDDEN;
      case "unavailable":
        return UNAVAILABLE;
      case "invalid":
        return "error: The update was invalid and was not queued. Shorten it and try again.";
      case "conflict":
        return "error: This call already saved different words. Make a new call to add another update.";
      case "ended":
        return "error: This work has ended or is held for recovery. No update was queued; check its status first.";
    }
  },
};

export const workStopTool: RunnableTool = {
  name: "work_stop",
  description:
    "Stop the requester's own linked Ship work in this main conversation, including its active children. Use only when the person asks to stop it.",
  inputSchema: {
    type: "object",
    properties: {
      actId: { type: "string", description: "The stable act id returned when this conversation started the work" },
    },
    required: ["actId"],
    additionalProperties: false,
  },
  failsInText: true,
  async run(input, ctx) {
    if (!ctx.mainWork) return UNAVAILABLE;
    const actId = actIdOf(input);
    if (!actId) return "error: I need the work id from the earlier handoff before stopping it.";
    const result = await ctx.mainWork.stop(actId);
    switch (result.kind) {
      case "stopped":
        return `Stop mark saved for this work. ${result.childOutcomes.length} child stop result(s) returned; check status for their final state.`;
      case "partial":
        return result.runnerStopped
          ? "error: Stop incomplete. The stop mark saved, but a worker did not confirm it stopped. Check status before assuming this work stopped."
          : "error: Stop incomplete. The runner's stop mark did not save, so it may continue. Check status before assuming this work stopped.";
      case "not_found":
        return NOT_FOUND;
      case "forbidden":
        return FORBIDDEN;
      case "unavailable":
        return UNAVAILABLE;
    }
  },
};

export const MAIN_WORK_TOOLS: readonly RunnableTool[] = [workStatusTool, workSteerTool, workStopTool];
