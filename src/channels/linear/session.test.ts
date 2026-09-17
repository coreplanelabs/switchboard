import { describe, expect, it } from "vitest";
import { linearMessage, linearThread } from "./session.js";
import type { LinearSession } from "./api.js";
import type { LinearWebhookEvent } from "./webhook.js";

const session: LinearSession = {
  id: "session",
  appUserId: "bot",
  creatorId: "alice",
  url: "https://linear.app/acme/issue/ENG-1",
  issue: { id: "issue", identifier: "ENG-1", title: "Fix login", description: "Login fails", teamId: "team" },
};
const event: LinearWebhookEvent = {
  key: "org:session:created",
  receivedAt: 100,
  payload: {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org",
    appUserId: "bot",
    agentSession: { id: "session", appUserId: "bot", organizationId: "org", creatorId: "alice" },
    promptContext: "<issue>Fix login</issue>",
  },
};

describe("Linear session input", () => {
  it("preserves the signed responsible person, team scope and session identity", () => {
    expect(linearMessage(event, session, "bot")).toMatchObject({
      kind: "message",
      msg: {
        userId: "linear:org:alice",
        channelId: "linear:org:team",
        threadKey: "linear:org:session",
        messageId: event.key,
        text: event.payload.promptContext,
        receivedAt: 100,
      },
    });
    expect(linearThread("linear:org:session")).toEqual({ organizationId: "org", sessionId: "session" });
    expect(linearThread("slack:org:session")).toBeUndefined();
  });
  it("uses a follow-up's own author and id without replacing the initial context", () => {
    const follow: LinearWebhookEvent = {
      ...event,
      key: "prompt-key",
      payload: {
        ...event.payload,
        action: "prompted",
        agentActivity: {
          id: "activity",
          agentSessionId: "session",
          userId: "bob",
          content: { type: "prompt", body: "Use OAuth" },
        },
      },
    };
    expect(linearMessage(follow, session, "bot")).toMatchObject({
      kind: "message",
      msg: {
        userId: "linear:org:bob",
        threadKey: "linear:org:session",
        messageId: "activity",
        text: "Use OAuth",
      },
    });
    expect(
      linearMessage(
        {
          ...follow,
          payload: {
            ...follow.payload,
            agentActivity: {
              ...(follow.payload.agentActivity as object),
              signal: "stop",
            },
          },
        },
        session,
        "bot",
      ),
    ).toMatchObject({ kind: "stop", userId: "linear:org:bob", threadKey: "linear:org:session" });
  });
  it("refuses forged ownership, missing human identity, mismatched prompts and dismissed sessions", () => {
    for (const changed of [
      { ...session, appUserId: "another-bot" },
      { ...session, creatorId: undefined },
      { ...session, id: "another-session" },
      { ...session, dismissedAt: "dismissed" },
    ])
      expect(() => linearMessage(event, changed, "bot")).toThrow();
    expect(() =>
      linearMessage({ ...event, payload: { ...event.payload, appUserId: "other" } }, session, "bot"),
    ).toThrow();
    expect(() =>
      linearMessage(
        {
          ...event,
          payload: {
            ...event.payload,
            action: "prompted",
            agentActivity: {
              id: "p",
              userId: "bob",
              agentSessionId: "other",
              content: { type: "prompt", body: "hi" },
            },
          },
        },
        session,
        "bot",
      ),
    ).toThrow();
  });
});
