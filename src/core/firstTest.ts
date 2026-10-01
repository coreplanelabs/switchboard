import type { FirstTestCheckout, FirstTestOwner, FirstTestReceipt, RefusalCode } from "./firstTestReceipt.js";
export type { FirstTestReceipt } from "./firstTestReceipt.js";
import { createHash, randomUUID } from "node:crypto";
import { execDeadline, type Executor, type ExecResult } from "../execution/executor.js";
import { readyEnvironmentCommand, type ReadyEnvironmentRequirement } from "../execution/seedPlan.js";
import { shellQuote } from "../execution/shellQuote.js";
import { redactAndCap } from "./redact.js";
import { FIRST_TEST_PREFLIGHT_MS, SECOND_MS } from "./budgets.js";

export interface FirstTestInput {
  executor: Pick<Executor, "execResult">;
  owner: FirstTestOwner;
  checkout: FirstTestCheckout;
  /** True only for this attachment's fresh backend restore, never a cached marker or saved binding. */
  seedRestored?: boolean;
  requirement: ReadyEnvironmentRequirement;
  previous?: unknown;
  remainingMs: () => number;
  signal: AbortSignal;
  clock: () => number;
  save: (receipt: FirstTestReceipt) => Promise<boolean>;
}
export class FirstTestHeld extends Error {
  constructor(readonly code: RefusalCode | "persistence_failed" | "reconciliation_required") {
    super(
      code === "seed_identity_unverifiable"
        ? "The seeded workspace's current dependency archive cannot be verified. The original run stays held. Automatic seeded receipt reuse is unavailable; an operator must stop this held run and authorize a fresh attempt after verifying the environment."
        : code === "reconciliation_required"
          ? "The first test has an unknown outcome. This run is held on its original workspace; an operator must reconcile the recorded operation before coding can continue. Automatic operation lookup is unavailable."
          : `The first test is held (${code}). This run retains its original workspace and receipt; an operator must resolve the recorded refusal before coding can continue.`,
    );
    this.name = "FirstTestHeld";
  }
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const STREAM_CAP = 8_000;
function resultOf(value: unknown): ExecResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Partial<ExecResult>;
  if (
    typeof r.stdout !== "string" ||
    typeof r.stderr !== "string" ||
    !Number.isInteger(r.exitCode) ||
    r.exitCode! < 0 ||
    r.exitCode! > 255 ||
    typeof r.truncated !== "boolean"
  )
    return undefined;
  return {
    stdout: redactAndCap(r.stdout, STREAM_CAP),
    stderr: redactAndCap(r.stderr, STREAM_CAP),
    exitCode: r.exitCode!,
    truncated: r.truncated || r.stdout.length > STREAM_CAP || r.stderr.length > STREAM_CAP,
  };
}
function sameFields(a: unknown, b: Record<string, string>): boolean {
  return (
    !!a &&
    typeof a === "object" &&
    Object.entries(b).every(([key, value]) => (a as Record<string, unknown>)[key] === value)
  );
}

/** Fixed exit codes describe preconditions; no rendered command output is a control signal.
 * The bounded Git object hash binds patches and lockfiles without storing their contents. */
function preflight(input: FirstTestInput): string {
  const { checkout: c, requirement: r } = input;
  return [
    "set -eu -o pipefail",
    `cd ${shellQuote(c.workspace)} || exit 13`,
    `test "$(pwd -P)" = ${shellQuote(c.workspace)} || exit 13`,
    `test "$(cat /proc/sys/kernel/random/boot_id)" = ${shellQuote(c.container)} || exit 13`,
    ...[...new Set(["git", "bash", ...r.requiredTools])].map(
      (tool) => `command -v ${shellQuote(tool)} >/dev/null 2>&1 || exit 12`,
    ),
    `test "$(git rev-parse HEAD)" = ${shellQuote(c.head)} || exit 13`,
    `test "$(git symbolic-ref --short HEAD)" = ${shellQuote(c.ref)} || exit 13`,
    `test -d ${shellQuote(r.dependencyDir)} || exit 11`,
    `{ git diff --no-ext-diff --no-textconv --binary HEAD; git status --porcelain=v1 -z --untracked-files=all; git ls-files --others --exclude-standard -z | while IFS= read -r -d '' file; do git hash-object -- "$file"; done; } | git hash-object --stdin`,
  ].join("\n");
}

