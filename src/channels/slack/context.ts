import {
  slackSourceDenial,
  type SlackSourceDenial,
  type SlackSourceDenialReason,
} from "../../core/references/denial.js";
import {
  sourceBinding,
  sameSourceBinding,
  sourceHash,
  type SlackSourceRead,
  type SlackSourceReceipt,
} from "../../core/references/receipts.js";
import type { ToolResultContent } from "../../core/chatMessage.js";
import type { Actor, ChannelDirectory } from "../../core/authz/types.js";
import { wrapUntrusted } from "../../core/commandRegistry.js";
import { referenceAccess, sameReferenceAudience, type ReferenceRefusal } from "../../core/dispatch/references.js";
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
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Read only the SDK's structured error fields; this adapter is also bundled
 * into the CLI package, which does not carry the Slack SDK at runtime. */
function temporaryReadFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, statusCode } = error as { code?: unknown; statusCode?: unknown };
  return (
    code === "slack_webapi_rate_limited_error" ||
    code === "slack_webapi_request_error" ||
    (code === "slack_webapi_http_error" &&
      typeof statusCode === "number" &&
      (statusCode === 429 || (statusCode >= 500 && statusCode < 600)))
  );
}

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

async function loadSlackFile(
  file: SlackFile,
  token?: import("../../secrets.js").Secret,
): Promise<LoadedSlackFile | undefined> {
  const kind = classifyDocument(file.mimetype, file.name);
  if (kind) {
    const result = await fetchDocuments([file], 1, SLACK_CONTEXT_MAX_FILE_BYTES, token);
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
  const result = await fetchImages([file], 1, SLACK_CONTEXT_MAX_FILE_BYTES, token);
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
 * origin verifies private delivery. Linked sources use the same reference
 * policy and the configured read account without changing channel subscriptions.
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

  type SourceAudience = Pick<SlackSourceReceipt, "visibility" | "shared">;
  const sourceAccess = async (
    ref: ConversationRef,
    read = false,
  ): Promise<{ audience: SourceAudience } | { refused: ReferenceRefusal }> => {
    let request = msg;
    if (origin.startsWith("D")) {
      if (!(await verifyDirectOrigin())) return { refused: "denied" };
      if (ref.channelId === msg.channelId) return { audience: { visibility: "dm" } };
      request = {
        ...msg,
        directAudience: {
          kind: "slack-unshared-im",
          userId: actor.id,
          channelId: msg.channelId,
          threadKey: msg.threadKey,
        },
      };
    }
    const access = await referenceAccess(
      { conversationReaders: [reader], channelDirectory: input.directory },
      { actor, msg: request, ...(read ? {} : { purpose: "revalidate" as const }) },
      { reader, ref },
      true,
    );
    return "refused" in access
      ? access
      : {
          audience: {
            visibility: access.classification.visibility,
            ...(access.classification.shared ? { shared: true } : {}),
          },
        };
  };
  const allowedLink = async (
    url: string,
    file: boolean,
  ): Promise<{ ref: ConversationRef; audience: SourceAudience } | SlackSourceDenial> => {
    const ref = await linkOf(url);
    if (!ref) return slackSourceDenial("unavailable", file);
    if (ref.channelId !== msg.channelId && ref.channelId.startsWith("slack:D"))
      return slackSourceDenial("cross_dm_forbidden", file);
    const access = await sourceAccess(ref, ref.channelId !== msg.channelId);
    if ("refused" in access) {
      const temporary = access.refused === "rate-limited" || access.refused === "timed-out";
      return slackSourceDenial(temporary ? "temporarily_unavailable" : "unavailable", file);
    }
    return { ref, audience: access.audience };
  };

  const binding = sourceBinding(msg);
  const originRef = { channelId: msg.channelId, threadKey: msg.threadKey, url: msg.sourceUrl ?? msg.threadKey };
  const refused = (file = false, reason: SlackSourceDenialReason = "unavailable"): SlackSourceDenial =>
    slackSourceDenial(reason, file);

  async function quoteMessages(
    request: SlackContextRequest,
    ref: typeof originRef,
    raw: SlackThreadMessage[],
    label: string,
    audience: SourceAudience,
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
    const fresh = await sourceAccess(ref);
    if ("refused" in fresh || !sameReferenceAudience(audience, fresh.audience)) return refused();
    return {
      kind: "read",
      content: quoted(label, selected.map(line)),
      receipt: {
        kind: "slack-source",
        ...binding,
        source: ref,
        ...audience,
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
    canReadSource: async (ref) => !("refused" in (await sourceAccess(ref))),
    async readSource(request): Promise<SlackSourceRead> {
      try {
        const access = await sourceAccess(originRef);
        if ("refused" in access) return refused(request.kind === "file");
        const { audience } = access;
        if (request.kind === "thread")
          return quoteMessages(
            request,
            originRef,
            await fetchSlackReplies(client, origin, originThread),
            `Current Slack thread · ${msg.threadKey}`,
            audience,
          );
        if (request.kind === "nearby") {
          const page = await client.conversations.history({ channel: origin, limit: SLACK_CONTEXT_MAX_MESSAGES });
          return quoteMessages(
            request,
            originRef,
            [...(page.messages ?? [])].reverse(),
            `Nearby Slack channel · ${msg.channelId}`,
            audience,
            true,
          );
        }
        const linked =
          request.kind === "file" && request.url === undefined
            ? { ref: originRef, audience }
            : await allowedLink(request.url!, request.kind === "file");
        if (!("ref" in linked)) return linked;
        const { ref, audience: linkedAudience } = linked;
        if (request.kind === "link")
          return quoteMessages(
            request,
            ref,
            await reader.forReference(msg.channelId, ref).readThread(ref),
            `Linked Slack thread · ${ref.threadKey}`,
            linkedAudience,
          );
        const target = request.url ? messageTs(request.url) : request.messageTs;
        if (!target) return refused(true);
        const raw = (await reader.forReference(msg.channelId, ref).readThread(ref, target)).find(
          (m) => m.ts === target,
        );
        const file = raw && threadTurns([raw], {})[0]?.files?.find((f) => f.id === request.fileId);
        if (!raw || !file) return refused(true);
        const loaded = await allowedFile(file, ref);
        const fresh = await sourceAccess(ref);
        if (loaded === undefined || "refused" in fresh || !sameReferenceAudience(linkedAudience, fresh.audience))
          return refused(true);
        return {
          kind: "read",
          content: loaded.content,
          receipt: {
            kind: "slack-source",
            ...binding,
            source: ref,
            ...linkedAudience,
            readKind: "file",
            messages: [{ id: target, hash: await slackMessageHash(raw) }],
            file: { id: request.fileId, hash: loaded.hash },
            coverage: { kind: "bounded", truncated: loaded.truncated },
          },
        };
      } catch (error) {
        return refused(
          request.kind === "file",
          temporaryReadFailure(error) ? "temporarily_unavailable" : "unavailable",
        );
      }
    },
    async originAudience() {
      const access = await sourceAccess(originRef);
      return "refused" in access ? undefined : access.audience.visibility;
    },
    async revalidateSource(receipt): Promise<boolean> {
      if (!sameSourceBinding(receipt, binding)) return false;
      const ref = receipt.source;
      try {
        const audience = await sourceAccess(ref);
        if ("refused" in audience || !sameReferenceAudience(receipt, audience.audience)) return false;
        const channel = ref.channelId.slice(6);
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
          raw = await reader.forReference(msg.channelId, ref).readThread(
            ref,
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
          const loaded = file && (await allowedFile(file, ref));
          if (loaded === undefined || loaded.hash !== receipt.file.hash) return false;
        }
        const fresh = await sourceAccess(ref);
        return !("refused" in fresh) && sameReferenceAudience(receipt, fresh.audience);
      } catch {
        return false;
      }
    },
  };

  async function allowedFile(file: SlackFile, ref: ConversationRef): Promise<LoadedSlackFile | undefined> {
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
    return input.loadFile ? input.loadFile(file) : loadSlackFile(file, reader.forReference(msg.channelId, ref).token);
  }
}
