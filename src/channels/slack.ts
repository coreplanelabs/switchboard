import { App, SocketModeReceiver, webApi } from "@slack/bolt";
import { dispatch, type CoreDeps } from "../core/dispatcher.js";
import { STATUS_PREFIXES } from "../core/dispatch/reply.js";
import {
  createStatusBudget,
  STATUS_EDITS_PER_MINUTE,
  TERMINAL_RESENDS,
  type StatusBudget,
} from "../core/statusBudget.js";
import { startRequestRoot, withProcessRoot } from "../core/requestTrace.js";
import { systemClock } from "../core/trace/clock.js";
import type { Span } from "../core/trace/types.js";
import { catchUpWindowWarning } from "../core/drain.js";
import { mdToMrkdwn } from "./mrkdwn.js";
import { classifyMessage, threadIncludesBot } from "./slackTriggers.js";
import {
  fetchDocuments,
  fetchImages,
  MAX_DOCS_PER_MESSAGE,
  MAX_HISTORY_DOCS,
  MAX_HISTORY_DOCUMENT_BYTES,
  MAX_HISTORY_IMAGE_BYTES,
  MAX_HISTORY_IMAGES,
  MAX_IMAGES_PER_MESSAGE,
  type SlackFile,
} from "./slack/attachments.js";
import { dedupeDelivery, wasHandledHere } from "./slack/dedupe.js";
import { resolveChannelName, resolveTeamUrl, resolveUserName, slackPermalink } from "./slack/lookups.js";
import { isLiveCard, liveCardKey, liveCards, refreshForeignLiveCards, render } from "./slack/statusCard.js";
import { ACK_EMOJI, catchUpMissedMentions, tsMs } from "./slackCatchUp.js";
import { processSecrets, type Secret } from "../secrets.js";
import { missingBotScopes, recordCatchUpOutcome, recordMissingScopes } from "./slackCatchUpStatus.js";
import { recordSocketConnected, recordSocketDisconnected } from "./slackSocketStatus.js";
export { classifyMessage, threadIncludesBot, type MessageDecision } from "./slackTriggers.js";
import type {
  ChannelIO,
  DocumentAttachment,
  HistoryItem,
  ImageAttachment,
  IncomingMessage,
  OpenedThread,
  StatusHandle,
  StatusUpdate,
} from "../core/types.js";

// Slack channel adapter: pure transport. Wires Bolt (Socket Mode) events into
// the core dispatcher and implements ChannelIO on top of the Slack Web API.
// No routing, config, or agent logic lives here.

type SlackClient = webApi.WebClient;

/** The two Web API clients the adapter runs on. Replies, card posts and reads
 *  go through `client` (Bolt's, with its 30-minute rate-limit retry). Card
 *  EDITS go through `statusClient` (`createStatusClient`) so a 429 on a
 *  heartbeat never pauses the queue a reply is waiting in
 *  (docs/reference/specs/run-visibility.md item 8). */
export interface SlackClients {
  client: SlackClient;
  statusClient: SlackClient;
}

/** The one budget every card in this process draws from. */
const processStatusBudget = createStatusBudget({ perMinute: STATUS_EDITS_PER_MINUTE });

/** The client card edits ride on: a rate-limited call REJECTS at once instead of
 *  pausing the queue and retrying for up to 30 minutes (the default policy) —
 *  a refused progress frame is dropped, a refused terminal frame is re-sent
 *  after Slack's Retry-After up to `TERMINAL_RESENDS` times (`SlackIO.status`).
 *  One retry for transport errors. */
export function createStatusClient(token: Secret | undefined): SlackClient {
  return new webApi.WebClient(token?.reveal(), { rejectRateLimitedCalls: true, retryConfig: { retries: 1 } });
}

/** Slack's Retry-After, in seconds, when `err` is the status client's rate-limit rejection. */
function retryAfterSeconds(err: unknown): number | undefined {
  const e = err as { code?: string; retryAfter?: unknown } | undefined;
  return e?.code === webApi.ErrorCode.RateLimitedError && typeof e.retryAfter === "number" ? e.retryAfter : undefined;
}