/** A durable unknown intent precedes execution. A lost response never causes replay.
 * This version has no backend operation lookup: unknown receipts remain explicitly held. */
export async function ensureFirstTest(input: FirstTestInput): Promise<FirstTestReceipt> {
  const { requirement, checkout, owner, previous, executor } = input;
  readyEnvironmentCommand(checkout.workspace, requirement);
  const action = requirement.firstAction;
  const command = requirement.testCommand;
  if (!action || typeof command !== "string") throw new FirstTestHeld("binding_mismatch");
  const requirementHash = hash(
    JSON.stringify([
      command,
      requirement.dependencyDir,
      [...requirement.requiredTools].sort(),
      action.kind,
      action.policyVersion,
      action.timeoutMs,
    ]),
  );
  const commandHash = hash(command);
  let receipt: FirstTestReceipt = {
    version: 1,
    operationId: randomUUID(),
    owner: { ...owner },
    checkout: { ...checkout },
    policyVersion: action.policyVersion,
    requirementHash,
    commandHash,
    workspaceHash: "",
    startedAt: input.clock(),
    outcome: { kind: "unknown", code: "execution_pending" },
  };
  let priorCompleted = false;
  const persist = async () => {
    if (!(await input.save(structuredClone(receipt)).catch(() => false))) throw new FirstTestHeld("persistence_failed");
  };
  const refuse = async (code: RefusalCode): Promise<never> => {
    // Never replace a prior operation's evidence with a refusal from another binding.
    if (!priorCompleted) {
      const attempt = { at: input.clock(), code };
      receipt.refusedAttempts = {
        count: (receipt.refusedAttempts?.count ?? 0) + 1,
        first: receipt.refusedAttempts?.first ?? attempt,
        last: attempt,
      };
      receipt.outcome = { kind: "refused", code };
      await persist();
    }
    throw new FirstTestHeld(code);
  };
  if (previous !== undefined) {
    const p = previous as Partial<FirstTestReceipt> | null;
    if (
      !p ||
      p.version !== 1 ||
      typeof p.operationId !== "string" ||
      !p.operationId ||
      !sameFields(p.owner, { ...owner }) ||
      !sameFields(p.checkout, { ...checkout }) ||
      p.requirementHash !== requirementHash ||
      p.commandHash !== commandHash ||
      p.policyVersion !== action.policyVersion ||
      typeof p.workspaceHash !== "string" ||
      !Number.isFinite(p.startedAt) ||
      !p.outcome
    )
      throw new FirstTestHeld("binding_mismatch");
    if (p.outcome.kind === "unknown") throw new FirstTestHeld("reconciliation_required");
    if (p.outcome.kind === "completed") {
      if (
        !p.workspaceHash ||
        !resultOf(p.outcome) ||
        [124, 137, 143, 200].includes(p.outcome.exitCode) ||
        !Number.isFinite(p.completedAt)
      )
        throw new FirstTestHeld("binding_mismatch");
      priorCompleted = true;
    } else if (
      p.outcome.kind !== "refused" ||
      ![
        "seed_identity_unverifiable",
        "unsupported_backend",
        "binding_mismatch",
        "dependencies_missing",
        "tool_missing",
        "preflight_failed",
        "budget_exhausted",
      ].includes(p.outcome.code)
    ) {
      throw new FirstTestHeld("binding_mismatch");
    }
    // Saved archive metadata and a workspace marker cannot attest current dependency state.
    // A future typed backend identity read can enable this without trusting model-writable files.
    if (checkout.backend === "sandbox") throw new FirstTestHeld("seed_identity_unverifiable");
    receipt = structuredClone(p) as FirstTestReceipt;
  }
  if (checkout.backend === "sandbox" && input.seedRestored !== true) return refuse("seed_identity_unverifiable");
  if (!executor.execResult) return refuse("unsupported_backend");
  if (
    !["resident", "sandbox"].includes(checkout.backend) ||
    !checkout.container ||
    !checkout.workspace ||
    !checkout.head ||
    !checkout.ref ||
    !checkout.repo ||
    !checkout.dependencyKey
  )
    return refuse("binding_mismatch");
  if (input.signal.aborted || input.remainingMs() < FIRST_TEST_PREFLIGHT_MS + (priorCompleted ? 0 : action.timeoutMs))
    return refuse("budget_exhausted");
  const signal = execDeadline(input.remainingMs(), input.signal);
  let probe: ExecResult | undefined;
  try {
    probe = resultOf(await executor.execResult(preflight(input), { timeoutMs: FIRST_TEST_PREFLIGHT_MS, signal }));
  } catch {
    return refuse("preflight_failed");
  }
  if (!probe || probe.truncated) return refuse("preflight_failed");
  if (probe.exitCode !== 0)
    return refuse(
      probe.exitCode === 11
        ? "dependencies_missing"
        : probe.exitCode === 12
          ? "tool_missing"
          : probe.exitCode === 13
            ? "binding_mismatch"
            : "preflight_failed",
    );
  if (!probe.stdout) return refuse("preflight_failed");
  const workspaceHash = hash(probe.stdout);
  if (priorCompleted) {
    if (receipt.workspaceHash !== workspaceHash) throw new FirstTestHeld("binding_mismatch");
    return receipt;
  }
  receipt.workspaceHash = workspaceHash;
  receipt.outcome = { kind: "unknown", code: "execution_pending" };
  await persist();
  const timeoutMs = Math.min(action.timeoutMs, input.remainingMs());
  if (input.signal.aborted || timeoutMs < SECOND_MS) return refuse("budget_exhausted");
  let result: ExecResult | undefined;
  try {
    result = resultOf(
      await executor.execResult(
        [
          // Recheck in the SAME command invocation: a backend may reattach between calls.
          `first_test_workspace=$(bash -c ${shellQuote(preflight(input))}) || exit 200`,
          `test "$first_test_workspace" = ${shellQuote(probe.stdout.trim())} || exit 200`,
          `cd ${shellQuote(checkout.workspace)} && bash -c ${shellQuote(command)}`,
        ].join("\n"),
        { timeoutMs, signal },
      ),
    );
  } catch {
    /* The pending intent remains the truth until an authoritative outcome exists. */
  }
  // 200 is the in-command guard's reserved exit: either the checkout moved or
  // the command itself used that code. Neither is sufficient completion evidence.
  if (!result || signal.aborted || [124, 137, 143, 200].includes(result.exitCode)) {
    receipt.outcome = { kind: "unknown", code: "completion_unknown", ...(result ? { result } : {}) };
    await persist();
    throw new FirstTestHeld("reconciliation_required");
  }
  receipt.outcome = { kind: "completed", ...result };
  receipt.completedAt = input.clock();
  await persist();
  return receipt;
}

/** Only receipt facts are instructions; command streams remain untrusted tool evidence. */
export function firstTestContext(receipt: FirstTestReceipt): string {
  return `Switchboard completed the required first baseline command before coding. Operation ${receipt.operationId}; repository ${receipt.checkout.repo}; ref ${receipt.checkout.ref}; head ${receipt.checkout.head}; policy ${receipt.policyVersion}. The receipt records command completion, not proof that test assertions ran.\n<untrusted-first-test-result>\n${JSON.stringify(receipt.outcome).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026")}\n</untrusted-first-test-result>`;
}
