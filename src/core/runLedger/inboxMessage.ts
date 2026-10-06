// The durable shape of a message on the run ledger (docs/reference/specs/run-history.md
// items 40 and 42): a steered follow-up in `run_inbox`, and the request a run
// was admitted for in its row's `meta.request`. One writer, one reader, so a
// row written by one generation is read the same way by the next.

import type { IncomingMessage, SlackDirectAudience, StagedFile } from "../types.js";

/** Durable provenance only; every private action still verifies Slack live. */
export type DirectAudienceStamp = SlackDirectAudience;

/** A control is a typed fact from the canonical plane writer, never text. */
export type InboxControl =
  | { kind: "checkpoint"; round: number; causes: readonly ("long_call" | "no_push")[] }
  | { kind: "provider-reissue"; provider: string };

export interface InboxTarget {
  runId: string;
  channelId: string;
  threadKey: string;
  requester?: string;
}

export interface InboxCustody extends InboxTarget {
  version: 1;
  requester: string;
  producerGen: string;
}

export function inboxCustodyOf(value: unknown): InboxCustody | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    !["runId", "channelId", "threadKey", "requester", "producerGen"].every(
      (key) => typeof v[key] === "string" && v[key].length > 0,
    )
  )
    return;
  return {
    version: 1,
    runId: String(v.runId),
    channelId: String(v.channelId),
    threadKey: String(v.threadKey),
    requester: String(v.requester),
    producerGen: String(v.producerGen),
  };
}

/** The store stamps the destination from its live owner, not from supplied
 * requester text. Opaque legacy payloads retain these custody coordinates. */
export function bindInboxCustody(
  message: Record<string, unknown>,
  target: InboxTarget & { requester: string; producerGen: string },
  internalControl = false,
): Record<string, unknown> | undefined {
  if (
    ![target.runId, target.channelId, target.threadKey, target.requester, target.producerGen].every(
      (field) => typeof field === "string" && field.length > 0,
    ) ||
    message.target !== undefined
  )
    return;
  if (
    !internalControl &&
    (message.userId === "plane" || message.kind === "checkpoint" || message.kind === "provider-reissue")
  )
    return;
  if (
    internalControl &&
    ((message.channelId !== undefined && message.channelId !== target.channelId) ||
      (message.threadKey !== undefined && message.threadKey !== target.threadKey))
  )
    return;
  return { ...structuredClone(message), target: { version: 1, ...target } };
}

export const CHECKPOINT_STEER_SENTENCE =
  "finish the step you are on, push a checkpoint and end the round; start no new command; the resident takes your push";

export function inboxControlText(control: InboxControl): string {
  return control.kind === "checkpoint"
    ? CHECKPOINT_STEER_SENTENCE
    : `the model provider ${control.provider} is answering again — re-issue the held turn and continue`;
}

export function inboxControlOf(stored: Record<string, unknown>, target?: InboxTarget): InboxControl | undefined {
  if (
    stored.version !== 1 ||
    !target ||
    stored.targetRunId !== target.runId ||
    stored.channelId !== target.channelId ||
    stored.threadKey !== target.threadKey ||
    stored.userId !== "plane" ||
    typeof stored.plane !== "object" ||
    stored.plane === null ||
    ["authenticatedAs", "postedBy", "relayedBy", "fromRunId", "directAudience"].some((key) => stored[key] !== undefined)
  )
    return;
  const plane = stored.plane as Record<string, unknown>;
  if (
    stored.kind === "checkpoint" &&
    plane.steer === "checkpoint" &&
    Number.isSafeInteger(plane.round) &&
    Number(plane.round) >= 0 &&
    Array.isArray(plane.causes) &&
    plane.causes.length > 0 &&
    plane.causes.every((cause) => cause === "long_call" || cause === "no_push")
  )
    return { kind: "checkpoint", round: Number(plane.round), causes: [...plane.causes] };
  if (
    stored.kind === "provider-reissue" &&
    plane.steer === "reissue" &&
    typeof plane.provider === "string" &&
    plane.provider.length > 0 &&
    plane.provider.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(plane.provider)
  )
    return { kind: "provider-reissue", provider: plane.provider };
}

export function directAudienceStampOf(
  source: Pick<IncomingMessage, "channelId" | "userId" | "threadKey"> & {
    directAudience?: unknown;
    relayedBy?: string;
    postedBy?: string;
    authenticatedAs?: string;
    fromRunId?: string;
  },
): DirectAudienceStamp | undefined {
  const value = source.directAudience;
  if (typeof value !== "object" || value === null) return undefined;
  const audience = value as Record<string, unknown>;
  if (
    audience.kind !== "slack-unshared-im" ||
    typeof source.channelId !== "string" ||
    typeof source.userId !== "string" ||
    typeof source.threadKey !== "string" ||
    audience.channelId !== source.channelId ||
    audience.userId !== source.userId ||
    audience.threadKey !== source.threadKey ||
    !/^slack:D[A-Z0-9_]+$/.test(source.channelId) ||
    !/^slack:[UW][A-Z0-9_]+$/.test(source.userId) ||
    !source.threadKey.startsWith(`${source.channelId}:`) ||
    source.relayedBy !== undefined ||
    source.postedBy !== undefined ||
    source.authenticatedAs !== undefined ||
    source.fromRunId !== undefined
  )
    return undefined;
  return { kind: "slack-unshared-im", channelId: source.channelId, userId: source.userId, threadKey: source.threadKey };
}

