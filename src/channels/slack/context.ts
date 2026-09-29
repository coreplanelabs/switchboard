import type { ToolResultContent } from "../../core/chatMessage.js";
import type { Actor, ChannelDirectory } from "../../core/authz/types.js";
import { wrapUntrusted } from "../../core/commandRegistry.js";
import { readReferences, REFERENCE_MAX_BYTES, REFERENCE_MAX_MESSAGES } from "../../core/dispatch/references.js";
import type { ReferencedConversation } from "../../core/references/types.js";
import type { IncomingMessage } from "../../core/types.js";
import type { SlackContextCapability, SlackContextRequest } from "../../tools/slackContext.js";
import { classifyDocument, fetchDocuments, fetchImages, isSecretFile, type SlackFile } from "./attachments.js";
import { fetchSlackReplies, SlackConversationReader, type ReferenceClient } from "./references.js";
import { resolveTeamUrl, slackPermalink } from "./lookups.js";
import { threadTurns, type SlackThreadMessage, type ThreadTurn } from "./threadTurns.js";

/** The bot's existing Slack Web API client, with the channel history read this tool needs. */
export interface SlackContextClient extends Omit<ReferenceClient, "conversations"> {
  conversations: Omit<ReferenceClient["conversations"], "replies"> & {
    replies: ReferenceClient["conversations"]["replies"];
    history(args: { channel: string; limit: number }): Promise<{ messages?: SlackThreadMessage[] }>;
  };
}

