import type { DocumentAttachment, ImageAttachment } from "./types.js";

// Thread admission (features/thread-admission.md): ONE live run per thread.
//
// A thread reply that arrives while a run is already in flight in that thread
// used to start a second, fully independent run — two agents editing the same
// per-thread workspace at once (2026-09-04: two coding runs in one Slack
// thread shared a checkout; the second's `git checkout -b` switched the
// first's branch under it, and the first's PR post named a branch it never
// pushed). Admission replaces that with two outcomes, decided per follow-up:
//
//   steer  — the follow-up is folded into the live run: appended to its inbox
//            and read by the runner at its next step boundary, so the agent
//            hears "one more thing" mid-task instead of a rival run hearing it.
//            The live run is never interrupted or restarted for it.
//   refuse — the follow-up gets a short reply naming the live run and is not
//            run: when the live agent does not steer (a review or a ship
//            pipeline is a unit of work, not a conversation), or when the
//            follow-up asks for a DIFFERENT agent than the one running.
//
// The dispatcher claims a thread's slot at entry — before history, the setup
// card, or any executor attach — and releases it when the run has fully ended.
// Inputs still unconsumed at release (the run ended before its next step, or
// never reached the runner) are handed back so the dispatcher can run them as
// a fresh turn rather than drop them. Everything here is synchronous, pure
// state, and platform-blind; nothing here starts a run.

/** One follow-up message admitted into a live run. */
export interface FollowUpInput {
  text: string;
  userId: string;
  userName?: string;
  sourceUrl?: string;
  images?: ImageAttachment[];
  documents?: DocumentAttachment[];
  /** When it arrived (ms epoch). */
  at: number;
}

/** Whether follow-ups fold into a running instance of an agent. */
export type FollowUpPolicy = "steer" | "refuse";

/**
 * The queue between the dispatcher (producer: a steered follow-up) and the
 * runner (consumer: `drain()` at each step boundary). Bounded only by the run:
 * a follow-up is at most one message, and a run ends within its budgets.
 * `T` lets the producer keep channel-side context (the follow-up's own
 * `ChannelIO`, for the fresh turn an unconsumed input becomes) on the same
 * record; the runner reads only the `FollowUpInput` fields.
 */
export class FollowUpInbox<T extends FollowUpInput = FollowUpInput> {
  private pending: T[] = [];

  push(input: T): void {
    this.pending.push(input);
  }

  /** Everything pushed since the last drain, oldest first; the inbox is empty after. */
  drain(): T[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  get size(): number {
    return this.pending.length;
  }
}

/** The run a thread is currently occupied by, as admission sees it. */
export interface LiveThread<T extends FollowUpInput = FollowUpInput> {
  agent: string;
  policy: FollowUpPolicy;
  inbox: FollowUpInbox<T>;
  startedAt: number;
  /** Set by the owning dispatch once its run is registered (the run page link
   *  for the ack/refusal replies); absent while setup is still in progress. */
  runLink?: string;
  runId?: string;
}

export type ClaimOutcome<T extends FollowUpInput = FollowUpInput> =
  /** No run was live: the caller now owns the slot and must `release()` it. */
  | { kind: "start"; live: LiveThread<T> }
  /** A run is live in this thread; the caller decides steer/refuse against it. */
  | { kind: "live"; live: LiveThread<T> };

/** The per-process map of live threads. One instance per bot process (module
 *  default in the dispatcher); tests construct their own. */
export class ThreadAdmission<T extends FollowUpInput = FollowUpInput> {
  private readonly live = new Map<string, LiveThread<T>>();

  claim(threadKey: string, run: { agent: string; policy: FollowUpPolicy; now?: number }): ClaimOutcome<T> {
    const existing = this.live.get(threadKey);
    if (existing) return { kind: "live", live: existing };
    const live: LiveThread<T> = {
      agent: run.agent,
      policy: run.policy,
      inbox: new FollowUpInbox<T>(),
      startedAt: run.now ?? Date.now(),
    };
    this.live.set(threadKey, live);
    return { kind: "start", live };
  }

  /** Release the slot IF `live` still owns it (a stale release — a slot already
   *  re-claimed by a later run — is a no-op) and hand back whatever the run
   *  never consumed. */
  release(threadKey: string, live: LiveThread<T>): T[] {
    if (this.live.get(threadKey) !== live) return [];
    this.live.delete(threadKey);
    return live.inbox.drain();
  }

  get(threadKey: string): LiveThread<T> | undefined {
    return this.live.get(threadKey);
  }

