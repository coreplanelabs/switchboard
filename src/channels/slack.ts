import { extname } from "node:path";
import bolt from "@slack/bolt";
import { dispatch, STATUS_PREFIXES, type CoreDeps } from "../core/dispatcher.js";
import { mdToMrkdwn } from "./mrkdwn.js";
import { escapeMrkdwn } from "./slackEscape.js";
import { SlackFormatter } from "./slackFormatter.js";
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

const { App } = bolt;
type SlackClient = bolt.webApi.WebClient;

const PLATFORM = "slack";
const SLACK_MSG_LIMIT = 3500;
// Reaction added to a triggering message the moment the bot accepts it.
const ACK_EMOJI = "eyes";

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

/** What to do with an incoming message event. Pure — the async thread-
 *  participation lookup stays with the caller. Exported for tests. */
export type MessageDecision = "skip" | "handle" | "handle-if-bot-in-thread";

export function classifyMessage(
  m: { bot_id?: string; subtype?: string; channel_type?: string; thread_ts?: string; text?: string },
  botUserId?: string,
): MessageDecision {
  // "file_share" is how Slack marks a message with attachments — still a
  // user message, so let it through the subtype gate.
  if (m.bot_id || (m.subtype && m.subtype !== "file_share")) return "skip";
  if (m.channel_type === "im") return "handle";
  // Channel/group messages: only thread follow-ups, and only in threads the
  // bot is already part of. Mentions are app_mention's job (the same message
  // fires both events — skip here to avoid double-handling), and top-level
  // channel posts still require a mention.
  if (!m.thread_ts) return "skip";
  if (botUserId && (m.text ?? "").includes(`<@${botUserId}>`)) return "skip";
  return "handle-if-bot-in-thread";
}

/** Is the bot part of this thread — has it posted, or been mentioned anywhere
 *  in it? Pure over already-fetched messages. Exported for tests. */
export function threadIncludesBot(
  messages: Array<{ user?: string; text?: string }>,
  botUserId?: string,
): boolean {
  if (!botUserId) return false;
  return messages.some((m) => m.user === botUserId || (m.text ?? "").includes(`<@${botUserId}>`));
}

