import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chatMessage.js";
import { boundChildHandoff, HANDOFF_MAX_BYTES, isChildHandoff, parentContextOf, type ChildHandoff } from "./handoff.js";

const handoff: ChildHandoff = {
  version: 1,
  source: { runId: "run-parent", threadKey: "cli:parent", channelId: "cli:main", requester: "cli:user" },
  session: { key: "cli:parent:@thread", from: 0, to: 8 },
  notepad: { text: "Keep the failing test output", updatedAt: 100, hash: "a".repeat(64) },
  assets: [
    {
      key: "artifact/key",
      name: "plan.pdf",
      contentType: "application/pdf",
      size: 3,
      direction: "in",
      runId: "run-parent",
      held: true,
    },
  ],
};

describe("structured child handoff", () => {
  it("preserves complete tool exchanges, attachments and author stamps without provider reasoning", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Read the plan" },
          { type: "document", name: "plan.pdf", mediaType: "application/pdf", data: "cGRm" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private", signature: "sig" },
          { type: "tool_use", id: "call-1", name: "read", input: { path: "plan" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call-1",
            content: [
              { type: "text", text: "exact output" },
              { type: "image", mediaType: "image/png", data: "aW1hZ2U=" },
            ],
          },
        ],
      },
    ];
    const result = parentContextOf(messages, handoff, ["cli:user", undefined, undefined]);
    expect(result.handoff).toEqual(handoff);
    expect(result.messages.flatMap((m) => m.content).some((p) => p.type === "thinking")).toBe(false);
    expect(result.messages.slice(1)).toEqual([
      messages[0],
      { ...messages[1], content: messages[1].content.slice(1) },
      messages[2],
    ]);
    expect(result.actors).toEqual([undefined, "cli:user", undefined, undefined]);
    messages[0].content[0] = { type: "text", text: "changed later" };
    expect(result.messages[1].content[0]).toEqual({ type: "text", text: "Read the plan" });
  });

  it("labels unfinished calls and preserves orphan results as evidence without invalid tool pairs", () => {
    const result = parentContextOf(
      [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "before-cut",
              content: [
                { type: "text", text: "older result" },
                { type: "image", mediaType: "image/png", data: "aQ==" },
              ],
            },
          ],
        },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "unfinished", name: "spawn_run", input: { preset: "research" } }],
        },
      ],
      handoff,
    );
    const parts = result.messages.flatMap((m) => m.content);
    expect(parts.some((p) => p.type === "tool_use" || p.type === "tool_result")).toBe(false);
    expect(JSON.stringify(parts)).toContain("before-cut");
    expect(JSON.stringify(parts)).toContain("unfinished");
    expect(JSON.stringify(parts)).toContain("result was not recorded");
    expect(parts).toContainEqual({ type: "image", mediaType: "image/png", data: "aQ==" });
  });

  it("bounds large inline catalogues with exact run event cursors instead of losing the source", () => {
    const assets = Array.from({ length: 1000 }, (_, seq) => ({ ...handoff.assets[0], key: `artifact/${seq}`, seq }));
    const bounded = boundChildHandoff({ ...handoff, assets });
    expect(new TextEncoder().encode(JSON.stringify(bounded)).byteLength).toBeLessThanOrEqual(HANDOFF_MAX_BYTES);
    expect(bounded).toMatchObject({
      source: handoff.source,
      session: handoff.session,
      notepad: handoff.notepad,
      assets: [],
      omitted: { assets: true },
      assetRuns: [{ runId: "run-parent", throughSeq: 999 }],
    });
  });

  it("validates frozen references and rejects malformed provenance or ranges", () => {
    expect(isChildHandoff(JSON.parse(JSON.stringify(handoff)))).toBe(true);
    expect(isChildHandoff({ ...handoff, session: { ...handoff.session, to: -2 } })).toBe(false);
    expect(isChildHandoff({ ...handoff, source: { ...handoff.source, requester: null } })).toBe(false);
    expect(isChildHandoff({ ...handoff, assets: [{ ...handoff.assets[0], key: 3 }] })).toBe(false);
    expect(isChildHandoff({ ...handoff, consumer: null })).toBe(false);
    expect(
      isChildHandoff({
        ...handoff,
        omitted: { assets: true },
        assetRuns: [{ runId: "run-parent" }],
        assets: undefined,
      }),
    ).toBe(false);
    expect(isChildHandoff({ ...handoff, omitted: { notepad: true } })).toBe(false);
  });
});
