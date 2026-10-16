import { z } from "zod";
import { BASH_TIMEOUT_MAX_MS, BASH_TIMEOUT_MIN_MS } from "../execution/bashTimeout.js";
import { NOTEPAD_MAX_BYTES } from "../core/runLedger/sessionLog.js";
import { utf8ByteLength } from "../core/runRecord.js";
import { redactAndCap, redactSecrets } from "../core/runEvents.js";
import type { CheckExecutionReceipt } from "../core/checkExecutionTypes.js";
import { COMMAND_CAP, STREAM_CAP, RECEIPT_CAP } from "../core/checkExecutionSchema.js";
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
    command: z.string().min(1).max(COMMAND_CAP),
    purpose: z.enum(["baseline", "verification"]),
    checkpoint: checkpointSchema.optional(),
    timeoutMs: z.number().int().min(BASH_TIMEOUT_MIN_MS).max(BASH_TIMEOUT_MAX_MS).optional(),
  })
  .strict();

export const runCheckTool: RunnableTool = {
  name: "run_check",
  description: `Run a task-relevant baseline or verification command in this run's checkout and save its actual process result. This run retains at most ${RECEIPT_CAP} checks and ${STREAM_CAP} characters per output stream. Use read or review_read for source text, not repeated small shell slices. If a request requires shell-based source collection, save the large read-only output once under $TMPDIR and read the saved file. Choose a focused command after reading repository instructions. Purpose describes your intent, not proof of test coverage or pre-edit ordering. This grants no extra authority and installs nothing automatically. An unknown result must not be blindly retried. Optional checkpoint replaces your working notes only after a new recorded verification exits zero. Supply the current goal, decisions, rejected approaches, reported completed work, unproven work and next step; these reports are not certified by the command. Replayed checks never replace notes.`,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      command: {
        type: "string",
        minLength: 1,
        maxLength: COMMAND_CAP,
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
    if (!ctx.checkExecution || !ctx.callId) {
      ctx.reportToolFailure?.({ code: "capability_unavailable", recovery: "correct" });
      return "error: recorded checks are unavailable for this run; command did not start";
    }
    ctx.reportToolFailure?.({ code: "invalid_input", recovery: "correct" });
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
    // Recovery can stop the harness before its native log receives this result.
    // Preserve the original bounded evidence on the run stream first.
    const retainFailure = (text: string): string => {
      try {
        ctx.publish?.({
          type: "run_note",
          kind: "harness_error",
          summary: `run_check ${redactAndCap(ctx.callId ?? "", 200)}: ${text}`.slice(0, 16_000),
        });
      } catch {
        // Observation cannot change the original receipt or recovery hold.
      }
      return text;
    };
    if (response.kind === "unavailable") {
      if (response.reason === "metadata_revalidation_required") {
        ctx.reportToolFailure?.({ code: "capability_unavailable", recovery: "stop" });
        return retainFailure(
          "error: original metadata completed; selected command did not start because checkout freshness is unverified. The saved metadata remains retained.",
        );
      }
      const invalid = ["invalid_input", "command_refused"].includes(response.reason);
      const missing = ["recording_unavailable", "unsupported_executor", "workspace_unavailable", "capacity"].includes(
        response.reason,
      );
      // A batch can cross the receipt budget without starting any of its
      // excess commands. These refusals must not consume recovery attempts.
      const lifecycle = ["budget_exhausted", "stopped", "receipt_limit"].includes(response.reason);
      ctx.reportToolFailure?.({
        code: lifecycle
          ? "lifecycle"
          : invalid
            ? "invalid_input"
            : missing
              ? "capability_unavailable"
              : "outcome_unknown",
        recovery: lifecycle || invalid || missing ? "correct" : "stop",
      });
      if (response.reason === "capacity") return "error: recorded check capacity exhausted; command did not start";
      if (response.reason === "receipt_limit")
        return retainFailure(
          "error: recorded check receipt limit reached; command did not start. Use read or review_read for source and saved output; do not retry this check under another call id.",
        );
      if (response.reason === "recording_unavailable")
        return "error: recording capability unavailable; command did not start";
      const text = `error: recorded check unavailable (${response.reason}); no completion receipt was returned${diagnosticText}${
        response.metadataFailure ? `\nMetadata diagnostic: ${JSON.stringify(response.metadataFailure)}` : ""
      }`;
      return lifecycle || invalid || missing ? text : retainFailure(text);
    }
    const receipt = response.receipt;
    if (receipt.outcome.kind !== "completed")
      ctx.reportToolFailure?.({
        code:
          receipt.outcome.kind === "not_started"
            ? receipt.outcome.reason === "command_refused"
              ? "invalid_input"
              : "lifecycle"
            : "outcome_unknown",
        recovery: receipt.outcome.kind === "not_started" ? "correct" : "stop",
      });
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
    // Redact text leaves before serialization: header patterns must not consume
    // the structural fields that follow them on the JSON line.
    const encoded = JSON.stringify(receipt, (_key, value: unknown) =>
      typeof value === "string" ? redactAndCap(value, 16_000) : value,
    )
      .replaceAll("<", "\\u003c")
      .replaceAll(">", "\\u003e")
      .replaceAll("&", "\\u0026");
    const summary =
      receipt.outcome.kind === "completed"
        ? `Command completed with exit ${receipt.outcome.exitCode}. This records process completion, not proof that tests ran or passed.`
        : receipt.outcome.kind === "not_started"
          ? `Command did not start (${receipt.outcome.reason}). No execution result exists.`
          : "Command outcome is unknown; do not blindly rerun it. Existing workspace recovery must reconcile the operation.";
    const outputNotice =
      receipt.outcome.kind === "completed" && receipt.outcome.truncated
        ? "\nOutput is truncated; this receipt is partial evidence. Use read or review_read for source text. For large read-only shell output, save it once under $TMPDIR and read the saved file. Do not run small shell slices or repeat a check only to recover output."
        : "";
    // A long command or captured stream can fill the retained note. Keep the
    // closed failure facts ahead of that excerpt; the full receipt stays saved.
    const failureState = ["pending", "unknown"].includes(receipt.outcome.kind)
      ? `\nCheck state: ${JSON.stringify({
          callId: redactAndCap(receipt.callId, 200),
          commandHash: receipt.commandHash,
          outcome:
            receipt.outcome.kind === "unknown"
              ? {
                  kind: "unknown",
                  reason: receipt.outcome.reason,
                  infrastructureReason: receipt.outcome.infrastructureReason,
                }
              : { kind: receipt.outcome.kind },
        })}`
      : "";
    const text = `${receipt.outcome.kind === "completed" ? "" : "error: "}${summary}${outputNotice}${diagnosticText}${failureState}${checkpointResult ? `\n${checkpointResult}` : ""}\n<untrusted-check-evidence>\n${encoded}\n</untrusted-check-evidence>`;
    return ["pending", "unknown"].includes(receipt.outcome.kind) ? retainFailure(text) : text;
  },
};
