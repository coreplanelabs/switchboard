import { describe, expect, it } from "vitest";
import { ALL_GRANTS } from "../authz/grants.js";
import type { Actor } from "../authz/types.js";
import type { IncomingMessage, SlackDirectAudience } from "../types.js";
import { followUpFromInbox } from "./admission.js";
import { durableInboxMessage } from "../runLedger/inboxMessage.js";
import { MainSourceTracker } from "./mainSource.js";
import { withOrganizationPrivateAudience, requesterMessageId } from "./privateDestination.js";
import { withChatActor, resolveChatActor } from "../authz/actor.js";

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

describe("main action source", () => {
  it("preserves the delivered MCP approval binding through durable follow-up selection", () => {
    const source = {
      channelId: "mcp:default",
      threadKey: "mcp:default:one",
      userId: "slack:U101",
      authenticatedAs: "mcp:credential-one",
      messageId: "1",
      text: "show config",
    };
    const approvalConnection = {
      id: "connection-one",
      credentialId: "mcp:credential-one",
      requestHash: "b".repeat(64),
      mode: "form" as const,
    };
    const followUp = { ...source, messageId: "2", text: "reset this channel", approvalConnection };
    const input = followUpFromInbox(
      { seq: 7, message: durableInboxMessage(followUp, followUp.text, 2) },
      {
        reply: async () => {},
        status: async () => ({ update: () => {}, done: async () => {} }),
        history: async () => [],
      },
      0,
    )!;
    const sources = new MainSourceTracker(source, actor);
    sources.accept([input]);
    expect(sources.get("reset this channel")?.msg).toEqual({ ...followUp, receivedAt: 2 });
  });

  it("does not restore command authority from merged context or a later ordinary follow-up", () => {
    const merged = { ...initial, directAudience: undefined, mergedFollowUps: true as const };
    const sources = new MainSourceTracker(merged, actor);
    sources.accept([{ userId: initial.userId, text: "set my effort high", messageId: "2", at: 2 }]);
    expect(sources.select("set my effort high")).toEqual({ kind: "refused", reason: "source_compromised" });
    const fresh = new MainSourceTracker({ ...merged, mergedFollowUps: undefined }, actor);
    expect(fresh.select(initial.text)).toMatchObject({ kind: "selected", source: { msg: { messageId: "1" } } });
    fresh.accept([
      { userId: initial.userId, text: "set my effort high", messageId: "2", at: 2, mergedFollowUps: true },
    ]);
    expect(fresh.select("set my effort high")).toEqual({ kind: "refused", reason: "source_compromised" });
  });

  it("binds a public requester follow-up without inventing a private audience", () => {
    const publicMessage: IncomingMessage = {
      channelId: "mcp:default",
      threadKey: "mcp:default:one",
      userId: "slack:U101",
      authenticatedAs: "mcp:credential-one",
      messageId: "1",
      text: "show my configuration",
    };
    const sources = new MainSourceTracker(publicMessage, actor);
    const next = {
      userId: publicMessage.userId,
      authenticatedAs: publicMessage.authenticatedAs,
      messageId: "2",
      text: "set my effort high",
      at: 2,
    };
    sources.observe(next);
    expect(sources.get("show my configuration")?.msg.messageId).toBe("1");
    sources.accept([next]);
    expect(sources.get("set my effort high")?.msg).toEqual({
      channelId: "mcp:default",
      threadKey: "mcp:default:one",
      userId: "slack:U101",
      authenticatedAs: "mcp:credential-one",
      messageId: "2",
      receivedAt: 2,
      text: "set my effort high",
    });
    sources.accept([{ ...next, messageId: undefined, ledgerSeq: 7 }]);
    expect(sources.get("set my effort high")?.msg.messageId).toBe("inbox-7");
    sources.observe({ ...next, authenticatedAs: "mcp:credential-two", messageId: "3" });
    expect(sources.select("set my effort high")).toEqual({ kind: "refused", reason: "source_compromised" });
    sources.accept([{ ...next, messageId: "4" }]);
    expect(sources.select("set my effort high")).toEqual({ kind: "refused", reason: "source_compromised" });
  });

  it("keeps a browser followup's fresh actor and source ordinal and rejects a JSON source guess", () => {
    const plain = {
      channelId: "http:home",
      threadKey: "http:home:alice",
      userId: "access:alice",
      messageId: "browser:first",
      text: "Explain it",
    };
    const audience = {
      kind: "organization-private" as const,
      organization: "acme",
      stream: "person:alice",
      actorId: plain.userId,
      userId: plain.userId,
      channelId: plain.channelId,
      threadKey: plain.threadKey,
    };
    const first = withOrganizationPrivateAudience(plain, audience, 1);
    const actual: Actor = {
      ...actor(plain),
      memberOf: new Set(["slack:PROVED"]),
      memberOfOrganizations: new Set(["acme"]),
    };
    const sources = new MainSourceTracker(withChatActor(first, actual), (message) =>
      resolveChatActor(message, () => ALL_GRANTS),
    );
    const followup = withChatActor(
      withOrganizationPrivateAudience(
        { userId: plain.userId, messageId: "browser:second", text: "fix it", at: 2 },
        audience,
        9,
      ),
      actual,
    );
    expect(sources.observe(followup)).toBe(true);
    expect(sources.get("Explain it")?.msg.messageId).toBe("browser:first");
    sources.accept([followup]);
    const selected = sources.select("fix it");
    expect(selected).toMatchObject({
      kind: "selected",
      source: {
        actor: { id: "access:alice", memberOf: new Set(["slack:PROVED"]), memberOfOrganizations: new Set(["acme"]) },
        msg: { messageId: "browser:second" },
      },
    });
    if (selected.kind !== "selected") throw new Error("No source");
    expect(requesterMessageId(selected.source.msg)).toBe("browser:9:browser%3Asecond");
    const publicSource = new MainSourceTracker(plain, actor);
    publicSource.accept([followup]);
    expect(publicSource.select("fix it")).toEqual({ kind: "refused", reason: "source_compromised" });
    const missingNativeId = new MainSourceTracker(first, actor);
    missingNativeId.accept([{ ...followup, messageId: undefined, ledgerSeq: 9 }]);
    expect(missingNativeId.select("fix it")).toEqual({ kind: "refused", reason: "source_compromised" });
    sources.accept([JSON.parse(JSON.stringify(followup))]);
    expect(sources.select("fix it")).toEqual({ kind: "refused", reason: "source_compromised" });
  });
  it("reports a compromised source separately from a quote that is not in the latest turn", () => {
    const sources = new MainSourceTracker(initial, actor);
    expect(sources.select("fix it")).toEqual({
      kind: "refused",
      reason: "source_quote_mismatch",
      retryQuote: "Why did signup fail?",
    });
    expect(sources.select(" ")).toEqual({ kind: "refused", reason: "source_quote_missing" });
    sources.accept([{ userId: "slack:UOTHER", directAudience, text: "fix it", messageId: "2", at: 2 }]);
    expect(sources.select("fix it")).toEqual({ kind: "refused", reason: "source_compromised" });
  });

  it("keeps missing pilot configuration distinct from a mismatched target", () => {
    const sources = new MainSourceTracker(initial, actor);
    const selected = sources.select(initial.text);
    expect(selected.kind).toBe("selected");
    if (selected.kind !== "selected") return;
    expect(sources.bindRepository(selected.source, "acme/api")).toEqual({
      kind: "refused",
      reason: "repository_unconfigured",
    });
    expect(sources.bindRepository(selected.source, "vendor/lib", "acme/api")).toEqual({
      kind: "refused",
      reason: "repository_mismatch",
    });
    expect(sources.bindRepository(selected.source, "ACME/API", "acme/api")).toMatchObject({
      kind: "ready",
      authorizedRepo: "acme/api",
      msg: { messageId: "1" },
    });
  });

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
