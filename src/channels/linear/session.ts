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
  const channel = current.issue?.teamId ?? current.id;
  if (!safeId(channel)) throw new Error("linear_invalid_team");
  const channelId = `linear:${org}:${channel}`,
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
    text =
      string(payload.promptContext) ??
      (current.issue
        ? `${current.issue.identifier}: ${current.issue.title}\n\n${current.issue.description ?? ""}`
        : string(object(session.comment).body));
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
      ...(current.issue ? { channelName: current.issue.identifier } : {}),
      ...(current.url ? { sourceUrl: current.url } : {}),
    },
  };
}