/** The most a durable inbox row may weigh, serialized: the state Worker caps
 *  `/runs/inbox` bodies at 512 KiB (`MAX_BODY_BYTES`), and the row travels
 *  inside a JSON envelope with the store key and run id. */
export const DURABLE_INBOX_MAX_BYTES = 400 * 1024;

type Attachment = { mediaType: string; data: string; name?: string };

/** The durable copy of a message: the text given (a follow-up's directive-free
 *  text; a request's text verbatim, directives included), sender, link, thread,
 *  arrival time, the run that sent it when a run did (`fromRunId`, a parent's
 *  steer — agent-conductor item 8) — attachments included when the row stays
 *  under `DURABLE_INBOX_MAX_BYTES`, because a screenshot must survive a
 *  restart as much as its caption. Over the cap the bytes are left with the
 *  in-memory copy and the row says how many attachments it lost, so the
 *  message read back can say so too. */
export function durableInboxMessage(
  msg: IncomingMessage,
  text: string,
  at: number,
  from?: { runId: string },
): Record<string, unknown> {
  const directAudience = from === undefined ? directAudienceStampOf(msg) : undefined;
  const base: Record<string, unknown> = {
    version: 1,
    kind: "message",
    channelId: msg.channelId,
    userId: msg.userId,
    threadKey: msg.threadKey,
    text,
    at,
    ...(msg.userName !== undefined ? { userName: msg.userName } : {}),
    // The credential behind a bound person rides the row (authorization.md item
    // 15): a restart must dispatch under the credential's grants, not the person's.
    ...(msg.authenticatedAs !== undefined ? { authenticatedAs: msg.authenticatedAs } : {}),
    ...(msg.postedBy !== undefined ? { postedBy: msg.postedBy } : {}),
    ...(msg.relayedBy !== undefined ? { relayedBy: msg.relayedBy } : {}),
    ...(msg.sourceUrl !== undefined ? { sourceUrl: msg.sourceUrl } : {}),
    ...(directAudience !== undefined ? { directAudience } : {}),
    ...(msg.channelName !== undefined ? { channelName: msg.channelName } : {}),
    ...(msg.messageId !== undefined ? { messageId: msg.messageId } : {}),
    ...(from !== undefined ? { fromRunId: from.runId } : {}),
    // Staged references are metadata (record 0033) — a few hundred bytes each —
    // so they ride the base row and survive the restart whatever the
    // attachments below do.
    ...(msg.staged && msg.staged.length > 0 ? { staged: msg.staged.map(stagedRow) } : {}),
  };
  const images = msg.images ?? [];
  const documents = msg.documents ?? [];
  if (images.length === 0 && documents.length === 0) return base;
  const withAttachments = {
    ...base,
    ...(images.length > 0 ? { images: images.map(attachmentRow) } : {}),
    ...(documents.length > 0 ? { documents: documents.map(attachmentRow) } : {}),
  };
  // Bytes as the Worker counts them (Content-Length), not UTF-16 code units.
  if (Buffer.byteLength(JSON.stringify(withAttachments), "utf8") <= DURABLE_INBOX_MAX_BYTES) return withAttachments;
  // All or nothing by design: a partial carry would hand the model some of the
  // sender's attachments as if they were all of them; the note names the count.
  return { ...base, attachmentsDropped: { images: images.length, documents: documents.length } };
}

const attachmentRow = (a: Attachment) => ({
  mediaType: a.mediaType,
  data: a.data,
  ...(a.name !== undefined ? { name: a.name } : {}),
});

const stagedRow = (s: StagedFile) => ({ name: s.name, size: s.size, type: s.type, url: s.url, messageId: s.messageId });

/** A stored staged list back as references; an entry missing a field is dropped, never fatal. */
function stagedFromInbox(v: unknown): StagedFile[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((e): StagedFile[] => {
    if (typeof e !== "object" || e === null) return [];
    const r = e as Record<string, unknown>;
    if (
      typeof r.name !== "string" ||
      typeof r.size !== "number" ||
      typeof r.type !== "string" ||
      typeof r.url !== "string" ||
      typeof r.messageId !== "string"
    )
      return [];
    return [{ name: r.name, size: r.size, type: r.type, url: r.url, messageId: r.messageId }];
  });
  return out.length > 0 ? out : undefined;
}

/** A durable row back as the message it was: text (with the dropped-attachments
 *  note appended when the row says it lost some), sender, link, thread,
 *  attachments as typed parts, the arrival time (`fallbackAt` when the row
 *  has none), and the run that sent it when one did. Undefined when the
 *  stored shape is not one this build wrote — the caller skips it, never fatal. */
