import type { Actor, ChannelVisibility } from "../core/authz/types.js";
import type { WorkBrief } from "../core/coordinator/contract.js";
import type { MainStartInput, MainStartResult } from "../core/coordinator/mainStart.js";
import type { MainTaskAuthority } from "../core/coordinator/requesterAuthority.js";
import type { IncomingMessage, SlackDirectAudience } from "../core/types.js";
import type { RunnableTool } from "./runnableTool.js";

type Brief = MainStartInput["brief"];

/** The requester and source message come from dispatch, never tool input. */
export interface MainStartCapability {
  start(repo: string, brief: Brief, sourceMessage: string): Promise<MainStartResult>;
}

/** The private worker's progress and completion path is proved only for a
 * direct requester in a Slack DM. Keep seed and live model tool lists equal. */
export function canOfferMainStart(
  agentName: string,
  visibility: ChannelVisibility,
  msg: IncomingMessage,
  actor: Actor,
  hasStarter: boolean,
): boolean {
  return (
    agentName === "orchestrator" &&
    visibility === "dm" &&
    hasStarter &&
    /^slack:D[A-Za-z0-9]+$/.test(msg.channelId) &&
    msg.threadKey.startsWith(`${msg.channelId}:`) &&
    /^slack:[UW][A-Za-z0-9]+$/.test(msg.userId) &&
    msg.directAudience?.kind === "slack-unshared-im" &&
    msg.directAudience.channelId === msg.channelId &&
    msg.directAudience.userId === msg.userId &&
    msg.directAudience.threadKey === msg.threadKey &&
    msg.postedBy === undefined &&
    msg.authenticatedAs === undefined &&
    actor.kind === "user" &&
    actor.id === msg.userId &&
    actor.origin?.channelId === msg.channelId &&
    actor.origin.threadKey === msg.threadKey
  );
}

export function mainStartForRun(deps: {
  agentName: string;
  channelVisibility: ChannelVisibility;
  initial: { actor: Actor; msg: IncomingMessage };
  source: (
    sourceMessage: string,
    repo: string,
  ) =>
    | Promise<{ actor: Actor; msg: IncomingMessage; authorizedRepo: string; authority?: MainTaskAuthority } | undefined>
    | { actor: Actor; msg: IncomingMessage; authorizedRepo: string; authority?: MainTaskAuthority }
    | undefined;
  live: () => boolean;
  runId: string;
  verifyDirectAudience?: (audience: SlackDirectAudience) => Promise<boolean>;
  start?: (input: MainStartInput) => Promise<MainStartResult>;
}): MainStartCapability | undefined {
  // The model's tool call and evidence are logged in the conversation. Only a
  // verified direct Slack DM may carry private work through this tool.
  const verifyDirectAudience = deps.verifyDirectAudience;
  if (
    !verifyDirectAudience ||
    !canOfferMainStart(deps.agentName, deps.channelVisibility, deps.initial.msg, deps.initial.actor, !!deps.start)
  )
    return undefined;
  return {
    start: async (repo, brief, sourceMessage) => {
      if (!deps.live()) return Promise.resolve({ kind: "refused", reply: "The main run stopped, so no work started." });
      const source = await deps.source(sourceMessage, repo);
      if (source && !canOfferMainStart(deps.agentName, deps.channelVisibility, source.msg, source.actor, !!deps.start))
        return Promise.resolve({ kind: "refused", reply: "I can't start from that sender; nothing started." });
      if (!source)
        return {
          kind: "refused",
          reply:
            "I couldn't bind this start to your latest private message and the pilot repository. Nothing started. I'll ask once if the request or target is unclear.",
        };
      let privateNow = false;
      try {
        privateNow = await verifyDirectAudience(source.msg.directAudience!);
      } catch {
        // A failed Slack read is no proof that the destination stayed private.
      }
      if (!privateNow) return { kind: "refused", reply: "This is no longer a private conversation; nothing started." };
      if (!deps.live()) return { kind: "refused", reply: "The main run stopped, so no work started." };
      return deps.start!({
        actor: source.actor,
        msg: source.msg,
        mainRunId: deps.runId,
        repo,
        authorizedRepo: source.authorizedRepo,
        authority: source.authority,
        brief,
        stillLive: deps.live,
        stillPrivate: async () => {
          try {
            return await verifyDirectAudience(source.msg.directAudience!);
          } catch {
            return false;
          }
        },
      });
    },
  };
}

