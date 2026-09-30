import { describe, expect, it } from "vitest";
import { ALL_GRANTS } from "../authz/grants.js";
import type { Actor } from "../authz/types.js";
import type { IncomingMessage, SlackDirectAudience } from "../types.js";
import { MainSourceTracker } from "./mainSource.js";

const directAudience: SlackDirectAudience = {
  kind: "slack-unshared-im",
  channelId: "slack:D1",
  userId: "slack:U101",
  threadKey: "slack:D1:1",
};
const initial: IncomingMessage = {
  channelId: "slack:D1",
  threadKey: "slack:D1:1",
  userId: "slack:U101",
  directAudience,
  messageId: "1",
  text: "Why did signup fail?",
};
const actor = (msg: IncomingMessage): Actor => ({
  kind: "user",
  id: msg.userId,
  origin: { channelId: msg.channelId, threadKey: msg.threadKey },
  grants: ALL_GRANTS,
});

describe("private main work source — admitted conversation messages", () => {
  it("binds only the latest delivered person turn to the configured pilot repository", () => {
    const sources = new MainSourceTracker(initial, actor);
    sources.accept([{ userId: initial.userId, directAudience, text: "fix it", messageId: "2", at: 2 }]);
    expect(sources.getWorkRequest("fix it", "acme/api", "acme/api")).toMatchObject({
      authorizedRepo: "acme/api",
      msg: { messageId: "2", text: "fix it", directAudience },
    });
    expect(sources.getWorkRequest("Why did signup fail?", "acme/api", "acme/api")).toBeUndefined();
    expect(sources.getWorkRequest("fix it", "acme/web", "acme/api")).toBeUndefined();
    expect(sources.getWorkRequest("fix it", "acme/api")).toBeUndefined();
    expect(sources.getWorkRequest("model-invented request", "acme/api", "acme/api")).toBeUndefined();
  });

  it("lets a later delivered correction supersede an unstarted earlier act", () => {
    const sources = new MainSourceTracker({ ...initial, text: "Please fix signup" }, actor);
    sources.accept([
      { userId: initial.userId, directAudience, text: "Stop; explain it instead", messageId: "2", at: 2 },
    ]);
    expect(sources.getWorkRequest("Please fix signup", "acme/api", "acme/api")).toBeUndefined();
    expect(sources.get("Stop; explain it instead")?.msg.messageId).toBe("2");
  });

  it("keeps only the last verified turn when a batch contains several follow-ups", () => {
    const sources = new MainSourceTracker(initial, actor);
    sources.accept([
      { userId: initial.userId, directAudience, text: "fix signup", messageId: "2", at: 2 },
      { userId: initial.userId, directAudience, text: "fix billing", messageId: "3", at: 3 },
    ]);
    expect(sources.get("fix signup")).toBeUndefined();
    expect(sources.get("fix billing")?.msg.messageId).toBe("3");
  });

  it("permanently withdraws source authority after a foreign or unauthenticated follow-up", () => {
    for (const invalid of [
      { userId: "slack:UOTHER", directAudience, text: "fix it", messageId: "2", at: 2 },
      { userId: initial.userId, text: "fix it", messageId: "2", at: 2 },
      { userId: initial.userId, directAudience, postedBy: "slack:bot:B1", text: "fix it", messageId: "2", at: 2 },
      { userId: initial.userId, directAudience, text: "fix it", at: 2 },
    ]) {
      const sources = new MainSourceTracker(initial, actor);
      sources.accept([invalid]);
      sources.accept([{ userId: initial.userId, directAudience, text: "fix again", messageId: "3", at: 3 }]);
      expect(sources.get("fix again")).toBeUndefined();
      expect(sources.getWorkRequest(initial.text, "acme/api", "acme/api")).toBeUndefined();
    }
  });

  it("ignores a provider recovery control row without replacing the person turn", () => {
    const sources = new MainSourceTracker(initial, actor);
    sources.accept([
      {
        userId: "plane",
        text: "the model provider anthropic is answering again — re-issue the held turn and continue",
        at: 2,
      },
    ]);
    expect(sources.get(initial.text)?.msg.messageId).toBe("1");
  });
});
