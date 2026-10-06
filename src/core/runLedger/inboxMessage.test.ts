import { describe, expect, it } from "vitest";
import { decide, emptyPlaneState } from "../plane/decide.js";
import type { IncomingMessage, StagedFile } from "../types.js";
import {
  bindInboxCustody,
  directAudienceStampOf,
  DURABLE_INBOX_MAX_BYTES,
  durableInboxMessage,
  messageFromInbox,
} from "./inboxMessage.js";

// Feature: docs/reference/specs/execution.md item 20 (record 0033) / run-history.md
// item 40 — a steer that carries a staged reference survives the durable inbox:
// the reference is metadata, so it rides the base row whatever the inline
// attachments do, and reads back as the same reference.

const clip: StagedFile = {
  name: "clip.mp4",
  size: 312_000_000,
  type: "video/mp4",
  url: "https://files.slack.com/files-pri/T1-F1/clip.mp4",
  messageId: "1700000000.000200",
};
const base: IncomingMessage = {
  channelId: "slack:C1",
  userId: "slack:UA",
  threadKey: "slack:C1:1.0",
  text: "and this video",
  userName: "alice",
};

describe("durable inbox continuity", () => {
  it("binds the canonical destination independently of a named steer's source route", () => {
    const destination = {
      runId: "target-run",
      channelId: "slack:C2",
      threadKey: "slack:C2:2.0",
      requester: "slack:UA",
      producerGen: "target-gen",
    };
    const original = durableInboxMessage({ ...base, authenticatedAs: "http:alice" }, "cross-channel steer", 17);
    const stored = bindInboxCustody(original, destination);
    expect(stored).toMatchObject({
      channelId: base.channelId,
      threadKey: base.threadKey,
      authenticatedAs: "http:alice",
      target: { version: 1, ...destination },
    });
    expect(messageFromInbox(stored!, 0, destination)?.msg).toMatchObject({
      channelId: base.channelId,
      threadKey: base.threadKey,
      userId: base.userId,
      authenticatedAs: "http:alice",
    });
    expect(messageFromInbox(stored!, 0, { ...destination, runId: "foreign" })).toBeUndefined();
    expect(original).not.toHaveProperty("target");
    expect(bindInboxCustody({ ...original, target: { version: 1, ...destination } }, destination)).toBeUndefined();
    expect(bindInboxCustody({ ...original, userId: "plane", kind: "provider-reissue" }, destination)).toBeUndefined();
  });

  it("does not carry private audience authority across a different canonical destination", () => {
    const msg: IncomingMessage = {
      channelId: "slack:DMAIN",
      threadKey: "slack:DMAIN:1.0",
      userId: "slack:UALICE",
      text: "steer",
      directAudience: {
        kind: "slack-unshared-im",
        channelId: "slack:DMAIN",
        threadKey: "slack:DMAIN:1.0",
        userId: "slack:UALICE",
      },
    };
    const stored = {
      ...durableInboxMessage(msg, msg.text, 1),
      target: {
        version: 1,
        runId: "other",
        channelId: "slack:C2",
        threadKey: "slack:C2:2.0",
        requester: msg.userId,
        producerGen: "g1",
      },
    };
    expect(messageFromInbox(stored, 0)).toBeUndefined();
  });

  it("round-trips a checkpoint for the original canonical run and route", () => {
    const state = emptyPlaneState();
    state.liveRuns["run-a"] = { channelId: base.channelId, threadKey: base.threadKey };
    const decision = decide(state, {
      kind: "heartbeat",
      runId: "run-a",
      at: 1_000,
      noPushMs: 1,
      facts: { coding: true, round: 1, startedAt: 0 },
    });
    const row = decision.writes.find((write) => write.table === "run_inbox");
    expect(row?.table).toBe("run_inbox");
    if (row?.table !== "run_inbox") throw new Error("checkpoint absent");
    expect(
      messageFromInbox(row.message, 0, { runId: "run-a", channelId: base.channelId, threadKey: base.threadKey })?.msg,
    ).toMatchObject({ channelId: base.channelId, threadKey: base.threadKey, userId: "plane" });
    expect(row.message).toMatchObject({ version: 1, kind: "checkpoint", targetRunId: "run-a" });
  });

  it.each(["authenticatedAs", "postedBy", "relayedBy", "fromRunId"])(
    "retains a malformed %s without downgrading the principal",
    (field) => {
      const row = { ...durableInboxMessage(base, base.text, 1), [field]: 17 };
      expect(messageFromInbox(row, 0)).toBeUndefined();
      expect(row[field]).toBe(17);
    },
  );

  it("refuses an unknown codec version without changing its payload", () => {
    const row = { ...durableInboxMessage(base, base.text, 1), version: 99 };
    expect(messageFromInbox(row, 0)).toBeUndefined();
    expect(row.version).toBe(99);
  });
});