  get size(): number {
    return this.live.size;
  }
}

export type FollowUpDecision = { kind: "steer" } | { kind: "refuse"; reason: "agent_mismatch" | "not_steerable" };

/**
 * Steer unless the follow-up explicitly asks for a different agent than the
 * one running (`agent:review` in a live coding thread is a new request, not a
 * nudge) or the live agent does not take mid-run input at all.
 */
export function decideFollowUp(live: LiveThread, requested: { agent?: string }): FollowUpDecision {
  if (requested.agent !== undefined && requested.agent !== live.agent)
    return { kind: "refuse", reason: "agent_mismatch" };
  if (live.policy === "refuse") return { kind: "refuse", reason: "not_steerable" };
  return { kind: "steer" };
}

const elapsed = (live: LiveThread, now: number) => `${Math.max(0, Math.round((now - live.startedAt) / 1000))}s`;
// A bare URL, never mrkdwn `<url|label>`: `ChannelIO.reply` escapes `<`/`>`
// (live 2026-09-05 the label form arrived as literal `&lt;…|live run&gt;`),
// and Slack auto-links a bare URL — the same convention as the review
// verdict's run link.
const linkSuffix = (live: LiveThread) => (live.runLink ? ` · ${live.runLink}` : "");

/** The one-line reply a steered follow-up gets: where it went. */
export function steerAck(live: LiveThread, now: number): string {
  return `↪ Folded into the *${live.agent}* run already in flight in this thread (${elapsed(live, now)} in) — it picks this up at its next step.${linkSuffix(live)}`;
}

/** The reply a refused follow-up gets: what is live, why it was not run, what to do. */
export function refusalReply(
  live: LiveThread,
  decision: { reason: "agent_mismatch" | "not_steerable" },
  requestedAgent: string | undefined,
  now: number,
): string {
  const head = `⏳ A *${live.agent}* run is already in flight in this thread (${elapsed(live, now)} in).${linkSuffix(live)}`;
  if (decision.reason === "agent_mismatch") {
    return `${head}\nAn \`agent:${requestedAgent}\` request cannot start beside it — one run per thread. Wait for it to finish and re-send, or start a new thread.`;
  }
  return `${head}\nA *${live.agent}* run does not take follow-ups mid-flight — wait for it to finish, then re-send (or stop it from the live run page).`;
}

/** The header for follow-ups drained on a tool turn: the model is mid-task. */
const followUpHeader = (n: number) =>
  n > 1
    ? `↪ ${n} follow-ups from the thread, sent while you were working. Take them into account from here on; they may narrow, widen or redirect the task:`
    : "↪ Follow-up from the thread, sent while you were working. Take it into account from here on; it may narrow, widen or redirect the task:";

/** The header when the follow-ups landed on a finished answer (item 3): that
 *  answer was never delivered — the thread has seen nothing yet — so the model
 *  must not write an increment on top of it (live 2026-09-05: "Perfect
 *  addition. Let me add that detail…" was the ONLY reply the thread got). */
const supersededHeader = (n: number) =>
  `↪ ${n > 1 ? `${n} follow-ups` : "Follow-up"} from the thread, sent while you were writing your answer. That answer was NOT delivered — the thread has not seen it, and it will not be sent. Write ONE complete answer now that covers the original request AND ${n > 1 ? "all of these follow-ups" : "this follow-up"}:`;

/** The text block the runner hands the model for a batch of drained follow-ups
 *  (any count: one is quoted as is, several are a bulleted list in arrival
 *  order). `superseded`: the batch displaced a final answer rather than riding
 *  a tool turn. */
export function followUpPrompt(inputs: FollowUpInput[], opts: { superseded?: boolean } = {}): string {
  const body = inputs.map((i) => (inputs.length > 1 ? `- ${i.text}` : i.text)).join("\n");
  return `${opts.superseded ? supersededHeader(inputs.length) : followUpHeader(inputs.length)}\n\n${body}`;
}

/** A short, single-line snippet of a follow-up for cards and run notes. */
export function followUpSnippet(input: FollowUpInput, max = 80): string {
  const oneLine = input.text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Unconsumed follow-ups → the ONE message a fresh turn runs them as: texts
 * joined in arrival order, attachments concatenated, identity from the last
 * (most recent) input. Empty input → undefined (nothing to run).
 */
export function mergeFollowUps(inputs: FollowUpInput[]):
  | {
      text: string;
      userId: string;
      userName?: string;
      sourceUrl?: string;
      images?: ImageAttachment[];
      documents?: DocumentAttachment[];
    }
  | undefined {
  if (inputs.length === 0) return undefined;
  const last = inputs[inputs.length - 1];
  const images = inputs.flatMap((i) => i.images ?? []);
  const documents = inputs.flatMap((i) => i.documents ?? []);
  return {
    text: inputs.map((i) => i.text).join("\n\n"),
    userId: last.userId,
    ...(last.userName !== undefined ? { userName: last.userName } : {}),
    ...(last.sourceUrl !== undefined ? { sourceUrl: last.sourceUrl } : {}),
    ...(images.length > 0 ? { images } : {}),
    ...(documents.length > 0 ? { documents } : {}),
  };
}
