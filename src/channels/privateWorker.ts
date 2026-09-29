import {
  PRIVATE_WORKER_EVENT_MAX_CHARS,
  PRIVATE_WORKER_REPLY_MAX_CHARS,
  privateWorkerThreadKey,
  type PrivateWorkerIdentity,
  type PrivateWorkerLog,
} from "../core/privateWorkerLog.js";
import type { ChannelIO, HistoryItem, StatusHandle, StatusUpdate } from "../core/types.js";

export { privateWorkerThreadKey, parsePrivateWorkerThreadKey } from "../core/privateWorkerLog.js";
export type { PrivateWorkerIdentity } from "../core/privateWorkerLog.js";
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
