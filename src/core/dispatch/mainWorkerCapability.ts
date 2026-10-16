import type { ConfigStore } from "../../config.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { chatActorOf } from "../authz/actor.js";
import { visibilityOf } from "../authz/channelDirectory.js";
import { canOfferMainStart } from "../../tools/mainStart.js";
import { privateDestinationOf, verifyPrivateDestination } from "./privateDestination.js";
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
  msg: IncomingMessage,
  io?: Pick<ChannelIO, "verifyDirectAudience" | "organizationPrivateAudience" | "verifyOrganizationPrivateAudience">,
  sourceTrusted?: () => boolean,
  observeRead?: MainWorkReadObserver,
  readSeedReceipt?: UnitSeedReader,
): Promise<MainWorkerCapability | undefined> {
  if (agentName !== "orchestrator" || !deps.coordinatorInstances || !deps.privateWorkerLog) return undefined;
  const audience = privateDestinationOf(msg);
  const verify = async () => {
    try {
      return audience?.kind === "slack-unshared-im"
        ? (await io?.verifyDirectAudience?.(audience))?.ok === true
        : !!audience && (await verifyPrivateDestination(io, audience)).ok;
    } catch {
      return false;
    }
  };
  const actor = chatActorOf(deps.config, msg);
  if (!audience || !canOfferMainStart(agentName, visibilityOf(msg.channelId), msg, actor, true) || !sourceTrusted?.())
    return undefined;
  if (!(await verify()) || !sourceTrusted()) return undefined;
  const relay = createMainWorkerRelay({
    instances: deps.coordinatorInstances,
    privateWorkerLog: deps.privateWorkerLog,
    clock: deps.clock,
    liveAuthority: { verify, active: sourceTrusted },
    readSeedReceipt,
  });
  const read: MainWorkerCapability["read"] = async (input) => {
    if (!sourceTrusted()) return { kind: "unavailable" };
    if (!(await verify())) return { kind: "unavailable" };
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