/** An error's one-line name for a log: the message of an `Error`, the `code` of a
 *  Slack Web API rejection (a plain object, e.g. `slack_webapi_rate_limited_error`), else its JSON. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  const code = (err as { code?: unknown } | undefined)?.code;
  if (typeof code === "string") return code;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

const PLATFORM = "slack";
const SLACK_MSG_LIMIT = 3500;

// Rotating inline-status phrases (assistant.threads.setStatus loading_messages).
// Switchboard-flavored; Slack cycles through them while a turn runs.
const LOADING_PHRASES = [
  "is patching you through…",
  "is untangling the cords…",
  "is ringing the exchange…",
  "is consulting the operators…",
  "is rerouting the trunk lines…",
  "is holding the line…",
  "is splicing the wires…",
  "is checking the jacks…",
  "is dialing long distance…",
  "is clearing the static…",
];

export function createSlackApp(deps: CoreDeps) {
  const clock = deps.clock ?? systemClock;
  // The receiver is built explicitly (rather than `socketMode: true`) so the
  // adapter can listen to its websocket lifecycle: every `connected` — first
  // start and each reconnect — triggers the missed-mention catch-up
  // (docs/decisions/0012-reconnect-catch-up-as-recovery.md).
  // The two Slack credentials are revealed into Bolt's constructors and nowhere else.
  const appToken = processSecrets.get("SLACK_APP_TOKEN");
  const botToken = processSecrets.get("SLACK_BOT_TOKEN");
  const receiver = new SocketModeReceiver({ appToken: appToken?.reveal() ?? "" });
  const app = new App({ token: botToken?.reveal(), receiver });
  const statusClient = createStatusClient(botToken);

  let botUserId: string | undefined;
  /** The bot-scope check runs once per process, on the first `connected`. */
  let scopesChecked = false;

  const catchUp = deps.config.config.slack?.catchUp;
  if (catchUp?.enabled !== false) {
    // A window shorter than the drain deadline + cold start cannot cover a
    // full-length deploy blackout. Warn, keep the operator's value.
    const windowWarning = catchUpWindowWarning(catchUp?.windowMinutes);
    if (windowWarning) console.warn(`[catch-up] ${windowWarning}`);
    // Socket-state record for /healthz: connected/disconnected transitions, so
    // the cold-start window (HTTP up, Slack not yet connected) and a silently
    // dead socket are both visible off-box (slackSocketStatus.ts).
    receiver.client.on("disconnected", () => recordSocketDisconnected());
    receiver.client.on("connected", () => {
      recordSocketConnected();
      void (async () => {
        // `botUserId` is retried on EVERY connect until it resolves (an
        // auth.test that answers without user_id must not no-op the catch-up
        // for the life of the process); only the scope check latches.
        if (!botUserId || !scopesChecked) {
          const auth = await app.client.auth.test();
          botUserId ??= auth.user_id ?? undefined;
          if (!scopesChecked) {
            scopesChecked = true;
            // Startup scope check: every Web API result carries the token's
            // granted scopes. Missing ones are the silent failure mode — without
            // `channels:read`/`groups:read` the catch-up cannot list channels
            // and its scan is a no-op that nothing reports — so they are logged
            // loudly once and kept on the status record that /healthz reports.
            const missing = missingBotScopes(auth.response_metadata?.scopes);
            recordMissingScopes(missing);
            if (missing.length > 0) {
              console.error(
                `[slack] bot token is MISSING required scopes: ${missing.join(", ")} — reinstall the app with them (docs/tutorials/run-it-locally.md → Connect it to Slack); until then the features needing them silently do nothing`,
              );
            }
          }
        }
        if (!botUserId) return;
        const id = botUserId;
        // The sweep below asks `isLiveCard`; the ledger's answer is refreshed
        // first so a generation that died since the last connect no longer
        // shields its cards (run-history item 36).
        await refreshForeignLiveCards();
        // The pass is one `slack.catch_up` root on the span log (docs/reference/specs/
        // tracing.md item 20), its counts as attrs; a throw fails it and still
        // reaches the catch below.
        await withProcessRoot(deps, "slack.catch_up", async (root) => {
          const result = await catchUpMissedMentions({
            client: app.client,
            botUserId: id,
            windowMs: catchUp?.windowMinutes != null ? catchUp.windowMinutes * 60_000 : undefined,
            alreadyHandled: wasHandledHere,
            // Orphaned-card sweep (item 8): cards a dead process left spinning
            // are closed as interrupted; cards this process is driving — or that
            // the run ledger says another live generation holds — are not.
            isLive: isLiveCard,
            onOrphanedCard: async (card, frame) => {
              await app.client.chat.update({ channel: card.channel, ts: card.ts, ...render(frame) });
            },
            // Not awaited per message: a run takes minutes and live events run
            // concurrently too — the runner only awaits the hand-off.
            onMissed: (m) => {
              // The scan's alreadyHandled check ran at scan time; a live
              // delivery that landed between the scan and this dispatch has
              // claimed the pair since — re-check, or both would run.
              if (wasHandledHere(m.channel, m.ts)) {
                console.log(`[catch-up] ${m.channel}:${m.ts}: skipped — handled live since the scan`);
                return;
              }
              void handle(
                deps,
                { client: app.client, statusClient },
                {
                  channel: m.channel,
                  user: m.user,
                  text: stripMention(m.text, id),
                  ts: m.ts,
                  threadTs: m.threadTs,
                  files: m.files as SlackFile[] | undefined,
                  botUserId: id,
                  caughtUp: true,
                },
              ).catch((err: Error) => console.error(`[catch-up] ${m.channel}:${m.ts}: ${err.message}`));
            },
          });
          root.setAttrs({
            channels: result.channels,
            missed: result.missed,
            orphans: result.orphans,
            skipped: result.skippedChannels,
          });
        });
      })().catch((err: Error) => {
        // auth.test itself failed (bad token, network): the scan never ran —
        // record that too, or /healthz would keep showing a stale clean run.
        console.error(`[catch-up] ${err.message}`);
        recordCatchUpOutcome({ at: clock(), channels: 0, missed: 0, skippedChannels: 0, error: err.message });
      });
    });
  }

  app.event("app_mention", async ({ event, client }) => {
    botUserId ??= (await client.auth.test()).user_id ?? undefined;
    await handle(
      deps,
      { client, statusClient },
      {
        channel: event.channel,
        user: event.user ?? "unknown",
        text: stripMention(event.text ?? "", botUserId),
        ts: event.ts,
        threadTs: event.thread_ts ?? event.ts,
        files: (event as { files?: SlackFile[] }).files,
        botUserId,
      },
    );
  });

  // DMs to the bot, and follow-up replies in threads the bot participates in
  // (no re-mention needed once a conversation has started).
  app.message(async ({ message, client }) => {
    const m = message as {
      channel_type?: string;
      channel: string;
      user?: string;
      text?: string;
      ts: string;
      thread_ts?: string;
      bot_id?: string;
      subtype?: string;
      files?: SlackFile[];
    };
    // Two-phase, deliberately: the botUserId-free pre-check catches every
    // skip except mention-in-thread, so definite skips (bot messages,
    // subtypes, top-level channel posts) never cost an auth.test call — a
    // small improvement over the pre-extraction code, which called auth.test
    // before the top-level-post check. Dispatch outcomes are identical.
    if (classifyMessage(m) === "skip") return;
    botUserId ??= (await client.auth.test()).user_id ?? undefined;
    const decision = classifyMessage(m, botUserId);
    if (decision === "skip") return;
    let thread: SlackThreadMessage[] | undefined;
    if (decision === "handle-if-bot-in-thread") {
      thread = await threadIfBotInIt(client, m.channel, m.thread_ts!, botUserId);
      if (!thread) return;
    }
    await handle(
      deps,
      { client, statusClient },
      {
        channel: m.channel,
        user: m.user ?? "unknown",
        text: stripMention(m.text ?? "", botUserId),
        ts: m.ts,
        threadTs: m.thread_ts ?? m.ts,
        files: m.files,
        botUserId,
        thread,
      },
    );
  });

  // The receiver rides along for the Bolt-level wiring test: emitting
  // `connected` on `receiver.client` is exactly what a real reconnect does, so
  // the test can drive the hook without a live socket. Production
  // (src/index.ts) uses only `app`.
  return { app, receiver, statusClient };
}