describe("durable inbox — staged references (record 0033)", () => {
  it("carries a verified DM address across replay but drops malformed claims", () => {
    const dm: IncomingMessage = {
      channelId: "slack:DMAIN",
      userId: "slack:UALICE",
      threadKey: "slack:DMAIN:1.0",
      text: "follow up",
      directAudience: {
        kind: "slack-unshared-im",
        channelId: "slack:DMAIN",
        userId: "slack:UALICE",
        threadKey: "slack:DMAIN:1.0",
      },
    };
    const stored = durableInboxMessage(dm, dm.text, 1);
    expect(messageFromInbox(stored, 1)?.msg.directAudience).toEqual(dm.directAudience);
    expect(
      messageFromInbox({ ...stored, directAudience: { ...dm.directAudience, userId: "slack:UBOB" } }, 1)?.msg
        .directAudience,
    ).toBeUndefined();
    expect(directAudienceStampOf({ ...dm, postedBy: "slack:bot:BOTHER" })).toBeUndefined();
    expect(directAudienceStampOf({ ...dm, authenticatedAs: "http:relay" })).toBeUndefined();
    expect(durableInboxMessage(dm, dm.text, 1, { runId: "parent" }).directAudience).toBeUndefined();
    expect(messageFromInbox({ ...stored, fromRunId: "parent" }, 1)?.msg.directAudience).toBeUndefined();
    const relayed = durableInboxMessage({ ...dm, relayedBy: "slack:bot:BOTHER" }, dm.text, 1);
    expect(relayed.relayedBy).toBe("slack:bot:BOTHER");
    expect(relayed.directAudience).toBeUndefined();
    expect(messageFromInbox(relayed, 1)?.msg.relayedBy).toBe("slack:bot:BOTHER");
    expect(messageFromInbox({ ...stored, relayedBy: "slack:bot:BOTHER" }, 1)?.msg.directAudience).toBeUndefined();
  });

  it("keeps a matching private audience stamp for a restarted request and drops a forged one", () => {
    const directAudience = {
      kind: "slack-unshared-im" as const,
      channelId: "slack:D1",
      userId: "slack:WALICE",
      threadKey: "slack:D1:1.0",
    };
    const dm = { ...base, ...directAudience, directAudience };
    const stored = durableInboxMessage(dm, dm.text, 1);
    expect(stored.directAudience).toEqual(directAudience);
    expect((messageFromInbox(stored, 0)?.msg as IncomingMessage & { directAudience?: unknown }).directAudience).toEqual(
      directAudience,
    );
    expect(
      messageFromInbox({ ...stored, directAudience: { ...directAudience, userId: "slack:WB0B" } }, 0),
    ).toBeUndefined();
  });
  it("a steer with a staged reference writes it on the row and reads it back as the same reference", () => {
    const row = durableInboxMessage({ ...base, staged: [clip] }, "and this video", 1_700_000_000_000);
    expect(row.staged).toEqual([clip]);
    const back = messageFromInbox(row, 0);
    expect(back?.msg.staged).toEqual([clip]);
    expect(back?.msg.text).toBe("and this video");
  });

  it("the message's own id rides the row and reads back, so a steer folded in after a restart still names the message its files came with", () => {
    const row = durableInboxMessage({ ...base, messageId: "1700000000.000200" }, base.text, 1);
    expect(row.messageId).toBe("1700000000.000200");
    expect(messageFromInbox(row, 0)?.msg.messageId).toBe("1700000000.000200");
    // A row from a channel without message ids carries none, and reads back without one.
    const bare = durableInboxMessage(base, base.text, 1);
    expect("messageId" in bare).toBe(false);
    expect(messageFromInbox(bare, 0)?.msg.messageId).toBeUndefined();
  });

  it("the reference survives even when the inline attachments do not fit the row", () => {
    const huge = { mediaType: "image/png", data: "A".repeat(DURABLE_INBOX_MAX_BYTES), name: "shot.png" };
    const row = durableInboxMessage({ ...base, images: [huge], staged: [clip] }, base.text, 1);
    expect(row.images).toBeUndefined();
    expect(row.attachmentsDropped).toEqual({ images: 1, documents: 0 });
    expect(row.staged).toEqual([clip]);
    const back = messageFromInbox(row, 0);
    expect(back?.msg.staged).toEqual([clip]);
    expect(back?.msg.text).toContain("could not be carried across the bot's restart");
  });

  it("a row without staged files reads back without the key; a malformed entry is dropped, never fatal", () => {
    expect(durableInboxMessage(base, base.text, 1).staged).toBeUndefined();
    expect(messageFromInbox(durableInboxMessage(base, base.text, 1), 0)?.msg.staged).toBeUndefined();
    const row = { ...durableInboxMessage(base, base.text, 1), staged: [{ name: "x" }, 7, clip] };
    expect(messageFromInbox(row, 0)?.msg.staged).toEqual([clip]);
  });

  // authorization.md item 15: the credential behind a bound person survives the
  // row, so a restart dispatches under its grants, not the person's.
  it("a bound credential's `authenticatedAs` rides the row and reads back; a message without one reads back without the key", () => {
    const bound = { ...base, userId: "slack:U0ALICE", authenticatedAs: "http:alice-ingress" };
    const row = durableInboxMessage(bound, bound.text, 1);
    expect(row.authenticatedAs).toBe("http:alice-ingress");
    expect(messageFromInbox(row, 0)?.msg).toMatchObject({
      userId: "slack:U0ALICE",
      authenticatedAs: "http:alice-ingress",
    });
    expect("authenticatedAs" in durableInboxMessage(base, base.text, 1)).toBe(false);
    expect("authenticatedAs" in (messageFromInbox(durableInboxMessage(base, base.text, 1), 0)?.msg ?? {})).toBe(false);
  });

  // authorization.md item 14: the relaying app rides the row too, so a restart decides on app ∩ person.
  it("a relayed message's `postedBy` rides the row and reads back; absent otherwise", () => {
    const relayed = { ...base, postedBy: "slack:bot:B0CLAUDE" };
    const row = durableInboxMessage(relayed, relayed.text, 1);
    expect(row.postedBy).toBe("slack:bot:B0CLAUDE");
    expect(messageFromInbox(row, 0)?.msg.postedBy).toBe("slack:bot:B0CLAUDE");
    expect("postedBy" in (messageFromInbox(durableInboxMessage(base, base.text, 1), 0)?.msg ?? {})).toBe(false);
  });
});
