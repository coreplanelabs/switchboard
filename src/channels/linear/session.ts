import type { IncomingMessage } from "../../core/types.js";
import { object, string, type LinearSession } from "./api.js";
import type { LinearWebhookEvent } from "./webhook.js";

const safeId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function linearThread(threadKey: string): { organizationId: string; sessionId: string } | undefined {
  const [platform, organizationId, sessionId, extra] = threadKey.split(":");
  return platform === "linear" && safeId(organizationId) && safeId(sessionId) && extra === undefined
    ? { organizationId, sessionId }
    : undefined;
}

export type LinearInput =
  | { kind: "message"; msg: IncomingMessage; triggeringActivityId?: string }
  | { kind: "stop"; userId: string; channelId: string; threadKey: string; receivedAt: number };

/** Signed identity plus fresh access/ownership. Prompt text is never identity
 *  or authority, and delegation never borrows the issue assignee's grants. */
export function linearMessage(event: LinearWebhookEvent, current: LinearSession, appUserId: string): LinearInput {
  const payload = event.payload,
    session = object(payload.agentSession);
  const org = payload.organizationId;
  if (
    payload.type !== "AgentSessionEvent" ||
    !safeId(org) ||
    !safeId(current.id) ||
    session.id !== current.id ||
    session.organizationId !== org ||
    payload.appUserId !== appUserId ||
    session.appUserId !== appUserId ||
    current.appUserId !== appUserId
  )
    throw new Error("linear_wrong_session");
  if (current.dismissedAt) throw new Error("linear_session_dismissed");
  const channel = current.issue?.teamId ?? current.surface?.id ?? current.id;
  if (!safeId(channel)) throw new Error("linear_invalid_team");
  const scope = !current.issue && current.surface ? `${current.surface.kind}:${channel}` : channel;
  const channelId = `linear:${org}:${scope}`,
    threadKey = `linear:${org}:${current.id}`;
  let user: unknown,
    text: string | undefined,
    messageId = event.key,
    name: string | undefined;
  let triggeringActivityId: string | undefined;
  if (payload.action === "created") {
    user = session.creatorId;
    if (user !== current.creatorId) throw new Error("linear_wrong_creator");
    name = string(object(session.creator).name);
    text = string(payload.promptContext) ?? linearSessionContext(current) ?? string(object(session.comment).body);
  } else if (payload.action === "prompted") {
    const activity = object(payload.agentActivity),
      content = object(activity.content);
    if (!safeId(activity.id) || activity.agentSessionId !== current.id || content.type !== "prompt")
      throw new Error("linear_invalid_prompt");
    user = activity.userId;
    name = string(object(activity.user).name);
    if (!safeId(user) || user === appUserId) throw new Error("linear_human_required");
    if (activity.signal === "stop")
      return { kind: "stop", userId: `linear:${org}:${user}`, channelId, threadKey, receivedAt: event.receivedAt };
    messageId = activity.id;
    triggeringActivityId = activity.id;
    text = string(content.body);
  } else throw new Error("linear_unsupported_event");
  if (!safeId(user) || user === appUserId) throw new Error("linear_human_required");
  if (!text) throw new Error("linear_empty_prompt");
  return {
    kind: "message",
    triggeringActivityId,
    msg: {
      channelId,
      threadKey,
      userId: `linear:${org}:${user}`,
      text,
      messageId,
      receivedAt: event.receivedAt,
      ...(name ? { userName: name } : {}),
      ...(current.issue
        ? { channelName: current.issue.identifier }
        : current.surface
          ? { channelName: current.surface.title }
          : {}),
      ...((current.url ?? current.surface?.url) ? { sourceUrl: current.url ?? current.surface?.url } : {}),
    },
  };
}

/** A created session need not retain a user activity. Rebuild its issue and
 * initiating comment together, so later turns retain the mention's files. */
export function linearSessionContext(session: LinearSession): string | undefined {
  const parts = [
    session.issue
      ? `Linear issue ${session.issue.identifier}: ${session.issue.title}\n\n${session.issue.description ?? ""}`
      : undefined,
    session.surface
      ? `Linear ${session.surface.kind} ${session.surface.title}:\n\n${session.surface.content ?? ""}`
      : undefined,
    session.sourceComment?.body && session.sourceComment.body !== session.comment?.body
      ? `Source comment:\n${session.sourceComment.body}`
      : undefined,
    session.comment?.body ? `Comment that started this session:\n${session.comment.body}` : undefined,
  ].filter((part) => part !== undefined);
  return parts.length ? parts.join("\n\n") : undefined;
}
