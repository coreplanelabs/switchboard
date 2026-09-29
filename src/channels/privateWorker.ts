import { INSTANCE_ID_PATTERN } from "../core/coordinator/contract.js";
import type { PrivateWorkerLog } from "../core/privateWorkerLog.js";
import type { ChannelIO, HistoryItem, StatusHandle, StatusUpdate } from "../core/types.js";

export interface PrivateWorkerIdentity {
  instanceId: string;
  unit: string;
}

const UNIT_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Stable across bot generations; never a Slack thread key. */
export function privateWorkerThreadKey(identity: PrivateWorkerIdentity): string {
  if (!INSTANCE_ID_PATTERN.test(identity.instanceId) || !UNIT_ID_PATTERN.test(identity.unit))
    throw new Error("invalid private worker identity");
  return `worker:${identity.instanceId}:${identity.unit}`;
}

/** Record a previously authorized human turn before dispatch; retries reuse its id. */
export async function appendPrivateWorkerInput(
  log: PrivateWorkerLog,
  identity: PrivateWorkerIdentity,
  input: { id: string; sender: string; text: string; at: number },
): Promise<void> {
  await log.append(privateWorkerThreadKey(identity), { kind: "input", ...input });
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
      await log.append(threadKey, { kind: "reply", text, at: opts.clock(), ...(runId !== undefined ? { runId } : {}) });
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
