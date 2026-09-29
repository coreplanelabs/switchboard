import { INSTANCE_ID_PATTERN } from "../core/coordinator/contract.js";
import {
  PRIVATE_WORKER_EVENT_MAX_CHARS,
  PRIVATE_WORKER_REPLY_MAX_CHARS,
  type PrivateWorkerLog,
} from "../core/privateWorkerLog.js";
import type { ChannelIO, HistoryItem, StatusHandle, StatusUpdate } from "../core/types.js";

export interface PrivateWorkerIdentity {
  instanceId: string;
  unit: string;
}

const UNIT_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const SHORTENED_COPY = "\n\n[Private history copy shortened; original text may be longer.]";

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

/** Stable across bot generations; never a Slack thread key. */
export function privateWorkerThreadKey(identity: PrivateWorkerIdentity): string {
  if (!INSTANCE_ID_PATTERN.test(identity.instanceId) || !UNIT_ID_PATTERN.test(identity.unit))
    throw new Error("invalid private worker identity");
  return `worker:${identity.instanceId}:${identity.unit}`;
}

/** Only an exact internal key can be rebuilt after a bot restart. */
export function parsePrivateWorkerThreadKey(threadKey: string): PrivateWorkerIdentity | undefined {
  const match = /^worker:([^:]+):([^:]+)$/.exec(threadKey);
  if (!match || !INSTANCE_ID_PATTERN.test(match[1]!) || !UNIT_ID_PATTERN.test(match[2]!)) return undefined;
  return { instanceId: match[1]!, unit: match[2]! };
}

/** Record a previously authorized human turn before dispatch; retries reuse its id. */
export async function appendPrivateWorkerInput(
  log: PrivateWorkerLog,
  identity: PrivateWorkerIdentity,
  input: { id: string; sender: string; text: string; at: number },
): Promise<void> {
  await log.append(
    privateWorkerThreadKey(identity),
    boundedHistoryCopy({ kind: "input" as const, ...input }, PRIVATE_WORKER_EVENT_MAX_CHARS),
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
  opts: { clock: () => number; currentInputId?: string; runId?: string },
): ChannelIO {
  const threadKey = privateWorkerThreadKey(identity);
  let runId = opts.runId;
  const history = async (): Promise<HistoryItem[]> =>
    (await log.list(threadKey)).flatMap((event): HistoryItem[] => {
      if (event.kind === "input" && event.id !== opts.currentInputId)
        return [{ role: "user", text: event.text, at: event.at, user: event.sender }];
      if (event.kind === "reply") return [{ role: "assistant", text: event.text, at: event.at }];
      return [];
    });
  return {
    history,
    reply: async (text) => {
      await log.append(
        threadKey,
        boundedHistoryCopy(
          { kind: "reply" as const, text, at: opts.clock(), ...(runId !== undefined ? { runId } : {}) },
          PRIVATE_WORKER_REPLY_MAX_CHARS,
        ),
      );
    },
    status: async (initial): Promise<StatusHandle> => {
      const opened = await log.append(threadKey, { kind: "status", phase: "start", frame: initial, at: opts.clock() });
      const statusSeq = opened.seq;
      let pending = Promise.resolve();
      let failure: unknown;
      let ending: Promise<void> | undefined;
      const appendFrame = (phase: "update" | "done", frame: StatusUpdate): Promise<void> =>
        log.append(threadKey, { kind: "status", phase, statusSeq, frame, at: opts.clock() }).then(() => {});
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