interface SlackEvent {
  channel: string;
  user: string;
  text: string;
  /** ts of the triggering message itself (history() skips it by this) */
  ts: string;
  threadTs: string;
  files?: SlackFile[];
  botUserId?: string;
  /** The thread's messages when the handler has already fetched them (the
   *  follow-up path's bot-in-thread check); `history()` reuses them. */
  thread?: SlackThreadMessage[];
  /** Set when the reconnect catch-up replayed this message (it arrived while
   *  the socket was down); the thread is told how late the pickup was. */
  caughtUp?: true;
}

/** The one-line thread note a replayed message gets, so a caller who waited
 *  through a deploy blackout (minutes with no 👀 — indistinguishable, from the
 *  thread, from being ignored) learns the delay was the bot restarting — not
 *  the request being ignored, and not something to re-send. Pure; exported
 *  for tests. */
export function catchUpDelayNote(messageTs: string, nowMs: number): string {
  const lateMs = Math.max(0, nowMs - Number(messageTs) * 1000);
  const mins = Math.round(lateMs / 60_000);
  const late = mins < 1 ? "under a minute" : `${mins} min`;
  return `⏱ Picked up ${late} after it was posted: the bot was restarting (a deploy or platform move) and Slack does not queue events while it is down. Handling it now — no need to re-send.`;
}

