import type { SweepOrigin } from "../commands/pulls.js";
import { MINUTE_MS, PULL_SWEEP } from "../budgets.js";
import {
  createPullSweepService,
  type PullSweepDeps,
  type PullSweepService,
  type SweepEffectJournal,
  type SweepNativePlan,
  type SweepPullRequest,
  type SweepResult,
} from "../pullSweep.js";
import type { SweepDispatchRequest } from "../pullSweepWiring.js";
import { createSweepEffectJournal } from "./sweepEffectJournal.js";
import {
  maintenanceAdmissionMatches,
  prepareMaintenanceAdmission,
  releaseMaintenanceReservation,
  type MaintenanceAdmissionResult,
} from "./maintenanceAdmission.js";
import {
  isCoordinatorInstance,
  isCoordinatorUnit,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";
import { unitEffectResultMatches, type UnitEffectCompletionOutcome, type UnitEffectTransition } from "./unitEffect.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import type { RunLedger } from "../runLedger/ledger.js";
type Admitted = Extract<MaintenanceAdmissionResult, { ok: true }>;
export interface MaintenanceSweepDeps {
  instances: CoordinatorInstanceStore;
  ledger: Pick<RunLedger, "appendSession" | "readSessionEntry">;
  now(): number;
  canWrite(origin: SweepOrigin, pr: SweepPullRequest): Promise<boolean>;
  readHead(pr: SweepPullRequest): Promise<{ repo: string; ref: string; base: string; sha: string } | undefined>;
  dispatch(
    owner: { instance: CoordinatorInstance; unit: CoordinatorUnit },
    request: SweepDispatchRequest,
    agent: "coding" | "review",
  ): Promise<UnitEffectCompletionOutcome>;
  build(origin: SweepOrigin): PullSweepDeps;
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
/** Only the accepted call on this exact cell may advance its publication fence. */
export async function publishSweepHead(
  admitted: Admitted,
  deps: Pick<MaintenanceSweepDeps, "instances" | "readHead">,
  pr: SweepPullRequest,
): Promise<boolean> {
  const rows = (await deps.instances.listUnits(admitted.instance.id)).filter((r) => r.unit === admitted.unit.unit);
  const row = rows.length === 1 && isCoordinatorUnit(rows[0]) ? rows[0] : undefined;
  const cell = row?.currentEffect;
  if (
    !row ||
    !cell ||
    cell.id !== admitted.effectId ||
    cell.ordinal !== admitted.ordinal ||
    !same(cell.execution, admitted.execution) ||
    !same(cell.target, admitted.unit.currentEffect?.target)
  )
    return false;
  const push = cell.calls.find((c) => c.operation === "rebase_push");
  if (!push || push.state !== "accepted" || !push.commitSha) return true;
  if (row.publication?.expectedHeadSha.toLowerCase() === push.commitSha.toLowerCase()) return true;
  const native = await deps.readHead(pr);
  if (
    !native ||
    native.repo.toLowerCase() !== pr.repo.toLowerCase() ||
    native.ref !== pr.branch ||
    native.base !== pr.base ||
    native.sha.toLowerCase() !== push.commitSha.toLowerCase()
  )
    return false;
  if (row.publication?.expectedHeadSha.toLowerCase() === native.sha.toLowerCase()) return true;
  const change: UnitEffectTransition = {
    kind: "publish",
    expected: row,
    execution: admitted.execution,
    effectId: admitted.effectId,
  };
  let answer;
  try {
    answer = await deps.instances.transitionUnitEffect(change);
  } catch {
    /* Read only the same durable transition after a lost ACK. */
  }
  if (answer?.ok && unitEffectResultMatches(change, answer.unit)) return true;
  const actual = (await deps.instances.listUnits(admitted.instance.id)).filter((r) => r.unit === row.unit);
  return actual.length === 1 && unitEffectResultMatches(change, actual[0]);
}
/** A known refusal can finish its obligation; uncertain calls stay owned. */
async function settleKnownMaintenance(
  admitted: Admitted,
  deps: MaintenanceSweepDeps,
  pr: SweepPullRequest,
): Promise<void> {
  const read = async () => {
    const rows = (await deps.instances.listUnits(admitted.instance.id)).filter(
      (row) => row.unit === admitted.unit.unit,
    );
    if (rows.length !== 1 || !isCoordinatorUnit(rows[0])) return undefined;
    const row = rows[0],
      cell = row.currentEffect;
    return cell?.id === admitted.effectId &&
      cell.ordinal === admitted.ordinal &&
      same(cell.execution, admitted.execution) &&
      same(cell.target, admitted.unit.currentEffect?.target)
      ? row
      : undefined;
  };
  let row = await read();
  if (
    !row ||
    row.currentEffect!.phase === "settled" ||
    row.currentEffect!.calls.some((call) => call.state === "pending" || call.state === "uncertain")
  )
    return;
  // Settlement records completed calls, not the current remote tip. A later
  // writer cannot make known outcomes uncertain or keep this action active.
  // Advance the binding only when the exact accepted head is still proven.
  await publishSweepHead(admitted, deps, pr);
  row = await read();
  if (!row) return;
  for (let index = 0; index < row.currentEffect!.calls.length; index++) {
    if (row.currentEffect!.calls[index]!.state !== "unstarted") continue;
    const change: UnitEffectTransition = {
      kind: "cancel",
      expected: row,
      execution: admitted.execution,
      effectId: admitted.effectId,
      call: index,
    };
    let answer;
    try {
      answer = await deps.instances.transitionUnitEffect(change);
    } catch {
      /* Confirm only this same durable cancellation. */
    }
    const actual = answer?.ok ? answer.unit : await read();
    if (!actual || !unitEffectResultMatches(change, actual)) return;
    row = actual;
  }
  const change: UnitEffectTransition = {
    kind: "settle",
    expected: row,
    execution: admitted.execution,
    effectId: admitted.effectId,
  };
  // A lost settlement ACK retains its typed call outcomes; it never grants a
  // second native mutation. A retry can read the same canonical settled row.
  await deps.instances.transitionUnitEffect(change).catch(() => undefined);
}
/** Each actual source reserves each PR separately. The built dependencies carry
 * the shared repository throughput queue into each per-PR sweep. */
export function createMaintenanceSweepService(origin: SweepOrigin, deps: MaintenanceSweepDeps): PullSweepService {
  return {
    async sweep(target) {
      const base = deps.build(origin);
      const prs = (await base.listOwnedPullRequests(target.repo)).filter(
        (pr) => target.number === undefined || pr.number === target.number,
      );
      if (!prs.length) return createPullSweepService(base).sweep(target);
      const results: SweepResult[] = [];
      for (const pr of prs) {
        const error = (reason: string): SweepResult => ({
          repo: pr.repo,
          number: pr.number,
          outcome: "error",
          line: `#${pr.number} not swept — ${reason}`,
        });
        let admitted: Admitted | undefined;
        try {
          if (!origin.intent || !(await deps.canWrite(origin, pr))) {
            results.push(error("maintenance authority unavailable"));
            continue;
          }
          const input = {
            version: 1 as const,
            intent: origin.intent,
            target: { repo: pr.repo, pr: pr.number, ref: pr.branch, base: pr.base, headSha: pr.headSha },
            createdAt: deps.now(),
            bounds: { ...PULL_SWEEP },
            ...(origin.intent.kind === "watch"
              ? { owner: { instanceId: origin.intent.instanceId, unit: origin.intent.unit } }
              : {}),
          };
          const prepared = await prepareMaintenanceAdmission(input);
          const result = await deps.instances.admitMaintenance(input);
          if (!result.ok || !maintenanceAdmissionMatches(prepared, result)) {
            results.push(error(result.ok ? "original maintenance receipt changed" : `maintenance ${result.reason}`));
            continue;
          }
          admitted = result;
          const current = async () => {
            const instance = await deps.instances.get(result.instance.id);
            const rows = (await deps.instances.listUnits(result.instance.id)).filter(
              (r) => r.unit === result.unit.unit,
            );
            if (
              !instance ||
              !isCoordinatorInstance(instance) ||
              !same({ ...instance, stop: undefined }, { ...result.instance, stop: undefined }) ||
              rows.length !== 1 ||
              !isCoordinatorUnit(rows[0]) ||
              rows[0].currentEffect?.id !== result.effectId ||
              rows[0].currentEffect.ordinal !== result.ordinal ||
              !same(rows[0].currentEffect.execution, result.execution) ||
              !same(rows[0].currentEffect.target, result.unit.currentEffect?.target)
            )
              throw new Error("maintenance ownership changed");
            return { instance, unit: rows[0] };
          };
          const journal = createSweepEffectJournal(result, deps);
          const effect: SweepEffectJournal = {
            ...journal,
            async begin(plan, index) {
              if (
                deps.now() >=
                  result.execution.maintenance!.admittedAt +
                    result.execution.maintenance!.bounds.leaseMinutes * MINUTE_MS ||
                !(await deps.canWrite(origin, pr))
              )
                return false;
              if (!(await publishSweepHead(result, deps, pr))) return false;
              const expected = plan.calls.slice(0, index).some((c) => c.operation === "rebase_push")
                ? plan.newHead
                : plan.pr.headSha;
              const native = await deps.readHead(pr);
              if (
                !native ||
                native.repo.toLowerCase() !== pr.repo.toLowerCase() ||
                native.ref !== pr.branch ||
                native.base !== pr.base ||
                native.sha.toLowerCase() !== expected.toLowerCase()
              )
                return false;
              return journal.begin(plan, index);
            },
            async settle(plan) {
              return (await publishSweepHead(result, deps, pr)) && (await journal.settle(plan));
            },
          };
          const dispatch = async (request: SweepDispatchRequest, agent: "coding" | "review") => {
            const owner = await current();
            if (owner.instance.stop || owner.unit.recoveryHold)
              return { state: "refused" as const, cause: "external_refused" as const };
            return deps.dispatch(owner, request, agent);
          };
          const wiring = deps.build(origin);
          const effects = {
            ...wiring.effects,
            ...(wiring.effects.prepareNativeCalls
              ? {
                  async prepareNativeCalls(
                    ...args: Parameters<NonNullable<PullSweepDeps["effects"]["prepareNativeCalls"]>>
                  ) {
                    const calls = await wiring.effects.prepareNativeCalls!(...args);
                    const { instance, unit } = await current();
                    return calls.map((call) =>
                      call.operation !== "spawn"
                        ? call
                        : {
                            ...call,
                            request: {
                              ...call.request,
                              channelId: instance.channelId,
                              userId: instance.userId,
                              threadKey:
                                (call.agent === "coding" ? undefined : unit.reviewThread?.threadKey) ??
                                unit.threadKey ??
                                instance.threadKey,
                            },
                          },
                    );
                  },
                }
              : {}),
            async performNativeCall(plan: SweepNativePlan, index: number) {
              const call = plan.calls[index];
              return call?.operation === "spawn"
                ? dispatch(call.request, call.agent ?? "review")
                : wiring.effects.performNativeCall!(plan, index);
            },
            async modelRoundSpent() {
              return (await current()).unit.rounds.some((round) => round.maintenance !== undefined);
            },
            async startModelRound(_pr: SweepPullRequest, bounds: { leaseMinutes: number; spendCapUsd: number }) {
              if (!same(bounds, result.execution.maintenance?.bounds))
                return { started: false as const, reason: "original maintenance budget changed" };
              const { instance, unit: row } = await current();
              const request = {
                channelId: instance.channelId,
                userId: instance.userId,
                threadKey: row.threadKey ?? instance.threadKey,
                text: `Resolve the conflicts in https://github.com/${pr.repo}/pull/${pr.number} against ${pr.base}. Keep the existing pull request and branch.`,
              };
              const plan: SweepNativePlan = {
                pr: { ...pr },
                newHead: pr.headSha,
                decision: "fix-round",
                calls: [{ operation: "spawn", agent: "coding", state: "unstarted", request }],
              };
              if (!(await effect.admit(plan)) || !(await effect.begin(plan, 0)))
                return { started: false as const, reason: "original model admission unconfirmed" };
              let native: UnitEffectCompletionOutcome;
              try {
                native = await dispatch(request, "coding");
              } catch {
                native = { state: "uncertain" };
              }
              if (
                !(await effect.complete(plan, 0, native)) ||
                native.state !== "accepted" ||
                !native.runId ||
                !(await effect.settle(plan))
              )
                return { started: false as const, reason: "original model result unconfirmed" };
              return { started: true as const, runId: native.runId };
            },
          };
          const report = await createPullSweepService({
            ...wiring,
            effects,
            effect,
            runnerOwns: undefined,
            listOwnedPullRequests: async () => [pr],
          }).sweep({ repo: pr.repo, number: pr.number });
          if (!(await publishSweepHead(result, deps, pr)))
            results.push(error("accepted native push binding remains unconfirmed"));
          else results.push(...report.results);
        } catch {
          results.push(error("original maintenance result unavailable"));
        } finally {
          if (admitted) {
            await settleKnownMaintenance(admitted, deps, pr).catch(() => undefined);
            await releaseMaintenanceReservation(admitted, deps.instances);
          }
        }
      }
      return { repo: target.repo, results };
    },
  };
}
