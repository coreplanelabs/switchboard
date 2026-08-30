import { extname } from "node:path";
import bolt from "@slack/bolt";
import { dispatch, STATUS_PREFIXES, type CoreDeps } from "../core/dispatcher.js";
import { catchUpWindowWarning } from "../core/drain.js";
import { mdToMrkdwn } from "./mrkdwn.js";
import { escapeMrkdwn } from "./slackEscape.js";
import { classifyMessage, threadIncludesBot } from "./slackTriggers.js";
import { ACK_EMOJI, botRepliedAfter, catchUpMissedMentions, fetchReplies, type CatchUpClient, type SlackHistoryMessage } from "./slackCatchUp.js";
import { missingBotScopes, recordCatchUpOutcome, recordMissingScopes } from "./slackCatchUpStatus.js";
import { recordSocketConnected, recordSocketDisconnected } from "./slackSocketStatus.js";
export { classifyMessage, threadIncludesBot, type MessageDecision } from "./slackTriggers.js";
import type {
  ChannelIO,
  DocumentAttachment,
  HistoryItem,
  ImageAttachment,
  StatusHandle,
  StatusUpdate,
} from "../core/types.js";

// Slack channel adapter: pure transport. Wires Bolt (Socket Mode) events into
// the core dispatcher and implements ChannelIO on top of the Slack Web API.
// No routing, config, or agent logic lives here.

const { App, SocketModeReceiver } = bolt;
type SlackClient = bolt.webApi.WebClient;

const PLATFORM = "slack";
const SLACK_MSG_LIMIT = 3500;

// Attachment ingestion. Only image types every provider accepts; Slack file
// downloads need the files:read bot scope.
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // provider hard limit per image
const MAX_IMAGES_PER_MESSAGE = 10;
// Budget across a whole thread history so a screenshot-heavy thread can't
// blow up the request payload; spent newest-first (recent images matter most).
const MAX_HISTORY_IMAGES = 20;
const MAX_HISTORY_IMAGE_BYTES = 24 * 1024 * 1024;

// Document ingestion (mirrors images): PDFs (native document block where the
// provider supports it) and text/code/CSV/log files (inlined as fenced text).
const PDF_TYPE = "application/pdf";
// Text-ish mimetypes beyond the `text/*` family that Slack may report.
// `application/json` is deliberately absent: JSON is a common container for
// credentials (service-account keys, token dumps), so a file is never inlined
// just because Slack tags it application/json — the denylist below plus the
// extension allowlist decide, never the JSON mimetype on its own.
const TEXT_MIME_TYPES = new Set([
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/x-sh",
  "application/javascript",
  "application/typescript",
]);
// Mimetypes Slack assigns when it can't identify a file — fall back to the
// filename extension to decide whether it's a text/code file.
const GENERIC_MIME_TYPES = new Set(["application/octet-stream", "binary/octet-stream", ""]);
// Extensions inlined as text under the generic-mimetype fallback. JSON (`.json`,
// `.jsonl`) and config formats (`.env`, `.ini`, `.cfg`, `.conf`) are absent by
// design — the first two are frequent secret containers, the rest are covered by
// the secret-file denylist — so a generic-typed config/JSON file is not "fair
// game" for inlining just because of its extension.
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".log", ".csv", ".tsv", ".rst",
  ".yaml", ".yml", ".toml",
  ".xml", ".html", ".htm", ".css", ".scss", ".less",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".php", ".swift",
  ".sh", ".bash", ".zsh", ".sql", ".r", ".pl", ".lua", ".dart", ".scala",
  ".clj", ".ex", ".exs", ".vue", ".svelte", ".graphql", ".proto", ".dockerfile",
]);
// Secret-file denylist — filename shapes whose contents are likely credentials,
// private keys, or secret config. Matching files are skipped-with-note and their
// bytes NEVER reach the model prompt. This OVERRIDES text classification
// (checked before the text-mimetype/extension allowlist), because the whole risk
// is a secret file whose mimetype/extension otherwise reads as harmless text.
//
// Matched on the filename, case-insensitive, and independent of
// `node:path.extname` — which returns "" for dotfiles like `.env` and `.npmrc`,
// so an extname-based check would miss exactly the files that matter most.
const SECRET_FILE_EXTENSIONS = [
  ".pem", ".key", ".p12", ".pfx", ".npmrc", ".netrc", ".ini", ".cfg", ".conf",
];
const SECRET_FILE_PREFIXES = ["id_rsa"];