/** One message as `conversations.replies` returns it — the fields history() reads. */
type SlackThreadMessage = { bot_id?: string; user?: string; text?: string; ts?: string; files?: SlackFile[] };

async function handle(deps: CoreDeps, { client, statusClient }: SlackClients, ev: SlackEvent): Promise<void> {
  // The request's root (docs/reference/specs/tracing.md): our process saw the message NOW,
  // before the redelivery guard — a dropped redelivery is a root with one
  // child and no run. Everything the adapter does before `dispatch()` is one
  // `slack.receive` span; `dispatch()` ends the root, this finally is the
  // backstop (`end()` is idempotent).
  const receivedAt = systemClock();
  // The platform's stamp rides on the root from its start, so the record's
  // `request` span_start carries `queuedBeforeMs` (the page's queued caption).
  const trace = startRequestRoot(deps, { channel: "slack", receivedAt, originAt: tsMs(ev.ts) });
  try {
    const received = await trace.root.span("slack.receive", (span) => receiveSlackMessage(client, ev, span));
    if (!received) {
      trace.root.end("ok", { status: "refused" });
      return;
    }
    await dispatch(
      deps,
      { ...received, receivedAt, originAt: tsMs(ev.ts) },
      new SlackIO(client, ev, { statusClient }),
      { trace },
    );
  } finally {
    // Reached un-ended only when the receive itself threw (a download, a lookup):
    // `dispatch()` ends the root on every path of its own.
    if (!trace.root.ended) trace.root.end("error", { status: "failed" });
  }
}

/** The adapter's own work before the core sees the message: the redelivery
 *  guard, the 👀 ack, the catch-up note, the file downloads and the display
 *  names — the `slack.receive` span's body. `undefined` when the event is a
 *  redelivery that already ran (the span says `dedupe: duplicate`). */
