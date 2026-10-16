import type { Secret } from "../../secrets.js";
import { nativeMediaSchema, nativeMediaDigest, matchesNativeMedia, type NativeMedia } from "../../core/nativeMedia.js";
import type { IncomingMessage } from "../../core/types.js";
import {
  acceptedStagedFile,
  fetchDocuments,
  fetchImages,
  MAX_DOCS_PER_MESSAGE,
  MAX_IMAGES_PER_MESSAGE,
  stagedFiles,
  type SlackFile,
} from "./attachments.js";

interface SourceMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  edited?: { ts?: string };
  files?: SlackFile[];
}
export interface SlackNativeMediaOptions {
  replies(args: {
    channel: string;
    ts: string;
    oldest: string;
    latest: string;
    inclusive: true;
    limit: 1;
  }): Promise<{ messages?: SourceMessage[] }>;
  policy(): { staging: boolean; maxBytesPerMessage: number };
  token?(): Secret | undefined;
}
const safeUrl = (value?: string) => {
  try {
    const url = new URL(value ?? "");
    return (
      url.protocol === "https:" &&
      (url.hostname === "slack.com" || url.hostname.endsWith(".slack.com")) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
};
const fileFacts = (files: SlackFile[]) =>
  JSON.stringify(files.map((file) => ({ id: file.id, name: file.name, type: file.mimetype, size: file.size })));
/** Credentials remain in the Slack adapter. Durable requests retain addresses and hashes only. */
export function createSlackNativeMedia(options: SlackNativeMediaOptions) {
  async function read(address: Pick<NativeMedia, "channelId" | "userId" | "threadKey" | "messageId">) {
    const channel = address.channelId.slice("slack:".length);
    if (
      !/^D[A-Z0-9_]+$/.test(channel) ||
      !/^slack:[UW][A-Z0-9_]+$/.test(address.userId) ||
      !address.threadKey.startsWith(`${address.channelId}:`)
    )
      return;
    const root = address.threadKey.slice(address.channelId.length + 1);
    const response = await options.replies({
      channel,
      ts: root,
      oldest: address.messageId,
      latest: address.messageId,
      inclusive: true,
      limit: 1,
    });
    if (response.messages?.length !== 1) return;
    const message = response.messages[0]!;
    if (
      message.ts !== address.messageId ||
      `slack:${message.user}` !== address.userId ||
      message.bot_id ||
      (message.thread_ts ?? message.ts) !== root ||
      typeof message.text !== "string"
    )
      return;
    return message;
  }
  async function capture(
    address: Pick<NativeMedia, "channelId" | "userId" | "threadKey" | "messageId"> & { rawText: string },
    sourceFiles: SlackFile[],
    accepted: {
      images: Awaited<ReturnType<typeof fetchImages>>;
      documents: Awaited<ReturnType<typeof fetchDocuments>>;
    },
    msg: Pick<IncomingMessage, "images" | "documents" | "staged">,
  ): Promise<NativeMedia | undefined> {
    const source = await read(address);
    if (!source || source.text !== address.rawText) return;
    const currentFiles = source.files ?? [];
    if (currentFiles.length !== sourceFiles.length) return;
    for (let slot = 0; slot < sourceFiles.length; slot++) {
      const initial = sourceFiles[slot]!,
        current = currentFiles[slot]!;
      if (
        (initial.id && initial.id !== current.id) ||
        initial.name !== current.name ||
        initial.mimetype !== current.mimetype ||
        initial.size !== current.size
      )
        return;
    }
    const files: NativeMedia["files"] = [];
    for (const kind of ["image", "document"] as const) {
      const items = kind === "image" ? (msg.images ?? []) : (msg.documents ?? []);
      const original = kind === "image" ? accepted.images.acceptedFiles : accepted.documents.acceptedFiles;
      for (let index = 0; index < items.length; index++) {
        const item = items[index]!,
          receipt = original[index];
        const slot = receipt ? sourceFiles.indexOf(receipt.file) : -1;
        const file = currentFiles[slot];
        if (
          !receipt ||
          !file?.id ||
          file.size !== receipt.size ||
          !safeUrl(file.url_private_download ?? file.url_private)
        )
          return;
        files.push({
          id: `slack:file:${file.id}`,
          slot,
          kind,
          index,
          mediaType: item.mediaType,
          ...(item.name ? { name: item.name } : {}),
          size: receipt.size,
          representationDigest: await nativeMediaDigest(item.data),
          ...(item.staged ? { staged: item.staged } : {}),
        });
      }
    }
    for (let index = 0; index < (msg.staged?.length ?? 0); index++) {
      const item = msg.staged![index]!;
      const slot = sourceFiles.findIndex(
        (file) => (file.url_private_download ?? file.url_private) === item.url && file.name === item.name,
      );
      const file = currentFiles[slot];
      if (!file?.id || !safeUrl(item.url) || file.size !== item.size || file.mimetype !== item.type) return;
      files.push({
        id: `slack:file:${file.id}`,
        slot,
        kind: "staged",
        index,
        mediaType: item.type,
        name: item.name,
        size: item.size,
        staged: item,
      });
    }
    const { rawText: _raw, ...sourceAddress } = address;
    const parsed = nativeMediaSchema.safeParse({
      version: 1,
      ...sourceAddress,
      rawTextDigest: await nativeMediaDigest(address.rawText),
      sourceFilesDigest: await nativeMediaDigest(fileFacts(currentFiles)),
      ...(source.edited?.ts ? { editedAt: source.edited.ts } : {}),
      files,
    });
    return parsed.success ? parsed.data : undefined;
  }
  async function materialize(
    media: NativeMedia,
  ): Promise<Pick<IncomingMessage, "images" | "documents" | "staged"> | undefined> {
    const parsed = nativeMediaSchema.safeParse(media);
    if (!parsed.success) return;
    media = parsed.data;
    const source = await read(media);
    if (
      !source ||
      (await nativeMediaDigest(source.text!)) !== media.rawTextDigest ||
      source.edited?.ts !== media.editedAt ||
      (await nativeMediaDigest(fileFacts(source.files ?? []))) !== media.sourceFilesDigest
    )
      return;
    const raw = source.files ?? [],
      images = [],
      documents = [],
      staged = [];
    for (const file of media.files) {
      const current = raw[file.slot];
      if (
        !current ||
        `slack:file:${current.id}` !== file.id ||
        current.size !== file.size ||
        current.name !== file.name ||
        !safeUrl(current.url_private_download ?? current.url_private)
      )
        return;
      if (file.kind === "staged") {
        const pass = stagedFiles([current], { ...options.policy(), messageId: media.messageId });
        const item = pass.staged[0];
        if (!item) return;
        staged.push({
          ...item,
          ...(file.staged?.workspaceIndex !== undefined ? { workspaceIndex: file.staged.workspaceIndex } : {}),
        });
      } else if (file.kind === "image") {
        const pass = await fetchImages([current], MAX_IMAGES_PER_MESSAGE, Infinity, options.token?.());
        const item = pass.images[0];
        if (!item || pass.acceptedFiles[0]?.size !== file.size) return;
        const ref = file.staged
          ? acceptedStagedFile(pass.acceptedFiles[0]!, media.messageId, file.staged.workspaceIndex!)
          : undefined;
        if (file.staged && (!options.policy().staging || !ref)) return;
        images.push({ ...item, ...(ref ? { staged: ref } : {}) });
      } else {
        const pass = await fetchDocuments([current], MAX_DOCS_PER_MESSAGE, Infinity, options.token?.());
        const item = pass.documents[0];
        if (!item || pass.acceptedFiles[0]?.size !== file.size) return;
        const ref = file.staged
          ? acceptedStagedFile(pass.acceptedFiles[0]!, media.messageId, file.staged.workspaceIndex!)
          : undefined;
        if (file.staged && (!options.policy().staging || !ref)) return;
        documents.push({ ...item, ...(ref ? { staged: ref } : {}) });
      }
    }
    const value = { images, documents, staged };
    if (
      !(await matchesNativeMedia(media, value)) ||
      [
        ...staged,
        ...images.flatMap((item) => (item.staged ? [item.staged] : [])),
        ...documents.flatMap((item) => (item.staged ? [item.staged] : [])),
      ].reduce((sum, item) => sum + item.size, 0) > options.policy().maxBytesPerMessage
    )
      return;
    const final = await read(media);
    if (
      !final ||
      (await nativeMediaDigest(final.text!)) !== media.rawTextDigest ||
      final.edited?.ts !== media.editedAt ||
      (await nativeMediaDigest(fileFacts(final.files ?? []))) !== media.sourceFilesDigest
    )
      return;
    return value;
  }
  return { capture, materialize };
}
