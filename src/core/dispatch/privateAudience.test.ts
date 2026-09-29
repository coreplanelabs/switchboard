import { describe, expect, it, vi } from "vitest";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { wrapUntrusted } from "../untrusted.js";
import {
  privateAudienceRefusal,
  privateAudienceRequired,
  privateAudienceStillValid,
  recoveredPrivateAudienceLatch,
  revalidateSavedSlackContext,
  samePrivateRequesterFollowUp,
  savedSlackContextNeedsRecheck,
} from "./privateAudience.js";

const msg: IncomingMessage = {
  channelId: "slack:DMAIN",
  userId: "slack:UALICE",
  threadKey: "slack:DMAIN:1.0",
  text: "look here",
  directAudience: {
    kind: "slack-unshared-im",
    channelId: "slack:DMAIN",
    userId: "slack:UALICE",
    threadKey: "slack:DMAIN:1.0",
  },
};

describe("private audience publication gate", () => {
  it("fails closed on a recovered private run even when no indirect follow-up remains pending", () => {
    expect(recoveredPrivateAudienceLatch(msg, true).revoked).toBe(true);
    expect(privateAudienceRefusal(recoveredPrivateAudienceLatch(msg, true))).toContain("run restarted");
    expect(recoveredPrivateAudienceLatch(msg, false).revoked).toBe(false);
    expect(recoveredPrivateAudienceLatch({ ...msg, directAudience: undefined }, true).revoked).toBe(false);
    expect(privateAudienceRefusal({ revoked: true })).toContain("verify this private conversation");
  });
  it("denies saved Slack reads and unproven session cuts without blocking a fresh seed", () => {
    const clean = {
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "new question" }] }],
      log: { from: 0, turns: 1 },
      notes: [],
    };
    expect(savedSlackContextNeedsRecheck(undefined)).toBe(false);
    expect(savedSlackContextNeedsRecheck(undefined, [{ role: "assistant", text: "old source answer" }])).toBe(true);
    expect(savedSlackContextNeedsRecheck(clean)).toBe(false);
    expect(savedSlackContextNeedsRecheck({ ...clean, log: { from: 2, turns: 1 } })).toBe(true);
    expect(savedSlackContextNeedsRecheck({ ...clean, summary: "earlier context" })).toBe(true);
    expect(
      savedSlackContextNeedsRecheck({
        ...clean,
        messages: [{ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "slack_context", input: {} }] }],
      }),
    ).toBe(true);
    expect(
      savedSlackContextNeedsRecheck({
        ...clean,
        messages: [{ role: "user", content: [{ type: "tool_result", toolUseId: "c1", content: "unknown source" }] }],
      }),
    ).toBe(true);
  });
  it("rechecks saved origin messages while allowing only later appended messages", async () => {
    const saved = `Current Slack thread · ${msg.threadKey} · 1 message\n${wrapUntrusted("1.0 · UALICE: signup failures: 17")}`;
    const appended = `Current Slack thread · ${msg.threadKey} · 2 messages\n${wrapUntrusted("1.0 · UALICE: signup failures: 17\n2.0 · UALICE: fix it")}`;
    const seed = {
      messages: [
        {
          role: "assistant" as const,
          content: [{ type: "tool_use" as const, id: "c1", name: "slack_context", input: { kind: "thread" } }],
        },
        { role: "user" as const, content: [{ type: "tool_result" as const, toolUseId: "c1", content: saved }] },
      ],
      log: { from: 0, turns: 2 },
      notes: [],
    };
    const read = vi.fn(async () => appended);
    expect(await revalidateSavedSlackContext(seed, { read })).toBe(true);
    expect(read).toHaveBeenCalledWith({ kind: "thread" }, "revalidate");
    read.mockResolvedValue(
      `Current Slack thread · ${msg.threadKey} · 2 messages\n${wrapUntrusted("1.0 · UALICE: signup failures: 18\n2.0 · UALICE: fix it")}`,
    );
    expect(await revalidateSavedSlackContext(seed, { read })).toBe(false);
    read.mockResolvedValue(
      `Current Slack thread · slack:DOTHER:1.0 · 2 messages\n${wrapUntrusted("1.0 · UALICE: signup failures: 17\n2.0 · UALICE: fix it")}`,
    );
    expect(await revalidateSavedSlackContext(seed, { read })).toBe(false);
  });
  it("rejects a changed linked source even when it remains readable", async () => {
    const seed = {
      messages: [
        {
          role: "assistant" as const,
          content: [
            {
              type: "tool_use" as const,
              id: "c1",
              name: "slack_context",
              input: { kind: "link", url: "https://workspace.slack.com/archives/CPUBLIC/p1790000000000001" },
            },
          ],
        },
        {
          role: "user" as const,
          content: [{ type: "tool_result" as const, toolUseId: "c1", content: "private count: 17" }],
        },
      ],
      log: { from: 0, turns: 2 },
      notes: [],
    };
    const read = vi.fn(async () => "private count: 18");
    expect(await revalidateSavedSlackContext(seed, { read })).toBe(false);
    expect(read).toHaveBeenCalledWith(
      { kind: "link", url: "https://workspace.slack.com/archives/CPUBLIC/p1790000000000001" },
      "revalidate",
    );
    read.mockResolvedValue("private count: 17");
    expect(await revalidateSavedSlackContext(seed, { read })).toBe(true);
  });
  it("keeps only a direct follow-up from the same requester eligible for private reads", () => {
    const direct = { userId: msg.userId, directAudience: msg.directAudience, msg };
    expect(samePrivateRequesterFollowUp(msg, direct)).toBe(true);
    expect(samePrivateRequesterFollowUp(msg, { ...direct, msg: { ...msg, relayedBy: "slack:bot:BOTHER" } })).toBe(
      false,
    );
    expect(samePrivateRequesterFollowUp(msg, { ...direct, msg: { ...msg, postedBy: "slack:bot:BOTHER" } })).toBe(false);
    expect(samePrivateRequesterFollowUp(msg, { ...direct, msg: { ...msg, authenticatedAs: "http:relay" } })).toBe(
      false,
    );
    expect(samePrivateRequesterFollowUp(msg, { ...direct, userId: "slack:UBOB" })).toBe(false);
    expect(samePrivateRequesterFollowUp(msg, { ...direct, directAudience: undefined })).toBe(false);
    expect(samePrivateRequesterFollowUp(msg, { ...direct, from: { runId: "child" } })).toBe(false);
  });

  it("requires a matching claim and fresh adapter proof", async () => {
    const verifyDirectAudience = vi.fn(async () => true);
    const io = { directAudience: () => msg.directAudience, verifyDirectAudience } as unknown as ChannelIO;
    expect(privateAudienceRequired(msg)).toBe(true);
    expect(await privateAudienceStillValid(msg, io)).toBe(true);
    expect(verifyDirectAudience).toHaveBeenCalledWith(msg.directAudience);
    expect(await privateAudienceStillValid({ ...msg, userId: "slack:UBOB" }, io)).toBe(false);
    expect(await privateAudienceStillValid(msg, { ...io, verifyDirectAudience: async () => false })).toBe(false);
    expect(await privateAudienceStillValid(msg, {} as ChannelIO)).toBe(false);
    expect(privateAudienceRequired({ ...msg, directAudience: undefined })).toBe(false);
  });
});