async function receiveSlackMessage(
  client: SlackClient,
  ev: SlackEvent,
  span: Span,
): Promise<Omit<IncomingMessage, "receivedAt" | "originAt"> | undefined> {
  // Redelivery guard: claim (channel, ts) and drop the event when it
  // demonstrably ran already — in this process, or (for a stale delivery)
  // visibly answered in its own thread. Before the ack: a dropped redelivery
  // already wears the first handling's 👀.
  const drop = await dedupeDelivery(client, ev);
  if (drop) {
    console.log(`[redelivery] ${ev.channel}:${ev.ts} dropped: ${drop}`);
    span.setAttrs({ dedupe: "duplicate" });
    return undefined;
  }
  span.setAttrs({ dedupe: "fresh", caughtUp: ev.caughtUp === true, files: ev.files?.length ?? 0 });
  // Immediate receipt: react to the triggering message so the sender knows it
  // was accepted, before any model/tool work starts. Fire-and-forget — a
  // missing reactions:write scope (or a re-run reacting twice) must never
  // block or fail the request itself.
  client.reactions.add({ channel: ev.channel, timestamp: ev.ts, name: ACK_EMOJI }).catch((err: Error) => {
    if (!err.message.includes("already_reacted")) console.error(`[ack] ${err.message}`);
  });
  // A replayed message says how late the pickup was — best-effort, like the
  // ack, and overlapped with the file downloads (one Slack round-trip, not a
  // serial one). Awaited before dispatch so the note precedes the run card.
  const delayNote = ev.caughtUp
    ? new SlackIO(client, ev).reply(catchUpDelayNote(ev.ts, systemClock())).catch((err: Error) => {
        console.error(`[catch-up] ${ev.channel}:${ev.ts} delay note failed: ${err.message}`);
      })
    : Promise.resolve();
  // Independent budgets, independent downloads — the two passes overlap.
  const [{ images, skipped: skippedImages }, { documents, skipped: skippedDocs }] = await Promise.all([
    fetchImages(ev.files, MAX_IMAGES_PER_MESSAGE),
    fetchDocuments(ev.files, MAX_DOCS_PER_MESSAGE),
    delayNote,
  ]);
  // A file is genuinely unsupported only when BOTH passes rejected it — the
  // image pass skips every non-image (PDFs, text) and the document pass skips
  // every non-document (images), so their intersection is exactly the files
  // that are neither a usable image nor a usable document.
  const skipped = skippedImages.filter((s) => skippedDocs.includes(s));
  // Human display names for the run label — best-effort and cached: a failed
  // lookup leaves the field undefined (the label falls back to the raw id) and
  // never fails the dispatch. Resolved in parallel so the two lookups don't add
  // up on the first message for a new channel/user.
  const [channelName, userName, team] = await Promise.all([
    resolveChannelName(client, ev.channel),
    resolveUserName(client, ev.user),
    resolveTeamUrl(client),
  ]);
  // Tell the model about attachments it can't see, so it never claims an
  // attached file simply didn't come through.
  const note =
    skipped.length > 0
      ? `\n\n(Note: ${skipped.length} attachment(s) could not be passed through: ${skipped.join(", ")})`
      : "";
  return {
    channelId: `${PLATFORM}:${ev.channel}`,
    userId: `${PLATFORM}:${ev.user}`,
    threadKey: `${PLATFORM}:${ev.channel}:${ev.threadTs}`,
    text: ev.text + note,
    channelName,
    userName,
    sourceUrl: team ? slackPermalink(team, ev.channel, ev.ts, ev.threadTs) : undefined,
    images: images.length > 0 ? images : undefined,
    documents: documents.length > 0 ? documents : undefined,
  };
}

/** Exported for tests. */
/** The channel IO for a run resumed after a restart (docs/reference/specs/run-history.md
 *  item 38): the thread from the ledger row's `threadKey`, the requester from
 *  its meta, and the card it already has. There is no triggering event — the
 *  message that started the run was handled by the previous generation. */
export function resumeSlackIO(
  client: SlackClient,
  run: { channel: string; threadTs: string; user: string; cardTs?: string; botUserId?: string },
  opts: { statusClient?: SlackClient; statusBudget?: StatusBudget } = {},
): SlackIO {
  return new SlackIO(
    client,
    {
      channel: run.channel,
      user: run.user,
      text: "",
      ts: run.threadTs,
      threadTs: run.threadTs,
      botUserId: run.botUserId,
    },
    { ...opts, ...(run.cardTs ? { existingCard: { ts: run.cardTs } } : {}) },
  );
}

export class SlackIO implements ChannelIO {
  constructor(
    private client: SlackClient,
    private ev: SlackEvent,
    /** `existingCard`: the status message a resumed run already has in the
     *  thread (docs/reference/specs/run-history.md item 38) — `status()` edits it instead
     *  of posting a second card. `statusClient`: where card edits go (default
     *  `client`; production passes `createStatusClient`'s). `statusBudget`: the
     *  edit budget drawn from (default the process's one). */
    private opts: { existingCard?: { ts: string }; statusClient?: SlackClient; statusBudget?: StatusBudget } = {},
  ) {}

  async reply(text: string): Promise<void> {
    await this.post(mdToMrkdwn(text));
  }

  /** Long command output as a file in the thread: Slack renders an uploaded
   *  `.md` as formatted Markdown in a collapsed preview with an expand control
   *  — one message instead of a run of 3500-char chunks. Needs the `files:write` scope; a
   *  failed upload (scope missing, API error) falls back to the chunked reply
   *  so the output always arrives. */
  async attach(file: { name: string; text: string; lead: string }): Promise<void> {
    try {
      await this.client.files.uploadV2({
        channel_id: this.ev.channel,
        thread_ts: this.ev.threadTs,
        filename: file.name,
        title: file.name,
        content: file.text,
        initial_comment: mdToMrkdwn(file.lead),
      });
    } catch (err) {
      console.warn(`[slack] attach failed (${err instanceof Error ? err.message : String(err)}) — replying as text`);
      await this.post(mdToMrkdwn(`${file.lead}\n${file.text}`));
    }
  }

