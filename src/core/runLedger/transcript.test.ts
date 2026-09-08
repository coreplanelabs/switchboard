import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../providers/types.js";
import { assembleTranscript, chunkRows, turnRows } from "./transcript.js";
import { ATTACHMENT_REF_BYTES, TRANSCRIPT_PART_BYTES } from "./types.js";

// The transcript on the wire (docs/reference/specs/run-history.md item 32): one row per
// content part so no row nears the Durable Object's 2 MB limit, base64
// attachment data over a threshold stored once and referenced, requests
// chunked under the body fence, and the read side assembling the exact array
// the runner had — thinking blocks included — or reporting the gap.

const text = (t: string) => ({ type: "text" as const, text: t });

describe("turnRows — one row per content part, attachments by reference", () => {
  it("splits a turn into part rows carrying idx/part and the part's JSON verbatim", () => {
    const message: ChatMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "…", signature: "sig" },
        { type: "tool_use", id: "call_1", name: "bash", input: { command: "ls" } },
      ],
    };
    const { rows, attachments } = turnRows(4, message);
    expect(rows.map((r) => [r.idx, r.part])).toEqual([
      [4, 0],
      [4, 1],
    ]);
    expect(JSON.parse(rows[0].json)).toEqual({ role: "assistant", part: message.content[0] });
    expect(JSON.parse(rows[1].json)).toEqual({ role: "assistant", part: message.content[1] });
    expect(attachments).toEqual([]);
  });

  it("an image or document whose base64 exceeds the threshold is stored once and the row carries a ref", () => {
    const big = "A".repeat(ATTACHMENT_REF_BYTES + 10);
    const message: ChatMessage = {
      role: "user",
      content: [text("see attached"), { type: "image", mediaType: "image/png", data: big }],
    };
    const { rows, attachments } = turnRows(0, message);
    expect(rows).toHaveLength(2);
    const part = JSON.parse(rows[1].json).part as Record<string, unknown>;
    expect(part).toEqual({ type: "image", mediaType: "image/png", data: "", dataRef: "t0p1" });
    expect(attachments).toEqual([{ ref: "t0p1", mediaType: "image/png", data: big }]);
    expect(rows[1].json.length).toBeLessThan(1_000);
  });

  it("a small attachment stays inline", () => {
    const message: ChatMessage = { role: "user", content: [{ type: "image", mediaType: "image/png", data: "abc" }] };
    const { rows, attachments } = turnRows(0, message);
    expect(JSON.parse(rows[0].json).part.data).toBe("abc");
    expect(attachments).toEqual([]);
  });

  it("a text part over the row budget is refused by name — never truncated, never silently split", () => {
    const message: ChatMessage = { role: "user", content: [text("x".repeat(TRANSCRIPT_PART_BYTES + 1))] };
    expect(() => turnRows(0, message)).toThrow(/part 0 of turn 0 is .* bytes, over the .* row budget/);
  });

  it("budgets are UTF-8 bytes, not characters: a multibyte part under the budget in characters but over it in bytes is refused", () => {
    // 600k CJK characters: under 1.5M in `.length`, ~1.8 MB in UTF-8.
    const message: ChatMessage = { role: "user", content: [text("漢".repeat(600_000))] };
    expect("漢".repeat(600_000).length).toBeLessThan(TRANSCRIPT_PART_BYTES);
    expect(() => turnRows(0, message)).toThrow(/over the .* row budget/);
  });
});

describe("chunkRows — requests under the body fence", () => {
  it("packs rows into requests whose JSON stays under maxBytes, preserving order; a single row over the fence is its own request", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ idx: i, part: 0, json: "x".repeat(300) }));
    const chunks = chunkRows(rows, 1_000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(rows);
    for (const c of chunks) expect(JSON.stringify(c).length).toBeLessThanOrEqual(1_000 + 400);
  });

  it("no rows → no requests", () => {
    expect(chunkRows([], 1_000)).toEqual([]);
  });

  it("chunks by UTF-8 bytes: multibyte rows pack fewer per request than their character count suggests", () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({ idx: i, part: 0, json: "漢".repeat(100) })); // 300 bytes each
    const byBytes = chunkRows(rows, 1_000);
    expect(byBytes.length).toBeGreaterThanOrEqual(2);
    for (const c of byBytes)
      expect(new TextEncoder().encode(JSON.stringify(c)).byteLength).toBeLessThanOrEqual(1_000 + 400);
  });
});

describe("assembleTranscript — the array the runner had, or the gap", () => {
  it("rebuilds turns from rows in (idx, part) order, re-inflating referenced attachments", () => {
    const seed: ChatMessage[] = [
      {
        role: "user",
        content: [text("hi"), { type: "image", mediaType: "image/png", data: "B".repeat(ATTACHMENT_REF_BYTES + 1) }],
      },
      { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }, text("hello")] },
    ];
    const rows = seed.flatMap((m, i) => turnRows(i, m).rows);
    const attachments = seed.flatMap((m, i) => turnRows(i, m).attachments);
    const shuffled = [...rows].reverse();
    const out = assembleTranscript(shuffled, attachments);
    expect(out).toEqual({ complete: true, turns: 2, messages: seed });
  });

  it("a missing turn or a missing part makes the transcript incomplete and names the gap; the turns before the gap are kept", () => {
    const rows = [
      { idx: 0, part: 0, json: JSON.stringify({ role: "user", part: text("a") }) },
      { idx: 2, part: 0, json: JSON.stringify({ role: "user", part: text("c") }) },
    ];
    expect(assembleTranscript(rows, [])).toEqual({
      complete: false,
      turns: 1,
      messages: [{ role: "user", content: [text("a")] }],
      gap: "turn 1 is missing",
    });
    const parts = [
      { idx: 0, part: 0, json: JSON.stringify({ role: "user", part: text("a") }) },
      { idx: 0, part: 2, json: JSON.stringify({ role: "user", part: text("c") }) },
    ];
    expect(assembleTranscript(parts, [])).toMatchObject({ complete: false, turns: 0, gap: "turn 0 is missing part 1" });
  });

  it("a referenced attachment that was never stored is a gap, not an empty image", () => {
    const rows = [
      {
        idx: 0,
        part: 0,
        json: JSON.stringify({
          role: "user",
          part: { type: "image", mediaType: "image/png", data: "", dataRef: "t0p0" },
        }),
      },
    ];
    expect(assembleTranscript(rows, [])).toMatchObject({
      complete: false,
      turns: 0,
      gap: "attachment t0p0 is missing",
    });
  });

  it("no rows → an empty, complete transcript of zero turns", () => {
    expect(assembleTranscript([], [])).toEqual({ complete: true, turns: 0, messages: [] });
  });
});
