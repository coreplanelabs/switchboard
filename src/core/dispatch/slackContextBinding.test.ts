import { SOURCE_RECEIPT_MAX, SOURCE_METADATA_MAX_BYTES, isSessionSources } from "../references/receipts.js";
import { testSlackCapability, testSlackReceipt, testSessionSources } from "../testing/slackSources.js";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../authz/types.js";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { bindSlackContext, toolsForSlackContextRun } from "./slackContextBinding.js";

const msg: IncomingMessage = {
  channelId: "slack:DMAIN",
  userId: "slack:UALICE",
  threadKey: "slack:DMAIN:1790000000.000001",
  text: "What happened?",
  directAudience: {
    kind: "slack-unshared-im",
    channelId: "slack:DMAIN",
    userId: "slack:UALICE",
    threadKey: "slack:DMAIN:1790000000.000001",
  },
};
const actor: Actor = {
  kind: "user",
  id: msg.userId,
  grants: { actions: new Set(), channels: new Set(), repos: new Set() },
};

describe("Slack context run binding", () => {
  it("registers Slack reads only for the requester's verified direct main conversation", async () => {
    const create = vi.fn(() => testSlackCapability(msg, async () => "source"));
    const audience = {
      channelId: msg.channelId,
      userId: msg.userId,
      threadKey: msg.threadKey,
    };
    const io = { directAudience: () => audience, verifyDirectAudience: async () => true } as unknown as ChannelIO;
    const bound = await bindSlackContext({ agentName: "orchestrator", actor, msg, io, visibility: "dm", create });
    expect(bound).toBeDefined();
    expect(create).toHaveBeenCalledWith(actor, msg);
    expect(toolsForSlackContextRun("orchestrator", bound).map((t) => t.name)).toContain("slack_context");
    expect(toolsForSlackContextRun("orchestrator", undefined).map((t) => t.name)).not.toContain("slack_context");
    for (const change of [
      { agentName: "coding" },
      { recovered: true },
      { visibility: "private" as const },
      { io: {} as ChannelIO },
      { msg: { ...msg, channelId: "slack:CCHANNEL", threadKey: "slack:CCHANNEL:1790000000.000001" } },
      { msg: { ...msg, relayedBy: "other app" } },
      { actor: { ...actor, id: "slack:UBOB" } },
      { io: { directAudience: () => ({ ...audience, userId: "slack:UBOB" }) } as ChannelIO },
    ]) {
      expect(
        await bindSlackContext({ agentName: "orchestrator", actor, msg, io, visibility: "dm", create, ...change }),
      ).toBeUndefined();
    }
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rechecks the same one-person destination before the model answer can publish", async () => {
    let current = { channelId: msg.channelId, userId: msg.userId, threadKey: msg.threadKey };
    const io = { directAudience: () => current, verifyDirectAudience: async () => true } as unknown as ChannelIO;
    const read = vi.fn(async () => "private source");
    const bound = await bindSlackContext({
      agentName: "orchestrator",
      actor,
      msg,
      io,
      visibility: "dm",
      create: () => testSlackCapability(msg, read),
    });
    expect(await bound?.destinationStillPrivate()).toBe(true);
    current = { ...current, channelId: "slack:CCHANNEL" };
    expect(await bound?.destinationStillPrivate()).toBe(false);
    await expect(bound?.capability.read({ kind: "thread" })).resolves.not.toContain("private source");
    expect(read).not.toHaveBeenCalled();
  });

  it("passes saved-source revalidation through the same private destination checks", async () => {
    let available = true;
    const io = {
      directAudience: () => msg.directAudience,
      verifyDirectAudience: async () => available,
    } as unknown as ChannelIO;
    const read = vi.fn(async () => "private source");
    const bound = await bindSlackContext({
      agentName: "orchestrator",
      actor,
      msg,
      io,
      visibility: "dm",
      create: () => testSlackCapability(msg, read),
    });
    expect(await bound?.revalidate(testSlackReceipt(msg))).toBe(true);
    available = false;
    expect(await bound?.revalidate(testSlackReceipt(msg))).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps a source revocation sealed even when Slack still reports the DM private", async () => {
    const io = {
      directAudience: () => msg.directAudience,
      verifyDirectAudience: async () => true,
    } as unknown as ChannelIO;
    const bound = await bindSlackContext({
      agentName: "orchestrator",
      actor,
      msg,
      io,
      visibility: "dm",
      create: () =>
        testSlackCapability(msg, async () => {
          bound?.revoke();
          return "private source";
        }),
    });
    await bound?.initialize(testSessionSources(msg, []), async () => true);
    expect(await bound?.capability.read({ kind: "thread" })).toContain("no longer available");
    expect(await bound?.destinationStillPrivate()).toBe(false);
    expect(await bound?.capability.read({ kind: "thread" })).toContain("no longer available");
  });

  it("keeps revocation sealed when it arrives during Slack audience verification", async () => {
    let verifierStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      verifierStarted = resolve;
    });
    let finishVerification!: (value: boolean) => void;
    const verifying = new Promise<boolean>((resolve) => {
      finishVerification = resolve;
    });
    let checks = 0;
    const io = {
      directAudience: () => msg.directAudience,
      verifyDirectAudience: () => (++checks === 1 ? Promise.resolve(true) : (verifierStarted(), verifying)),
    } as unknown as ChannelIO;
    const bound = await bindSlackContext({
      agentName: "orchestrator",
      actor,
      msg,
      io,
      visibility: "dm",
      create: () => testSlackCapability(msg, async () => "private source"),
    });
    const checking = bound!.destinationStillPrivate();
    await started;
    bound!.revoke();
    finishVerification(true);
    expect(await checking).toBe(false);
  });

  it("refuses an externally shared or unverifiable D conversation before tool registration", async () => {
    const io = {
      directAudience: () => ({ channelId: msg.channelId, userId: msg.userId, threadKey: msg.threadKey }),
      verifyDirectAudience: async () => true,
    } as unknown as ChannelIO;
    for (const verified of [false, undefined]) {
      const bound = await bindSlackContext({
        agentName: "orchestrator",
        actor,
        msg,
        io,
        visibility: "dm",
        create: () => ({
          ...testSlackCapability(msg, async () => "source"),
          verifyDirectOrigin: async () => verified === true,
        }),
      });
      expect(bound).toBeUndefined();
    }
  });
});

