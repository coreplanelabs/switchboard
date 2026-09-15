import { describe, expect, it } from "vitest";
import type { HistoryItem } from "../types.js";
import type { ConversationRef, ReferencedConversation } from "./types.js";

// Record 0037, hard part 1: a referenced conversation must never be a history
// item, because five consumers read `history` before the model does and one of
// them picks the agent. The two shapes are kept apart by a discriminant, so a
// stray `history.push(referenced)` is a compile error, pinned here.
describe("ReferencedConversation is not a HistoryItem", () => {
  const ref: ConversationRef = {
    channelId: "slack:C_FRONTEND",
    threadKey: "slack:C_FRONTEND:1789439332.061189",
    url: "https://team.example/archives/C_FRONTEND/p1789439332061189",
  };
  const referenced: ReferencedConversation = {
    kind: "reference",
    ref,
    channelName: "frontend",
    permalink: ref.url,
    messages: [{ at: 1_789_439_332_061, author: "teammate", text: "hello" }],
  };

  it("does not unify at the type level, in either direction", () => {
    // @ts-expect-error a referenced conversation cannot stand in for a history item
    const asHistory: HistoryItem = referenced;
    const history: HistoryItem = { role: "user", text: "hi" };
    // @ts-expect-error a history item cannot stand in for a referenced conversation
    const asReferenced: ReferencedConversation = history;
    expect(asHistory).toBeDefined();
    expect(asReferenced).toBeDefined();
  });

  it("carries the source it will be labelled with", () => {
    expect(referenced.kind).toBe("reference");
    expect(referenced.permalink).toBe(ref.url);
    expect(referenced.messages[0].author).toBe("teammate");
  });
});
