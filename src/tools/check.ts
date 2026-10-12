import { z } from "zod";
import { BASH_TIMEOUT_MAX_MS, BASH_TIMEOUT_MIN_MS } from "../execution/bashTimeout.js";
import { NOTEPAD_MAX_BYTES } from "../core/runLedger/sessionLog.js";
import { utf8ByteLength } from "../core/runRecord.js";
import { redactSecrets } from "../core/runEvents.js";
import type { CheckExecutionReceipt } from "../core/checkExecutionTypes.js";
import type { RunnableTool } from "./runnableTool.js";
import { typedExecutionDiagnosticFrom, type TypedExecutionDiagnostic } from "../execution/typedExecutionDiagnostic.js";

const checkpointSchema = z
  .object({
    phase: z.string().trim().min(1).max(100),
    goal: z.string().trim().min(1),
    decisions: z.array(z.string().trim().min(1)).max(16),
    rejected: z.array(z.string().trim().min(1)).max(16),
    completed: z.array(z.string().trim().min(1)).max(16),
    unproven: z.array(z.string().trim().min(1)).max(16),
    next: z.string().trim().min(1),
  })
  .strict();

function phaseNotes(checkpoint: z.infer<typeof checkpointSchema>): string {
  const section = (title: string, items: string[]) =>
    `## ${title}\n${items.length ? items.map((item) => `- ${item.replace(/\r?\n/g, "\n  ")}`).join("\n") : "- None reported"}`;
  return [
    section("Phase", [checkpoint.phase]),
    section("Goal", [checkpoint.goal]),
    section("Decisions (reported)", checkpoint.decisions),
    section("Rejected approaches (reported)", checkpoint.rejected),
    section("Completed work (reported, not certified by this check)", checkpoint.completed),
    section("Unproven", checkpoint.unproven),
    section("Next", [checkpoint.next]),
  ].join("\n\n");
}

function verificationNotes(receipt: CheckExecutionReceipt): string {
  return [
    "## Recorded verification",
    "- Recorded process completed with exit 0; this does not certify the reported work or test coverage.",
    `- Check call: ${receipt.callId}`,
    `- HEAD: ${receipt.workspace.head}`,
    `- Working-tree fingerprint: ${receipt.workspace.fingerprint}`,
    `- Command hash: ${receipt.commandHash}`,
    "- Checkout observed before the command; the tree may have changed during or after execution. Recall the check result for its command, owner and output.",
  ].join("\n");
}

const inputSchema = z
  .object({
    command: z.string().min(1).max(2_000),
    purpose: z.enum(["baseline", "verification"]),
    checkpoint: checkpointSchema.optional(),
    timeoutMs: z.number().int().min(BASH_TIMEOUT_MIN_MS).max(BASH_TIMEOUT_MAX_MS).optional(),
  })
  .strict();

