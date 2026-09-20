import {
  App,
  SocketModeReceiver,
  webApi,
  type BlockAction,
  type ButtonAction,
  type SlackActionMiddlewareArgs,
  type types as slackTypes,
} from "@slack/bolt";
import { dispatch, dispatchClick, type CoreDeps } from "../core/dispatcher.js";
import { chatActorOf } from "../core/authz/actor.js";
import {
  decideIntake as coreDecideIntake,
  degradedIntakeLine,
  type IntakeDeps,
  type IntakeFacts,
  type IntakeReceipt,
  type IntakeTurn,
} from "../core/intake.js";
import { readThread, requesterOf } from "../core/dispatch/thread.js";
import { pendingQuestionOf } from "../core/dispatch/operator.js";
import type { RunView, RunsService } from "../core/runsService.js";
import type { ConfirmationStore } from "../core/confirmations.js";
import type { IntakeMode } from "../config/validate.js";
import { renderOffer } from "../core/confirmations.js";
import { type SlackThreadMessage, stripAppFooter, threadTurns } from "./slack/threadTurns.js";
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
import { escapeMrkdwn } from "./slackEscape.js";
import { classifyMessage, threadIncludesBot } from "./slackTriggers.js";
import {
  fetchDocuments,
  fetchImages,
  stagedFiles,
  MAX_DOCS_PER_MESSAGE,
  MAX_HISTORY_DOCS,
  MAX_HISTORY_DOCUMENT_BYTES,
  MAX_HISTORY_IMAGE_BYTES,
  MAX_HISTORY_IMAGES,
  MAX_IMAGES_PER_MESSAGE,
  type SlackFile,
} from "./slack/attachments.js";
import { dedupeDelivery, markHandledHere, wasHandledHere } from "./slack/dedupe.js";
import { resolveChannelName, resolveTeamUrl, resolveUserName, slackPermalink } from "./slack/lookups.js";
import { rawTextOf, resolveSlackRequester, type SlackBlock, type SlackPoster } from "./slack/requester.js";
import { isLiveCard, liveCardKey, liveCards, refreshForeignLiveCards, render } from "./slack/statusCard.js";
import { ACK_EMOJI, catchUpMissedMentions, tsMs, type MissedMessage } from "./slackCatchUp.js";
import { processSecrets, type Secret } from "../secrets.js";
import { ARTIFACT_DEFAULTS } from "../artifacts/config.js";
import { missingBotScopes, recordCatchUpOutcome, recordMissingScopes } from "./slackCatchUpStatus.js";
import { recordSocketConnected, recordSocketDisconnected } from "./slackSocketStatus.js";
export { classifyMessage, threadIncludesBot, type MessageDecision } from "./slackTriggers.js";
import type {
  ChannelIO,
  ConfirmationOffer,
  DocumentAttachment,
  HistoryItem,
  ImageAttachment,
  IncomingMessage,
  OpenedThread,
  StatusHandle,
  StatusUpdate,
  UploadTicket,
} from "../core/types.js";

// Slack channel adapter: pure transport. Wires Bolt (Socket Mode) events into
// the core dispatcher and implements ChannelIO on top of the Slack Web API.
// No routing, config, or agent logic lives here.

type SlackClient = webApi.WebClient;
/** A Block Kit block as the Web API takes it: one of the known shapes, or any block by `type`. */
type SlackBlockKit = slackTypes.KnownBlock | slackTypes.Block;

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
/** Block Kit's cap on one section's text — the offer message's completion is one section. */
const SLACK_SECTION_LIMIT = 3000;

/** What the offer message reads when the adapter itself could not carry the
 *  click into the core or its answer back — the core's own refusals are its
 *  named lines (dispatch/confirm.ts); this one is the adapter's. The line stays
 *  on the message above it, so the person can still type it. */
export const CLICK_FAILED_LINE = "this click could not be handled; type the line to run it";

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

/** Which run's status handle speaks for each thread's inline shimmer
 *  (`channel:threadTs` → the owning card's `channel:ts`). Slack keeps ONE
 *  status per thread, so with two runs in one thread (a plan runner's coding
 *  child finishing while its review child starts) the newest run to start owns
 *  the shimmer: a finished sibling's close must not wipe the live run's
 *  "working" status, and a run that still owns the shimmer clears it the moment
 *  it is done — the thread stops saying the bot is working for that run at
 *  once, its card closed to its done state right above the write-up. An entry
 *  is shed by its owner's `done`; a run killed before `done` leaves its
 *  thread's entry until the next run in the thread overwrites it or the
 *  process restarts — one key/card string pair per thread, so the leak is
 *  bounded by the threads a process ever spoke in. */
const shimmerOwners = new Map<string, string>();

