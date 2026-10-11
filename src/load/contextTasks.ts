import type { ChatMessage } from "../core/chatMessage.js";
import type { ContextTrial } from "./contextEvaluation.js";

export interface ContextTask {
  id: string;
  task: string;
  boundary: ContextTrial["boundary"];
  source: ChatMessage[];
  notepad: string;
  expected: ContextTrial["expected"];
  expectedNotes: string[];
  avoidCommands: string[];
}

/** Source material and grading labels are separate inputs. Only the source,
 * task and working note may enter a completion request. */
export function contextTasks(): ContextTask[] {
  return [
    {
      id: "corrected-goal",
      boundary: "compaction",
      task: "Report the current environment in fact environment. Check the retained correction, not the earlier goal.",
      source: [
        { role: "user", content: [{ type: "text", text: "Investigate production." }] },
        {
          role: "user",
          content: [{ type: "text", text: "Correction: investigate staging only. Production is outside scope." }],
        },
      ],
      notepad: "The environment was corrected; the exact correction is retained at turn:1.",
      expected: { environment: { value: "staging", source: "turn:1" } },
      expectedNotes: [],
      avoidCommands: [],
    },
    {
      id: "original-failure",
      boundary: "compaction",
      task: "Report the exact failed test name in fact failure. Read the original result before answering.",
      source: [
        { role: "assistant", content: [{ type: "tool_use", id: "test", name: "test", input: {} }] },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "test",
              content: "FAIL session_context.test.ts > retained_correction\nExpected staging; received production.",
            },
          ],
        },
      ],
      notepad: "A test failed. The exact original output is retained at turn:1.",
      expected: { failure: { value: "retained_correction", source: "turn:1" } },
      expectedNotes: [],
      avoidCommands: [],
    },
    {
      id: "rejected-approach",
      boundary: "restart",
      task: "Report the accepted next approach in fact approach. Preserve the rejected approach when updating your notes.",
      source: [
        {
          role: "user",
          content: [{ type: "text", text: "Choose a recovery approach without replacing the resident." }],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Reject force-rebuild: it loses original evidence. Accepted approach: preserve-and-inspect.",
            },
          ],
        },
      ],
      notepad: "Rejected force-rebuild because it loses evidence. Accepted preserve-and-inspect. Source: turn:1.",
      expected: { approach: { value: "preserve-and-inspect", source: "turn:1" } },
      expectedNotes: ["force-rebuild", "preserve-and-inspect"],
      avoidCommands: ["force-rebuild"],
    },
    {
      id: "child-source",
      boundary: "child-handoff",
      task: "Report the authorized parent receipt in fact receipt. Read parent turn:1 with source parent; parent turn:2 is outside the frozen source range.",
      source: [
        {
          role: "user",
          content: [{ type: "text", text: "Inspect the parent receipt; do not broaden its source range." }],
        },
        { role: "user", content: [{ type: "text", text: "Authorized receipt: staging-check-17." }] },
      ],
      notepad: "The parent receipt is retained at parent:turn:1. Parent notes are read-only.",
      expected: { receipt: { value: "staging-check-17", source: "parent:turn:1" } },
      expectedNotes: [],
      avoidCommands: [],
    },
  ];
}