export const runCheckTool: RunnableTool = {
  name: "run_check",
  description:
    "Run a task-relevant baseline or verification command in this run's checkout and save its actual process result. Choose a focused command after reading repository instructions. Purpose describes your intent, not proof of test coverage or pre-edit ordering. This grants no extra authority and installs nothing automatically. An unknown result must not be blindly retried. Optional checkpoint replaces your working notes only after a new recorded verification exits zero. Supply the current goal, decisions, rejected approaches, reported completed work, unproven work and next step; these reports are not certified by the command. Replayed checks never replace notes.",
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
      checkpoint: {
        type: "object",
        additionalProperties: false,
        description:
          "Replace your own working notes at this phase boundary after recorded verification. All fields are required; use empty arrays when none apply.",
        properties: {
          phase: { type: "string", minLength: 1, maxLength: 100 },
          goal: { type: "string", minLength: 1 },
          decisions: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 16 },
          rejected: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 16 },
          completed: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 16 },
          unproven: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 16 },
          next: { type: "string", minLength: 1 },
        },
        required: ["phase", "goal", "decisions", "rejected", "completed", "unproven", "next"],
      },
      timeoutMs: { type: "integer", minimum: BASH_TIMEOUT_MIN_MS, maximum: BASH_TIMEOUT_MAX_MS },
    },
    required: ["command", "purpose"],
    anyOf: [
      { type: "object", properties: { purpose: { type: "string", enum: ["verification"] } } },
      {
        type: "object",
        additionalProperties: false,
        // The root validates these fields; this branch excludes a baseline checkpoint.
        properties: { command: {}, purpose: { type: "string", enum: ["baseline"] }, timeoutMs: {} },
      },
    ],
  },
  failsInText: true,
  async run(input, ctx) {
    if (!ctx.checkExecution || !ctx.callId)
      return "error: recorded checks are unavailable for this run; command did not start";
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success)
      return "error: invalid check input; provide command, purpose, optional timeoutMs and optional complete checkpoint";
    const { checkpoint, ...executionInput } = parsed.data;
    const workingNotes = checkpoint ? phaseNotes(checkpoint) : undefined;
    if (checkpoint && parsed.data.purpose !== "verification")
      return "error: checkpoint requires verification; command did not start";
    if (checkpoint && !ctx.session) return "error: phase notes are unavailable; command did not start";
    // Reserve room for the fixed receipt fields before any process can start.
    if (workingNotes && utf8ByteLength(workingNotes) > NOTEPAD_MAX_BYTES - 1_500)
      return "error: phase notes exceed the notepad budget including verification evidence; shorten them. Command did not start";
    const response = await ctx.checkExecution.run(executionInput, ctx.callId, {
      signal: ctx.signal,
      remainingMs: ctx.remainingMs,
    });
    let diagnostic: TypedExecutionDiagnostic | undefined;
    try {
      const observed = typedExecutionDiagnosticFrom(
        Object.getOwnPropertyDescriptor(response, "executionDiagnostic")?.value,
      );
      if (
        observed?.caller === "check" &&
        ((observed.operation === "metadata" &&
          response.kind === "unavailable" &&
          response.reason === "metadata_unavailable" &&
          response.metadataFailure?.phase === "execute" &&
          response.metadataFailure.kind === "thrown") ||
          (observed.operation === "command" &&
            response.kind === "recorded" &&
            response.receipt.outcome.kind === "unknown" &&
            ["transport", "interrupted"].includes(response.receipt.outcome.reason)))
      )
        diagnostic = observed;
    } catch {
      /* Optional observation cannot change the original tool result. */
    }
    const diagnosticText = diagnostic ? `\nExecution diagnostic: ${JSON.stringify(diagnostic)}` : "";
    if (response.kind === "unavailable" && response.reason === "recording_unavailable")
      return "error: recording capability unavailable; command did not start";
    if (response.kind === "unavailable")
      return `error: recorded check unavailable (${response.reason}); no completion receipt was returned${diagnosticText}${
        response.metadataFailure ? `\nMetadata diagnostic: ${JSON.stringify(response.metadataFailure)}` : ""
      }`;
    const receipt = response.receipt;
    let checkpointResult = "";
    if (workingNotes) {
      if (response.replayed)
        checkpointResult = "replayed check; phase notes not saved; existing notes remain unchanged";
      else if (
        receipt.purpose !== "verification" ||
        receipt.outcome.kind !== "completed" ||
        receipt.outcome.exitCode !== 0
      )
        checkpointResult = "phase notes not saved: verification did not complete with exit 0";
      else if (ctx.signal?.aborted) checkpointResult = "phase notes not saved: this tool session stopped";
      else {
        const text = `${workingNotes}\n\n${verificationNotes(receipt)}`;
        try {
          const written = await ctx.session!.writeNotepad(text);
          if (written.ok) {
            checkpointResult = "phase notes saved; they reach the next run and compaction recovery";
            try {
              ctx.publish?.({ type: "notes", text: redactSecrets(text) });
            } catch {
              // A timeline observation cannot undo an acknowledged notes write.
            }
          } else checkpointResult = `phase notes not saved (${written.reason}); the recorded command is not retried`;
        } catch {
          checkpointResult =
            "phase notes persistence is unknown; the recorded command is not retried. Reconcile the notes before refreshing them";
        }
      }
    }
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
    return `${receipt.outcome.kind === "completed" ? "" : "error: "}${summary}${diagnosticText}${checkpointResult ? `\n${checkpointResult}` : ""}\n<untrusted-check-evidence>\n${encoded}\n</untrusted-check-evidence>`;
  },
};
