import { createHash } from "node:crypto";
import { z } from "zod";
import { execDeadline, type Executor, type ExecResult } from "../execution/executor.js";
import { bashBudgetWithinRun, clampBashTimeout } from "../execution/bashTimeout.js";
import { shellQuote } from "../execution/shellQuote.js";
import { FIRST_TEST_PREFLIGHT_MS } from "./budgets.js";
import { redactAndCap } from "./redact.js";
import type {
  CheckExecutionCapability,
  CheckExecutionControl,
  CheckExecutionInput,
  CheckExecutionOwner,
  CheckExecutionReceipt,
  CheckExecutionResponse,
  CheckExecutionState,
} from "./checkExecutionTypes.js";

const STREAM_CAP = 4_000;
const COMMAND_CAP = 2_000;
const RECEIPT_CAP = 32;
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const resultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().int().min(0).max(255),
  truncated: z.boolean(),
});
const storedResultSchema = resultSchema.extend({
  stdout: z.string().max(STREAM_CAP),
  stderr: z.string().max(STREAM_CAP),
});
const ownerSchema = z
  .object({
    runId: z.string().min(1),
    requester: z.string().min(1),
    threadKey: z.string().min(1),
    unit: z.string().min(1).optional(),
    repo: z.string().min(1),
  })
  .strict()
  .refine((owner) => !Object.hasOwn(owner, "unit") || owner.unit !== undefined);
const receiptSchema = z
  .object({
    callId: z.string().min(1).max(200),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    commandHash: z.string().regex(/^[a-f0-9]{64}$/),
    command: z.string().max(COMMAND_CAP),
    purpose: z.enum(["baseline", "verification"]),
    owner: ownerSchema,
    workspace: z.object({ cwd: z.string().min(1).max(4096), head: sha, fingerprint: sha }).strict(),
    timeoutMs: z.number().int().positive(),
    startedAt: z.number().finite(),
    completedAt: z.number().finite().optional(),
    outcome: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("pending") }).strict(),
      z
        .object({ kind: z.literal("not_started"), reason: z.enum(["command_refused", "budget_exhausted", "stopped"]) })
        .strict(),
      storedResultSchema.extend({ kind: z.literal("completed") }).strict(),
      z
        .object({
          kind: z.literal("unknown"),
          reason: z.enum(["interrupted", "transport", "invalid_result"]),
          result: storedResultSchema.optional(),
        })
        .strict(),
    ]),
  })
  .strict();
const stateSchema = z.object({ version: z.literal(1), receipts: z.array(receiptSchema).max(RECEIPT_CAP) }).strict();

export interface CheckExecutionBinding {
  executor: () => Pick<Executor, "execResult">;
  workspace: () => string | undefined;
  /** Initial capability absence is distinct from a later failed durable write. */
  recordingAvailable: boolean;
  owner: CheckExecutionOwner;
  /** The existing harness shell policy, supplied by the runner rather than copied here. */
  authorizeCommand: (command: string, timeoutMs: number) => boolean | Promise<boolean>;
  previous?: unknown;
  save: (state: CheckExecutionState) => Promise<boolean>;
  remainingMs: () => number;
  signal: AbortSignal;
  clock: () => number;
}

/** Fixed metadata only. Git output is a structural observation, never a control instruction. */
function metadataCommand(workspace: string): string {
  const git = "git --no-optional-locks -c core.fsmonitor=false";
  return [
    "set -eu -o pipefail",
    `cd -- ${shellQuote(workspace)}`,
    "check_cwd=$(pwd -P)",
    `check_head=$(${git} rev-parse --verify HEAD)`,
    `check_fingerprint=$({ ${git} diff --no-ext-diff --no-textconv --binary HEAD; ${git} status --porcelain=v1 -z --untracked-files=all; ${git} ls-files --others --exclude-standard -z | while IFS= read -r -d '' file; do ${git} hash-object -- "$file"; done; } | ${git} hash-object --stdin)`,
    'printf "%s\\n%s\\n%s\\n" "$check_cwd" "$check_head" "$check_fingerprint"',
  ].join("\n");
}

function boundedResult(value: unknown): ExecResult | undefined {
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const stdout = redactAndCap(r.stdout, STREAM_CAP);
  const stderr = redactAndCap(r.stderr, STREAM_CAP);
  return {
    stdout: stdout.slice(0, STREAM_CAP),
    stderr: stderr.slice(0, STREAM_CAP),
    exitCode: r.exitCode,
    truncated:
      r.truncated ||
      stdout.length > STREAM_CAP ||
      stderr.length > STREAM_CAP ||
      r.stdout.length > STREAM_CAP ||
      r.stderr.length > STREAM_CAP,
  };
}

