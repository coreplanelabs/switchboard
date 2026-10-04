import type { CheckRetryTarget, GithubWriteResult, PullRequestFacts } from "../../execution/githubPulls.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import {
  UNIT_EFFECT_MAX_CALLS,
  type UnitEffectCall,
  type UnitEffectExecution,
  type UnitEffectRefusal,
  type UnitEffectTransition,
} from "./unitEffect.js";

export interface CheckRecoveryInput {
  instance: CoordinatorInstance;
  unit: CoordinatorUnit;
  execution: UnitEffectExecution;
  effectId: string;
  ordinal: number;
  pr: number;
  headSha: string;
  retry?: string[];
  refire?: boolean;
}
export interface CheckRecoveryDeps {
  instances: Pick<CoordinatorInstanceStore, "transitionUnitEffect" | "get" | "listUnits">;
  readPull(): Promise<PullRequestFacts | undefined>;
  retryTargets(): Promise<CheckRetryTarget[] | undefined>;
  canWrite?(call: UnitEffectCall): boolean;
  write(call: UnitEffectCall): Promise<GithubWriteResult>;
}
export type CheckRecoveryResult =
  { ok: true; dispatched: boolean; effectOrdinal?: number } | { ok: false; reason: UnitEffectRefusal };

/** The unit owns each native call before dispatch. Unknown responses retain the
 * call; an unchanged check run cannot prove whether a rerequest was admitted. */
