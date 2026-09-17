import { questionText } from "../core/question.js";
import type { RunnableTool } from "./runnableTool.js";

export const requestInputTool: RunnableTool = {
  name: "request_input",
  failsInText: true,
  description:
    "Ask the user for missing information required to continue. Supply one clear question, with Markdown options when useful. Call this only when blocked on their answer, then end your turn without further work. Switchboard sends the recorded question and waits for a reply; it does not publish a PR or review verdict from this turn. A later call replaces the question. Do not use this to request credentials or to bypass authorization.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", minLength: 1, maxLength: 4000, description: "The question shown to the user" },
    },
    required: ["question"],
    additionalProperties: false,
  },
  async run(input, ctx) {
    const question = questionText(input.question);
    if (!question) return "error: question must contain 1–4000 characters";
    if (!ctx.onQuestion) return "error: this run cannot request user input";
    ctx.onQuestion(question);
    return "Question recorded. End your turn now; Switchboard will ask it and wait for the user's reply.";
  },
};