  private async post(mrkdwn: string): Promise<void> {
    for (const chunk of chunkText(mrkdwn, SLACK_MSG_LIMIT)) {
      await this.client.chat.postMessage({
        channel: this.ev.channel,
        thread_ts: this.ev.threadTs,
        text: chunk,
      });
    }
  }

  /** A child run's thread of its own (docs/reference/specs/slack-channel.md item
   *  11): the lead is posted top-level in this conversation's channel — a
   *  Slack thread hangs off a top-level message, never off a reply — and the
   *  thread's IO is built from the posted `ts` the way `resumeSlackIO` builds
   *  one from a row's parts: the same requester, the same clients and budget,
   *  no triggering event. The permalink rides as the thread's `sourceUrl` when
   *  the team URL is known. */
  async openThread(lead: string): Promise<OpenedThread> {
    const posted = await this.client.chat.postMessage({ channel: this.ev.channel, text: mdToMrkdwn(lead) });
    // The thread is keyed by the lead's `ts`: an answer without one is refused
    // by name (the spawn relays it as `spawn_failed`), never a thread on `undefined`.
    const ts = posted.ts;
    if (typeof ts !== "string" || ts === "")
      throw new Error(
        `[slack] chat.postMessage answered without a ts for the child thread's lead in ${this.ev.channel}`,
      );
    const team = await resolveTeamUrl(this.client);
    const io = new SlackIO(
      this.client,
      { channel: this.ev.channel, user: this.ev.user, text: "", ts, threadTs: ts, botUserId: this.ev.botUserId },
      { statusClient: this.opts.statusClient, statusBudget: this.opts.statusBudget },
    );
    return {
      thread: {
        threadKey: `${PLATFORM}:${this.ev.channel}:${ts}`,
        ...(team ? { sourceUrl: slackPermalink(team, this.ev.channel, ts, ts) } : {}),
      },
      io,
    };
  }