export function createSlackApp(deps: CoreDeps, intake?: SlackIntakeGate) {
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
          // Candidates a receipt (or a fresh verdict) silenced — read, never
          // re-run — counted here so the root says why `missed` outnumbers the
          // runs (item 7).
          let silenced = 0;
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
            // The runner awaits only the hand-off — the receipt read and the
            // verdict — never the run: a run takes minutes and live events run
            // concurrently too (`actOnMissedMessage`'s dispatch fires and forgets).
            onMissed: async (m) => {
              const act = await actOnMissedMessage(m, {
                botUserId: id,
                ...(intake ? { intake } : {}),
                dispatch: (extra) => {
                  void handle(
                    deps,
                    { client: app.client, statusClient },
                    {
                      channel: m.channel,
                      user: m.user,
                      text: stripMention(m.text, id),
                      ts: m.ts,
                      threadTs: m.threadTs,
                      files: m.files,
                      botUserId: id,
                      caughtUp: true,
                      // Truthful label: the scan replays mentions AND plain
                      // thread replies in bot-participating threads (item 7,
                      // `findMissed`); a gated replay carries `intakeDecided`
                      // so the gate never decides it twice.
                      ...extra,
                    },
                    intake,
                  ).catch((err: Error) => console.error(`[catch-up] ${m.channel}:${m.ts}: ${err.message}`));
                },
              });
              if (act === "silenced") silenced++;
            },
          });
          root.setAttrs({
            channels: result.channels,
            missed: result.missed,
            silenced,
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
    // An app's post that mentions the bot arrives here with no `user`: the
    // poster rides along and the requester is resolved from it (item 13).
    const posted = event as {
      bot_id?: string;
      username?: string;
      bot_profile?: { name?: string };
      blocks?: SlackBlock[];
    };
    await handle(
      deps,
      { client, statusClient },
      {
        channel: event.channel,
        user: event.user,
        poster: posterOf(posted),
        rawText: rawTextOf(event.text, posted.blocks),
        text: stripMention(event.text ?? "", botUserId),
        ts: event.ts,
        threadTs: event.thread_ts ?? event.ts,
        files: (event as { files?: SlackFile[] }).files,
        botUserId,
        trigger: "mention",
      },
      intake,
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
        user: m.user,
        poster: posterOf(m),
        rawText: rawTextOf(m.text, (m as { blocks?: SlackBlock[] }).blocks),
        text: stripMention(m.text ?? "", botUserId),
        ts: m.ts,
        threadTs: m.thread_ts ?? m.ts,
        files: m.files,
        botUserId,
        thread,
        trigger: decision === "handle-if-bot-in-thread" ? "thread-follow-up" : "dm",
      },
      intake,
    );
  });

  // A click on a confirmation's Run or Cancel (docs/reference/specs/slack-channel.md
  // item 14). Over Socket Mode a `block_actions` payload arrives on the same
  // connection as the events, once the Slack app's interactivity is on; the
  // handler acks first and hands the core the id, the actor and the handle.
  app.action<BlockAction<ButtonAction>>(/^confirm\./, ({ ack, body, action, client }) =>
    handleConfirmClick(deps, { client, statusClient }, { ack, body, action }, botUserId),
  );

  // The receiver rides along for the Bolt-level wiring test: emitting
  // `connected` on `receiver.client` is exactly what a real reconnect does, so
  // the test can drive the hook without a live socket. Production
  // (src/index.ts) uses only `app`.
  return { app, receiver, statusClient };
}

/** The app behind a message with no `user`, as Slack names it. */
function posterOf(m: { bot_id?: string; username?: string; bot_profile?: { name?: string } }): SlackPoster | undefined {
  if (!m.bot_id && !m.username && !m.bot_profile?.name) return undefined;
  const name = m.username ?? m.bot_profile?.name;
  return { ...(m.bot_id !== undefined ? { botId: m.bot_id } : {}), ...(name !== undefined ? { name } : {}) };
}

interface SlackEvent {
  channel: string;
  /** The sender, when a person posted the message; absent on an app's post (`poster` says which). */
  user?: string;
  poster?: SlackPoster;
  /** The text as Slack delivered it, footers included — the requester's relay footer is read from it. */
  rawText?: string;
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
  /** What fired this event: a mention, a DM, or an unmentioned thread
   *  follow-up — the one trigger the intake gate reads (record 0058). Absent
   *  on an IO built without a triggering event (a resume, a click, a child
   *  thread's lead), which never passes through `receiveSlackMessage`. */
  trigger?: "mention" | "dm" | "thread-follow-up";
  /** Set when a stored receipt — or the catch-up's own verdict over the paged
   *  thread — already decided this message (`actOnMissedMessage`, item 7); the
   *  gate never decides it twice. */
  intakeDecided?: true;
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

/** What the catch-up's act did with one missed message (docs/reference/specs/slack-channel.md item 7). */
export type CaughtUpAct = "dispatched" | "silenced" | "skipped";

/**
 * The catch-up's act for one missed message, before `handle()` (item 7, the
 * catch-up half of item 15). A candidate with a mention — including an edit
 * that gained one, which arrives as a subtype the live path skips — and one in
 * an `always` thread are dispatched exactly as today, no receipt read. Any
 * other unmentioned follow-up gets its stored receipt read first: a `silent`
 * row marks the pair seen and is counted under `silenced` on the
 * `slack.catch_up` root — read, never re-run; an `addressed` row dispatches
 * the replay with `intakeDecided`, so the gate never decides it twice; no row
 * (a failing read decides as if none) runs `decideIntake` over the thread's
 * tail the scan already paged (`MissedMessage.thread`) and proceeds by the
 * stored verdict. The seen-set is re-checked AFTER the read — the scan's
 * `alreadyHandled` ran at scan time and the read awaited since, so a live
 * claim that landed in between owns the message: skipped, never run twice.
 */
export async function actOnMissedMessage(
  m: MissedMessage,
  opts: {
    botUserId: string;
    intake?: SlackIntakeGate;
    /** Dispatch through `handle()` — fire-and-forget, like a live event. */
    dispatch: (extra: { trigger: "mention" | "thread-follow-up"; intakeDecided?: true }) => void;
    /** The same-process seen-set; the module-level one unless a test injects its own. */
    seen?: { was(channel: string, ts: string): boolean; mark(channel: string, ts: string): void };
    log?: (line: string) => void;
  },
): Promise<CaughtUpAct> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const seen = opts.seen ?? { was: wasHandledHere, mark: markHandledHere };
  // An edit that gained a mention is a mention, whatever an older receipt says.
  const mention = m.text.includes(`<@${opts.botUserId}>`);
  let silent = false;
  let decided = false;
  if (!mention && opts.intake) {
    const intake = opts.intake;
    const threadKey = `${PLATFORM}:${m.channel}:${m.threadTs}`;
    const mode = intake.intakeModeFor(
      threadKey,
      m.user !== undefined ? `${PLATFORM}:${m.user}` : undefined,
      `${PLATFORM}:${m.channel}`,
    );
    if (mode !== "always") {
      const key = `${m.channel}:${m.ts}`;
      let row: IntakeReceipt | undefined;
      try {
        row = await intake.deps.ledger?.readIntake(key);
      } catch (err) {
        log(`[catch-up] ${key}: receipt read failed — ${describeError(err)}; deciding as if none`);
      }
      if (row) {
        decided = true;
        silent = row.verdict === "silent";
        if (silent) log(`[catch-up] ${key}: silenced by its stored receipt (${row.source}): ${row.reason}`);
      } else {
        const page = m.thread;
        const { turns, facts } = await intakeEvidence(
          intake,
          threadKey,
          { ts: m.ts, threadTs: m.threadTs, user: m.user, botUserId: opts.botUserId, text: m.text },
          page,
        );
        const decision = await intake.decideIntake(
          {
            key,
            threadKey,
            mode,
            model: intake.modelRef,
            gen: intake.gen,
            message: stripMention(m.text, opts.botUserId),
            turns,
            facts,
          },
          intake.deps,
        );
        log(
          `[intake] ${key} ${decision.verdict} (${decision.source}, receipt ${decision.receipt}): ${decision.reason} — decided at catch-up`,
        );
        decided = true;
        silent = decision.verdict !== "addressed";
      }
    }
  }
  // Re-checked after the read: a live claim that landed since the scan owns it.
  if (seen.was(m.channel, m.ts)) {
    log(`[catch-up] ${m.channel}:${m.ts}: skipped — handled live since the scan`);
    return "skipped";
  }
  if (silent) {
    seen.mark(m.channel, m.ts);
    return "silenced";
  }
  opts.dispatch({
    trigger: mention ? "mention" : "thread-follow-up",
    ...(decided ? { intakeDecided: true as const } : {}),
  });
  return "dispatched";
}