/** Does this filename look like a secret/credential/key/config file? Case-
 *  insensitive; conservative (a false match only skips a file, never leaks one).
 *  Exported for tests. */
export function isSecretFile(name: string | undefined): boolean {
  const n = (name ?? "").trim().toLowerCase();
  if (!n) return false;
  // `.env` in any position: bare `.env`, dotfiles (`.env.local`,
  // `.env.production`), and suffixed configs (`config.env`, `prod.env`).
  if (n.includes(".env")) return true;
  // SSH / private-key material by filename prefix (`id_rsa`, `id_rsa.pub`, …).
  if (SECRET_FILE_PREFIXES.some((p) => n.startsWith(p))) return true;
  // Credential JSON blobs — the common shapes secrets ship in.
  if (n === "credentials.json") return true;
  if (n.endsWith(".json") && (n.includes("service-account") || n.endsWith("-key.json"))) return true;
  // Secret-ish extensions, including dotfiles `extname` can't see.
  return SECRET_FILE_EXTENSIONS.some((ext) => n.endsWith(ext));
}
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024; // per-file cap; PDFs run larger than images
const MAX_DOCS_PER_MESSAGE = 10;
// Thread-wide budget, spent newest-first (recent files matter most). Sized to
// stay under Anthropic's ~32MB request ceiling for a document-heavy thread.
const MAX_HISTORY_DOCS = 20;
const MAX_HISTORY_DOCUMENT_BYTES = 32 * 1024 * 1024;

/** Classify a file for document ingestion: a PDF, an inlinable text/code file,
 *  or neither. A secret-file denylist match (`isSecretFile`) is classified as
 *  neither — before any text check — so credentials never inline. Otherwise text
 *  detection prefers the mimetype and falls back to the filename extension only
 *  when Slack reports a generic/unknown type. Exported for tests. */
export function classifyDocument(mimetype: string | undefined, name: string | undefined): "pdf" | "text" | null {
  if (mimetype === PDF_TYPE) return "pdf";
  // Secret-file denylist OVERRIDES text classification: a credentials/key/config
  // file is skipped, never decoded into the prompt, even when its mimetype
  // (application/json, text/plain) or extension would otherwise mark it text.
  if (isSecretFile(name)) return null;
  const mt = mimetype ?? "";
  if (mt.startsWith("text/") || TEXT_MIME_TYPES.has(mt)) return "text";
  if (GENERIC_MIME_TYPES.has(mt) && TEXT_EXTENSIONS.has(extname(name ?? "").toLowerCase())) {
    return "text";
  }
  return null;
}