  async status(initial: StatusUpdate): Promise<StatusHandle> {
    // Card edits and the shimmer ride the status client and draw from the
    // process budget (docs/reference/specs/run-visibility.md item 8); the card's post
    // and a resumed card's first edit stay on the main client — they must land.
    const statusClient = this.opts.statusClient ?? this.client;
    const budget = this.opts.statusBudget ?? processStatusBudget;
    // Native Slack shimmer: rotating loading phrases shown inline in the
    // thread ("Switchboard is <phrase>"). Works in channel threads since
    // March 2026 with chat:write; auto-clears when the bot replies, times out
    // after ~2 min idle, so re-up every 75s during long turns.
    const setShimmer = () =>
      statusClient.assistant.threads
        .setStatus({
          channel_id: this.ev.channel,
          thread_ts: this.ev.threadTs,
          status: LOADING_PHRASES[0],
          loading_messages: LOADING_PHRASES,
        })
        .catch((err: Error) => console.error(`[shimmer] ${err.message}`));

    // Post the activity card FIRST: any bot message in the thread auto-clears
    // the inline status, so the shimmer must be set after the card exists
    // (edits to the card don't clear it; only new messages do). A resumed run
    // keeps the card the previous generation posted: edited in place, so the
    // thread shows one card whose frames carry on.
    let ts: string | undefined;
    if (this.opts.existingCard) {
      // A card the previous generation posted may have been deleted since; a
      // failed edit falls back to a fresh card rather than a run with none.
      const existing = this.opts.existingCard.ts;
      const edited = await this.client.chat
        .update({ channel: this.ev.channel, ts: existing, ...render(initial) })
        .then(() => true)
        .catch((err: Error) => {
          console.warn(
            `[slack] resumed run's card ${this.ev.channel}:${existing} not editable (${err.message}) — posting a fresh card`,
          );
          return false;
        });
      if (edited) ts = existing;
    }
    if (ts === undefined) {
      const posted = await this.client.chat.postMessage({
        channel: this.ev.channel,
        thread_ts: this.ev.threadTs,
        ...render(initial),
      });
      ts = posted.ts as string;
    }
    await setShimmer();
    const shimmerTimer = setInterval(() => void setShimmer(), 75_000);
    liveCards.add(liveCardKey(this.ev.channel, ts));
    const card = `${this.ev.channel}:${ts}`;
    budget.open(card);
    const edit = (frame: StatusUpdate) => statusClient.chat.update({ channel: this.ev.channel, ts, ...render(frame) });
    // Progress frames the budget refused: the card was stale until the next
    // heartbeat that got a token. Counted for the close's log line.
    let dropped = 0;
    // The terminal frame is the one a reader waits for, so it is never dropped:
    // a 429 is re-sent after Slack's Retry-After, up to TERMINAL_RESENDS times,
    // on unref'd timers off the reply's path (a process exiting first leaves the
    // card to the orphan sweep).
    const sendTerminal = async (frame: StatusUpdate, attempt: number): Promise<void> => {
      try {
        await edit(frame);
      } catch (err) {
        const retryAfter = retryAfterSeconds(err);
        if (retryAfter === undefined || attempt >= TERMINAL_RESENDS) {
          console.warn(
            `[slack] card ${card}: terminal frame not painted (${describeError(err)}) after ${attempt + 1} attempts`,
          );
          return;
        }
        setTimeout(() => void sendTerminal(frame, attempt + 1), retryAfter * 1000).unref();
      }
    };
    return {
      handle: { channel: this.ev.channel, ts },
      update: (frame) => {
        if (!budget.tryProgress(card, this.ev.channel)) {
          dropped++;
          return;
        }
        // A rate-limited or failed progress edit is dropped: the next frame repaints.
        void edit(frame).catch(() => {});
      },
      done: async (frame) => {
        clearInterval(shimmerTimer);
        liveCards.delete(liveCardKey(this.ev.channel, ts));
        budget.close(card);
        // Funded now: one round trip before the reply, the common case. Not
        // funded: the edit goes out when the budget says, and the reply does not wait.
        const waitMs = budget.takeTerminal(this.ev.channel);
        if (waitMs === 0) await sendTerminal(frame, 0);
        else {
          console.warn(`[slack] card ${card}: terminal frame waits ${waitMs} ms for the status budget`);
          setTimeout(() => void sendTerminal(frame, 0), waitMs).unref();
        }
        if (dropped > 0) console.log(`[slack] card ${card}: ${dropped} progress frames dropped by the status budget`);
        // reply auto-clears the shimmer; clear explicitly for error paths
        await statusClient.assistant.threads
          .setStatus({ channel_id: this.ev.channel, thread_ts: this.ev.threadTs, status: "" })
          .catch(() => {});
      },
    };
  }

  async history(): Promise<HistoryItem[]> {
    const items: HistoryItem[] = [];
    try {
      // A follow-up handler already read this thread to decide the bot is in
      // it (`threadIfBotInIt`) — that page is the same call with the same
      // arguments, so it is reused instead of fetched a second time.
      const thread =
        this.ev.thread ??
        (
          await this.client.conversations.replies({
            channel: this.ev.channel,
            ts: this.ev.threadTs,
            limit: 50,
          })
        ).messages ??
        [];
      const kept: { role: "user" | "assistant"; text: string; files?: SlackFile[] }[] = [];
      for (const m of thread) {
        const mm = m as { bot_id?: string; text?: string; ts?: string; files?: SlackFile[] };
        // Skip the triggering message itself; the dispatcher appends it
        // (directive-stripped, images included) as the current turn.
        if (mm.ts === this.ev.ts) continue;
        const raw = mm.text ?? "";
        const text = this.ev.botUserId ? raw.replaceAll(`<@${this.ev.botUserId}>`, "").trim() : raw;
        if (STATUS_PREFIXES.some((p) => text.startsWith(p))) continue;
        const files = mm.bot_id ? undefined : mm.files; // only user attachments go to the model
        if (!text && !files?.length) continue;
        kept.push({ role: mm.bot_id ? "assistant" : "user", text, files });
      }
      // Download attachments newest-first so each thread-wide budget favors the
      // most recent files when a long thread overflows it. Images and documents
      // draw from independent budgets — one pool can't starve the other.
      const imagesByIndex: (ImageAttachment[] | undefined)[] = [];
      const documentsByIndex: (DocumentAttachment[] | undefined)[] = [];
      let imagesLeft = MAX_HISTORY_IMAGES;
      let imageBytesLeft = MAX_HISTORY_IMAGE_BYTES;
      let docsLeft = MAX_HISTORY_DOCS;
      let docBytesLeft = MAX_HISTORY_DOCUMENT_BYTES;
      // Messages stay sequential (each one's downloads decide the budget left
      // for the next); within a message the image and document passes run
      // concurrently — independent budgets — and each pass downloads its files
      // concurrently.
      for (let i = kept.length - 1; i >= 0; i--) {
        const files = kept[i].files;
        if (!files?.length) continue;
        const [imagePass, docPass] = await Promise.all([
          imagesLeft > 0 && imageBytesLeft > 0
            ? fetchImages(files, Math.min(MAX_IMAGES_PER_MESSAGE, imagesLeft), imageBytesLeft)
            : undefined,
          docsLeft > 0 && docBytesLeft > 0
            ? fetchDocuments(files, Math.min(MAX_DOCS_PER_MESSAGE, docsLeft), docBytesLeft)
            : undefined,
        ]);
        if (imagePass) {
          imagesLeft -= imagePass.images.length;
          imageBytesLeft -= imagePass.bytes;
          if (imagePass.images.length > 0) imagesByIndex[i] = imagePass.images;
        }
        if (docPass) {
          docsLeft -= docPass.documents.length;
          docBytesLeft -= docPass.bytes;
          if (docPass.documents.length > 0) documentsByIndex[i] = docPass.documents;
        }
      }
      for (let i = 0; i < kept.length; i++) {
        const { role, text } = kept[i];
        const images = imagesByIndex[i];
        const documents = documentsByIndex[i];
        // attachment-only turn whose downloads all failed
        if (!text && !images && !documents) continue;
        items.push({ role, text, images, documents });
      }
    } catch {
      // best-effort; the dispatcher still has the current message
    }
    return items;
  }
}

