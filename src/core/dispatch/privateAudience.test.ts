import { booleanAudienceVerifier } from "../testing/audienceVerifier.js";
import { verifySlackDirectAudience } from "../../channels/slack/directAudience.js";
import { testSessionSources, testSlackCapability, testSlackReceipt } from "../testing/slackSources.js";
import { describe, expect, it, vi } from "vitest";
import type { ChannelIO, IncomingMessage } from "../types.js";
import {
  privateAudienceRefusal,
  privateAudienceRequired,
  privateAudienceStillValid,
  privateRunAudienceDecision,
  recoveredPrivateAudienceLatch,
  revalidateSavedSlackContext,
  revalidateSourcesDecision,
  privateFollowUpFailure,
  samePrivateRequesterFollowUp,
  savedSlackContextNeedsRecheck,
} from "./privateAudience.js";
import { bindSlackContext } from "./slackContextBinding.js";
import { sourceCheckError } from "./sourceCheckError.js";
import { TransientStoreError } from "../storeFailure.js";

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
  it("continues after a transient source read when fresh proof succeeds", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const io: ChannelIO = {
        reply: async () => {},
        history: async () => [],
        status: async () => ({ update: async () => {}, done: async () => {} }),
        directAudience: () => msg.directAudience,
        verifyDirectAudience: async () => ({ ok: true }),
      };
      let checks = 0;
      const latch = {
        revoked: false,
        revalidateSources: async () => {
          if (++checks === 1) throw sourceCheckError("origins", new TransientStoreError("temporary read failure"));
          return { ok: true as const };
        },
      };
      expect(await privateRunAudienceDecision(msg, io, latch)).toEqual({ ok: true });
      expect(latch.revoked).toBe(false);
      expect(checks).toBe(2);
    } finally {
      log.mockRestore();
    }
  });

  it("withholds source data when a fresh retry is also unavailable", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const io: ChannelIO = {
        reply: async () => {},
        history: async () => [],
        status: async () => ({ update: async () => {}, done: async () => {} }),
        directAudience: () => msg.directAudience,
        verifyDirectAudience: async () => ({ ok: true }),
      };
      let checks = 0;
      const latch = {
        revoked: false,
        revalidateSources: async () => {
          checks++;
          throw sourceCheckError("origins", new TransientStoreError("temporary read failure"));
        },
      };
      await expect(privateRunAudienceDecision(msg, io, latch)).rejects.toMatchObject({
        name: "SourceCheckError",
        stage: "origins",
      });
      expect(latch.revoked).toBe(true);
      expect(checks).toBe(2);
      expect(await privateRunAudienceDecision(msg, io, latch)).toEqual({
        ok: false,
        code: "saved-context-unproved",
        check: "context_validation_exception",
      });
    } finally {
      log.mockRestore();
    }
  });

  it("propagates a failed saved-source check and keeps the audience revoked", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cause = new TypeError("PRIVATE_SOURCE_BYTES");
      const io: ChannelIO = {
        reply: async () => {},
        history: async () => [],
        status: async () => ({ update: async () => {}, done: async () => {} }),
        directAudience: () => msg.directAudience,
        verifyDirectAudience: async () => ({ ok: true }),
      };
      const latch = {
        revoked: false,
        revalidateSources: () =>
          revalidateSourcesDecision([testSlackReceipt(msg)], async () => {
            throw cause;
          }),
      };
      await expect(privateRunAudienceDecision(msg, io, latch)).rejects.toMatchObject({
        name: "SourceCheckError",
        stage: "slack-revalidation",
        cause,
      });
      expect(await privateRunAudienceDecision(msg, io, latch)).toEqual({ ok: false, code: "slack-source-unverified" });
      expect(log.mock.calls.map(([line]) => JSON.parse(line))).toMatchObject([
        {
          event: "source_check.failed",
          sourceCheckStage: "slack-revalidation",
          sourceErrorClass: "TypeError",
          kind: "infra",
          code: "source_check_failed",
        },
      ]);
    } finally {
      log.mockRestore();
    }
  });

  it("keeps the failed context check across private publication rechecks", async () => {
    const io: ChannelIO = {
      reply: async () => {},
      history: async () => [],
      status: async () => ({ update: async () => {}, done: async () => {} }),
      directAudience: () => msg.directAudience,
      verifyDirectAudience: async () => ({ ok: true }),
    };
    let checks = 0;
    const latch = {
      revoked: false,
      revalidateSources: async () => {
        if (++checks > 1) return { ok: true as const };
        return {
          ok: false as const,
          code: "saved-context-unproved" as const,
          check: "execution_receipt_missing" as const,
        };
      },
    };
    expect(await privateRunAudienceDecision(msg, io, latch)).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "execution_receipt_missing",
    });
    expect(await privateRunAudienceDecision(msg, io, latch)).toEqual({
      ok: false,
      code: "saved-context-unproved",
      check: "execution_receipt_missing",
    });
    expect(checks).toBe(1);
  });
  it("keeps a verified private answer after three reads and one recovered unavailable check", async () => {
    let checks = 0;
    let unavailable = false;
    let shared = false;
    const client = {
      auth: { test: async () => ({ team_id: "TLOCAL" }) },
      users: { info: async () => ({ user: { team_id: "TLOCAL" } }) },
      conversations: {
        info: async () => {
          checks++;
          if (unavailable) {
            unavailable = false;
            throw new Error("temporary Slack failure");
          }
          return { channel: { user: "UALICE", is_im: true, is_org_shared: false, is_shared: shared } };
        },
      },
    };
    const io = {
      directAudience: () => msg.directAudience,
      verifyDirectAudience: (audience: NonNullable<IncomingMessage["directAudience"]>) =>
        verifySlackDirectAudience(client, audience),
    } as ChannelIO;
    const bound = await bindSlackContext({
      agentName: "orchestrator",
      actor: { kind: "user", id: msg.userId, grants: { actions: new Set(), channels: new Set(), repos: new Set() } },
      msg,
      io,
      visibility: "dm",
      create: () => testSlackCapability(msg, async () => "private source"),
    });
    expect(bound).toBeDefined();
    expect(await bound!.initialize(testSessionSources(msg, []), async () => true)).toBe(true);
    for (let read = 0; read < 3; read++)
      expect(await bound!.capability.read({ kind: "thread" })).toBe("private source");
    const beforeAnswer = checks;
    unavailable = true;
    expect(await privateRunAudienceDecision(msg, io, { revoked: false }, bound)).toEqual({ ok: true });
    expect(checks).toBe(beforeAnswer + 3);
    shared = true;
    expect(await privateRunAudienceDecision(msg, io, { revoked: false })).toEqual({
      ok: false,
      code: "direct-audience-denied",
    });
    expect(checks).toBe(beforeAnswer + 4);
  });

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
    expect(privateAudienceRefusal(recoveredPrivateAudienceLatch(msg, true))).toBe(
      "This run restarted, so I can't safely reuse its private source details. A new message with the source in your direct Slack chat with Switchboard, outside this thread, starts a fresh check.",
    );
    expect(recoveredPrivateAudienceLatch(msg, false).revoked).toBe(false);
    expect(recoveredPrivateAudienceLatch({ ...msg, directAudience: undefined }, true).revoked).toBe(false);
    expect(privateAudienceRefusal({ revoked: true })).toContain("verify who can read this private conversation");
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