interface SlackFile {
  id?: string;
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

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

/** The slice of the Slack Web API the name resolvers use — declared structurally
 *  so both the real WebClient and a test mock satisfy it. */
interface NameLookupClient {
  conversations: { info(args: { channel: string }): Promise<{ channel?: { name?: string } }> };
  users: {
    info(args: {
      user: string;
    }): Promise<{
      user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
    }>;
  };
}

// Bounded so a long-lived process can't grow them without limit. On overflow the
// oldest-inserted entry is dropped (Map preserves insertion order) — names are
// cheap to re-resolve, so a simple FIFO bound suffices; no LRU is warranted.
const NAME_CACHE_MAX = 1000;
const channelNameCache = new Map<string, string>();
const userNameCache = new Map<string, string>();

function cachePut(cache: Map<string, string>, key: string, value: string): void {
  cache.set(key, value);
  if (cache.size > NAME_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Resolve a channel's human name (cached, best-effort). Undefined on any API
 *  error or when the channel has no name — the caller falls back to the raw id. A
 *  failed lookup is NOT cached, so a transient error can be retried next time.
 *  Exported for tests. */
export async function resolveChannelName(
  client: NameLookupClient,
  channel: string,
): Promise<string | undefined> {
  const hit = channelNameCache.get(channel);
  if (hit !== undefined) return hit;
  try {
    const info = await client.conversations.info({ channel });
    const name = info.channel?.name;
    if (name) cachePut(channelNameCache, channel, name);
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a user's display name (cached, best-effort): profile.display_name,
 *  then real_name, then the handle. Same failure/caching contract as
 *  `resolveChannelName`. Exported for tests. */
export async function resolveUserName(
  client: NameLookupClient,
  user: string,
): Promise<string | undefined> {
  const hit = userNameCache.get(user);
  if (hit !== undefined) return hit;
  try {
    const u = (await client.users.info({ user })).user;
    const name = u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name;
    if (name) cachePut(userNameCache, user, name);
    return name || undefined;
  } catch {
    return undefined;
  }
}

/** Clear both name caches — for tests, so cache-hit assertions start clean. */
export function resetSlackNameCaches(): void {
  channelNameCache.clear();
  userNameCache.clear();
}

export function createSlackApp(deps: CoreDeps) {
  // The receiver is built explicitly (rather than `socketMode: true`) so the
  // adapter can listen to its websocket lifecycle: every `connected` — first
  // start and each reconnect — triggers the missed-mention catch-up (#184).
  const receiver = new SocketModeReceiver({ appToken: process.env.SLACK_APP_TOKEN ?? "" });
  const app = new App({ token: process.env.SLACK_BOT_TOKEN, receiver });

  let botUserId: string | undefined;
  /** The bot-scope check runs once per process, on the first `connected`. */
  let scopesChecked = false;

  const catchUp = deps.config.config.slack?.catchUp;
  if (catchUp?.enabled !== false) {
    // A window shorter than the drain deadline + cold start cannot cover a
    // full-length deploy blackout (#272). Warn, keep the operator's value.
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
            // Startup scope check (#271): every Web API result carries the
            // token's granted scopes. Missing ones are the silent failure mode —
            // live 2026-08-30 the catch-up could not list channels for hours and
            // nothing said so — so they are logged loudly once and kept on the
            // status record that /healthz reports.
            const missing = missingBotScopes(auth.response_metadata?.scopes);
            recordMissingScopes(missing);
            if (missing.length > 0) {
              console.error(`[slack] bot token is MISSING required scopes: ${missing.join(", ")} — reinstall the app with them (README → Slack app setup); until then the features needing them silently do nothing`);
            }
          }
        }
        if (!botUserId) return;
        const id = botUserId;
        await catchUpMissedMentions({
          client: app.client,
          botUserId: id,
          windowMs: catchUp?.windowMinutes != null ? catchUp.windowMinutes * 60_000 : undefined,
          alreadyHandled: wasHandledHere,
          // Orphaned-card sweep (item 8): cards a dead process left spinning
          // are closed as interrupted; cards this process is driving are not.
          ownedHere: ownsLiveCard,
          onOrphanedCard: async (card, frame) => {
            await app.client.chat.update({ channel: card.channel, ts: card.ts, ...render(frame) });
          },
          // Not awaited per message: a run takes minutes and live events run
          // concurrently too — the runner only awaits the hand-off.
          onMissed: (m) => {
            // The scan's alreadyHandled check ran at scan time; a live
            // delivery that landed between the scan and this dispatch has
            // claimed the pair since — re-check, or both would run (#346).
            if (wasHandledHere(m.channel, m.ts)) {
              console.log(`[catch-up] ${m.channel}:${m.ts}: skipped — handled live since the scan`);
              return;
            }
            void handle(deps, app.client, {
              channel: m.channel,
              user: m.user,
              text: stripMention(m.text, id),
              ts: m.ts,
              threadTs: m.threadTs,
              files: m.files as SlackFile[] | undefined,
              botUserId: id,
              caughtUp: true,
            }).catch((err: Error) => console.error(`[catch-up] ${m.channel}:${m.ts}: ${err.message}`));
          },
        });
      })().catch((err: Error) => {
        // auth.test itself failed (bad token, network): the scan never ran —
        // record that too, or /healthz would keep showing a stale clean run.
        console.error(`[catch-up] ${err.message}`);
        recordCatchUpOutcome({ at: Date.now(), channels: 0, missed: 0, skippedChannels: 0, error: err.message });
      });
    });
  }

  app.event("app_mention", async ({ event, client }) => {
    botUserId ??= (await client.auth.test()).user_id ?? undefined;
    await handle(deps, client, {
      channel: event.channel,
      user: event.user ?? "unknown",
      text: stripMention(event.text ?? "", botUserId),
      ts: event.ts,
      threadTs: event.thread_ts ?? event.ts,
      files: (event as { files?: SlackFile[] }).files,
      botUserId,
    });
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
    await handle(deps, client, {
      channel: m.channel,
      user: m.user ?? "unknown",
      text: stripMention(m.text ?? "", botUserId),
      ts: m.ts,
      threadTs: m.thread_ts ?? m.ts,
      files: m.files,
      botUserId,
      thread,
    });
  });

  return app;
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
 *  through a deploy blackout (2026-08-30: 7.5 min with no 👀 on PR #300's
 *  re-review) learns the delay was the bot restarting — not the request being
 *  ignored, and not something to re-send. Pure; exported for tests. */
