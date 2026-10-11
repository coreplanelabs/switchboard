import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../chatMessage.js";
import { handoffBriefOf } from "./handoffBrief.js";

describe("focused parent brief", () => {
  it("keeps the goal, corrections, attachments and notes without tool exploration", () => {
    const input: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "Find the failed deployment; keep its original owner." }] },
      { role: "assistant", content: [{ type: "tool_use", id: "logs", name: "read", input: {} }] },
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "logs", content: "irrelevant exploration ".repeat(20_000) },
          { type: "text", text: "Correction: investigate staging only." },
          { type: "image", mediaType: "image/png", data: "aQ==" },
          { type: "document", mediaType: "application/pdf", name: "scope.pdf", data: "cGRm" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "An abandoned theory." }] },
    ];
    const actual = handoffBriefOf(
      input,
      ["cli:owner", undefined, "cli:owner"],
      "Deploy 17 failed; production is unchanged.",
    );
    expect(actual).toEqual({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Frozen parent working notes (source evidence):\nDeploy 17 failed; production is unchanged.",
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "Find the failed deployment; keep its original owner." }] },
        {
          role: "user",
          content: [
            { type: "text", text: "Correction: investigate staging only." },
            { type: "image", mediaType: "image/png", data: "aQ==" },
            { type: "document", mediaType: "application/pdf", name: "scope.pdf", data: "cGRm" },
          ],
        },
      ],
      actors: [undefined, "cli:owner", "cli:owner"],
    });
    input[0].content[0] = { type: "text", text: "changed later" };
    expect(actual.messages[1].content).toEqual([
      { type: "text", text: "Find the failed deployment; keep its original owner." },
    ]);
  });

  it("rejects oversized protected text whole and counts UTF-8 bytes", () => {
    const content = [{ type: "text" as const, text: "界".repeat(17_000) }];
    expect(() => handoffBriefOf([{ role: "user", content }])).toThrow("no source request or correction was truncated");
    expect(handoffBriefOf([{ role: "user", content: [{ type: "text", text: "Keep staging only." }] }])).toEqual({
      messages: [{ role: "user", content: [{ type: "text", text: "Keep staging only." }] }],
    });
  });

  it("keeps structured attachment bytes under their own limits", () => {
    const attachment = { type: "image" as const, mediaType: "image/png", data: "a".repeat(100_000) };
    expect(handoffBriefOf([{ role: "user", content: [attachment] }])).toEqual({
      messages: [{ role: "user", content: [attachment] }],
    });
  });
});
