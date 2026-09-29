import type { Actor, ChannelVisibility } from "../authz/types.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import type { SlackContextCapability, VerifiedSlackContextCapability } from "../../tools/slackContext.js";
import type { RunnableTool } from "../../tools/runnableTool.js";
import { TOOLSETS } from "../../tools/toolsets.js";
import { privateAudienceRequired, privateAudienceStillValid } from "./privateAudience.js";

export interface SlackContextBinding {
  capability: SlackContextCapability;
  /** Re-read the adapter's reply address before recording or sending model output. */
  destinationStillPrivate(): Promise<boolean>;
  /** An indirect follow-up permanently ends this run's private read authority. */
  revoke(): void;
}

/** An opt-in read exists only on the requester's own Slack DM, under the main agent. */
export async function bindSlackContext(input: {
  agentName: string;
  actor: Actor;
  msg: IncomingMessage;
  io: ChannelIO;
  visibility: ChannelVisibility;
  /** Recovery may have lost an earlier indirect-source revocation. */
  recovered?: boolean;
  create?: (actor: Actor, msg: IncomingMessage) => VerifiedSlackContextCapability;
}): Promise<SlackContextBinding | undefined> {
  const { agentName, actor, msg, io, visibility, recovered, create } = input;
  let revoked = false;
  const destinationStillPrivate = async () => !revoked && (await privateAudienceStillValid(msg, io)) && !revoked;
  if (
    !create ||
    recovered === true ||
    agentName !== "orchestrator" ||
    visibility !== "dm" ||
    !/^slack:D[A-Z0-9_]+$/.test(msg.channelId) ||
    !msg.threadKey.startsWith(`${msg.channelId}:`) ||
    actor.kind !== "user" ||
    actor.id !== msg.userId ||
    msg.relayedBy !== undefined ||
    !privateAudienceRequired(msg) ||
    !(await destinationStillPrivate())
  )
    return undefined;
  try {
    const source = create(actor, msg);
    if (!(await source.verifyDirectOrigin())) return undefined;
    return {
      capability: {
        read: async (request, purpose) => {
          if (!(await destinationStillPrivate()))
            return "slack_context: this private conversation is no longer available.";
          const result = await source.read(request, purpose);
          return (await destinationStillPrivate())
            ? result
            : "slack_context: this private conversation is no longer available.";
        },
      },
      destinationStillPrivate,
      revoke: () => {
        revoked = true;
      },
    };
  } catch {
    return undefined;
  }
}

/** The private tool must be absent from both the claimed tool list and the live loop otherwise. */
export function toolsForSlackContextRun(toolset: string, binding: SlackContextBinding | undefined): RunnableTool[] {
  const tools = TOOLSETS[toolset] ?? [];
  return binding ? tools : tools.filter((tool) => tool.name !== "slack_context");
}
