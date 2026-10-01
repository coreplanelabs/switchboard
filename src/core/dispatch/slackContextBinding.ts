import {
  addSourceReceipt,
  isSessionSources,
  sameSourceBinding,
  sourceBinding,
  type SessionSources,
  type SlackSourceReceipt,
} from "../references/receipts.js";
import type { Actor, ChannelVisibility } from "../authz/types.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import type { SlackContextCapability, VerifiedSlackContextCapability } from "../../tools/slackContext.js";
import type { RunnableTool } from "../../tools/runnableTool.js";
import { TOOLSETS } from "../../tools/toolsets.js";
import {
  privateAudienceRequired,
  privateAudienceStillValid,
  revalidateSourcesWithinBudget,
} from "./privateAudience.js";

export interface SlackContextBinding {
  capability: SlackContextCapability;
  initialize(sources: SessionSources, persist: (sources: SessionSources) => Promise<boolean>): Promise<boolean>;
  revalidate(receipt: SlackSourceReceipt): Promise<boolean>;
  sourcesStillValid(): Promise<boolean>;
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
    let sources: SessionSources = { version: 1, status: "unknown" };
    let persist: ((sources: SessionSources) => Promise<boolean>) | undefined;
    let writes = Promise.resolve(true);
    const save = (next: SessionSources): Promise<boolean> => {
      sources = next;
      writes = writes.then(async (ok) => ok && !!persist && (await persist(next))).catch(() => false);
      return writes;
    };
    const revalidate = async (receipt: SlackSourceReceipt) =>
      !revoked &&
      sameSourceBinding(receipt, sourceBinding(msg)) &&
      (await destinationStillPrivate()) &&
      (await source.revalidateSource(receipt)) &&
      (await destinationStillPrivate());
    return {
      async initialize(initial, write) {
        if (
          persist ||
          !isSessionSources(initial) ||
          initial.status !== "known" ||
          !sameSourceBinding(initial.binding, sourceBinding(msg))
        )
          return false;
        persist = write;
        return save(initial);
      },
      revalidate,
      async sourcesStillValid() {
        if (sources.status !== "known" || revoked || !(await writes)) return false;
        if (!(await revalidateSourcesWithinBudget(sources.receipts, revalidate))) {
          revoked = true;
          await save({ version: 1, status: "revoked" });
          return false;
        }
        return destinationStillPrivate();
      },
      capability: {
        read: async (request) => {
          if (!(await destinationStillPrivate()))
            return "slack_context: this private conversation is no longer available.";
          if (!persist || sources.status !== "known") return "slack_context: source receipts are unavailable.";
          const result = await source.readSource(request);
          if (!(await destinationStillPrivate()))
            return "slack_context: this private conversation is no longer available.";
          if (result.kind === "refused") return result.content;
          const next = addSourceReceipt(sources, result.receipt);
          if (!isSessionSources(next) || next.status !== "known" || !(await save(next))) {
            revoked = true;
            await save({ version: 1, status: "revoked" });
            return "slack_context: the source receipt could not be saved. Start a new DM message with the source.";
          }
          return (await destinationStillPrivate())
            ? result.content
            : "slack_context: this private conversation is no longer available.";
        },
      },
      destinationStillPrivate,
      revoke: () => {
        revoked = true;
        void save({ version: 1, status: "revoked" });
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