export function catchUpDelayNote(messageTs: string, nowMs: number): string {
  const lateMs = Math.max(0, nowMs - Number(messageTs) * 1000);
  const mins = Math.round(lateMs / 60_000);
  const late = mins < 1 ? "under a minute" : `${mins} min`;
  return `⏱ Picked up ${late} after it was posted: the bot was restarting (a deploy or platform move) and Slack does not queue events while it is down. Handling it now — no need to re-send.`;
}

/** One message as `conversations.replies` returns it — the fields history() reads. */
type SlackThreadMessage = { bot_id?: string; user?: string; text?: string; ts?: string; files?: SlackFile[] };

// Same-process dedupe for the reconnect catch-up: (channel, ts) pairs this
// process has accepted, live or via catch-up, so a message delivered both ways
// runs once. Bounded FIFO; the durable record is Slack (👀 / bot reply).
const HANDLED_MAX = 5000;
const handledHere = new Set<string>();
function markHandledHere(channel: string, ts: string): void {
  handledHere.add(`${channel}:${ts}`);
  if (handledHere.size > HANDLED_MAX) {
    const oldest = handledHere.values().next().value;
    if (oldest !== undefined) handledHere.delete(oldest);
  }
}
function wasHandledHere(channel: string, ts: string): boolean {
  return handledHere.has(`${channel}:${ts}`);
}
/** A live delivery older than this is not live: Slack delivers events within
 *  seconds, so an old `ts` means the event was RE-delivered (its original
 *  delivery was never acked — a deploy blackout) or flushed after a blackout.
 *  Only those pay the guard's one thread fetch. */
export const STALE_DELIVERY_MS = 60_000;

/** Delivery-time dedupe (#346). Live 2026-08-30 20:31:57Z: Slack re-delivered
 *  a mention posted at 20:25:51 into the deploy blackout — the reconnect
 *  catch-up had already answered it at 20:28 (⏱ note, card, answer, PR review)
 *  — and the adapter ran it AGAIN in full: `handle()` marked the handled-set
 *  but nothing ever consulted it on the live path (only the catch-up scan
 *  did), and a second LGTM review landed on the PR. Both deploy-window
 *  mentions that evening were re-delivered at +~6 min and double-ran.
 *
 *  Claims (channel, ts) and answers why the event must be DROPPED, or null to
 *  proceed:
 *  1. Same-process: the pair is already in the handled-set (handled live or by
 *     this process's catch-up) — drop without any API call.
 *  2. Cross-process (the first handling died with the old container): a live
 *     delivery older than `STALE_DELIVERY_MS` pays ONE `conversations.replies`
 *     fetch and is dropped when the bot has already posted in the thread after
 *     it. A stale event with 👀 but NO bot reply after it still runs — that is
 *     #317's ack-then-killed shape, and re-running it is the point.
 *  Fail-open: an unfetchable thread runs the event — a lost request is worse
 *  than the duplicate this guard exists to prevent. Catch-up replays
 *  (`caughtUp`) skip both checks: the scan already decided, against the same
 *  Slack state, that the message is unanswered.
 *
 *  Claim-before-await: the mark lands before the guard's fetch, so a
 *  concurrent second delivery of the same (channel, ts) hits check 1 no matter
 *  how the awaits interleave. */
