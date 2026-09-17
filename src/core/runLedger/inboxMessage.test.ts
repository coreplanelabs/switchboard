import { describe, expect, it } from "vitest";
import type { IncomingMessage, StagedFile } from "../types.js";
import { DURABLE_INBOX_MAX_BYTES, durableInboxMessage, messageFromInbox } from "./inboxMessage.js";

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

describe("durable inbox — staged references (record 0033)", () => {
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