describe("trusted source receipt persistence", () => {
  const io = {
    directAudience: () => msg.directAudience,
    verifyDirectAudience: async () => true,
  } as unknown as ChannelIO;
  it("waits for the receipt write before delivering content and refuses a failed write", async () => {
    let finish!: (ok: boolean) => void;
    const pending = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    let writes = 0;
    const bound = (await bindSlackContext({
      agentName: "orchestrator",
      actor,
      msg,
      io,
      visibility: "dm",
      create: () => testSlackCapability(msg, async () => "source bytes"),
    }))!;
    expect(await bound.initialize(testSessionSources(msg, []), async () => (++writes === 1 ? true : pending))).toBe(
      true,
    );
    let delivered = false;
    const read = bound.capability.read({ kind: "thread" }).then((content) => {
      delivered = true;
      return content;
    });
    await vi.waitFor(() => expect(writes).toBe(2));
    expect(delivered).toBe(false);
    finish(false);
    expect(await read).not.toContain("source bytes");
    expect(await bound.destinationStillPrivate()).toBe(false);
  });

  it("fails closed at the cumulative receipt cap without evicting dependencies", async () => {
    const sources = testSessionSources(
      msg,
      Array.from({ length: SOURCE_RECEIPT_MAX }, (_, i) => ({
        ...testSlackReceipt(msg),
        source: { ...testSlackReceipt(msg).source, url: `source-${i}` },
      })),
    );
    const bound = (await bindSlackContext({
      agentName: "orchestrator",
      actor,
      msg,
      io,
      visibility: "dm",
      create: () => testSlackCapability(msg, async () => "source bytes"),
    }))!;
    const persist = vi.fn(async () => true);
    expect(await bound.initialize(sources, persist)).toBe(true);
    expect(await bound.capability.read({ kind: "thread" })).not.toContain("source bytes");
    expect(await bound.sourcesStillValid()).toBe(false);
    expect(persist).toHaveBeenLastCalledWith({ version: 1, status: "revoked" });
  });
});

describe("source metadata bounds", () => {
  it("rejects oversized metadata and cumulative message hashes without truncating them", () => {
    const receipt = testSlackReceipt(msg);
    expect(
      isSessionSources(
        testSessionSources(msg, [
          { ...receipt, source: { ...receipt.source, url: "x".repeat(SOURCE_METADATA_MAX_BYTES) } },
        ]),
      ),
    ).toBe(false);
    const receipts = Array.from({ length: 3 }, (_, n) => ({
      ...receipt,
      messages: Array.from({ length: 40 }, (_, i) => ({ id: `${n}.${i}`, hash: "a".repeat(64) })),
    }));
    expect(isSessionSources(testSessionSources(msg, receipts))).toBe(false);
  });
});