function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  chunks.push(rest);
  return chunks;
}

/**
 * Is the bot already part of this thread — has it posted in it, or been
 * mentioned anywhere in it? Checked per follow-up (one replies call) so
 * participation survives restarts — no in-memory thread registry to lose.
 * Answers with the thread's messages when it is (else undefined): that page is
 * handed on to `SlackIO.history()` so a follow-up costs ONE
 * `conversations.replies`, not two identical ones.
 */
async function threadIfBotInIt(
  client: SlackClient,
  channel: string,
  threadTs: string,
  botUserId?: string,
): Promise<SlackThreadMessage[] | undefined> {
  if (!botUserId) return undefined;
  try {
    const replies = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    const messages = (replies.messages ?? []) as SlackThreadMessage[];
    return threadIncludesBot(messages, botUserId) ? messages : undefined;
  } catch {
    return undefined; // can't read the thread => stay quiet
  }
}

/** Slack appends "*Sent using* <@APP|Name>" as the LAST line of a message an
 *  app posts on a user's behalf (the Claude Slack plugin does this). It is
 *  platform chrome, not the user's words — left in, it breaks strict inline
 *  parsers (`repo onboard …` saw `*Sent` as a bad token). Only whole trailing
 *  footers of exactly that shape are removed (repeated for stacked footers);
 *  the phrase inside a user's own text is untouched. The footer is anchored to
 *  the END of the text, not to its own line: the raw event text arrives as
 *  `friction report *Sent using* <@UAPP>` — same line, no newline — so a
 *  line-anchored regex lets `*Sent` reach the command parser (`repo list`
 *  masks this because it ignores trailing text). An optional bracketed sender
 *  attribution after the mention is tolerated too. */
const APP_FOOTER_RE = /(?:^|\s)(?:\*Sent using\*|Sent using)\s+<@[A-Z0-9]+(?:\|[^>]*)?>(?:\s*\[[^\]\n]*\])?\s*$/;

/** Exported for tests. */
export function stripMention(text: string, botUserId?: string): string {
  const stripped = botUserId ? text.replaceAll(`<@${botUserId}>`, "") : text.replace(/<@[A-Z0-9]+>/, "");
  // Exactly the two shapes Slack emits (bold or plain — never asymmetric), as
  // a whole trailing line; repeated because a forwarded app message can stack
  // two, and a message that is nothing but mention + footer strips to "".
  let out = stripped.trim();
  let prev: string;
  do {
    prev = out;
    out = out.replace(APP_FOOTER_RE, "").trim();
  } while (out !== prev);
  return out;
}
