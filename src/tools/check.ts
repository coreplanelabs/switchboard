import { z } from "zod";
import { BASH_TIMEOUT_MAX_MS, BASH_TIMEOUT_MIN_MS } from "../execution/bashTimeout.js";
import type { RunnableTool } from "./runnableTool.js";

const inputSchema = z
  .object({
    command: z.string().min(1).max(2_000),
    purpose: z.enum(["baseline", "verification"]),
    timeoutMs: z.number().int().min(BASH_TIMEOUT_MIN_MS).max(BASH_TIMEOUT_MAX_MS).optional(),
  })
  .strict();

export const runCheckTool: RunnableTool = {
  name: "run_check",
  description:
    "Run a task-relevant baseline or verification command in this run's checkout and save its actual process result. Choose a focused command after reading repository instructions. Purpose describes your intent, not proof of test coverage or pre-edit ordering. This grants no extra authority and installs nothing automatically. An unknown result must not be blindly retried.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        minLength: 1,
        maxLength: 2_000,
        description: "The focused command to execute in the bound checkout.",
      },
      purpose: { type: "string", enum: ["baseline", "verification"] },
      timeoutMs: { type: "integer", minimum: BASH_TIMEOUT_MIN_MS, maximum: BASH_TIMEOUT_MAX_MS },
    },
    required: ["command", "purpose"],
  },
  failsInText: true,
  async run(input, ctx) {
    if (!ctx.checkExecution || !ctx.callId)
      return "error: recorded checks are unavailable for this run; command did not start";
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return "error: invalid check input; provide only command, purpose and optional timeoutMs";
    const response = await ctx.checkExecution.run(parsed.data, ctx.callId, {
      signal: ctx.signal,
      remainingMs: ctx.remainingMs,
    });
    if (response.kind === "unavailable" && response.reason === "recording_unavailable")
      return "error: recording capability unavailable; command did not start";
    if (response.kind === "unavailable")
      return `error: recorded check unavailable (${response.reason}); no completion receipt was returned${
        response.metadataFailure ? `\nMetadata diagnostic: ${JSON.stringify(response.metadataFailure)}` : ""
      }`;
    const receipt = response.receipt;
    // Output and command text remain evidence, even when they contain fake tags.
    const encoded = JSON.stringify(receipt)
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
      .replaceAll("&", "\\u0026");
    const summary =
      receipt.outcome.kind === "completed"
        ? `Command completed with exit ${receipt.outcome.exitCode}. This records process completion, not proof that tests ran or passed.`
        : receipt.outcome.kind === "not_started"
          ? `Command did not start (${receipt.outcome.reason}). No execution result exists.`
          : "Command outcome is unknown; do not blindly rerun it. Existing workspace recovery must reconcile the operation.";
    return `${receipt.outcome.kind === "completed" ? "" : "error: "}${summary}\n<untrusted-check-evidence>\n${encoded}\n</untrusted-check-evidence>`;
  },
};
