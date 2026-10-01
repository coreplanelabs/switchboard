import { sourceBinding, sameSourceBinding, sourceHash, type SlackSourceRead } from "../../core/references/receipts.js";
import type { ToolResultContent } from "../../core/chatMessage.js";
import type { Actor, ChannelDirectory } from "../../core/authz/types.js";
import { wrapUntrusted } from "../../core/commandRegistry.js";
import { readReferences } from "../../core/dispatch/references.js";
import type { ConversationRef } from "../../core/references/types.js";
import type { IncomingMessage } from "../../core/types.js";
import type { SlackContextRequest, VerifiedSlackContextCapability } from "../../tools/slackContext.js";
import { classifyDocument, fetchDocuments, fetchImages, isSecretFile, type SlackFile } from "./attachments.js";
import { verifySlackDirectAudience } from "./directAudience.js";
import { fetchSlackReplies, slackMessageHash, SlackConversationReader, type ReferenceClient } from "./references.js";
import { resolveTeamUrl, slackPermalink } from "./lookups.js";
import { threadTurns, type SlackThreadMessage, type ThreadTurn } from "./threadTurns.js";

/** The bot's existing Slack Web API client, with the channel history read this tool needs. */
export interface SlackContextClient extends Omit<ReferenceClient, "conversations"> {
  conversations: Omit<ReferenceClient["conversations"], "replies"> & {
    replies: ReferenceClient["conversations"]["replies"];
    history(args: {
      channel: string;
      limit: number;
      oldest?: string;
      latest?: string;
      inclusive?: boolean;
    }): Promise<{ messages?: SlackThreadMessage[]; has_more?: boolean }>;
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
  return `${label} · ${lines.length} message${lines.length === 1 ? "" : "s"}\n${wrapUntrusted(lines.join("\n"))}`;
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

export interface LoadedSlackFile {
  content: ToolResultContent;
  hash: string;
  truncated: boolean;
}

async function loadSlackFile(file: SlackFile): Promise<LoadedSlackFile | undefined> {
  const kind = classifyDocument(file.mimetype, file.name);
  if (kind) {
    const result = await fetchDocuments([file], 1, SLACK_CONTEXT_MAX_FILE_BYTES);
    const doc = result.documents[0];
    if (!doc) return undefined;
    const label = `Slack file ${JSON.stringify(file.name)} (${file.size} bytes)`;
    const content: ToolResultContent =
      kind === "pdf"
        ? [
            { type: "text", text: wrapUntrusted(`${label}; attached PDF follows as source data.`) },
            { type: "document", mediaType: doc.mediaType, data: doc.data, name: "Slack document" },
          ]
        : wrapUntrusted(`${label}\n${clipped(doc.data, SLACK_CONTEXT_MAX_FILE_TEXT_CHARS)}`);
    return {
      content,
      hash: await sourceHash({ mediaType: doc.mediaType, data: doc.data }),
      truncated: kind !== "pdf" && doc.data.length > SLACK_CONTEXT_MAX_FILE_TEXT_CHARS,
    };
  }
  if (!IMAGE_TYPES.has(file.mimetype ?? "")) return undefined;
  const result = await fetchImages([file], 1, SLACK_CONTEXT_MAX_FILE_BYTES);
  const image = result.images[0];
  return image
    ? {
        hash: await sourceHash({ mediaType: image.mediaType, data: image.data }),
        truncated: false,
        content: [
          {
            type: "text",
            text: wrapUntrusted(
              `Slack file ${JSON.stringify(file.name)} (${file.size} bytes); attached image follows as source data.`,
            ),
          },
          { type: "image", mediaType: image.mediaType, data: image.data },
        ],
      }
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
  loadFile?: (file: SlackFile) => Promise<LoadedSlackFile | undefined>;
}): VerifiedSlackContextCapability {
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

  const verifyDirectOrigin = async (): Promise<boolean> => {
    if (!origin.startsWith("D")) return false;
    return (
      await verifySlackDirectAudience(client, {
        kind: "slack-unshared-im",
        channelId: msg.channelId,
        userId: actor.id,
        threadKey: msg.threadKey,
      })
    ).ok;
  };

  const originAllowed = async (): Promise<boolean> => {
    if (origin.startsWith("D")) return verifyDirectOrigin();
    const ref = { channelId: msg.channelId, threadKey: msg.threadKey, url: msg.sourceUrl ?? msg.threadKey };
    const cls = await reader.classifyConversation(ref);
    if (cls.visibility === "never" || !cls.botIsMember) return false;
    if (cls.visibility === "private") return (await input.directory?.isMember(actor.id, msg.channelId)) === true;
    return reader.requesterIsFullMember(actor.id);
  };

  const originAllowedFresh = async (): Promise<boolean> => {
    if (origin.startsWith("D")) return verifyDirectOrigin();
    const ref = { channelId: msg.channelId, threadKey: msg.threadKey, url: msg.sourceUrl ?? msg.threadKey };
    const cls = await reader.classifyConversationFresh(ref);
    if (cls.visibility === "never" || !cls.botIsMember) return false;
    if (cls.visibility === "private") return (await input.directory?.isMember(actor.id, msg.channelId)) === true;
    return reader.requesterIsFullMember(actor.id);
  };

  const linkedStillAllowed = async (ref: NonNullable<ReturnType<typeof reader.parseConversationUrl>>) => {
    if (ref.channelId === msg.channelId) return originAllowedFresh();
    const cls = await reader.classifyConversationFresh(ref);
    return cls.visibility === "public" && cls.botIsMember && (await reader.requesterIsFullMember(actor.id));
  };

  const allowedLink = async (url: string): Promise<{ ref: ConversationRef } | undefined> => {
    const ref = await linkOf(url);
    if (!ref) return undefined;
    if (ref.channelId === msg.channelId) return { ref };
    // Public sources can be quoted into the destination; a private channel's
    // membership alone says nothing about everyone in the destination.
    const cls = await reader.classifyConversation(ref);
    if (cls.visibility !== "public" || !cls.botIsMember) return undefined;
    const checked = await readReferences({ conversationReaders: [reader] }, { actor, msg: { ...msg, text: url } });
    return checked.conversations.length === 1 && checked.refused.length === 0
      ? { ref: checked.conversations[0].ref }
      : undefined;
  };

  const binding = sourceBinding(msg);
  const originRef = { channelId: msg.channelId, threadKey: msg.threadKey, url: msg.sourceUrl ?? msg.threadKey };
  const refused = (file = false): SlackSourceRead => ({ kind: "refused", content: file ? FILE_REFUSED : REFUSED });

  async function quoteMessages(
    request: SlackContextRequest,
    ref: typeof originRef,
    raw: SlackThreadMessage[],
    label: string,
    nearby = false,
  ): Promise<SlackSourceRead> {
    const teamUrl = await resolveTeamUrl(client);
    const all = threadTurns(raw, {});
    let selected = all.slice(-SLACK_CONTEXT_MAX_MESSAGES);
    const line = (t: ThreadTurn) =>
      clipped(
        turnLine(
          t,
          teamUrl,
          ref.channelId.slice(6),
          nearby ? (t.ts ?? "") : ref.threadKey.slice(ref.channelId.length + 1),
        ),
        1200,
      );
    while (selected.length > 1 && selected.map(line).join("\n").length > SLACK_CONTEXT_MAX_TEXT_CHARS)
      selected = selected.slice(1);
    if (selected.some((t) => !t.ts)) return refused();
    const messages = await Promise.all(
      selected.map(async (t) => ({ id: t.ts!, hash: await slackMessageHash(raw.find((m) => m.ts === t.ts)!) })),
    );
    if (!(await linkedStillAllowed(ref))) return refused();
    return {
      kind: "read",
      content: quoted(label, selected.map(line)),
      receipt: {
        kind: "slack-source",
        ...binding,
        source: ref,
        visibility: ref.channelId === msg.channelId ? (origin.startsWith("D") ? "dm" : "private") : "public",
        readKind: request.kind,
        messages,
        coverage: {
          kind: nearby || selected.length < all.length ? "bounded" : "complete",
          truncated:
            nearby ||
            selected.length < all.length ||
            selected.some(
              (t) =>
                turnLine(t, teamUrl, ref.channelId.slice(6), ref.threadKey.slice(ref.channelId.length + 1)).length >
                1200,
            ),
        },
      },
    };
  }

  return {
    verifyDirectOrigin,
    async readSource(request): Promise<SlackSourceRead> {
      try {
        if (!(await originAllowed())) return refused(request.kind === "file");
        if (request.kind === "thread")
          return quoteMessages(
            request,
            originRef,
            await fetchSlackReplies(client, origin, originThread),
            `Current Slack thread · ${msg.threadKey}`,
          );
        if (request.kind === "nearby") {
          const page = await client.conversations.history({ channel: origin, limit: SLACK_CONTEXT_MAX_MESSAGES });
          return quoteMessages(
            request,
            originRef,
            [...(page.messages ?? [])].reverse(),
            `Nearby Slack channel · ${msg.channelId}`,
            true,
          );
        }
        const linked =
          request.kind === "file" && request.url === undefined ? { ref: originRef } : await allowedLink(request.url!);
        if (!linked) return refused(request.kind === "file");
        const { ref } = linked;
        const channel = ref.channelId.slice(6);
        const threadTs = ref.threadKey.slice(ref.channelId.length + 1);
        if (request.kind === "link")
          return quoteMessages(
            request,
            ref,
            await fetchSlackReplies(client, channel, threadTs),
            `Linked Slack thread · ${ref.threadKey}`,
          );
        const target = request.url ? messageTs(request.url) : request.messageTs;
        if (!target) return refused(true);
        const raw = (await fetchSlackReplies(client, channel, threadTs, target)).find((m) => m.ts === target);
        const file = raw && threadTurns([raw], {})[0]?.files?.find((f) => f.id === request.fileId);
        if (!raw || !file) return refused(true);
        const loaded = await allowedFile(file);
        if (loaded === undefined || !(await linkedStillAllowed(ref))) return refused(true);
        return {
          kind: "read",
          content: loaded.content,
          receipt: {
            kind: "slack-source",
            ...binding,
            source: ref,
            visibility: channel === origin ? (origin.startsWith("D") ? "dm" : "private") : "public",
            readKind: "file",
            messages: [{ id: target, hash: await slackMessageHash(raw) }],
            file: { id: request.fileId, hash: loaded.hash },
            coverage: { kind: "bounded", truncated: loaded.truncated },
          },
        };
      } catch {
        return refused(request.kind === "file");
      }
    },
    async revalidateSource(receipt): Promise<boolean> {
      if (!sameSourceBinding(receipt, binding)) return false;
      const ref = receipt.source;
      try {
        if (!(await originAllowedFresh()) || !(await linkedStillAllowed(ref))) return false;
        const channel = ref.channelId.slice(6);
        const threadTs = ref.threadKey.slice(ref.channelId.length + 1);
        let raw: SlackThreadMessage[];
        if (receipt.readKind === "nearby") {
          raw = [];
          for (const message of receipt.messages) {
            const page = await client.conversations.history({
              channel,
              limit: 1,
              oldest: message.id,
              latest: message.id,
              inclusive: true,
            });
            raw.push(...(page.messages ?? []).filter((m) => m.ts === message.id));
          }
        } else
          raw = await fetchSlackReplies(
            client,
            channel,
            threadTs,
            receipt.messages.map((message) => message.id),
          );
        for (const consumed of receipt.messages) {
          const matches = raw.filter((m) => m.ts === consumed.id);
          if (matches.length !== 1 || (await slackMessageHash(matches[0])) !== consumed.hash) return false;
        }
        if (receipt.file) {
          if (receipt.messages.length !== 1) return false;
          const message = raw.find((m) => m.ts === receipt.messages[0].id)!;
          const file = threadTurns([message], {})[0]?.files?.find((f) => f.id === receipt.file!.id);
          const loaded = file && (await allowedFile(file));
          if (loaded === undefined || loaded.hash !== receipt.file.hash) return false;
        }
        return (await originAllowedFresh()) && (await linkedStillAllowed(ref));
      } catch {
        return false;
      }
    },
  };

  async function allowedFile(file: SlackFile): Promise<LoadedSlackFile | undefined> {
    if (
      isSecretFile(file.name) ||
      !file.name ||
      !slackDownloadUrl(file) ||
      !Number.isInteger(file.size) ||
      (file.size ?? 0) <= 0 ||
      (file.size ?? 0) > SLACK_CONTEXT_MAX_FILE_BYTES ||
      (!classifyDocument(file.mimetype, file.name) && !IMAGE_TYPES.has(file.mimetype ?? ""))
    )
      return undefined;
    return (input.loadFile ?? loadSlackFile)(file);
  }
}
