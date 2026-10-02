import type { AudienceCheck } from "../audienceDecision.js";
import type { ConfigStore } from "../../config.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { chatActorOf } from "../authz/actor.js";
import { visibilityOf } from "../authz/channelDirectory.js";
import { createMainWorkerRelay } from "../coordinator/mainWorkerRelay.js";
import type { CoordinatorInstanceStore } from "../coordinator/instanceStore.js";
import type { PrivateWorkerLog } from "../privateWorkerLog.js";
import { renderWorkProgress, type MainWorkerCapability } from "../../tools/mainWorker.js";
import {
  isMainWorkReadReceipt,
  recordMainWorkRead,
  restoreMainWorkRead,
  type MainWorkReadObserver,
} from "../coordinator/mainWorkObservation.js";
import type { FollowUpInbox } from "../threadAdmission.js";
import type { UnitSeedReader } from "../coordinator/mainActions.js";

/** A main run's actor and origin are resolved once from its admitted request.
 * Neither the model nor a worker supplies them to the private relay. */
type DirectAudience = {
  kind: "slack-unshared-im";
  channelId: string;
  userId: string;
  threadKey: string;
};

// The Slack adapter supplies this attestation at intake and checks it again at
// use time. Keep the bridge structural while its channel seam lands separately.
type DirectAudienceIO = ChannelIO | { verifyDirectAudience?: (audience: DirectAudience) => Promise<AudienceCheck> };

async function verifiedDirectAudience(io: DirectAudienceIO | undefined, audience: DirectAudience): Promise<boolean> {
  if (!io || !("verifyDirectAudience" in io) || !io.verifyDirectAudience) return false;
  try {
    return (await io.verifyDirectAudience(audience)).ok;
  } catch {
    return false;
  }
}

/** The inbox retains only source facts after a drain. On rehost, a second
 * durable input cannot prove the original one-person source, so deny. */
export function privateProgressSourceTrusted(
  requesterId: string,
  inbox: Pick<FollowUpInbox, "hasOnlyDirectRequester">,
  resumedEvents?: readonly { type: string }[],
): () => boolean {
  const resumedInputs = resumedEvents?.filter((event) => event.type === "input").length;
  const resumedSourceUncertain = resumedInputs !== undefined && resumedInputs !== 1;
  return () => !resumedSourceUncertain && inbox.hasOnlyDirectRequester(requesterId);
}

export async function mainWorkerCapabilityFor(
  deps: {
    config: Pick<ConfigStore, "grantsFor">;
    coordinatorInstances?: CoordinatorInstanceStore;
    privateWorkerLog?: PrivateWorkerLog;
    clock?: () => number;
  },
  agentName: string,
  msg: IncomingMessage & { directAudience?: DirectAudience },
  io?: DirectAudienceIO,
  sourceTrusted?: () => boolean,
  observeRead?: MainWorkReadObserver,
  readSeedReceipt?: UnitSeedReader,
): Promise<MainWorkerCapability | undefined> {
  if (agentName !== "orchestrator" || !deps.coordinatorInstances || !deps.privateWorkerLog) return undefined;
  // Tool results persist in the main run's event log. A D-prefix cannot prove
  // a single reader: Slack Connect can turn a DM into a shared conversation.
  const audience = msg.directAudience;
  if (
    visibilityOf(msg.channelId) !== "dm" ||
    !/^slack:D[A-Z0-9_]+$/.test(msg.channelId) ||
    !msg.threadKey.startsWith(`${msg.channelId}:`) ||
    !/^slack:[UW][A-Z0-9_]+$/.test(msg.userId) ||
    audience?.kind !== "slack-unshared-im" ||
    audience.channelId !== msg.channelId ||
    audience.userId !== msg.userId ||
    audience.threadKey !== msg.threadKey ||
    msg.relayedBy !== undefined ||
    msg.postedBy !== undefined ||
    msg.authenticatedAs !== undefined
  )
    return undefined;
  const actor = chatActorOf(deps.config, msg);
  if (actor.kind !== "user" || actor.id !== msg.userId || !sourceTrusted?.()) return undefined;
  if (!(await verifiedDirectAudience(io, audience))) return undefined;
  if (!sourceTrusted()) return undefined;
  const relay = createMainWorkerRelay({
    instances: deps.coordinatorInstances,
    privateWorkerLog: deps.privateWorkerLog,
    clock: deps.clock,
    liveAuthority: { verify: () => verifiedDirectAudience(io, audience), active: sourceTrusted },
    readSeedReceipt,
  });
  const read: MainWorkerCapability["read"] = async (input) => {
    if (!sourceTrusted()) return { kind: "unavailable" };
    if (!(await verifiedDirectAudience(io, audience))) return { kind: "unavailable" };
    if (!sourceTrusted()) return { kind: "unavailable" };
    const result = await relay.read(actor, input);
    if (!sourceTrusted()) return { kind: "unavailable" };
    return result;
  };
  return {
    read,
    restoreRead: (receipt) => {
      if (
        !isMainWorkReadReceipt(receipt) ||
        receipt.tool !== "work_progress" ||
        receipt.observation.requesterId !== msg.userId ||
        receipt.observation.channelId !== msg.channelId ||
        receipt.observation.mainThreadKey !== msg.threadKey
      )
        return undefined;
      const input = structuredClone(receipt.input);
      return restoreMainWorkRead(receipt, async () => {
        const current = await read(input);
        return current.kind === "found"
          ? { observation: current.observation, content: renderWorkProgress(current) }
          : undefined;
      });
    },
    ...(observeRead
      ? ({
          recordRead: async (input, callId, result, content) => {
            await recordMainWorkRead(
              observeRead,
              { tool: "work_progress", callId, input, observation: result.observation, content },
              async () => {
                const current = await read(input);
                return current.kind === "found"
                  ? { observation: current.observation, content: renderWorkProgress(current) }
                  : undefined;
              },
            );
          },
        } satisfies Pick<MainWorkerCapability, "recordRead">)
      : {}),
  };
}
