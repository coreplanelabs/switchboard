import { booleanAudienceVerifier } from "../testing/audienceVerifier.js";
import { testSessionSources, testSlackReceipt } from "../testing/slackSources.js";
import { describe, expect, it, vi } from "vitest";
import type { ChannelIO, IncomingMessage } from "../types.js";
import {
  privateAudienceRefusal,
  privateAudienceRequired,
  privateAudienceStillValid,
  recoveredPrivateAudienceLatch,
  revalidateSavedSlackContext,
  revalidateSourcesDecision,
  privateFollowUpFailure,
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
  it("refuses a timed out source check and never starts another receipt", async () => {
    vi.useFakeTimers();
    try {
      let settle!: (value: boolean) => void;
      const check = vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            settle = resolve;
          }),
      );
      const pending = revalidateSourcesDecision([testSlackReceipt(msg), testSlackReceipt(msg)], check);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await pending).toEqual({ ok: false, code: "source-check-timeout" });
      settle(true);
      await Promise.resolve();
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not turn literal reference headers or model prose into source receipts", () => {
    const seed = {
      messages: [
        {
          role: "assistant" as const,
          content: [
            {
              type: "text" as const,
              text: "Referenced thread · #made-up · 1 message · https://team.example/archives/C_PUBLIC/p1790000000000001",
            },
          ],
        },
      ],
      log: { from: 0, turns: 1 },
      notes: [],
      sources: testSessionSources(msg, []),
    };
    expect(savedSlackContextNeedsRecheck(seed)).toBe(false);
    expect(
      savedSlackContextNeedsRecheck({ ...seed, summary: seed.messages[0].content[0].text, log: { from: 9, turns: 1 } }),
    ).toBe(false);
  });
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
    expect(savedSlackContextNeedsRecheck(clean)).toBe(true);
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
  it("revalidates only trusted receipts and leaves legacy or forged prose unknown", async () => {
    const receipt = testSlackReceipt(msg);
    const seed = {
      messages: [
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: JSON.stringify(testSessionSources(msg)) }],
        },
      ],
      log: { from: 0, turns: 1 },
      notes: [],
    };
    const revalidate = vi.fn(async () => true);
    expect(await revalidateSavedSlackContext(seed, revalidate)).toBe(false);
    expect(revalidate).not.toHaveBeenCalled();
    const trusted = { ...seed, sources: testSessionSources(msg) };
    expect(await revalidateSavedSlackContext(trusted, revalidate)).toBe(true);
    expect(revalidate).toHaveBeenCalledWith(receipt);
    revalidate.mockResolvedValue(false);
    expect(await revalidateSavedSlackContext(trusted, revalidate)).toBe(false);
  });
  it("keeps only a direct follow-up from the same requester eligible for private reads", () => {
    const direct = { userId: msg.userId, directAudience: msg.directAudience, msg };
    expect(samePrivateRequesterFollowUp(msg, direct)).toBe(true);
    expect(privateFollowUpFailure(msg, direct)).toBeUndefined();
    expect(privateFollowUpFailure(msg, { ...direct, from: { runId: "child" } })).toBe("followup-indirect");
    expect(privateFollowUpFailure(msg, { ...direct, userId: "slack:UBOB" })).toBe("followup-requester-mismatch");
    expect(privateFollowUpFailure(msg, { ...direct, directAudience: undefined })).toBe("followup-address-unproved");
    expect(
      privateFollowUpFailure(msg, {
        ...direct,
        directAudience: { ...msg.directAudience!, threadKey: "slack:DMAIN:other" },
      }),
    ).toBe("followup-address-mismatch");
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
    const io = {
      directAudience: () => msg.directAudience,
      verifyDirectAudience: booleanAudienceVerifier(verifyDirectAudience),
    } as unknown as ChannelIO;
    expect(privateAudienceRequired(msg)).toBe(true);
    expect(await privateAudienceStillValid(msg, io)).toBe(true);
    expect(verifyDirectAudience).toHaveBeenCalledWith(msg.directAudience);
    expect(await privateAudienceStillValid({ ...msg, userId: "slack:UBOB" }, io)).toBe(false);
    expect(
      await privateAudienceStillValid(msg, { ...io, verifyDirectAudience: booleanAudienceVerifier(async () => false) }),
    ).toBe(false);
    expect(await privateAudienceStillValid(msg, {} as ChannelIO)).toBe(false);
    expect(privateAudienceRequired({ ...msg, directAudience: undefined })).toBe(false);
  });
});