const text = (v: unknown, cap: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= cap;

function briefOf(input: Record<string, unknown>): Brief | undefined {
  if (!text(input.question, 1000) || !text(input.requestedChange, 1000)) return undefined;
  if (!Array.isArray(input.findings) || input.findings.length > 6) return undefined;
  const findings: WorkBrief["findings"] = [];
  for (const value of input.findings) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const f = value as Record<string, unknown>;
    if (!text(f.text, 1000)) return undefined;
    const analytic = f.query !== undefined || f.result !== undefined || f.timeWindow !== undefined;
    if (analytic && (!text(f.query, 3000) || !text(f.result, 1000) || !text(f.timeWindow, 256))) return undefined;
    if (!text(f.sourceUrl, 2048) || !f.sourceUrl.startsWith("https://")) return undefined;
    findings.push(
      analytic
        ? {
            kind: "analysis",
            text: f.text,
            query: f.query as string,
            result: f.result as string,
            timeWindow: f.timeWindow as string,
            sourceUrl: f.sourceUrl,
          }
        : { kind: "observation", text: f.text, sourceUrl: f.sourceUrl },
    );
  }
  if (input.suspectedCause !== undefined && !text(input.suspectedCause, 1000)) return undefined;
  if (input.acceptance !== undefined && !text(input.acceptance, 1000)) return undefined;
  return {
    question: input.question,
    findings,
    requestedChange: input.requestedChange,
    ...(input.suspectedCause !== undefined ? { suspectedCause: input.suspectedCause } : {}),
    ...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}),
  };
}

export const workStartTool: RunnableTool = {
  name: "work_start",
  description:
    "When the latest person turn in a direct Slack DM asks you to fix or build something, start one private coding worker. Interpret the whole turn: later corrections or a request for explanation alone mean do not start work. If intent is unclear, ask once. Carry forward the question and evidence you found; keep the user here and report the work id. Set sourceMessage to a quote from that latest person turn.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Repository owner/name for the requested change" },
      question: { type: "string", description: "The question that led to this change" },
      findings: {
        type: "array",
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            text: { type: "string" },
            query: { type: "string" },
            result: { type: "string" },
            timeWindow: { type: "string" },
            sourceUrl: { type: "string" },
          },
          required: ["text", "sourceUrl"],
          additionalProperties: false,
        },
      },
      suspectedCause: { type: "string" },
      requestedChange: { type: "string", description: "The plain-language change to make" },
      acceptance: { type: "string", description: "How the person will know the fix worked" },
      sourceMessage: {
        type: "string",
        description:
          "A quote from the latest delivered person turn asking for this change; use a short phrase for long messages",
      },
    },
    required: ["repo", "question", "findings", "requestedChange", "sourceMessage"],
    additionalProperties: false,
  },
  failsInText: true,
  async run(input, ctx) {
    if (ctx.signal?.aborted) return "error: The main run stopped; nothing started.";
    if (!ctx.mainStart) return "error: Private work is unavailable in this deployment; nothing started.";
    if (!text(input.repo, 256) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repo))
      return "error: I need a repository owner/name before starting the fix.";
    const brief = briefOf(input);
    if (!brief) return "error: The question or evidence is too long or incomplete; nothing started.";
    if (!text(input.sourceMessage, 1000)) return "error: I need a quote from the request message; nothing started.";
    const result = await ctx.mainStart.start(input.repo, brief, input.sourceMessage);
    return result.kind === "accepted"
      ? `Started one private worker. Work id: ${result.actId}. The main conversation stays here while it works.`
      : `error: ${result.reply}`;
  },
};