export async function dedupeDelivery(
  client: Pick<CatchUpClient, "conversations">,
  ev: { channel: string; ts: string; threadTs: string; botUserId?: string; caughtUp?: true },
  nowMs = Date.now(),
  state: { was: (c: string, ts: string) => boolean; mark: (c: string, ts: string) => void } = {
    was: wasHandledHere,
    mark: markHandledHere,
  },
): Promise<string | null> {
  if (!ev.caughtUp && state.was(ev.channel, ev.ts)) {
    return "already handled in this process (a Slack redelivery)";
  }
  state.mark(ev.channel, ev.ts);
  if (ev.caughtUp || !ev.botUserId) return null;
  const ageMs = nowMs - Number(ev.ts) * 1000;
  if (!Number.isFinite(ageMs) || ageMs < STALE_DELIVERY_MS) return null;
  let thread: SlackHistoryMessage[];
  try {
    thread = await fetchReplies(client, ev.channel, ev.threadTs);
  } catch {
    return null;
  }
  if (!botRepliedAfter(thread, { ts: ev.ts }, ev.botUserId)) return null;
  return `already answered in its thread (delivered ${Math.round(ageMs / 1000)}s after it was posted — a Slack redelivery)`;
}

/** The permalink Slack itself would mint for a message: `<team url>archives/
 *  <channel>/p<ts sans dot>`, plus the thread qualifier when the message is a
 *  reply. Pure — built from the cached `auth.test` URL, no extra API call. */
export function slackPermalink(teamUrl: string, channel: string, ts: string, threadTs: string): string {
  const base = `${teamUrl.replace(/\/+$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

// The workspace URL from auth.test (e.g. https://acme.slack.com/), resolved once
// per process — the permalink on every run's Request block is built from it.
let teamUrl: string | undefined;
async function resolveTeamUrl(client: SlackClient): Promise<string | undefined> {
  if (teamUrl) return teamUrl;
  try {
    teamUrl = (await client.auth.test()).url ?? undefined;
  } catch (err) {
    console.warn(`[slack] auth.test for the team URL failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return teamUrl;
}

