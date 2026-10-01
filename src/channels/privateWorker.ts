import {
  PRIVATE_WORKER_EVENT_MAX_CHARS,
  PRIVATE_WORKER_REPLY_MAX_CHARS,
  privateWorkerThreadKey,
  type PrivateWorkerIdentity,
  type PrivateWorkerLog,
} from "../core/privateWorkerLog.js";
import type { AudienceCheck } from "../core/audienceDecision.js";
import { mainTaskClaimMatches, type CoordinatorInstance, type CoordinatorUnit } from "../core/coordinator/contract.js";
import type { CoordinatorInstanceStore } from "../core/coordinator/instanceStore.js";
import { directAudienceStampOf } from "../core/runLedger/inboxMessage.js";
import type {
  ChannelIO,
  HistoryItem,
  IncomingMessage,
  SlackDirectAudience,
  StatusHandle,
  StatusUpdate,
} from "../core/types.js";

export { privateWorkerThreadKey, parsePrivateWorkerThreadKey } from "../core/privateWorkerLog.js";
export type { PrivateWorkerIdentity } from "../core/privateWorkerLog.js";
const SHORTENED_COPY = "\n\n[Private history copy shortened; original text may be longer.]";

/** The stored work decision, its internal spawn and the original DM travel
 * together. The verifier rechecks Slack each time; this is not a DM stamp for
 * the worker's internal thread. */
export interface PrivateWorkerAudienceBinding {
  actId: string;
  requester: SlackDirectAudience;
  spawnKey: string;
  verify(audience: SlackDirectAudience): Promise<AudienceCheck>;
}

export type PrivateWorkerAudienceSource =
  PrivateWorkerAudienceBinding | (() => Promise<PrivateWorkerAudienceBinding | undefined>);

/** Only the original stored main decision can supply a worker's requester. */
export function privateWorkerAudienceFor(
  instance: CoordinatorInstance,
  row: CoordinatorUnit,
  spawnKey: string,
  ioFor: (thread: { threadKey: string; userId: string }) => ChannelIO | undefined,
  instances: Pick<CoordinatorInstanceStore, "getMainTask">,
): PrivateWorkerAudienceBinding | undefined {
  const brief = row.workBrief;
  if (
    !brief ||
    !spawnKey ||
    !mainTaskClaimMatches({ mainThreadKey: brief.mainThreadKey, actId: brief.actId }, instance, row)
  )
    return undefined;
  const requester = directAudienceStampOf({
    channelId: instance.channelId,
    userId: instance.userId,
    threadKey: instance.threadKey,
    ...(instance.postedBy !== undefined ? { postedBy: instance.postedBy } : {}),
    ...(instance.authenticatedAs !== undefined ? { authenticatedAs: instance.authenticatedAs } : {}),
    directAudience: {
      kind: "slack-unshared-im",
      channelId: instance.channelId,
      userId: instance.userId,
      threadKey: instance.threadKey,
    },
  });
  if (!requester) return undefined;
  let originIO: ChannelIO | undefined;
  try {
    originIO = ioFor({ threadKey: brief.mainThreadKey, userId: brief.requesterId });
  } catch {
    return undefined;
  }
  if (!originIO) return undefined;
  return {
    actId: brief.actId,
    requester,
    spawnKey,
    verify: async (audience) => {
      const link = await instances.getMainTask({ mainThreadKey: brief.mainThreadKey, actId: brief.actId });
      if (
        link?.instanceId !== instance.id ||
        link.unit !== row.unit ||
        link.authority?.requesterId !== instance.userId ||
        link.authority.repo.toLowerCase() !== instance.repo.toLowerCase()
      )
        return { ok: false, code: "direct-address-unproved" };
      const address = originIO.directAudience?.();
      if (!address) return { ok: false, code: "direct-address-unproved" };
      if (
        address.channelId !== audience.channelId ||
        address.userId !== audience.userId ||
        address.threadKey !== audience.threadKey
      )
        return { ok: false, code: "direct-address-mismatch" };
      if (!originIO.verifyDirectAudience) return { ok: false, code: "direct-address-unproved" };
      return originIO.verifyDirectAudience(audience);
    },
  };
}

/** A resumed child re-reads its original unit before every private access. */
export function rehostPrivateWorkerIO(
  log: PrivateWorkerLog,
  identity: PrivateWorkerIdentity,
  opts: {
    clock: () => number;
    currentInputId?: string;
    instances: Pick<CoordinatorInstanceStore, "get" | "listUnits" | "getMainTask">;
    ioFor: (thread: { threadKey: string; userId: string }) => ChannelIO | undefined;
  },
): ChannelIO {
  return privateWorkerIO(log, identity, {
    clock: opts.clock,
    ...(opts.currentInputId !== undefined ? { currentInputId: opts.currentInputId } : {}),
    audience: async () => {
      try {
        const instance = await opts.instances.get(identity.instanceId);
        if (!instance) return undefined;
        const rows = (await opts.instances.listUnits(identity.instanceId)).filter((row) => row.unit === identity.unit);
        if (rows.length !== 1) return undefined;
        return privateWorkerAudienceFor(instance, rows[0]!, opts.currentInputId ?? "", opts.ioFor, opts.instances);
      } catch {
        return undefined;
      }
    },
  });
}

function boundedHistoryCopy<T extends { text: string }>(event: T, limit: number): T {
  // The state Worker adds a monotonic `seq` before storing the row. Leave
  // space for its serialized field so a read can validate the stored event.
  const maxInputChars = limit - 64;
  if (JSON.stringify(event).length <= maxInputChars) return event;
  const characters = Array.from(event.text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = { ...event, text: characters.slice(0, mid).join("") + SHORTENED_COPY };
    if (JSON.stringify(candidate).length <= maxInputChars) low = mid;
    else high = mid - 1;
  }
  return { ...event, text: characters.slice(0, low).join("") + SHORTENED_COPY };
}

