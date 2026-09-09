import { describe, expect, it } from "vitest";
import type { ChannelIO, IncomingMessage } from "../types.js";
import { DURABLE_INBOX_MAX_BYTES, durableInboxMessage, followUpFromInbox } from "./admission.js";

// Feature: docs/reference/specs/run-history.md item 40 — a durable inbox item back
// as a follow-up for the resumed run. The rest of the stage is proven through
// `dispatch()` in `src/core/dispatcher.test.ts` (`thread admission`, `run
// ledger write-through`).

const THREAD = "slack:CX:1.0";

const msg = (text: string, user = "slack:UX"): IncomingMessage => ({
  channelId: "slack:CX",
  userId: user,
  threadKey: THREAD,
  text,
});

function fakeIO() {
  const replies: string[] = [];
  const io: ChannelIO = {
    reply: async (t) => void replies.push(t),
    status: async () => ({ update: () => {}, done: async () => {} }),
    history: async () => [],
  };
  return { io, replies };
}

describe("followUpFromInbox — a durable inbox item back as a follow-up", () => {
  it("the durable copy carries a follow-up's attachments when they fit the state Worker's body cap and names what it dropped when they do not; the resume restores them as image/document parts, or tells the model what was lost", () => {
    const base = { ...msg("look at these", "slack:UY"), userName: "uy" };
    const small = durableInboxMessage(
      {
        ...base,
        images: [{ mediaType: "image/png", data: "QUJD" }],
        documents: [{ mediaType: "application/pdf", data: "UERG", name: "spec.pdf" }],
      },
      "look at these",
      9_000,
    );
    expect(small.images).toEqual([{ mediaType: "image/png", data: "QUJD" }]);
    expect(small.documents).toEqual([{ mediaType: "application/pdf", data: "UERG", name: "spec.pdf" }]);
    expect(small.attachmentsDropped).toBeUndefined();
    const io = fakeIO().io;
    const restored = followUpFromInbox({ seq: 3, message: small }, io, 0)!;
    expect(restored.images).toEqual([{ mediaType: "image/png", data: "QUJD" }]);
    expect(restored.documents).toEqual([{ mediaType: "application/pdf", data: "UERG", name: "spec.pdf" }]);
    expect(restored.text).toBe("look at these");
    // Over the cap: the text is kept, the bytes are not, and the count is recorded.
    const big = durableInboxMessage(
      { ...base, images: [{ mediaType: "image/png", data: "A".repeat(DURABLE_INBOX_MAX_BYTES) }] },
      "look at these",
      9_000,
    );
    expect(big.images).toBeUndefined();
    expect(big.attachmentsDropped).toEqual({ images: 1, documents: 0 });
    expect(Buffer.byteLength(JSON.stringify(big), "utf8")).toBeLessThan(DURABLE_INBOX_MAX_BYTES);
    const lossy = followUpFromInbox({ seq: 4, message: big }, io, 0)!;
    expect(lossy.images).toBeUndefined();
    expect(lossy.text).toBe(
      "look at these\n\n(1 attachment from this reply could not be carried across the bot's restart and is not attached.)",
    );
    // A malformed attachment entry is dropped on the way back, never fatal.
    const odd = followUpFromInbox(
      {
        seq: 5,
        message: {
          ...small,
          images: [
            { mediaType: 7, data: "QUJD" },
            { mediaType: "image/png", data: "QUJD" },
          ],
        },
      },
      io,
      0,
    )!;
    expect(odd.images).toEqual([{ mediaType: "image/png", data: "QUJD" }]);
  });
});