/** A thin ledger/executor adapter. This records selected commands; it does not
 * certify their relevance, test collection, side effects or ordering before edits. */
export function createCheckExecution(binding: CheckExecutionBinding): CheckExecutionCapability {
  const parsed = stateSchema.safeParse(binding.previous ?? { version: 1, receipts: [] });
  const parsedOwner = ownerSchema.safeParse(binding.owner);
  const owner = { ...binding.owner };
  const valid =
    parsedOwner.success &&
    parsed.success &&
    parsed.data.receipts.every(
      (receipt) =>
        (["runId", "requester", "threadKey", "repo"] as const).every((key) => receipt.owner[key] === owner[key]) &&
        Object.hasOwn(receipt.owner, "unit") === Object.hasOwn(owner, "unit") &&
        receipt.owner.unit === owner.unit &&
        (receipt.outcome.kind === "pending" || Number.isFinite(receipt.completedAt)) &&
        (receipt.outcome.kind !== "completed" || ![124, 137, 143].includes(receipt.outcome.exitCode)),
    ) &&
    new Set(parsed.data.receipts.map((receipt) => receipt.callId)).size === parsed.data.receipts.length;
  const state: CheckExecutionState =
    valid && parsed.success ? structuredClone(parsed.data) : { version: 1, receipts: [] };
  let persistenceFailed = false;
  let queue: Promise<unknown> = Promise.resolve();
  const unavailable = (
    reason: Extract<CheckExecutionResponse, { kind: "unavailable" }>["reason"],
  ): CheckExecutionResponse => ({ kind: "unavailable", reason });
  const persist = async (): Promise<boolean> => {
    try {
      if (await binding.save(structuredClone(state))) return true;
    } catch {
      /* Never dispatch or credit an unrecorded result. */
    }
    persistenceFailed = true;
    return false;
  };
  const authorized = async (command: string, timeoutMs: number): Promise<boolean> => {
    try {
      return (await binding.authorizeCommand(command, timeoutMs)) === true;
    } catch {
      return false;
    }
  };

  async function run(
    input: CheckExecutionInput,
    callId: string,
    signal: AbortSignal,
    control: CheckExecutionControl,
  ): Promise<CheckExecutionResponse> {
    if (!valid) return unavailable("invalid_state");
    if (persistenceFailed) return unavailable("persistence_failed");
    if (
      !input ||
      typeof input.command !== "string" ||
      !input.command.trim() ||
      input.command.length > COMMAND_CAP ||
      input.command.includes("\0") ||
      !["baseline", "verification"].includes(input.purpose) ||
      (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)) ||
      typeof callId !== "string" ||
      !callId ||
      callId.length > 200
    )
      return unavailable("invalid_input");
    const requestedTimeout = clampBashTimeout(input.timeoutMs);
    const inputHash = hash(JSON.stringify([input.command, input.purpose, input.timeoutMs]));
    const prior = state.receipts.find((receipt) => receipt.callId === callId);
    if (prior)
      return prior.inputHash === inputHash
        ? { kind: "recorded", receipt: structuredClone(prior) }
        : unavailable("call_mismatch");
    const commandHash = hash(input.command);
    // A new tool id is not permission to retry a command whose response was lost.
    // Do not grow a second recovery loop: existing executor recovery owns quiescence.
    if (
      state.receipts.some(
        (receipt) => receipt.commandHash === commandHash && ["pending", "unknown"].includes(receipt.outcome.kind),
      )
    )
      return unavailable("reconciliation_required");
    if (!binding.recordingAvailable) return unavailable("recording_unavailable");
    const workspace = binding.workspace();
    if (!workspace || !workspace.startsWith("/") || workspace.length > 4096 || /[\r\n\0]/.test(workspace))
      return unavailable("workspace_unavailable");
    if (state.receipts.length >= RECEIPT_CAP) return unavailable("receipt_limit");
    if (signal.aborted) return unavailable("stopped");
    const executor = binding.executor();
    if (!executor.execResult) return unavailable("unsupported_executor");
    const budget = () => {
      const remainingMs = Math.min(binding.remainingMs(), control.remainingMs?.() ?? Infinity);
      return bashBudgetWithinRun(requestedTimeout, Number.isFinite(remainingMs) ? remainingMs : 0);
    };
    const firstBudget = budget();
    if (firstBudget.kind === "exhausted") return unavailable("budget_exhausted");
    if (!(await authorized(input.command, firstBudget.kind === "clipped" ? firstBudget.timeoutMs : requestedTimeout)))
      return unavailable("command_refused");
    if (signal.aborted) return unavailable("stopped");
    const metadataBudget = budget();
    if (metadataBudget.kind === "exhausted") return unavailable("budget_exhausted");
    const metadataTimeout = Math.min(
      FIRST_TEST_PREFLIGHT_MS,
      metadataBudget.kind === "clipped" ? metadataBudget.timeoutMs : requestedTimeout,
    );
    let observed: ExecResult | undefined;
    try {
      observed = boundedResult(
        await executor.execResult(metadataCommand(workspace), {
          timeoutMs: metadataTimeout,
          signal: execDeadline(metadataTimeout, signal),
        }),
      );
    } catch {
      return unavailable("metadata_unavailable");
    }
    if (!observed || observed.exitCode !== 0 || observed.truncated) return unavailable("metadata_unavailable");
    const fields = observed.stdout.split("\n");
    if (
      fields.length !== 4 ||
      fields[3] !== "" ||
      !fields[0]?.startsWith("/") ||
      !sha.safeParse(fields[1]).success ||
      !sha.safeParse(fields[2]).success
    )
      return unavailable("metadata_unavailable");
    if (signal.aborted) return unavailable("stopped");
    const nextBudget = budget();
    if (nextBudget.kind === "exhausted") return unavailable("budget_exhausted");
    const timeoutMs = nextBudget.kind === "clipped" ? nextBudget.timeoutMs : requestedTimeout;
    const receipt: CheckExecutionReceipt = {
      callId,
      inputHash,
      commandHash,
      command: redactAndCap(input.command, COMMAND_CAP).slice(0, COMMAND_CAP),
      purpose: input.purpose,
      owner: { ...owner },
      workspace: { cwd: fields[0]!, head: fields[1]!, fingerprint: fields[2]! },
      timeoutMs,
      startedAt: binding.clock(),
      outcome: { kind: "pending" },
    };
    state.receipts.push(receipt);
    if (!(await persist())) return unavailable("persistence_failed");
    const dispatchAllowed = await authorized(input.command, timeoutMs);
    const dispatchBudget = budget();
    // A known pre-dispatch refusal is different from a command whose response
    // was lost. Recording that difference avoids an unnecessary recovery hold.
    if (signal.aborted || dispatchBudget.kind === "exhausted") {
      receipt.outcome = { kind: "not_started", reason: signal.aborted ? "stopped" : "budget_exhausted" };
    } else if (!dispatchAllowed) {
      receipt.outcome = { kind: "not_started", reason: "command_refused" };
    } else {
      receipt.timeoutMs = Math.min(
        timeoutMs,
        dispatchBudget.kind === "clipped" ? dispatchBudget.timeoutMs : requestedTimeout,
      );
      const commandSignal = execDeadline(receipt.timeoutMs, signal);
      try {
        const result = boundedResult(
          await executor.execResult(
            `cd -- ${shellQuote(receipt.workspace.cwd)} && bash -c ${shellQuote(input.command)}`,
            { timeoutMs: receipt.timeoutMs, signal: commandSignal },
          ),
        );
        receipt.outcome = !result
          ? { kind: "unknown", reason: "invalid_result" }
          : commandSignal.aborted || [124, 137, 143].includes(result.exitCode)
            ? { kind: "unknown", reason: "interrupted", result }
            : { kind: "completed", ...result };
      } catch {
        receipt.outcome = { kind: "unknown", reason: commandSignal.aborted ? "interrupted" : "transport" };
      }
    }
    receipt.completedAt = binding.clock();
    if (!(await persist())) return unavailable("persistence_failed");
    return { kind: "recorded", receipt: structuredClone(receipt) };
  }

  return {
    run(input, callId, control = {}) {
      const signal = control.signal ? AbortSignal.any([binding.signal, control.signal]) : binding.signal;
      const selected = { ...input };
      const pending = queue.then(() => run(selected, callId, signal, control));
      queue = pending.catch(() => undefined);
      return pending;
    },
  };
}
