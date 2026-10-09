import { describe, expect, it, vi } from "vitest";
import { Secret } from "../../secrets.js";
import { SlackChannelDirectory, type SlackDirectoryClient } from "../slackChannelDirectory.js";
import type { SlackContextClient } from "./context.js";
import { createSlackReadAccess } from "./readAccess.js";

function fixture() {
  const scopes = ["channels:read", "channels:history", "users:read", "groups:read", "groups:history", "files:read"];
  let privateMember = true;
  const sourceAuth = {
    url: "https://team.example/",
    team_id: "TLOCAL",
    user_id: "UREAD",
    response_metadata: { scopes },
  };
  const sourceCalls = vi.fn(async () => ({
    messages: [{ ts: "1790000000.000001", user: "UALICE", text: "source evidence" }],
  }));
  const make = (source: boolean): SlackContextClient & SlackDirectoryClient => ({
    auth: { test: async () => (source ? sourceAuth : { ...sourceAuth, user_id: "UBOT", bot_id: "BBOT" }) },
    users: {
      info: async () => ({ user: { team_id: "TLOCAL", is_restricted: false, is_ultra_restricted: false } }),
      conversations: async () => ({ channels: privateMember ? [{ id: "C_PRIVATE", is_private: true }] : [] }),
    },
    conversations: {
      info: async ({ channel }) => ({
        channel: channel.startsWith("D")
          ? { is_im: true, is_private: true, is_member: true, user: "UALICE", is_org_shared: false }
          : {
              is_private: channel === "C_PRIVATE",
              is_member: !source || channel === "C_PRIVATE",
              is_shared: channel === "C_PUBLIC",
            },
      }),
      replies: source ? sourceCalls : async () => ({ messages: [{ ts: "1790000000.000001", text: "working thread" }] }),
      history: async () => ({ messages: [] }),
    },
  });
  const listener = make(false);
  const source = make(true);
  const actor = {
    kind: "user" as const,
    id: "slack:UALICE",
    grants: { actions: new Set<string>(), channels: new Set<string>(), repos: new Set<string>() },
  };
  const msg = {
    userId: actor.id,
    channelId: "slack:D_WORK",
    threadKey: "slack:D_WORK:1790000000.000001",
    text: "read the source",
  };
  return {
    listener,
    source,
    sourceAuth,
    sourceCalls,
    actor,
    msg,
    revoke: () => {
      privateMember = false;
    },
  };
}

describe("workspace Slack read access", () => {
  it("constructs the unconfigured reader while Slack identity lookup is pending", async () => {
    const f = fixture();
    let finishIdentity!: () => void;
    f.listener.auth.test = () =>
      new Promise((resolve) => {
        finishIdentity = () => resolve({ url: "https://team.example/" });
      });
    const reads = await createSlackReadAccess({
      listener: f.listener,
      directory: new SlackChannelDirectory(f.listener),
    });
    finishIdentity();
    await reads.reader.ready();
    expect(reads.reader.parseConversationUrl("https://team.example/archives/C_PUBLIC/p1790000000000001")).toMatchObject(
      { channelId: "slack:C_PUBLIC", threadKey: "slack:C_PUBLIC:1790000000.000001" },
    );
  }, 500);

  it("reads an unjoined public source and retains bot delivery with no per-user connection", async () => {
    const f = fixture();
    const reads = await createSlackReadAccess({
      listener: f.listener,
      directory: new SlackChannelDirectory(f.listener),
      token: new Secret("read-token", "SLACK_READ_TOKEN"),
      sourceClient: f.source,
    });
    const cap = reads.context(f.actor, f.msg);
    const read = await cap.readSource({
      kind: "link",
      url: "https://team.example/archives/C_PUBLIC/p1790000000000001",
    });
    expect(read.content).toContain("source evidence");
    expect(read).toMatchObject({ kind: "read", receipt: { visibility: "public", shared: true } });
    const own = await cap.readSource({ kind: "thread" });
    expect(own.content).toContain("working thread");
    expect(f.sourceCalls.mock.calls).toHaveLength(1);
  });

  it("requires the requester's own private membership even when the read account has access", async () => {
    const f = fixture();
    const reads = await createSlackReadAccess({
      listener: f.listener,
      directory: new SlackChannelDirectory(f.listener),
      token: new Secret("read-token", "SLACK_READ_TOKEN"),
      sourceClient: f.source,
    });
    const cap = reads.context(f.actor, f.msg);
    const result = await cap.readSource({
      kind: "link",
      url: "https://team.example/archives/C_PRIVATE/p1790000000000001",
    });
    expect(result.content).toContain("source evidence");
    if (result.kind !== "read") throw new Error("expected read");
    f.revoke();
    expect(await cap.revalidateSource(result.receipt)).toBe(false);
    expect(
      await cap.readSource({ kind: "link", url: "https://team.example/archives/C_PRIVATE/p1790000000000001" }),
    ).toMatchObject({ kind: "refused", reason: "unavailable" });
  });

  it("retains the provider failure behind the named read-account startup error", async () => {
    const f = fixture();
    f.source.auth.test = async () => {
      throw new Error("invalid_auth");
    };
    await expect(
      createSlackReadAccess({
        listener: f.listener,
        directory: new SlackChannelDirectory(f.listener),
        token: new Secret("read-token", "SLACK_READ_TOKEN"),
        sourceClient: f.source,
      }),
    ).rejects.toMatchObject({
      message: "Slack readerTokenEnv requires a read-only user token for a full member of this workspace.",
      cause: { message: "invalid_auth" },
    });
  });

  it("rejects a writable, foreign-workspace or bot credential before using source content", async () => {
    for (const bad of ["write", "foreign", "bot"] as const) {
      const f = fixture();
      if (bad === "write") f.sourceAuth.response_metadata.scopes.push("chat:write");
      if (bad === "foreign") f.sourceAuth.team_id = "TOTHER";
      if (bad === "bot") Object.assign(f.sourceAuth, { bot_id: "BBOT" });
      await expect(
        createSlackReadAccess({
          listener: f.listener,
          directory: new SlackChannelDirectory(f.listener),
          token: new Secret("read-token", "SLACK_READ_TOKEN"),
          sourceClient: f.source,
        }),
      ).rejects.toThrow("requires a read-only user token");
      expect(f.sourceCalls.mock.calls).toHaveLength(0);
    }
    const f = fixture();
    const valid = await createSlackReadAccess({
      listener: f.listener,
      directory: new SlackChannelDirectory(f.listener),
      token: new Secret("read-token", "SLACK_READ_TOKEN"),
      sourceClient: f.source,
    });
    expect((await valid.context(f.actor, f.msg).readSource({ kind: "thread" })).content).toContain("working thread");
  });
});