export async function performCheckRecovery(
  input: CheckRecoveryInput,
  deps: CheckRecoveryDeps,
): Promise<CheckRecoveryResult> {
  let row = input.unit;
  const { execution, effectId, instance } = input;
  const base = instance.base ?? "main";
  const dispatched = () =>
    input.refire === true
      ? row.currentEffect!.calls.every((call) => call.state === "accepted")
      : row.currentEffect!.calls.some((call) => call.state === "accepted");
  const refusal = (reason: UnitEffectRefusal): CheckRecoveryResult => ({ ok: false, reason });
  if (
    execution.workflowId !== (row.recovery?.workflowId ?? instance.id) ||
    execution.recoveryActionId !== row.recovery?.actionId
  )
    return refusal("execution");
  const move = async (change: UnitEffectTransition) => {
    const answer = await deps.instances.transitionUnitEffect(change);
    if (!answer.ok) throw answer.reason;
    row = answer.unit;
  };
  const matchingPull = (facts: PullRequestFacts | undefined, state: "open" | "closed") =>
    facts?.state === state &&
    facts.mergedAt === undefined &&
    facts.sameRepoHead === true &&
    facts.verifiedHead?.repo.toLowerCase() === instance.repo.toLowerCase() &&
    facts.verifiedHead.ref === row.branch &&
    /^[a-f0-9]{40}$/i.test(facts.verifiedHead.sha) &&
    facts.verifiedHead.sha === input.headSha &&
    facts.baseRef === base;
  const readMatchingPull = async (state: "open" | "closed"): Promise<UnitEffectRefusal | undefined> => {
    const facts = await deps.readPull();
    if (!facts) return "unavailable";
    if (
      facts.state !== state ||
      facts.mergedAt !== undefined ||
      facts.sameRepoHead === false ||
      facts.headBranchExists === false ||
      (facts.headRef !== undefined && facts.headRef !== row.branch) ||
      (facts.baseRef !== undefined && facts.baseRef !== base)
    )
      return "conflict";
    const head = facts.verifiedHead;
    if (!head || !/^[a-f0-9]{40}$/i.test(head.sha)) return "unavailable";
    if (
      head.repo.toLowerCase() !== instance.repo.toLowerCase() ||
      head.ref !== row.branch ||
      head.sha !== input.headSha
    )
      return "conflict";
    return matchingPull(facts, state) ? undefined : "unavailable";
  };
  try {
    let cell = row.currentEffect;
    if (cell?.id === effectId) {
      if (
        cell.ordinal !== input.ordinal ||
        cell.execution.workflowId !== execution.workflowId ||
        cell.execution.recoveryActionId !== execution.recoveryActionId ||
        cell.target.repo !== instance.repo ||
        cell.target.ref !== row.branch ||
        cell.target.base !== base ||
        cell.target.pr !== input.pr ||
        cell.target.headSha !== input.headSha ||
        (input.refire === true
          ? cell.calls.length !== 2 ||
            cell.calls[0]?.operation !== "pull_close" ||
            cell.calls[1]?.operation !== "pull_reopen"
          : cell.calls.some((call) => !["actions_rerun", "check_rerequest"].includes(call.operation)))
      )
        return refusal("conflict");
      if (cell.phase === "settled") return { ok: true, dispatched: dispatched(), effectOrdinal: cell.ordinal };
    } else {
      if (cell?.phase === "active") return refusal("busy");
      const targetRefusal = await readMatchingPull("open");
      if (targetRefusal) return refusal(targetRefusal);
      const targets = input.refire === true ? undefined : await deps.retryTargets();
      if (input.refire !== true && targets === undefined) return refusal("unavailable");
      if (input.refire !== true && targets!.length === 0) return { ok: true, dispatched: false };
      const calls: UnitEffectCall[] =
        input.refire === true
          ? [
              { operation: "pull_close", state: "unstarted" },
              { operation: "pull_reopen", state: "unstarted" },
            ]
          : targets!.map((target) => ({ ...target, state: "unstarted" }));
      if (calls.length > UNIT_EFFECT_MAX_CALLS) return refusal("conflict");
      await move({
        kind: "admit",
        expected: row,
        execution,
        effect: {
          version: 1,
          id: effectId,
          ordinal: input.ordinal,
          execution,
          phase: "active",
          target: { repo: instance.repo, ref: row.branch, base, pr: input.pr, headSha: input.headSha },
          calls,
        },
      });
      cell = row.currentEffect!;
    }
    if (cell.calls.some((call) => call.state === "pending" || call.state === "uncertain")) return refusal("uncertain");
    for (let index = 0; index < cell.calls.length; index++) {
      const call = row.currentEffect!.calls[index]!;
      if (call.state !== "unstarted") continue;
      // Reopening is an obligation only after this exact admitted close was
      // positively accepted. A refusal or unknown close never authorizes it.
      if (call.operation === "pull_reopen" && row.currentEffect!.calls[0]?.state !== "accepted") {
        await move({ kind: "cancel", expected: row, execution, effectId, call: index });
        continue;
      }
      const targetRefusal = await readMatchingPull(call.operation === "pull_reopen" ? "closed" : "open");
      if (targetRefusal) return refusal(targetRefusal);
      if (deps.canWrite?.(call) === false) return refusal("unavailable");
      const begun = await deps.instances.transitionUnitEffect({
        kind: "begin",
        expected: row,
        execution,
        effectId,
        call: index,
      });
      if (!begun.ok) {
        if (begun.reason !== "stopped" && begun.reason !== "execution") return refusal(begun.reason);
        const actual = (await deps.instances.listUnits(instance.id)).filter((unit) => unit.unit === row.unit);
        const owner = await deps.instances.get(instance.id);
        if (
          actual.length !== 1 ||
          JSON.stringify(actual[0]) !== JSON.stringify(row) ||
          !owner ||
          owner.id !== instance.id ||
          owner.repo.toLowerCase() !== instance.repo.toLowerCase() ||
          owner.userId !== instance.userId ||
          actual[0]!.currentEffect?.execution.workflowId !== execution.workflowId ||
          actual[0]!.currentEffect?.execution.recoveryActionId !== execution.recoveryActionId ||
          execution.workflowId !== (row.recovery?.workflowId ?? instance.id) ||
          execution.recoveryActionId !== row.recovery?.actionId
        )
          return refusal("stale");
        // An accepted close retains its reopen obligation even if a stop or
        // owner refusal prevents progress; cancellation cannot discharge it.
        if (row.currentEffect!.calls.some((call) => call.operation === "pull_close" && call.state === "accepted"))
          return refusal("uncertain");
        for (let rest = index; rest < cell.calls.length; rest++)
          if (row.currentEffect!.calls[rest]?.state === "unstarted")
            await move({ kind: "cancel", expected: row, execution, effectId, call: rest });
        await move({ kind: "settle", expected: row, execution, effectId });
        return { ok: true, dispatched: dispatched(), effectOrdinal: cell.ordinal };
      }
      row = begun.unit;
      let result: GithubWriteResult = { state: "uncertain" };
      try {
        result = await deps.write(row.currentEffect!.calls[index]!);
      } catch {
        /* Keep unknown native admission. */
      }
      await move({
        kind: "complete",
        expected: row,
        execution,
        effectId,
        call: index,
        outcome: result.state === "refused" ? { state: "refused", cause: "external_refused" } : { state: result.state },
      });
      if (result.state === "uncertain") return refusal("uncertain");
      // A definite reopen refusal still leaves the accepted close's obligation
      // owned. Finishing the report cannot release a PR we knowingly left closed.
      if (call.operation === "pull_reopen" && result.state === "refused") return refusal("uncertain");
    }
    if (
      row.currentEffect!.calls.some(
        (call) =>
          call.operation === "pull_reopen" &&
          call.state === "refused" &&
          row.currentEffect!.calls[0]?.state === "accepted",
      )
    )
      return refusal("uncertain");
    await move({ kind: "settle", expected: row, execution, effectId });
    return { ok: true, dispatched: dispatched(), effectOrdinal: cell.ordinal };
  } catch (error) {
    return refusal(
      typeof error === "string" &&
        ["stale", "stopped", "execution", "busy", "conflict", "owned", "incomplete", "uncertain"].includes(error)
        ? (error as UnitEffectRefusal)
        : "unavailable",
    );
  }
}
