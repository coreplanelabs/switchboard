import { describe, expect, it } from "vitest";
import { POINTER_SUMMARY_PREFIX, compactionAskOf, pointerSummary } from "./compactionFallback.js";

// Feature: docs/reference/specs/harness-pi.md item 7 — the compaction the bot
// writes for pi when pi's own summary failed for good (record 0035: a
// compaction is a pointer, never a loss): the earlier turns leave the window
// under a fixed opening that names why, points at `recall` and the notes, and
// carries the summary the compaction before it left and pi's own file lists;
// and the shape the route reads the extension's ask in.

describe("pointerSummary — the compaction the bot writes when pi's summary could not be", () => {
  it("opens with the fixed prefix, says why pi's summary could not be written, points at recall and the notes, and carries the previous summary and the file lists in pi's own tags — each only when there is one", () => {
    const text = pointerSummary(
      {
        reason: "threshold",
        tokensBefore: 187_000,
        previousSummary: "So far: the tests were run; two fail.",
        readFiles: ["src/a.ts"],
        modifiedFiles: ["src/b.ts", "src/c.ts"],
      },
      "Auto-compaction failed: Turn prefix summarization failed: the request was refused under the provider's usage policy",
    );
    expect(text.startsWith(POINTER_SUMMARY_PREFIX)).toBe(true);
    expect(text).toContain(
      "pi's summary of them could not be written (Auto-compaction failed: Turn prefix summarization failed: the request was refused under the provider's usage policy)",
    );
    expect(text).toContain("`recall`");
    expect(text).toContain("`notes`");
    expect(text).toContain("The summary the compaction before this one left:\nSo far: the tests were run; two fail.");
    expect(text).toContain("<read-files>\nsrc/a.ts\n</read-files>");
    expect(text).toContain("<modified-files>\nsrc/b.ts\nsrc/c.ts\n</modified-files>");

    const bare = pointerSummary({ reason: "overflow", tokensBefore: 1, readFiles: [], modifiedFiles: [] }, "x");
    expect(bare.startsWith(POINTER_SUMMARY_PREFIX)).toBe(true);
    expect(bare).not.toContain("The summary the compaction before");
    expect(bare).not.toContain("<read-files>");
    expect(bare).not.toContain("<modified-files>");
  });

  it("the failure's words are redacted and capped like every note, so a provider's long error never becomes the window", () => {
    const text = pointerSummary(
      { reason: "threshold", tokensBefore: 1, readFiles: [], modifiedFiles: [] },
      `token sk-ant-api03-${"a".repeat(80)} ${"b".repeat(600)}`,
    );
    expect(text).not.toContain("sk-ant-api03-a");
    expect(text).not.toContain("b".repeat(400));
    expect(text).toContain("…)");
  });
});

describe("compactionAskOf — the body the extension posts", () => {
  it("reads the reason, the size, the previous summary when there is one and the two file lists, absent lists being empty", () => {
    expect(
      compactionAskOf({
        reason: "threshold",
        tokensBefore: 150_000,
        previousSummary: "so far",
        readFiles: ["a.ts"],
        modifiedFiles: ["b.ts"],
      }),
    ).toEqual({
      reason: "threshold",
      tokensBefore: 150_000,
      previousSummary: "so far",
      readFiles: ["a.ts"],
      modifiedFiles: ["b.ts"],
    });
    expect(compactionAskOf({ reason: "overflow", tokensBefore: 10 })).toEqual({
      reason: "overflow",
      tokensBefore: 10,
      readFiles: [],
      modifiedFiles: [],
    });
  });

  it("refuses a body that is not an object, a missing or non-string reason, a size that is not a finite number, a previous summary that is not a string, and a list with anything but strings", () => {
    expect(compactionAskOf(undefined)).toBeUndefined();
    expect(compactionAskOf("threshold")).toBeUndefined();
    expect(compactionAskOf({ tokensBefore: 1 })).toBeUndefined();
    expect(compactionAskOf({ reason: 4, tokensBefore: 1 })).toBeUndefined();
    expect(compactionAskOf({ reason: "threshold", tokensBefore: "1" })).toBeUndefined();
    expect(compactionAskOf({ reason: "threshold", tokensBefore: Number.NaN })).toBeUndefined();
    expect(compactionAskOf({ reason: "threshold", tokensBefore: 1, previousSummary: 7 })).toBeUndefined();
    expect(compactionAskOf({ reason: "threshold", tokensBefore: 1, readFiles: "a.ts" })).toBeUndefined();
    expect(compactionAskOf({ reason: "threshold", tokensBefore: 1, modifiedFiles: [1] })).toBeUndefined();
  });
});