// ---- human display-name resolution ------------------------------------------
// The core wants human names (IncomingMessage.channelName/userName) for the
// live-view run label, but stays channel-agnostic — so the Slack adapter resolves
// them here. Best-effort: a lookup failure leaves the name undefined and the
// label falls back to the raw id; a name lookup never delays or fails a dispatch.
// Names change rarely, so each id is resolved once and cached — one API call per
// new id, not per message.

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
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  let botUserId: string | undefined;

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
    if (decision === "handle-if-bot-in-thread") {
      if (!(await botInThread(client, m.channel, m.thread_ts!, botUserId))) return;
    }
    await handle(deps, client, {
      channel: m.channel,
      user: m.user ?? "unknown",
      text: stripMention(m.text ?? "", botUserId),
      ts: m.ts,
      threadTs: m.thread_ts ?? m.ts,
      files: m.files,
      botUserId,
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
}

async function handle(deps: CoreDeps, client: SlackClient, ev: SlackEvent): Promise<void> {
  // Immediate receipt: react to the triggering message so the sender knows it
  // was accepted, before any model/tool work starts. Fire-and-forget — a
  // missing reactions:write scope (or a re-run reacting twice) must never
  // block or fail the request itself.
  client.reactions
    .add({ channel: ev.channel, timestamp: ev.ts, name: ACK_EMOJI })
    .catch((err: Error) => {
      if (!err.message.includes("already_reacted")) console.error(`[ack] ${err.message}`);
    });
  const { images, skipped: skippedImages } = await fetchImages(ev.files, MAX_IMAGES_PER_MESSAGE);
  const { documents, skipped: skippedDocs } = await fetchDocuments(ev.files, MAX_DOCS_PER_MESSAGE);
  // A file is genuinely unsupported only when BOTH passes rejected it — the
  // image pass skips every non-image (PDFs, text) and the document pass skips
  // every non-document (images), so their intersection is exactly the files
  // that are neither a usable image nor a usable document.
  const skipped = skippedImages.filter((s) => skippedDocs.includes(s));
  // Human display names for the run label — best-effort and cached: a failed
  // lookup leaves the field undefined (the label falls back to the raw id) and
  // never fails the dispatch. Resolved in parallel so the two lookups don't add
  // up on the first message for a new channel/user.
  const [channelName, userName] = await Promise.all([
    resolveChannelName(client, ev.channel),
    resolveUserName(client, ev.user),
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
  const token = process.env.SLACK_BOT_TOKEN;
  for (const f of files ?? []) {
    const label = `${f.name ?? f.id ?? "file"} (${f.mimetype ?? "unknown type"})`;
    const url = f.url_private_download ?? f.url_private;
    if (
      !url ||
      !f.mimetype ||
      !IMAGE_TYPES.has(f.mimetype) ||
      (f.size ?? 0) > MAX_IMAGE_BYTES ||
      images.length >= maxImages
    ) {
      skipped.push(label);
      continue;
    }
    try {
      const res = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      // Slack answers unauthorized file fetches with an HTML login page and
      // HTTP 200 — content-type is the reliable failure signal.
      if (!res.ok || res.headers.get("content-type")?.includes("text/html")) {
        console.error(`[files] download failed for ${label}: HTTP ${res.status}`);
        skipped.push(label);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_IMAGE_BYTES || bytes + buf.byteLength > maxTotalBytes) {
        skipped.push(label);
        continue;
      }
      bytes += buf.byteLength;
      images.push({ mediaType: f.mimetype, data: buf.toString("base64"), name: f.name });
    } catch (err) {
      console.error(`[files] download failed for ${label}: ${err instanceof Error ? err.message : String(err)}`);
      skipped.push(label);
    }
  }
  return { images, skipped, bytes };
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
  const token = process.env.SLACK_BOT_TOKEN;
  for (const f of files ?? []) {
    const label = `${f.name ?? f.id ?? "file"} (${f.mimetype ?? "unknown type"})`;
    const url = f.url_private_download ?? f.url_private;
    const kind = classifyDocument(f.mimetype, f.name);
    if (!url || !kind || (f.size ?? 0) > MAX_DOCUMENT_BYTES || documents.length >= maxDocs) {
      skipped.push(label);
      continue;
    }
    try {
      const res = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      // Slack answers unauthorized file fetches with an HTML login page and
      // HTTP 200. Content-type is the signal — but a genuine .html text file is
      // itself text/html, so only treat text/html as a login page when the file
      // we requested wasn't HTML.
      const contentType = res.headers.get("content-type") ?? "";
      const looksLikeLoginPage = contentType.includes("text/html") && f.mimetype !== "text/html";
      if (!res.ok || looksLikeLoginPage) {
        console.error(`[files] download failed for ${label}: HTTP ${res.status}`);
        skipped.push(label);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_DOCUMENT_BYTES || bytes + buf.byteLength > maxTotalBytes) {
        skipped.push(label);
        continue;
      }
      bytes += buf.byteLength;
      documents.push({
        mediaType: f.mimetype ?? "text/plain",
        data: kind === "pdf" ? buf.toString("base64") : buf.toString("utf-8"),
        name: f.name,
      });
    } catch (err) {
      console.error(`[files] download failed for ${label}: ${err instanceof Error ? err.message : String(err)}`);
      skipped.push(label);
    }
  }
  return { documents, skipped, bytes };
}

class SlackIO implements ChannelIO {
  /** Structured output renders through the Slack formatter (structured →
   *  mrkdwn); `sendFormatted` posts its output verbatim. */
  readonly formatter = new SlackFormatter();

  constructor(
    private client: SlackClient,
    private ev: SlackEvent,
  ) {}

  async reply(text: string): Promise<void> {
    await this.post(mdToMrkdwn(text));
  }

  /** Post an already-mrkdwn payload (from `this.formatter`) without re-running
   *  the Markdown→mrkdwn converter — doing so would double-convert. */
  async sendFormatted(payload: string): Promise<void> {
    await this.post(payload);
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
    const edit = (frame: StatusUpdate) =>
      this.client.chat
        .update({ channel: this.ev.channel, ts, ...render(frame) })
        .catch(() => {});
    return {
      update: (frame) => void edit(frame),
      done: async (frame) => {
        clearInterval(shimmerTimer);
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
      const replies = await this.client.conversations.replies({
        channel: this.ev.channel,
        ts: this.ev.threadTs,
        limit: 50,
      });
      const kept: { role: "user" | "assistant"; text: string; files?: SlackFile[] }[] = [];
      for (const m of replies.messages ?? []) {
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
      for (let i = kept.length - 1; i >= 0; i--) {
        const files = kept[i].files;
        if (!files?.length) continue;
        if (imagesLeft > 0 && imageBytesLeft > 0) {
          const { images, bytes } = await fetchImages(
            files,
            Math.min(MAX_IMAGES_PER_MESSAGE, imagesLeft),
            imageBytesLeft,
          );
          imagesLeft -= images.length;
          imageBytesLeft -= bytes;
          if (images.length > 0) imagesByIndex[i] = images;
        }
        if (docsLeft > 0 && docBytesLeft > 0) {
          const { documents, bytes } = await fetchDocuments(
            files,
            Math.min(MAX_DOCS_PER_MESSAGE, docsLeft),
            docBytesLeft,
          );
          docsLeft -= documents.length;
          docBytesLeft -= bytes;
          if (documents.length > 0) documentsByIndex[i] = documents;
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

// Slack's section mrkdwn field caps at ~3000 chars. escapeMrkdwn can expand text
// up to 5× in the worst case (every char an `&` → `&amp;`), so the raw detail is
// sliced to a conservative length BEFORE escaping (keeping the truncation intent),
// then the escaped result is hard-capped as a provable belt-and-suspenders: any
// input, adversarial mixes included, stays ≤ RENDER_DETAIL_ESCAPED_MAX < 3000. A
// mid-entity cut only leaves inert text (e.g. `&am`) — escaping already removed
// every raw `<`/`>`/`&`, so truncation can never re-introduce live mrkdwn syntax.
const RENDER_DETAIL_RAW_MAX = 900;
const RENDER_DETAIL_ESCAPED_MAX = 2900;

/** Status frames render as Block Kit: context headline + preformatted activity.
 *  `frame.title` (the run label) and `frame.detail` (tool-output summaries + the
 *  agent's free-text update_status) are untrusted, so both are escaped before they
 *  land in the `mrkdwn` text fields — otherwise a `<!channel>` in tool output
 *  would fire a live @channel broadcast from a status card. escapeMrkdwn only
 *  neutralizes `&`/`<`/`>`, so the title's intentional `*bold*`/`` `code` ``
 *  markup renders as before. Exported for tests. */
export function render(frame: StatusUpdate): { text: string; blocks: object[] } {
  const title = escapeMrkdwn(frame.title);
  const blocks: object[] = [
    { type: "context", elements: [{ type: "mrkdwn", text: title }] },
  ];
  if (frame.detail) {
    const detail = escapeMrkdwn(frame.detail.slice(0, RENDER_DETAIL_RAW_MAX)).slice(
      0,
      RENDER_DETAIL_ESCAPED_MAX,
    );
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: detail },
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
 * Is the bot already part of this thread? True when it has posted in it or
 * was mentioned anywhere in it. Checked per follow-up (one replies call) so
 * participation survives restarts — no in-memory thread registry to lose.
 */
async function botInThread(
  client: SlackClient,
  channel: string,
  threadTs: string,
  botUserId?: string,
): Promise<boolean> {
  if (!botUserId) return false;
  try {
    const replies = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
    return threadIncludesBot((replies.messages ?? []) as Array<{ user?: string; text?: string }>, botUserId);
  } catch {
    return false; // can't read the thread => stay quiet
  }
}

/** Slack appends "*Sent using* <@APP|Name>" as the LAST line of a message an
 *  app posts on a user's behalf (the Claude Slack plugin does this). It is
 *  platform chrome, not the user's words — left in, it breaks strict inline
 *  parsers (`repo onboard …` saw `*Sent` as a bad token). Only whole trailing
 *  lines of exactly that shape are removed (repeated for stacked footers); the
 *  phrase inside a user's own text is untouched. Since 2026-08-29 the footer
 *  may end with the sender's attribution in brackets — `[justin
 *  <justin@coreplane.ai>]` — which is part of the same chrome line. */
const APP_FOOTER_RE = /(?:^|\n)\s*(?:\*Sent using\*|Sent using)\s+<@[A-Z0-9]+(?:\|[^>]*)?>(?:\s*\[[^\]\n]*\])?\s*$/;

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