export function messageFromInbox(
  stored: Record<string, unknown>,
  fallbackAt: number,
  target?: InboxTarget,
):
  | { msg: IncomingMessage; at: number; from?: { runId: string }; control?: InboxControl; custody?: InboxCustody }
  | undefined {
  const m = stored;
  if (typeof m !== "object" || m === null || Array.isArray(m)) return;
  if (m.version !== undefined && m.version !== 1) return;
  const custody = inboxCustodyOf(m.target);
  if (m.target !== undefined) {
    if (!custody) return;
    const bound = custody;
    if (
      (m.userId === "plane" || m.directAudience !== undefined) &&
      (bound.channelId !== m.channelId || bound.threadKey !== m.threadKey)
    )
      return;
    if (
      target &&
      (bound.runId !== target.runId ||
        bound.channelId !== target.channelId ||
        bound.threadKey !== target.threadKey ||
        (target.requester !== undefined && bound.requester !== target.requester))
    )
      return;
  }
  const control = inboxControlOf(m, target);
  if (m.version === 1 && m.kind !== "message" && !control) return;
  if (m.userId === "plane" && !control) return;
  // Dropping a present malformed principal would turn an app/credential into
  // the person's authority. Keep the row opaque instead.
  if (
    ["authenticatedAs", "postedBy", "relayedBy", "fromRunId"].some(
      (key) => m[key] !== undefined && (typeof m[key] !== "string" || m[key].length === 0),
    )
  )
    return;
  const str = (k: string): string | undefined => (typeof m[k] === "string" ? (m[k] as string) : undefined);
  const text = str("text");
  const userId = str("userId");
  const threadKey = str("threadKey");
  const channelId = str("channelId");
  if (text === undefined || userId === undefined || threadKey === undefined || channelId === undefined)
    return undefined;
  const userName = str("userName");
  const authenticatedAs = str("authenticatedAs");
  const postedBy = str("postedBy");
  const relayedBy = str("relayedBy");
  const sourceUrl = str("sourceUrl");
  const channelName = str("channelName");
  const messageId = str("messageId");
  const fromRunId = str("fromRunId");
  const at = typeof m.at === "number" && Number.isFinite(m.at) ? m.at : fallbackAt;
  const images = attachmentsFromInbox(m.images);
  const documents = attachmentsFromInbox(m.documents);
  const staged = stagedFromInbox(m.staged);
  const note = droppedNote(m.attachmentsDropped);
  const directAudience = directAudienceStampOf({
    channelId,
    userId,
    threadKey,
    directAudience: m.directAudience,
    relayedBy,
    postedBy,
    authenticatedAs,
    fromRunId,
  });
  if (m.directAudience !== undefined && !directAudience) return;
  if (m.version === undefined && channelId.startsWith("slack:D") && !directAudience) return;
  const msg: IncomingMessage = {
    channelId,
    userId,
    threadKey,
    text: control ? inboxControlText(control) : note ? `${text}\n\n${note}` : text,
    ...(userName !== undefined ? { userName } : {}),
    ...(authenticatedAs !== undefined ? { authenticatedAs } : {}),
    ...(postedBy !== undefined ? { postedBy } : {}),
    ...(relayedBy !== undefined ? { relayedBy } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
    ...(directAudience !== undefined ? { directAudience } : {}),
    ...(channelName !== undefined ? { channelName } : {}),
    ...(messageId !== undefined ? { messageId } : {}),
    ...(images ? { images } : {}),
    ...(documents ? { documents } : {}),
    ...(staged ? { staged } : {}),
  };
  return {
    msg,
    at,
    ...(fromRunId !== undefined ? { from: { runId: fromRunId } } : {}),
    ...(control ? { control } : {}),
    ...(custody ? { custody } : {}),
  };
}

/** A stored attachment list back as typed attachments; an entry that is not
 *  `{mediaType, data}` strings is dropped, never fatal. */
function attachmentsFromInbox(v: unknown): Attachment[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((e) => {
    if (typeof e !== "object" || e === null) return [];
    const r = e as Record<string, unknown>;
    if (typeof r.mediaType !== "string" || typeof r.data !== "string") return [];
    return [{ mediaType: r.mediaType, data: r.data, ...(typeof r.name === "string" ? { name: r.name } : {}) }];
  });
  return out.length > 0 ? out : undefined;
}

/** What a message read back says when its attachments did not fit the durable row. */
function droppedNote(dropped: unknown): string | undefined {
  if (typeof dropped !== "object" || dropped === null) return undefined;
  const d = dropped as Record<string, unknown>;
  const n = (typeof d.images === "number" ? d.images : 0) + (typeof d.documents === "number" ? d.documents : 0);
  if (n <= 0) return undefined;
  return `(${n} attachment${n === 1 ? "" : "s"} from this reply could not be carried across the bot's restart and ${n === 1 ? "is" : "are"} not attached.)`;
}