/** Record a previously authorized human turn before dispatch; retries reuse its id. */
export async function appendPrivateWorkerInput(
  log: PrivateWorkerLog,
  identity: PrivateWorkerIdentity,
  input: { id: string; sender: string; text: string; at: number },
): Promise<void> {
  // Hash the JSON string so distinct unpaired UTF-16 surrogates do not both
  // collapse to the same UTF-8 replacement character.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input.text)));
  const textSha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  await log.append(
    privateWorkerThreadKey(identity),
    boundedHistoryCopy({ kind: "input" as const, ...input, textSha256 }, PRIVATE_WORKER_EVENT_MAX_CHARS),
  );
}

/** A coordinator settlement is retried under the same key until its report is durable. */
export async function appendPrivateWorkerReply(
  log: PrivateWorkerLog,
  identity: PrivateWorkerIdentity,
  reply: { id: string; text: string; at: number },
): Promise<void> {
  await log.append(
    privateWorkerThreadKey(identity),
    boundedHistoryCopy({ kind: "reply" as const, ...reply }, PRIVATE_WORKER_REPLY_MAX_CHARS),
  );
}

/** An internal channel handle. It has no Slack client, openThread or upload method. */
export function privateWorkerIO(
  log: PrivateWorkerLog,
  identity: PrivateWorkerIdentity,
  opts: { clock: () => number; currentInputId?: string; runId?: string; audience?: PrivateWorkerAudienceSource },
): ChannelIO {
  const threadKey = privateWorkerThreadKey(identity);
  const resolveAudience = async () => (typeof opts.audience === "function" ? opts.audience() : opts.audience);
  const verifyBinding = async (
    request: IncomingMessage,
    audience: PrivateWorkerAudienceBinding | undefined,
  ): Promise<AudienceCheck> => {
    if (
      !audience ||
      !audience.actId ||
      !audience.spawnKey ||
      audience.spawnKey !== opts.currentInputId ||
      directAudienceStampOf({ ...audience.requester, directAudience: audience.requester }) === undefined
    )
      return { ok: false, code: "direct-address-unproved" };
    if (
      request.channelId !== audience.requester.channelId ||
      request.userId !== audience.requester.userId ||
      request.threadKey !== threadKey ||
      request.messageId !== audience.spawnKey ||
      request.directAudience !== undefined ||
      request.relayedBy !== undefined ||
      request.postedBy !== undefined ||
      request.authenticatedAs !== undefined
    )
      return { ok: false, code: "direct-address-mismatch" };
    try {
      return await audience.verify(audience.requester);
    } catch {
      return { ok: false, code: "direct-audience-unavailable" };
    }
  };
  const verifyPrivateWorkerAudience = async (request: IncomingMessage): Promise<AudienceCheck> =>
    verifyBinding(request, await resolveAudience());
  const currentRequest = (audience: PrivateWorkerAudienceBinding): IncomingMessage => ({
    channelId: audience.requester.channelId,
    userId: audience.requester.userId,
    threadKey,
    messageId: audience.spawnKey,
    text: "",
  });
  const checkCurrentAudience = async () => {
    if (!opts.audience) return;
    const audience = await resolveAudience();
    if (!audience || !(await verifyBinding(currentRequest(audience), audience)).ok)
      throw new Error("private worker audience unavailable");
  };
  let runId = opts.runId;
  const history = async (): Promise<HistoryItem[]> => {
    await checkCurrentAudience();
    const events = await log.list(threadKey);
    await checkCurrentAudience();
    return events.flatMap((event): HistoryItem[] => {
      if (event.kind === "input" && event.id !== opts.currentInputId)
        return [{ role: "user", text: event.text, at: event.at, user: event.sender }];
      if (event.kind === "reply") return [{ role: "assistant", text: event.text, at: event.at }];
      return [];
    });
  };
  return {
    history,
    ...(opts.audience ? { verifyPrivateWorkerAudience } : {}),
    reply: async (text) => {
      await checkCurrentAudience();
      await log.append(
        threadKey,
        boundedHistoryCopy(
          { kind: "reply" as const, text, at: opts.clock(), ...(runId !== undefined ? { runId } : {}) },
          PRIVATE_WORKER_REPLY_MAX_CHARS,
        ),
      );
    },
    status: async (initial): Promise<StatusHandle> => {
      await checkCurrentAudience();
      const opened = await log.append(threadKey, { kind: "status", phase: "start", frame: initial, at: opts.clock() });
      const statusSeq = opened.seq;
      let pending = Promise.resolve();
      let failure: unknown;
      let ending: Promise<void> | undefined;
      const appendFrame = async (phase: "update" | "done", frame: StatusUpdate): Promise<void> => {
        await checkCurrentAudience();
        await log.append(threadKey, { kind: "status", phase, statusSeq, frame, at: opts.clock() });
      };
      return {
        update(frame) {
          if (ending !== undefined) return;
          pending = pending
            .then(() => appendFrame("update", frame))
            .catch((err: unknown) => {
              failure = err;
            });
        },
        done(frame) {
          if (ending !== undefined) return ending;
          ending = pending.then(async () => {
            if (failure !== undefined) throw failure;
            await appendFrame("done", frame);
          });
          return ending;
        },
      };
    },
    runStarted: ({ id }) => {
      runId = id;
    },
  };
}