async function handle(deps: CoreDeps, client: SlackClient, ev: SlackEvent): Promise<void> {
  // Redelivery guard (#346): claim (channel, ts) and drop the event when it
  // demonstrably ran already — in this process, or (for a stale delivery)
  // visibly answered in its own thread. Before the ack: a dropped redelivery
  // already wears the first handling's 👀.
  const drop = await dedupeDelivery(client, ev);
  if (drop) {
    console.log(`[redelivery] ${ev.channel}:${ev.ts} dropped: ${drop}`);
    return;
  }
  // Immediate receipt: react to the triggering message so the sender knows it
  // was accepted, before any model/tool work starts. Fire-and-forget — a
  // missing reactions:write scope (or a re-run reacting twice) must never
  // block or fail the request itself.
  client.reactions
    .add({ channel: ev.channel, timestamp: ev.ts, name: ACK_EMOJI })
    .catch((err: Error) => {
      if (!err.message.includes("already_reacted")) console.error(`[ack] ${err.message}`);
    });
  // A replayed message says how late the pickup was — best-effort, like the
  // ack, and overlapped with the file downloads (one Slack round-trip, not a
  // serial one). Awaited before dispatch so the note precedes the run card.
  const delayNote = ev.caughtUp
    ? new SlackIO(client, ev).reply(catchUpDelayNote(ev.ts, Date.now())).catch((err: Error) => {
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
  await dispatch(
    deps,
    {
      channelId: `${PLATFORM}:${ev.channel}`,
      userId: `${PLATFORM}:${ev.user}`,
      threadKey: `${PLATFORM}:${ev.channel}:${ev.threadTs}`,
      text: ev.text + note,
      channelName,
      userName,
      sourceUrl: team ? slackPermalink(team, ev.channel, ev.ts, ev.threadTs) : undefined,
      images: images.length > 0 ? images : undefined,
      documents: documents.length > 0 ? documents : undefined,
    },
    new SlackIO(client, ev),
  );
}

/**
 * Download Slack-hosted files and return the ones usable as model image input.
 * Anything else (wrong type, too big, download failed) lands in `skipped` with
 * a human-readable label. Requires the files:read bot scope.
 */
export async function fetchImages(
  files: SlackFile[] | undefined,
  maxImages: number,
  maxTotalBytes = Infinity,
): Promise<{ images: ImageAttachment[]; skipped: string[]; bytes: number }> {
  const images: ImageAttachment[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  // Pass 1 (sync): decide which files are even candidates — type, declared
  // size, and the per-message count budget. Pass 2: download the candidates
  // CONCURRENTLY (each is a Slack CDN round trip; a screenshot-heavy message
  // used to pay them one after another). Pass 3 (sync, in the original order):
  // apply the byte budgets, so which file gets cut when the budget overflows is
  // the same as it was serially. One deliberate drift from the serial loop: the
  // count budget is spent by CANDIDATES, not by successful downloads, so a
  // failed fetch no longer frees its slot for a later file (serially, image #11
  // got in when #3 failed). Refilling would mean a second download round;
  // a failed Slack fetch is rare and the cost is one fewer attachment.
  const candidates: Array<{ f: SlackFile; label: string; url: string; mediaType: string }> = [];
  for (const f of files ?? []) {
    const label = fileLabel(f);
    const url = f.url_private_download ?? f.url_private;
    if (
      !url ||
      !f.mimetype ||
      !IMAGE_TYPES.has(f.mimetype) ||
      (f.size ?? 0) > MAX_IMAGE_BYTES ||
      candidates.length >= maxImages
    ) {
      skipped.push(label);
      continue;
    }
    candidates.push({ f, label, url, mediaType: f.mimetype });
  }
  // An image is never text/html, so any HTML answer is Slack's login page.
  const downloads = await Promise.all(
    candidates.map(({ url, label }) => downloadSlackFile(url, label, (contentType) => contentType.includes("text/html"))),
  );
  candidates.forEach(({ f, label, mediaType }, i) => {
    const buf = downloads[i];
    if (!buf || buf.byteLength > MAX_IMAGE_BYTES || bytes + buf.byteLength > maxTotalBytes) {
      skipped.push(label);
      return;
    }
    bytes += buf.byteLength;
    images.push({ mediaType, data: buf.toString("base64"), name: f.name });
  });
  return { images, skipped, bytes };
}

const fileLabel = (f: SlackFile) => `${f.name ?? f.id ?? "file"} (${f.mimetype ?? "unknown type"})`;

/** One Slack-hosted file's bytes, or undefined when the download failed (the
 *  failure is logged here; the caller only has to list the file as skipped).
 *  Slack answers an unauthorized file fetch with an HTML login page and HTTP
 *  200 — content-type is the reliable failure signal, judged by the caller
 *  (`isLoginPage`) because a genuine .html attachment is itself text/html. */
async function downloadSlackFile(url: string, label: string, isLoginPage: (contentType: string) => boolean): Promise<Buffer | undefined> {
  const token = process.env.SLACK_BOT_TOKEN;
  try {
    const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!res.ok || isLoginPage(res.headers.get("content-type") ?? "")) {
      console.error(`[files] download failed for ${label}: HTTP ${res.status}`);
      return undefined;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    console.error(`[files] download failed for ${label}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Download Slack-hosted files and return the ones usable as model document
 * input: PDFs (base64) and text/code/CSV/log files (decoded to UTF-8). Anything
 * else (an image, an unsupported type, too big, download failed) lands in
 * `skipped` with a human-readable label. Mirrors `fetchImages`; requires the
 * files:read bot scope.
 */
export async function fetchDocuments(
  files: SlackFile[] | undefined,
  maxDocs: number,
  maxTotalBytes = Infinity,
): Promise<{ documents: DocumentAttachment[]; skipped: string[]; bytes: number }> {
  const documents: DocumentAttachment[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  // Same three passes as fetchImages: candidates → concurrent downloads →
  // budgets applied in the original order.
  const candidates: Array<{ f: SlackFile; label: string; url: string; kind: "pdf" | "text" }> = [];
  for (const f of files ?? []) {
    const label = fileLabel(f);
    const url = f.url_private_download ?? f.url_private;
    const kind = classifyDocument(f.mimetype, f.name);
    if (!url || !kind || (f.size ?? 0) > MAX_DOCUMENT_BYTES || candidates.length >= maxDocs) {
      skipped.push(label);
      continue;
    }
    candidates.push({ f, label, url, kind });
  }
  const downloads = await Promise.all(
    candidates.map(({ url, label, f }) => downloadSlackFile(url, label, (contentType) => contentType.includes("text/html") && f.mimetype !== "text/html")),
  );
  candidates.forEach(({ f, label, kind }, i) => {
    const buf = downloads[i];
    if (!buf || buf.byteLength > MAX_DOCUMENT_BYTES || bytes + buf.byteLength > maxTotalBytes) {
      skipped.push(label);
      return;
    }
    bytes += buf.byteLength;
    documents.push({
      mediaType: f.mimetype ?? "text/plain",
      data: kind === "pdf" ? buf.toString("base64") : buf.toString("utf-8"),
      name: f.name,
    });
  });
  return { documents, skipped, bytes };
}

/** Exported for tests. */
export class SlackIO implements ChannelIO {
  constructor(
    private client: SlackClient,
    private ev: SlackEvent,
  ) {}

  async reply(text: string): Promise<void> {
    await this.post(mdToMrkdwn(text));
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

  async status(initial: StatusUpdate): Promise<StatusHandle> {
    // Native Slack shimmer: rotating loading phrases shown inline in the
    // thread ("Switchboard is <phrase>"). Works in channel threads since
    // March 2026 with chat:write; auto-clears when the bot replies, times out
    // after ~2 min idle, so re-up every 75s during long turns.
    const setShimmer = () =>
      this.client.assistant.threads
        .setStatus({
          channel_id: this.ev.channel,
          thread_ts: this.ev.threadTs,
          status: LOADING_PHRASES[0],
          loading_messages: LOADING_PHRASES,
        })
        .catch((err: Error) => console.error(`[shimmer] ${err.message}`));

    // Post the activity card FIRST: any bot message in the thread auto-clears
    // the inline status, so the shimmer must be set after the card exists
    // (edits to the card don't clear it; only new messages do).
    const posted = await this.client.chat.postMessage({
      channel: this.ev.channel,
      thread_ts: this.ev.threadTs,
      ...render(initial),
    });
    await setShimmer();
    const shimmerTimer = setInterval(() => void setShimmer(), 75_000);
    const ts = posted.ts as string;
    liveCards.add(liveCardKey(this.ev.channel, ts));
    const edit = (frame: StatusUpdate) =>
      this.client.chat
        .update({ channel: this.ev.channel, ts, ...render(frame) })
        .catch(() => {});
    return {
      update: (frame) => void edit(frame),
      done: async (frame) => {
        clearInterval(shimmerTimer);
        liveCards.delete(liveCardKey(this.ev.channel, ts));
        await edit(frame);
        // reply auto-clears the shimmer; clear explicitly for error paths
        await this.client.assistant.threads
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
          imagesLeft > 0 && imageBytesLeft > 0 ? fetchImages(files, Math.min(MAX_IMAGES_PER_MESSAGE, imagesLeft), imageBytesLeft) : undefined,
          docsLeft > 0 && docBytesLeft > 0 ? fetchDocuments(files, Math.min(MAX_DOCS_PER_MESSAGE, docsLeft), docBytesLeft) : undefined,
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

// The card body is bounded so the blocks payload stays far under Slack's
// per-message limits whatever the tools emit.
const RENDER_DETAIL_RAW_MAX = 900;

/** Status cards THIS process is currently driving (channel:ts), added when the
 *  card is posted and removed when it is closed. The reconnect sweep consults
 *  it so a websocket reconnect without a restart never closes a running run's
 *  card as "interrupted" — only cards no living process owns are orphans. */
const liveCards = new Set<string>();
const liveCardKey = (channel: string, ts: string) => `${channel}:${ts}`;
export function ownsLiveCard(channel: string, ts: string): boolean {
  return liveCards.has(liveCardKey(channel, ts));
}

/** Status frames render as Block Kit: context headline + rich_text activity.
 *
 *  The body MUST be a `rich_text` block, never a `section`: Slack's client
 *  collapses a section's mrkdwn behind "Show more" at FIVE rendered lines
 *  (measured live, 2026-08-30 — 8/12/16/20-line sections all fold; rich_text
 *  at 30 lines does not), and a folded card re-renders expanded-then-collapsed
 *  on every chat.update, shoving the whole thread up and down on each 5s
 *  heartbeat. The card is link + checklist + activity ≈ 6+ lines, permanently
 *  past that fold. rich_text has no per-block fold, so the card never folds
 *  and edits never move the layout.
 *
 *  rich_text also neutralizes injection by construction: `text` elements are
 *  literal (a `<!channel>` in tool output renders as those characters, never a
 *  live @channel broadcast), so the untrusted `frame.detail` needs no escaping.
 *  `frame.title` still lands in a `mrkdwn` context field and is escaped;
 *  escapeMrkdwn only neutralizes `&`/`<`/`>`, so the title's intentional
 *  `*bold*`/`` `code` `` markup renders as before. Exported for tests. */
export function render(frame: StatusUpdate): { text: string; blocks: object[] } {
  const title = escapeMrkdwn(frame.title);
  const blocks: object[] = [
    { type: "context", elements: [{ type: "mrkdwn", text: title }] },
  ];
  const elements: object[] = [];
  // The run link is a typed link element: one rendered line, and its 100+-char
  // capability URL lives in the `url` field where it has no width at all.
  if (frame.link) elements.push({ type: "link", url: frame.link.url, text: frame.link.label });
  if (frame.detail) {
    // The cap cut can land mid-astral-char; a lone high surrogate is invalid
    // JSON text and Slack rejects the payload, so drop it from the cut edge.
    const detail = frame.detail.slice(0, RENDER_DETAIL_RAW_MAX).replace(/[\uD800-\uDBFF]$/u, "");
    elements.push({ type: "text", text: frame.link ? `\n${detail}` : detail });
  }
  if (elements.length > 0) {
    blocks.push({
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements }],
    });
  }
  return { text: title, blocks };
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
 *  the END of the text, not to its own line: the raw event text seen live on
 *  2026-08-29 was `friction report *Sent using* <@U0BJJMDUCKY>` — same line,
 *  no newline — and a line-anchored regex let `*Sent` reach the command
 *  parser (`repo list` had masked this because it ignores trailing text). An
 *  optional bracketed sender attribution after the mention is tolerated too. */
const APP_FOOTER_RE = /(?:^|\s)(?:\*Sent using\*|Sent using)\s+<@[A-Z0-9]+(?:\|[^>]*)?>(?:\s*\[[^\]\n]*\])?\s*$/;

/** Exported for tests. */
export function stripMention(text: string, botUserId?: string): string {
  const stripped = botUserId
    ? text.replaceAll(`<@${botUserId}>`, "")
    : text.replace(/<@[A-Z0-9]+>/, "");
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
