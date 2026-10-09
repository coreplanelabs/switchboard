import { describe, expect, it, vi } from "vitest";
import { runSlackCommandSmoke } from "./slackSmoke.js";
const commit = "a".repeat(40),
  sha = "b".repeat(64),
  started = new Date(10).toISOString(),
  built = new Date(1).toISOString();
const config = {
  disposable: true,
  workspaceId: "TTEAM001",
  userId: "UTEST001",
  botUserId: "UBOT0001",
  channelId: "CCI00001",
};
const health = {
  ok: true,
  build: { commit, builtAt: built },
  startedAt: started,
  draining: false,
  slack: { connected: true },
  loadedBase: { source: { kind: "state", key: `base-${commit}`, version: 1 }, sha256: sha },
};
const text = `Switchboard 1.2.3 · build ${commit.slice(0, 8)} (built ${built})\nstarted ${started} · 0 runs in flight · not draining\nLoaded base: state base-${commit} v1 · sha256 ${sha}`;
function fixture(
  change: {
    wrongUser?: boolean;
    wrongReply?: boolean;
    postLost?: boolean;
    noReply?: boolean;
    privateChannel?: boolean;
    wrongAck?: boolean;
    channel?: string;
    rejectedAck?: boolean;
    botIdentity?: boolean;
    pendingShared?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: any, init: any) => {
    const method = String(url).split("/").at(-1)!;
    calls.push(method);
    if (method === "healthz") return Response.json(health);
    if (method === "auth.test")
      return Response.json({
        ok: true,
        team_id: config.workspaceId,
        user_id: change.wrongUser ? "UOTHER01" : config.userId,
        ...(change.botIdentity ? { bot_id: "BOTHER01" } : {}),
      });
    if (method === "conversations.info")
      return Response.json({
        ok: true,
        channel: {
          id: change.channel ?? "CCI00001",
          context_team_id: "TTEAM001",
          is_member: true,
          is_private: change.privateChannel ?? false,
          is_shared: false,
          is_pending_ext_shared: change.pendingShared ?? false,
        },
      });
    if (method === "chat.postMessage") {
      expect(Object.fromEntries(new URLSearchParams(init.body))).toMatchObject({
        channel: change.channel ?? "CCI00001",
        text: "<@UBOT0001> status show",
      });
      if (change.postLost) throw Error("lost response");
      return Response.json({
        ok: change.rejectedAck ? false : true,
        channel: change.wrongAck ? "DWRONG01" : (change.channel ?? "CCI00001"),
        ts: "1.000001",
        message: { user: config.userId },
      });
    }
    if (method === "conversations.replies")
      return Response.json({
        ok: true,
        messages: change.noReply
          ? []
          : [
              {
                user: config.botUserId,
                ts: "1.000002",
                thread_ts: "1.000001",
                text: change.wrongReply ? text.replace(commit.slice(0, 8), "deadbeef") : text,
              },
            ],
      });
    throw Error("unexpected endpoint");
  });
  return { calls, fetch };
}
const input = (fetch: any) => ({
  origin: "https://bot.example.test",
  healthUrl: "https://bot.example.test/healthz",
  expectedCommit: commit,
  userToken: "synthetic-user-token",
  config,
  fetch,
});
describe("Slack command acceptance", () => {
  it("posts one mention in the configured public channel and retains its matching deployed status reply", async () => {
    const f = fixture();
    const saved: any[] = [];
    const result = await runSlackCommandSmoke({
      ...input(f.fetch),
      onReceipt: async (value: any) => {
        saved.push(structuredClone(value));
      },
    });
    expect(result).toMatchObject({
      scope: "slack-command-smoke",
      outcome: "passed",
      message: { channel: "CCI00001", ts: "1.000001" },
      reply: { ts: "1.000002" },
      build: { commit },
    });
    expect(f.calls.filter((x) => x === "chat.postMessage")).toEqual(["chat.postMessage"]);
    expect(saved.some((r) => r.message?.ts === "1.000001" && r.outcome === "incomplete")).toBe(true);
  });
  it("uses the public channel selected by the operator", async () => {
    const f = fixture({ channel: "CALTERNATE01" });
    expect(
      await runSlackCommandSmoke({ ...input(f.fetch), config: { ...config, channelId: "CALTERNATE01" } }),
    ).toMatchObject({
      outcome: "passed",
      message: { channel: "CALTERNATE01", ts: "1.000001" },
      reply: { ts: "1.000002" },
    });
  });
  it("refuses another user before posting and never resubmits an unknown post", async () => {
    const wrong = fixture({ wrongUser: true });
    expect(await runSlackCommandSmoke(input(wrong.fetch))).toMatchObject({
      outcome: "incomplete",
      reason: "identity_unproven",
    });
    expect(wrong.calls).toEqual(["healthz", "auth.test"]);
    const lost = fixture({ postLost: true });
    expect(await runSlackCommandSmoke(input(lost.fetch))).toMatchObject({
      outcome: "incomplete",
      reason: "message_ack_unknown",
    });
    expect(lost.calls.filter((x) => x === "chat.postMessage")).toEqual(["chat.postMessage"]);
  });
  it("keeps the original message when the bot replies from another build", async () => {
    const f = fixture({ wrongReply: true });
    expect(await runSlackCommandSmoke(input(f.fetch))).toMatchObject({
      outcome: "incomplete",
      reason: "reply_unproven",
      message: { channel: "CCI00001", ts: "1.000001" },
    });
    expect(f.calls.filter((x) => x === "chat.postMessage")).toEqual(["chat.postMessage"]);
  });
  it("refuses private-channel access and retains an acknowledgment bound to another channel", async () => {
    const privateChannel = fixture({ privateChannel: true });
    expect(await runSlackCommandSmoke(input(privateChannel.fetch))).toMatchObject({
      outcome: "incomplete",
      reason: "conversation_unproven",
    });
    const wrongAck = fixture({ wrongAck: true });
    expect(await runSlackCommandSmoke(input(wrongAck.fetch))).toMatchObject({
      outcome: "incomplete",
      reason: "message_binding_unproven",
      message: { channel: "DWRONG01", ts: "1.000001" },
    });
    expect(wrongAck.calls.filter((x) => x === "chat.postMessage")).toEqual(["chat.postMessage"]);
  });
  it("refuses bot credentials before posting", async () => {
    const bot = fixture({ botIdentity: true });
    expect(await runSlackCommandSmoke(input(bot.fetch))).toMatchObject({
      outcome: "incomplete",
      reason: "identity_unproven",
    });
    expect(bot.calls).toEqual(["healthz", "auth.test"]);
  });
  it("refuses a channel awaiting external sharing before posting", async () => {
    const shared = fixture({ pendingShared: true });
    expect(await runSlackCommandSmoke(input(shared.fetch))).toMatchObject({
      outcome: "incomplete",
      reason: "conversation_unproven",
    });
    expect(shared.calls).toEqual(["healthz", "auth.test", "conversations.info"]);
  });
  it("retains native message identity when acknowledgment metadata is rejected", async () => {
    const f = fixture({ rejectedAck: true });
    expect(await runSlackCommandSmoke(input(f.fetch))).toMatchObject({
      outcome: "incomplete",
      reason: "message_ack_unknown",
      message: { channel: "CCI00001", ts: "1.000001" },
    });
    expect(f.calls.filter((x) => x === "chat.postMessage")).toEqual(["chat.postMessage"]);
  });
  it("stops observation at its deadline without another message", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ noReply: true });
      const pending = runSlackCommandSmoke(input(f.fetch));
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        outcome: "incomplete",
        reason: "reply_unproven",
        message: { channel: "CCI00001", ts: "1.000001" },
      });
      expect(f.calls.filter((x) => x === "chat.postMessage")).toEqual(["chat.postMessage"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