async function handle(
  deps: CoreDeps,
  { client, statusClient }: SlackClients,
  ev: SlackEvent,
  intake?: SlackIntakeGate,
): Promise<void> {
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
    const received = await trace.root.span("slack.receive", (span) =>
      receiveSlackMessage(
        client,
        ev,
        span,
        {
          staging: deps.artifacts !== undefined,
          maxBytesPerMessage:
            deps.config.config.artifacts?.inbound?.maxBytesPerMessage ?? ARTIFACT_DEFAULTS.maxBytesPerMessage,
        },
        relayAppsOf(deps),
        intake,
      ),
    );
    if (!received) {
      trace.root.end("ok", { status: "refused" });
      return;
    }
    await dispatch(
      deps,
      { ...received.message, receivedAt, originAt: tsMs(ev.ts) },
      new SlackIO(client, ev, { statusClient }),
      // The runs page the gate read rides on (record 0058, R2): the dispatcher
      // uses it in place of its own thread read, one page per reply.
      { trace, ...(received.thread ? { thread: received.thread } : {}) },
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
/** Whether files the inline path cannot carry are staged by reference
 *  (record 0033) — on exactly when the artifact store is configured — and the
 *  per-message byte budget they share (`artifacts.inbound.maxBytesPerMessage`). */
export interface StagingPolicy {
  staging: boolean;
  maxBytesPerMessage: number;
}

/** The operator's `slack.relayApps` — the bot ids whose relay footer names the
 *  requester (item 13); none configured means no footer is honoured. */
function relayAppsOf(deps: CoreDeps): readonly string[] {
  return deps.config.config.slack?.relayApps ?? [];
}

/** What the thread-reply intake gate runs on (record 0058; docs/reference/specs/
 *  slack-channel.md item 15), wired by the composition root (`wireIntakeGate`
 *  in src/index.ts) and handed whole by tests: the mode resolver
 *  (`config.intakeModeFor`), the verdict seam (the core's `decideIntake`,
 *  injectable so tests script it), what it runs on (`deps`: the fast model
 *  behind the router's seam, the receipt ledger or null, the clock), the
 *  receipt row's model ref and process generation, and the two best-effort
 *  reads the facts come from — the runs service and the confirmation store. */
export interface SlackIntakeGate {
  intakeModeFor(threadKey: string, userId: string | undefined, channelId: string): IntakeMode;
  decideIntake: typeof coreDecideIntake;
  deps: IntakeDeps;
  /** The resolved `<provider>/<model>` ref the verdict runs on, for the receipt row. */
  modelRef: string;
  /** The deciding process's generation counter, for the receipt row. */
  gen: number;
  /** The thread's runs page: the live-run fact, the requester, and the page
   *  handed on to `dispatch()` so it is read once per reply (R2). */
  runs?: Pick<RunsService, "listRuns">;
  /** The pending confirmation in this thread, for the facts. */
  confirmations?: Pick<ConfirmationStore, "pendingByThread">;
}

/** The gate as production wires it: the core's `decideIntake` bound in, and
 *  the degraded startup line printed exactly once when the process runs
 *  without a receipt ledger — verdicts are still made, addressed replies
 *  still run (record 0058: degrade, never fall silent). */
export function wireIntakeGate(gate: Omit<SlackIntakeGate, "decideIntake">): SlackIntakeGate {
  if (gate.deps.ledger === null) console.warn(degradedIntakeLine());
  return { decideIntake: coreDecideIntake, ...gate };
}

/** What the adapter hands `dispatch()`: the message, and — when the gate read
 *  it — the thread's runs page, used in place of the dispatcher's own read. */
export interface ReceivedSlackMessage {
  message: Omit<IncomingMessage, "receivedAt" | "originAt">;
  thread?: RunView[];
}

/** How many of the thread's newest turns the verdict sees (record 0058). */
const INTAKE_TURNS = 12;
/** The page `threadIfBotInIt` fetches; a page this full may not be the thread's end. */
const THREAD_PAGE_LIMIT = 50;
/** How many more `conversations.replies` pages the gate follows toward a long
 *  thread's end (replies page oldest-first) before judging over what it has. */
const INTAKE_TAIL_PAGES = 5;

export async function receiveSlackMessage(
  client: SlackClient,
  ev: SlackEvent,
  span: Span,
  policy: StagingPolicy,
  relayApps: readonly string[],
  intake?: SlackIntakeGate,
): Promise<ReceivedSlackMessage | undefined> {
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
  // The gate before the 👀 (record 0058; item 15): an unmentioned reply in a
  // bot thread gets its verdict after the guard's claim and before anything
  // visible or costly — the ack, the note, the downloads — so `silent`
  // produces nothing and downloads nothing. Only this trigger passes through
  // it: a mention, a DM and a top-level post are addressed by construction,
  // and a message a stored receipt already decided (`intakeDecided`) is never
  // decided twice — the catch-up's act reads the receipt (or decides itself)
  // and sets the flag on every gated replay it dispatches (item 7), so a
  // caught-up reply reaches this gate only when it arrived undecided (a mode
  // flip between the scan and the act), and deciding it fresh is then right.
  // `always` never reaches intake and never touches the ledger: today's path
  // byte for byte.
  let threadRuns: RunView[] | undefined;
  if (intake && ev.trigger === "thread-follow-up" && !ev.intakeDecided) {
    const threadKey = `${PLATFORM}:${ev.channel}:${ev.threadTs}`;
    const mode = intake.intakeModeFor(
      threadKey,
      ev.user !== undefined ? `${PLATFORM}:${ev.user}` : undefined,
      `${PLATFORM}:${ev.channel}`,
    );
    if (mode !== "always") {
      const gated = await gateThreadReply(client, ev, span, intake, mode, threadKey);
      if (!gated.proceed) return undefined;
      threadRuns = gated.thread;
    }
  }
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
  const [{ images, skippedFiles: imagePassSkipped }, { documents, skippedFiles: documentPassSkipped }] =
    await Promise.all([
      fetchImages(ev.files, MAX_IMAGES_PER_MESSAGE),
      fetchDocuments(ev.files, MAX_DOCS_PER_MESSAGE),
      delayNote,
    ]);
  // A file is genuinely unsupported only when BOTH passes rejected it — the
  // image pass skips every non-image (PDFs, text) and the document pass skips
  // every non-document (images), so their intersection is exactly the files
  // that are neither a usable image nor a usable document.
  const unsupported = imagePassSkipped.filter((f) => documentPassSkipped.includes(f));
  // With a store configured (record 0033) the files neither pass could carry
  // stay on Slack by reference for a run with a workspace to stage; the rest
  // are the ones the note below names, each with its reason.
  const { staged, skipped } = stagedFiles(unsupported, { ...policy, messageId: ev.ts });
  // Human display names for the run label — best-effort and cached: a failed
  // lookup leaves the field undefined (the label falls back to the raw id) and
  // never fails the dispatch. Resolved in parallel so the two lookups don't add
  // up on the first message for a new channel/user.
  // Who asked (item 13): the sender, or the person the configured relay app
  // posted for — read before the name lookups, which take the resolved person.
  // A person's post resolves without a call; an older relay footer costs one
  // `conversations.replies`.
  const requester = await resolveSlackRequester(
    client,
    {
      channel: ev.channel,
      ts: ev.ts,
      threadTs: ev.threadTs,
      ...(ev.user !== undefined ? { user: ev.user } : {}),
      text: ev.rawText ?? ev.text,
      ...(ev.poster !== undefined ? { poster: ev.poster } : {}),
    },
    relayApps,
  );
  span.setAttrs({ requester: requester.resolvedBy });
  const [channelName, userName, team] = await Promise.all([
    resolveChannelName(client, ev.channel),
    requester.slackUserId !== undefined
      ? resolveUserName(client, requester.slackUserId)
      : Promise.resolve(requester.userName),
    resolveTeamUrl(client),
  ]);
  // Tell the model about attachments it can't see, so it never claims an
  // attached file simply didn't come through.
  const note =
    skipped.length > 0
      ? `\n\n(Note: ${skipped.length} attachment(s) could not be passed through: ${skipped.join(", ")})`
      : "";
  return {
    message: {
      channelId: `${PLATFORM}:${ev.channel}`,
      userId: requester.userId,
      ...(requester.relayedBy !== undefined ? { relayedBy: requester.relayedBy } : {}),
      ...(requester.postedBy !== undefined ? { postedBy: requester.postedBy } : {}),
      threadKey: `${PLATFORM}:${ev.channel}:${ev.threadTs}`,
      text: ev.text + note,
      messageId: ev.ts,
      channelName,
      userName,
      sourceUrl: team ? slackPermalink(team, ev.channel, ev.ts, ev.threadTs) : undefined,
      images: images.length > 0 ? images : undefined,
      documents: documents.length > 0 ? documents : undefined,
      ...(staged.length > 0 ? { staged } : {}),
    },
    ...(threadRuns ? { thread: threadRuns } : {}),
  };
}

/**
 * The gate's one decision for an unmentioned thread reply in `mention` or
 * `classify` (record 0058; item 15). Gathers what the verdict sees — the
 * thread's newest turns labelled by user id, the facts only code can compute —
 * calls the seam, stamps the span's three closed keys (`intake`,
 * `intakeSource`, `intakeReceipt`; the reason is free text and stays on the
 * receipt row and the log line), and answers whether the reply proceeds:
 * only an `addressed` verdict whose receipt this caller holds — `inserted`, or
 * the degraded `failed`/`absent` — does; a row another caller stored means the
 * message is already someone's, whatever the verdict reads.
 */
async function gateThreadReply(
  client: SlackClient,
  ev: SlackEvent,
  span: Span,
  intake: SlackIntakeGate,
  mode: "mention" | "classify",
  threadKey: string,
): Promise<{ proceed: boolean; thread?: RunView[] }> {
  // The verdict sees the thread's NEWEST turns: the page `threadIfBotInIt`
  // already fetched covers a thread of 50 replies or fewer; a full page may
  // not be the thread's end — Slack pages replies OLDEST-first (`fetchReplies`
  // in slackCatchUp.ts pages whole threads for the same reason), so a
  // `latest`-bounded page would return the thread's head, not its tail. Cursor
  // forward from the prefetched page's end instead, bounded pages; the
  // `.slice(-INTAKE_TURNS)` below keeps the tail. Best-effort: a failed or
  // truncated fetch judges over what is in hand.
  let page = ev.thread ?? [];
  const lastTs = page[page.length - 1]?.ts;
  if (page.length >= THREAD_PAGE_LIMIT && lastTs !== undefined) {
    try {
      const seen = new Set(page.map((m) => m.ts));
      let cursor: string | undefined;
      for (let p = 0; p < INTAKE_TAIL_PAGES; p++) {
        const res = await client.conversations.replies({
          channel: ev.channel,
          ts: ev.threadTs,
          limit: THREAD_PAGE_LIMIT,
          ...(cursor !== undefined ? { cursor } : { oldest: lastTs, inclusive: false }),
        });
        const fresh = ((res.messages ?? []) as SlackThreadMessage[]).filter((m) => !seen.has(m.ts));
        for (const m of fresh) seen.add(m.ts);
        page = [...page, ...fresh];
        cursor = res.response_metadata?.next_cursor || undefined;
        if (!cursor) break;
      }
    } catch {
      // the tail is an improvement, not a requirement
    }
  }
  const { turns, facts, thread } = await intakeEvidence(intake, threadKey, ev, page, ev.thread ?? page);
  const decision = await intake.decideIntake(
    {
      key: `${ev.channel}:${ev.ts}`,
      threadKey,
      mode,
      model: intake.modelRef,
      gen: intake.gen,
      message: ev.text,
      turns,
      facts,
    },
    intake.deps,
  );
  span.setAttrs({ intake: decision.verdict, intakeSource: decision.source, intakeReceipt: decision.receipt });
  if (decision.verdict !== "addressed" || decision.receipt === "existing") {
    console.log(
      `[intake] ${ev.channel}:${ev.ts} ${decision.verdict} (${decision.source}, receipt ${decision.receipt}): ${decision.reason}`,
    );
    return { proceed: false };
  }
  return { proceed: true, ...(thread ? { thread } : {}) };
}

/** What one verdict sees, assembled from a thread page: the newest turns
 *  labelled bot/requester/person, and the facts only code can compute. The two
 *  store reads only the adapter can ask — the runs page (read ONCE: on the
 *  live path it rides out to dispatch, R2) and the pending confirmation — are
 *  both best-effort: a failed read leaves the fact empty, never blocks the
 *  verdict. `parentPage` is where the thread's parent is looked for (the live
 *  path's prefetched page carries it even when the newest-window fetch does
 *  not). Shared by the live gate (`gateThreadReply`) and the catch-up's act
 *  (`actOnMissedMessage`), so both judge with the same evidence. */
async function intakeEvidence(
  intake: SlackIntakeGate,
  threadKey: string,
  ev: Pick<SlackEvent, "ts" | "threadTs" | "user" | "botUserId" | "rawText" | "text">,
  page: SlackThreadMessage[],
  parentPage: SlackThreadMessage[] = page,
): Promise<{ turns: IntakeTurn[]; facts: IntakeFacts; thread?: RunView[] }> {
  const now = intake.deps.now();
  const [thread, pending] = await Promise.all([
    intake.runs ? readThread(intake.runs, threadKey) : Promise.resolve(undefined),
    intake.confirmations
      ? intake.confirmations.pendingByThread(threadKey).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  const requester = thread ? requesterOf(thread) : undefined;
  // The labeller compares each turn's `user` to the bot's own user id (no role
  // change in `threadTurns`): the bot's posts carry it, a relay app's post
  // carries only the app's bot_id and stays a person's turn.
  const kept = threadTurns(page, { skipTs: ev.ts, botUserId: ev.botUserId }).slice(-INTAKE_TURNS);
  const turns: IntakeTurn[] = kept.map((t) => ({
    role:
      t.user !== undefined && t.user === ev.botUserId
        ? "bot"
        : t.user !== undefined && `${PLATFORM}:${t.user}` === requester
          ? "requester"
          : "person",
    text: t.text,
  }));
  const lastBotTurn = [...kept].reverse().find((t) => t.user !== undefined && t.user === ev.botUserId);
  const live = thread?.find((r) => !r.finished);
  const parent = parentPage.find((m) => m.ts === ev.threadTs);
  const mentioned = [...(ev.rawText ?? ev.text).matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]);
  const facts: IntakeFacts = {
    ...(live
      ? {
          liveRun: {
            agent: live.agent ?? "unknown",
            secondsInFlight: Math.max(0, Math.round((now - live.startedAt) / 1000)),
          },
        }
      : {}),
    replierIsRequester: requester !== undefined && ev.user !== undefined && `${PLATFORM}:${ev.user}` === requester,
    ...(lastBotTurn?.at !== undefined
      ? { botLastSpokeSeconds: Math.max(0, Math.round((now - lastBotTurn.at) / 1000)) }
      : {}),
    mentionsOther: mentioned.some((id) => id !== ev.botUserId),
    ...(pending !== undefined ? { pendingConfirmation: pending.message.userId } : {}),
    threadStartedByBot: parent !== undefined && parent.user !== undefined && parent.user === ev.botUserId,
    // The operator's own question as the thread's last word (issue 2046): the
    // one fact that decides `addressed` without a model turn — the bot asked,
    // so a reply in its own thread is addressed to it, mention or none.
    ...(pendingQuestionOf(thread) !== undefined ? { pendingQuestion: true } : {}),
  };
  return { turns, facts, ...(thread ? { thread } : {}) };
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

/** The offer message a click landed on, as the `block_actions` payload carries
 *  it back: its `ts`, its plain-text fallback and its blocks — what the click's
 *  answer completes in place (`SlackIO.reply`, the first time). */
export interface OfferMessage {
  ts: string;
  text: string;
  blocks: readonly SlackBlockKit[];
}

/** The channel IO for a click on a confirmation (docs/reference/specs/slack-channel.md
 *  item 14): the offer's thread from the payload, the clicker as the user, no
 *  triggering event — `resumeSlackIO`'s shape — plus the offer message, which
 *  the first reply completes instead of posting under it. */
export function clickSlackIO(
  client: SlackClient,
  click: { channel: string; threadTs: string; user: string; botUserId?: string; offer: OfferMessage },
  opts: { statusClient?: SlackClient; statusBudget?: StatusBudget } = {},
): SlackIO {
  return new SlackIO(
    client,
    {
      channel: click.channel,
      user: click.user,
      text: "",
      ts: click.threadTs,
      threadTs: click.threadTs,
      botUserId: click.botUserId,
    },
    { ...opts, offerMessage: click.offer },
  );
}

/** The listener's arguments the click intake reads: Bolt's ack, the
 *  `block_actions` body and the button pressed. */
export type ConfirmClick = Pick<SlackActionMiddlewareArgs<BlockAction<ButtonAction>>, "ack" | "body" | "action">;

/** The note the taken offer carries while the core works (item 14): which
 *  button, who pressed it, and that it is in hand — as mrkdwn for the context
 *  block and as plain text for the fallback. The label is the pressed
 *  button's own (the payload carries it), so a question's Yes reads “Yes
 *  clicked by …” (record 0054) and a bare payload falls back to the offer's
 *  Run and Cancel. */
export function takenOfferNote(
  kind: "confirm" | "cancel",
  userId: string,
  label?: string,
): { mrkdwn: string; plain: string } {
  const button = label ?? (kind === "confirm" ? "Run" : "Cancel");
  const doing = kind === "confirm" ? "running…" : "cancelling…";
  return { mrkdwn: `*${button}* clicked by <@${userId}> · ${doing}`, plain: `${button} clicked · ${doing}` };
}

/** The offer message's blocks the moment a button is pressed: its own blocks
 *  minus the `actions` block, with the taken note as one more context line —
 *  so a second press has nothing to press while the command runs. Built from
 *  the payload's blocks, which are the offer as posted. */
export function takenOfferBlocks(
  blocks: readonly SlackBlockKit[],
  kind: "confirm" | "cancel",
  userId: string,
  label?: string,
): SlackBlockKit[] {
  return [
    ...blocks.filter((b) => b.type !== "actions"),
    { type: "context", elements: [{ type: "mrkdwn", text: takenOfferNote(kind, userId, label).mrkdwn }] },
  ];
}

/**
 * A click on a confirmation's Run or Cancel (record 0044; slack-channel.md
 * item 14), in this order and no other: ack — Slack gives a listener three
 * seconds, and nothing below may cost them — then the clicker resolved as a
 * message's requester is (`resolveSlackRequester`, `chatActorOf`: identity,
 * never authority — the core checks the requester against the actor), then the
 * handle for the offer's channel and thread with the offer message to complete,
 * then `dispatchClick` with the id the button carried. The core answers
 * through the handle: its first reply completes the offer message — the line
 * and the context kept, the buttons gone, the answer under them — and a later
 * one (a deferred command's settle follow-up) posts in the thread. Nothing
 * thrown leaves this function: a failure is logged and the offer message
 * completed with `CLICK_FAILED_LINE`, best-effort. A payload the adapter did
 * not post — no value, an unknown `confirm.*` id, no message — is acked,
 * logged and ignored.
 */
export async function handleConfirmClick(
  deps: CoreDeps,
  { client, statusClient }: SlackClients,
  { ack, body, action }: ConfirmClick,
  botUserId?: string,
): Promise<void> {
  await ack();
  const kind =
    action.action_id === "confirm.run" ? "confirm" : action.action_id === "confirm.cancel" ? "cancel" : undefined;
  const id = action.value;
  const message = body.message as (OfferMessage & { thread_ts?: string }) | undefined;
  const container = body.container as { channel_id?: string; thread_ts?: string } | undefined;
  const channel = body.channel?.id ?? container?.channel_id;
  if (!kind || !id || !message || !channel) {
    console.error(
      `[confirm] a ${action.action_id} click from ${body.user.id} carried no ${!kind ? "known kind" : !id ? "value" : !message ? "message" : "channel"}; ignored`,
    );
    return;
  }
  const threadTs = message.thread_ts ?? container?.thread_ts ?? message.ts;
  // Take the offer before anything else runs: Slack has no disabled state for a
  // button and its own grey flash ends after a moment, so a click that is only
  // answered when the command finishes leaves live buttons on the message
  // meanwhile. The buttons go now, and a line says who pressed which; the
  // completion below rebuilds from the payload's original blocks, so the note
  // is replaced by the answer. A take that fails is logged and the click
  // proceeds — the core's consume is single-use whatever the message shows.
  try {
    const label = action.text?.text;
    await client.chat.update({
      channel,
      ts: message.ts,
      text: `${message.text ?? ""}\n${takenOfferNote(kind, body.user.id, label).plain}`,
      blocks: takenOfferBlocks(message.blocks ?? [], kind, body.user.id, label),
    });
  } catch (err) {
    console.error(
      `[confirm] ${kind} click on ${id} in ${channel}:${message.ts}: the buttons could not be taken down — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let io: SlackIO | undefined;
  try {
    const requester = await resolveSlackRequester(
      client,
      { channel, ts: message.ts, threadTs, user: body.user.id, text: "" },
      relayAppsOf(deps),
    );
    const actor = chatActorOf(deps.config, {
      userId: requester.userId,
      channelId: `${PLATFORM}:${channel}`,
      threadKey: `${PLATFORM}:${channel}:${threadTs}`,
    });
    io = clickSlackIO(
      client,
      {
        channel,
        threadTs,
        user: body.user.id,
        botUserId,
        offer: { ts: message.ts, text: message.text ?? "", blocks: message.blocks ?? [] },
      },
      { statusClient },
    );
    await dispatchClick(deps, { kind, id, actor, io });
  } catch (err) {
    console.error(
      `[confirm] ${kind} click on ${id} in ${channel}:${message.ts} failed — ${err instanceof Error ? err.message : String(err)}`,
    );
    try {
      await (
        io ??
        clickSlackIO(client, {
          channel,
          threadTs,
          user: body.user.id,
          botUserId,
          offer: { ts: message.ts, text: message.text ?? "", blocks: message.blocks ?? [] },
        })
      ).reply(CLICK_FAILED_LINE);
    } catch (again) {
      console.error(
        `[confirm] ${kind} click on ${id} in ${channel}:${message.ts}: the offer message could not be completed either — ${again instanceof Error ? again.message : String(again)}`,
      );
    }
  }
}

export class SlackIO implements ChannelIO {
  /** Set once the offer message this IO completes has been completed (`reply`). */
  private offerCompleted = false;

  constructor(
    private client: SlackClient,
    private ev: SlackEvent,
    /** `existingCard`: the status message a resumed run already has in the
     *  thread (docs/reference/specs/run-history.md item 38) — `status()` edits it instead
     *  of posting a second card. `statusClient`: where card edits go (default
     *  `client`; production passes `createStatusClient`'s). `statusBudget`: the
     *  edit budget drawn from (default the process's one). `offerMessage`: the
     *  confirmation a click landed on (slack-channel.md item 14) — the first
     *  `reply` completes it in place; later replies post in the thread. */
    private opts: {
      existingCard?: { ts: string };
      statusClient?: SlackClient;
      statusBudget?: StatusBudget;
      offerMessage?: OfferMessage;
    } = {},
  ) {}

  async reply(text: string): Promise<void> {
    const mrkdwn = mdToMrkdwn(text);
    const offer = this.opts.offerMessage;
    if (!offer || this.offerCompleted) {
      await this.post(mrkdwn);
      return;
    }
    // The click's answer: the offer message becomes its outcome. Its own
    // blocks stay minus the buttons — the line above the answer, because the
    // core's refusals say "type the line to run it" — and the answer is one
    // section under them; an answer longer than a section carries continues
    // in the thread. Completed once: a later reply is a follow-up, posted.
    this.offerCompleted = true;
    const [first, ...rest] = chunkText(mrkdwn, SLACK_SECTION_LIMIT);
    await this.client.chat.update({
      channel: this.ev.channel,
      ts: offer.ts,
      text: `${offer.text}\n${first}`,
      blocks: [
        ...offer.blocks.filter((b) => b.type !== "actions"),
        { type: "section", text: { type: "mrkdwn", text: first } },
      ],
    });
    for (const chunk of rest) await this.post(chunk);
  }

  /** The confirmation a routed write is offered as (docs/reference/specs/slack-channel.md
   *  item 14, record 0044): one message in the thread — the exact line to run
   *  as a code span, the risk line as context, and Run and
   *  Cancel whose value is the offer's id — with the offer's text as the
   *  fallback, so a client without blocks still shows the line to type. */
  async offer(offer: ConfirmationOffer): Promise<void> {
    await this.client.chat.postMessage({
      channel: this.ev.channel,
      thread_ts: this.ev.threadTs,
      text: escapeMrkdwn(renderOffer(offer)),
      blocks: offerBlocks(offer),
    });
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

  /** A run's binary artifact in the thread — a screenshot renders inline, a
   *  PDF as a preview — through the same `files.uploadV2` with the bytes as
   *  the file. No fallback: a text reply cannot carry bytes, so a failed upload
   *  propagates for the caller to report. */
  async attachFile(file: { name: string; bytes: Uint8Array; lead: string }): Promise<void> {
    await this.client.files.uploadV2({
      channel_id: this.ev.channel,
      thread_ts: this.ev.threadTs,
      filename: file.name,
      title: file.name,
      file: Buffer.from(file.bytes),
      initial_comment: mdToMrkdwn(file.lead),
    });
  }

  /** The external-upload flow (docs/reference/specs/slack-channel.md item 10,
   *  record 0033): `files.getUploadURLExternal` mints a URL for exactly
   *  `size` bytes under `name`; the run's container POSTs the file there; then
   *  `complete` shares it into this thread with the lead as the comment
   *  (`files.completeUploadExternal`). The bot never sees the bytes. A ticket
   *  Slack answers without a URL or id is refused by name. */
  async uploadTicket(file: { name: string; size: number }): Promise<UploadTicket> {
    const minted = await this.client.files.getUploadURLExternal({ filename: file.name, length: file.size });
    const url = minted.upload_url;
    const id = minted.file_id;
    if (!url || !id)
      throw new Error(`files.getUploadURLExternal answered without an upload_url and file_id for ${file.name}`);
    return {
      url,
      complete: async (lead: string) => {
        await this.client.files.completeUploadExternal({
          files: [{ id, title: file.name }],
          channel_id: this.ev.channel,
          thread_ts: this.ev.threadTs,
          initial_comment: mdToMrkdwn(lead),
        });
      },
    };
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
    liveCards.add(liveCardKey(this.ev.channel, ts));
    const card = `${this.ev.channel}:${ts}`;
    // The newest run to start speaks for the thread's shimmer from here on; a
    // sibling that finishes later must not clear or re-up over this run's voice.
    const shimmerKey = `${this.ev.channel}:${this.ev.threadTs}`;
    shimmerOwners.set(shimmerKey, card);
    await setShimmer();
    const shimmerTimer = setInterval(() => {
      if (shimmerOwners.get(shimmerKey) === card) void setShimmer();
    }, 75_000);
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
        // The shimmer is thread-level, so only its current owner clears it: a
        // run whose shimmer is its own stops the thread's "working" status the
        // moment it is done (the reply auto-clears too; this covers error
        // paths), while a run whose sibling started during its finish skips the
        // clear — the live sibling's shimmer keeps speaking for the thread.
        if (shimmerOwners.get(shimmerKey) !== card) return;
        shimmerOwners.delete(shimmerKey);
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
      // The mapping is `threadTurns` (slack/threadTurns.ts): the triggering
      // message is skipped because the dispatcher appends it as the current
      // turn, and the same rules read a linked thread for the conversation
      // reader, so the two paths cannot drift.
      const kept = threadTurns(thread, { skipTs: this.ev.ts, botUserId: this.ev.botUserId });
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
        const { role, text, at, user } = kept[i];
        const images = imagesByIndex[i];
        const documents = documentsByIndex[i];
        // attachment-only turn whose downloads all failed
        if (!text && !images && !documents) continue;
        items.push({
          role,
          text,
          ...(at !== undefined ? { at } : {}),
          // The author's platform-namespaced id (session-log item 12): the
          // seed stores it on the rows this turn produces; a bot turn has none.
          ...(role === "user" && user !== undefined ? { user: `slack:${user}` } : {}),
          images,
          documents,
        });
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

/** The offer's Block Kit (item 14): the line as code — a span, or a fenced
 *  block when the line itself carries a backtick, which a span cannot hold —
 *  the risk (when the command declares one) as context, and the two buttons,
 *  each carrying the id the core consumes. Every text is escaped
 *  for mrkdwn: `&`, `<`, `>` are structural even inside code. */
function offerBlocks(offer: ConfirmationOffer): slackTypes.KnownBlock[] {
  const line = escapeMrkdwn(offer.line);
  const code = line.includes("`") ? `\`\`\`\n${line}\n\`\`\`` : `\`${line}\``;
  // A question's offer (record 0054): the refusal's sentence above the line —
  // the marker's `Did you mean:` leading the code — the evidence as context,
  // and Yes and No on the same two actions the confirmation uses, so one
  // intake serves both and Yes consumes the row exactly as Run does.
  if (offer.question) {
    return [
      { type: "section", text: { type: "mrkdwn", text: escapeMrkdwn(offer.question.text) } },
      { type: "section", text: { type: "mrkdwn", text: `Did you mean:\n${code}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(offer.question.evidence) }] },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "confirm.run",
            text: { type: "plain_text", text: "Yes" },
            style: "primary",
            value: offer.id,
          },
          { type: "button", action_id: "confirm.cancel", text: { type: "plain_text", text: "No" }, value: offer.id },
        ],
      },
    ];
  }
  // The risk rides as context when the command declares one; a command
  // without a risk gets the line and the buttons alone — no footer (routing-
  // and-config item 28: which scope asked is an operator's fact).
  const context: slackTypes.KnownBlock[] = offer.risk
    ? [{ type: "context", elements: [{ type: "mrkdwn", text: escapeMrkdwn(offer.risk) }] }]
    : [];
  return [
    { type: "section", text: { type: "mrkdwn", text: code } },
    ...context,
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "confirm.run",
          text: { type: "plain_text", text: "Run" },
          style: "primary",
          value: offer.id,
        },
        { type: "button", action_id: "confirm.cancel", text: { type: "plain_text", text: "Cancel" }, value: offer.id },
      ],
    },
  ];
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

/** The request text as the model sees it: the bot mention removed, then the
 *  Slack app footer (`stripAppFooter` in slack/threadTurns.ts — the same strip
 *  every history and quoted-thread turn gets). Exported for tests. */
export function stripMention(text: string, botUserId?: string): string {
  return stripAppFooter(botUserId ? text.replaceAll(`<@${botUserId}>`, "") : text.replace(/<@[A-Z0-9]+>/, ""));
}
