import { describe, expect, it } from "vitest";
import { attributedText, foldThreadEvents } from "./threadEvents.js";

// Feature: docs/reference/specs/thread-admission.md items 3, 4 and 9 — ONE
// renderer attributes another sender's words everywhere they are re-rendered
// (record 0062): the unit-thread fold, the live steer prompt and the fresh
// turn's merged text, so no second rendering can drift.

describe("attributedText — the one rendering of another sender's words", () => {
  it("prefixes the sender's display name, falling back to the id", () => {
    expect(attributedText({ sender: "slack:UA", senderName: "ann", text: "one" })).toBe("ann: one");
    expect(attributedText({ sender: "slack:UA", text: "one" })).toBe("slack:UA: one");
  });

  it("appends the dropped-attachments note on its own line, counted", () => {
    expect(attributedText({ sender: "slack:UA", text: "one", attachmentsDropped: 1 })).toBe(
      "slack:UA: one\n(1 attachment could not be carried and is not attached.)",
    );
    expect(attributedText({ sender: "slack:UA", text: "one", attachmentsDropped: 0 })).toBe("slack:UA: one");
  });
});

describe("foldThreadEvents — the attributed join of a unit's thread events", () => {
  it("attributes each text to its sender (display name first), in the order given, and notes dropped attachments", () => {
    expect(
      foldThreadEvents([
        { sender: "slack:UBOB", senderName: "bob", text: "also update the readme" },
        { sender: "slack:UCARA", text: "and bump the version", attachmentsDropped: 2 },
      ]),
    ).toBe(
      "bob: also update the readme\n\nslack:UCARA: and bump the version\n(2 attachments could not be carried and are not attached.)",
    );
  });
});