export const SLACK_CONTEXT_MAX_MESSAGES = 20;
export const SLACK_CONTEXT_MAX_TEXT_CHARS = 16_000;
export const SLACK_CONTEXT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SLACK_CONTEXT_MAX_FILE_TEXT_CHARS = 12_000;
const REFUSED = "slack_context: I can't read that Slack source.";
const FILE_REFUSED = "slack_context: I can't read that file from the linked message.";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function clipped(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/** Render after clipping, so a cut cannot remove the untrusted fence's close. */
function quoted(label: string, lines: readonly string[]): string {
  const bounded = lines.slice(-SLACK_CONTEXT_MAX_MESSAGES).map((line) => clipped(line, 1200));
  while (bounded.length > 1 && bounded.join("\n").length > SLACK_CONTEXT_MAX_TEXT_CHARS) bounded.shift();
  return `${label} · ${bounded.length} message${bounded.length === 1 ? "" : "s"}\n${wrapUntrusted(bounded.join("\n"))}`;
}

function fileReferences(turn: ThreadTurn, teamUrl: string | undefined, channel: string, threadTs: string): string {
  const source = turn.ts && teamUrl ? ` · ${slackPermalink(teamUrl, channel, turn.ts, threadTs)}` : "";
  const files = (turn.files ?? [])
    .slice(0, 5)
    .map((f) => (f.id ? `file ${f.id} ${JSON.stringify(f.name ?? "unnamed")}` : "file without ID"))
    .join(", ");
  return `${turn.ts ?? "unknown time"}${source}${files ? ` [${files}]` : ""}`;
}

function turnLine(turn: ThreadTurn, teamUrl: string | undefined, channel: string, threadTs: string): string {
  return `${fileReferences(turn, teamUrl, channel, threadTs)} · ${turn.user ?? turn.botId ?? "unknown"}: ${turn.text}`;
}

function messageTs(url: string): string | undefined {
  const match = /\/p(\d{10})(\d{6})(?:[?#]|$)/.exec(url);
  return match ? `${match[1]}.${match[2]}` : undefined;
}

function slackDownloadUrl(file: SlackFile): boolean {
  try {
    const url = new URL(file.url_private_download ?? file.url_private ?? "");
    return url.protocol === "https:" && url.hostname === "files.slack.com";
  } catch {
    return false;
  }
}

async function loadSlackFile(file: SlackFile): Promise<ToolResultContent | undefined> {
  const kind = classifyDocument(file.mimetype, file.name);
  if (kind) {
    const result = await fetchDocuments([file], 1, SLACK_CONTEXT_MAX_FILE_BYTES);
    const doc = result.documents[0];
    if (!doc) return undefined;
    const label = `Slack file ${JSON.stringify(file.name)} (${file.size} bytes)`;
    return kind === "pdf"
      ? [
          { type: "text", text: wrapUntrusted(`${label}; attached PDF follows as source data.`) },
          { type: "document", mediaType: doc.mediaType, data: doc.data, name: "Slack document" },
        ]
      : wrapUntrusted(`${label}\n${clipped(doc.data, SLACK_CONTEXT_MAX_FILE_TEXT_CHARS)}`);
  }
  if (!IMAGE_TYPES.has(file.mimetype ?? "")) return undefined;
  const result = await fetchImages([file], 1, SLACK_CONTEXT_MAX_FILE_BYTES);
  const image = result.images[0];
  return image
    ? [
        {
          type: "text",
          text: wrapUntrusted(
            `Slack file ${JSON.stringify(file.name)} (${file.size} bytes); attached image follows as source data.`,
          ),
        },
        { type: "image", mediaType: image.mediaType, data: image.data },
      ]
    : undefined;
}

/**
 * One requester's opt-in Slack read capability. The already-authenticated
 * origin is the only DM/private audience this primitive reads. Cross-channel
 * links reuse the established reference gate and require a public source.
 */
export function createSlackContextCapability(input: {
  client: SlackContextClient;
  reader: SlackConversationReader;
  actor: Actor;
  msg: IncomingMessage;
  /** The existing Slack membership directory; required for a private channel origin. */
  directory?: Pick<ChannelDirectory, "isMember">;
  /** Tests replace the existing attachment loader without reaching Slack. */
  loadFile?: (file: SlackFile) => Promise<ToolResultContent | undefined>;
}): SlackContextCapability {
  const { client, reader, actor, msg } = input;
  if (!/^slack:[CGD][A-Z0-9_]+$/.test(msg.channelId) || actor.kind !== "user" || actor.id !== msg.userId)
    throw new Error("Slack context needs the resolved requester and Slack origin");
  const origin = msg.channelId.slice("slack:".length);
  const originThread = msg.threadKey.slice(msg.channelId.length + 1);
  if (!/^\d+\.\d+$/.test(originThread)) throw new Error("Slack context needs a Slack thread key");

  const linkOf = async (url: string) => {
    await reader.ready();
    return reader.parseConversationUrl(url);
  };

  const originAllowed = async (): Promise<boolean> => {
    // A DM's exact source was delivered by Slack to this requester and bot.
    if (origin.startsWith("D")) return true;
    const ref = { channelId: msg.channelId, threadKey: msg.threadKey, url: msg.sourceUrl ?? msg.threadKey };
    const cls = await reader.classifyConversation(ref);
    if (cls.visibility === "never" || !cls.botIsMember) return false;
    if (cls.visibility === "private") return (await input.directory?.isMember(actor.id, msg.channelId)) === true;
    return reader.requesterIsFullMember(actor.id);
  };

  const allowedLink = async (
    url: string,
  ): Promise<
    | { ref: NonNullable<ReturnType<typeof reader.parseConversationUrl>>; conversation?: ReferencedConversation }
    | undefined
  > => {
    const ref = await linkOf(url);
    if (!ref) return undefined;
    if (ref.channelId === msg.channelId) return { ref };
    // Public sources can be quoted into the destination; a private channel's
    // membership alone says nothing about everyone in the destination.
    const cls = await reader.classifyConversation(ref);
    if (cls.visibility !== "public" || !cls.botIsMember) return undefined;
    const checked = await readReferences({ conversationReaders: [reader] }, { actor, msg: { ...msg, text: url } });
    return checked.conversations.length === 1 && checked.refused.length === 0
      ? { ref, conversation: checked.conversations[0] }
      : undefined;
  };

  return {
    async read(request: SlackContextRequest): Promise<ToolResultContent> {
      try {
        if (!(await originAllowed())) return request.kind === "file" ? FILE_REFUSED : REFUSED;
        if (request.kind === "thread") {
          const turns = threadTurns(await fetchSlackReplies(client, origin, originThread), {});
          const teamUrl = await resolveTeamUrl(client);
          return quoted(
            `Current Slack thread · ${msg.threadKey}`,
            turns.map((t) => turnLine(t, teamUrl, origin, originThread)),
          );
        }
        if (request.kind === "nearby") {
          const page = await client.conversations.history({ channel: origin, limit: SLACK_CONTEXT_MAX_MESSAGES });
          // Slack history is newest-first; normalize so the cap drops oldest.
          const turns = threadTurns(page.messages ?? [], {}).reverse();
          const teamUrl = await resolveTeamUrl(client);
          return quoted(
            `Nearby Slack channel · ${msg.channelId}`,
            turns.map((t) => turnLine(t, teamUrl, origin, t.ts ?? "")),
          );
        }
        const linked =
          request.kind === "file" && request.url === undefined ? undefined : await allowedLink(request.url!);
        if (!linked && !(request.kind === "file" && request.url === undefined))
          return request.kind === "file" ? FILE_REFUSED : REFUSED;
        if (request.kind === "file" && request.url === undefined) {
          const message = threadTurns(
            await fetchSlackReplies(client, origin, originThread, request.messageTs),
            {},
          ).find((m) => m.ts === request.messageTs);
          const file = message?.files?.find((f) => f.id === request.fileId);
          return file ? await allowedFile(file) : FILE_REFUSED;
        }
        if (!linked) return REFUSED;
        const { ref } = linked;
        if (request.kind === "link") {
          const read =
            linked.conversation ??
            (await reader.readConversation(ref, {
              maxMessages: Math.min(SLACK_CONTEXT_MAX_MESSAGES, REFERENCE_MAX_MESSAGES),
              maxBytes: REFERENCE_MAX_BYTES,
            }));
          const teamUrl = new URL(ref.url).origin;
          const fileLines = threadTurns(
            await fetchSlackReplies(
              client,
              ref.channelId.slice("slack:".length),
              ref.threadKey.slice(ref.channelId.length + 1),
            ),
            {},
          ).filter((t) => t.files?.length);
          return quoted(
            `Linked Slack thread · ${ref.threadKey}`,
            read.messages.map((m) => {
              const ownFiles = m.ts ? fileLines.find((t) => t.ts === m.ts) : undefined;
              return ownFiles
                ? `${fileReferences(ownFiles, teamUrl, ref.channelId.slice("slack:".length), ref.threadKey.slice(ref.channelId.length + 1))} · ${m.author}: ${m.text}`
                : `${m.author}: ${m.text}`;
            }),
          );
        }
        const targetTs = messageTs(request.url!);
        if (!targetTs) return FILE_REFUSED;
        const channel = ref.channelId.slice("slack:".length);
        const threadTs = ref.threadKey.slice(ref.channelId.length + 1);
        const message = threadTurns(await fetchSlackReplies(client, channel, threadTs, targetTs), {}).find(
          (m) => m.ts === targetTs,
        );
        const file = message?.files?.find((f) => f.id === request.fileId);
        return file ? await allowedFile(file) : FILE_REFUSED;
      } catch {
        return request.kind === "file" ? FILE_REFUSED : REFUSED;
      }
    },
  };

  async function allowedFile(file: SlackFile): Promise<ToolResultContent> {
    if (
      isSecretFile(file.name) ||
      !file.name ||
      !slackDownloadUrl(file) ||
      !Number.isInteger(file.size) ||
      (file.size ?? 0) <= 0 ||
      (file.size ?? 0) > SLACK_CONTEXT_MAX_FILE_BYTES ||
      (!classifyDocument(file.mimetype, file.name) && !IMAGE_TYPES.has(file.mimetype ?? ""))
    )
      return FILE_REFUSED;
    return (await (input.loadFile ?? loadSlackFile)(file)) ?? FILE_REFUSED;
  }
}
