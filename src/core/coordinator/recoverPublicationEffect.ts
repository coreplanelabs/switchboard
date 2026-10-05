import type { IdentityRefPublication, RewriteResult } from "../../execution/identityRewrite.js";
import type { OpenedPullRequest, PullRequestTarget, RecoveryPullWriteResult } from "../../execution/githubPulls.js";
import type { CoordinatorInstance, CoordinatorUnit } from "./contract.js";
import { STEP_NAME_PATTERN } from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import type { CoordinatorReportLedger } from "./reportContext.js";
import { contextThreadSessionKey, storedTurnRow } from "../runLedger/sessionLog.js";
import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../references/contextDependencies.js";
import { sourceHash } from "../references/receipts.js";
import type { UnitEffectExecution, UnitEffectRefusal, UnitEffectTransition } from "./unitEffect.js";

export interface RecoverPublicationInput {
  instance: CoordinatorInstance;
  unit: CoordinatorUnit;
  execution: UnitEffectExecution;
  effectId: string;
  ordinal: number;
  runId: string;
  headSha: string;
}
export interface RecoverPublicationDeps {
  instances: Pick<CoordinatorInstanceStore, "transitionUnitEffect">;
  ledger: CoordinatorReportLedger;
  head(): Promise<string | undefined>;
  render(): Promise<{ title: string; body: string }>;
  rewrite(refPublication: IdentityRefPublication, expectedTip: string): Promise<RewriteResult>;
  create(target: PullRequestTarget & { headSha: string }): Promise<RecoveryPullWriteResult>;
}
export type RecoverPublicationResult =
  | { ok: true; pr: OpenedPullRequest; effectOrdinal: number }
  | { ok: true; refused: true; effectOrdinal: number }
  | { ok: false; reason: UnitEffectRefusal };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/i.test(v);

/** Replay only this owner's frozen payload and positively acknowledged native
 * writes. Discovering a PR cannot resolve a possibly admitted create. */
export async function performRecoverPublication(
  input: RecoverPublicationInput,
  deps: RecoverPublicationDeps,
): Promise<RecoverPublicationResult> {
  let row = input.unit;
  const { instance, execution, effectId } = input;
  const fail = (reason: UnitEffectRefusal): RecoverPublicationResult => ({ ok: false, reason });
  if (
    execution.workflowId !== (row.recovery?.workflowId ?? instance.id) ||
    execution.recoveryActionId !== row.recovery?.actionId
  )
    return fail("execution");
  if (
    !instance.base ||
    !sha(input.headSha) ||
    !STEP_NAME_PATTERN.test(effectId) ||
    !effectId.startsWith(`${row.unit}/`) ||
    !Number.isSafeInteger(input.ordinal) ||
    input.ordinal < 1
  )
    return fail("conflict");
  const identity = {
    instanceId: instance.id,
    unit: row.unit,
    attempt: instance.attempt ?? 0,
    requester: instance.userId,
    channelId: instance.channelId,
    threadKey: row.threadKey ?? instance.threadKey,
    execution,
    effectId,
    ordinal: input.ordinal,
    runId: input.runId,
    repo: instance.repo,
    ref: row.branch,
    base: instance.base,
    headSha: input.headSha,
  };
  const key = contextThreadSessionKey(identity.threadKey);
  const rowId = `recover-publication:${await sourceHash(identity)}`;
  const read = async (id: string): Promise<unknown | undefined> => {
    const rows = await deps.ledger.readSessionEntry(key, id);
    if (rows === undefined) return undefined;
    if (rows.length !== 1 || rows[0]?.part !== 0) throw new Error("invalid publication snapshot");
    const entry = JSON.parse(rows[0].json);
    const saved = entry.recoverPublication;
    if (
      entry.role !== "assistant" ||
      entry.part?.type !== "text" ||
      entry.part.text !== "" ||
      saved?.version !== 1 ||
      !same(saved.owner, identity) ||
      !same(entry.context, UNKNOWN_CONTEXT_DEPENDENCIES)
    )
      throw new Error("foreign publication snapshot");
    return saved.value;
  };
  const freeze = async (id: string, value: unknown) => {
    const prior = await read(id);
    if (prior !== undefined) return prior;
    const appended = await deps.ledger.appendSession(
      key,
      id,
      [
        {
          part: 0,
          json: JSON.stringify({
            ...JSON.parse(
              storedTurnRow({ role: "assistant", text: "", folded: true, context: UNKNOWN_CONTEXT_DEPENDENCIES }),
            ),
            recoverPublication: { version: 1, owner: identity, value },
          }),
        },
      ],
      UNKNOWN_CONTEXT_DEPENDENCIES,
    );
    if (!appended.ok) throw new Error("publication snapshot unacknowledged");
    const saved = await read(id);
    if (saved === undefined) throw new Error("publication snapshot unavailable");
    return saved;
  };
  const move = async (change: UnitEffectTransition) => {
    const result = await deps.instances.transitionUnitEffect(change);
    if (!result.ok) throw result.reason;
    row = result.unit;
  };
  const settleRefusal = async (): Promise<RecoverPublicationResult | undefined> => {
    const cell = row.currentEffect;
    if (
      cell?.id !== effectId ||
      !cell.calls.some((call) => call.state === "refused" && call.cause === "external_refused")
    )
      return undefined;
    if (cell.calls.some((call) => call.state === "pending" || call.state === "uncertain")) return fail("uncertain");
    for (let call = 0; call < cell.calls.length; call++) {
      if (row.currentEffect!.calls[call]!.state === "unstarted")
        await move({ kind: "cancel", expected: row, execution, effectId, call });
    }
    if (row.currentEffect!.phase !== "settled") await move({ kind: "settle", expected: row, execution, effectId });
    return { ok: true, refused: true, effectOrdinal: cell.ordinal };
  };
  const admit = async (rewrite: boolean) =>
    move({
      kind: "admit",
      expected: row,
      execution,
      effect: {
        version: 1,
        id: effectId,
        ordinal: input.ordinal,
        execution,
        phase: "active",
        target: { repo: instance.repo, ref: row.branch, base: instance.base!, headSha: input.headSha },
        calls: [
          ...(rewrite ? [{ operation: "rebase_push" as const, state: "unstarted" as const }] : []),
          { operation: "pull_create", state: "unstarted" },
        ],
      },
    });
  try {
    let cell = row.currentEffect;
    if (cell?.id === effectId) {
      if (
        cell.ordinal !== input.ordinal ||
        !same(cell.execution, execution) ||
        cell.target.repo !== instance.repo ||
        cell.target.ref !== row.branch ||
        cell.target.base !== instance.base ||
        cell.target.headSha !== input.headSha ||
        cell.target.pr !== undefined ||
        !(
          (cell.calls.length === 1 && cell.calls[0]?.operation === "pull_create") ||
          (cell.calls.length === 2 &&
            cell.calls[0]?.operation === "rebase_push" &&
            cell.calls[1]?.operation === "pull_create")
        )
      )
        return fail("conflict");
      if (cell.calls.some((c) => c.state === "pending" || c.state === "uncertain")) return fail("uncertain");
    } else if (cell?.phase === "active") return fail("busy");
    else if (input.ordinal !== (cell?.ordinal ?? 0) + 1) return fail("conflict");
    let payload = await read(rowId);
    if (payload === undefined) {
      if (cell?.id === effectId) return fail("unavailable");
      if ((await deps.head()) !== input.headSha) return fail("conflict");
      payload = await freeze(rowId, await deps.render());
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).length !== 2 ||
      typeof (payload as { title?: unknown }).title !== "string" ||
      typeof (payload as { body?: unknown }).body !== "string"
    )
      return fail("conflict");
    const rendered = payload as { title: string; body: string };
    if (!rendered.title || rendered.title.length > 512 || rendered.body.length > 65000) return fail("conflict");
    const replayedRefusal = await settleRefusal();
    if (replayedRefusal !== undefined) return replayedRefusal;
    if (cell?.id !== effectId || (cell.calls[0]?.operation === "rebase_push" && cell.calls[0].state === "unstarted")) {
      const rewritten = await deps.rewrite(
        {
          begin: async ({ repo, update }) => {
            if (
              repo !== instance.repo ||
              update.ref !== `refs/heads/${row.branch}` ||
              update.old !== input.headSha ||
              !sha(update.next) ||
              update.next === update.old
            )
              return undefined;
            const frozen = await freeze(`${rowId}:ref`, update);
            if (!same(frozen, update) || (await deps.head()) !== update.old) return undefined;
            if (row.currentEffect?.id !== effectId) await admit(true);
            else if (
              row.currentEffect.calls[0]?.operation !== "rebase_push" ||
              row.currentEffect.calls[0].state !== "unstarted"
            )
              return undefined;
            await move({ kind: "begin", expected: row, execution, effectId, call: 0 });
            return {
              finish: async (outcome) => {
                try {
                  await move({
                    kind: "complete",
                    expected: row,
                    execution,
                    effectId,
                    call: 0,
                    outcome:
                      outcome === "accepted"
                        ? { state: "accepted", commitSha: update.next }
                        : outcome === "not_forwarded"
                          ? { state: "refused", cause: "external_refused" }
                          : { state: "uncertain" },
                  });
                  return true;
                } catch {
                  return false;
                }
              },
            };
          },
        },
        input.headSha,
      );
      const refusedRewrite = await settleRefusal();
      if (refusedRewrite !== undefined) return refusedRewrite;
      if (rewritten.kind === "unreadable")
        return fail(
          row.currentEffect?.calls.some((c) => c.state === "pending" || c.state === "uncertain")
            ? "uncertain"
            : "unavailable",
        );
      if (row.currentEffect?.id !== effectId) {
        if (rewritten.kind !== "clean") return fail("conflict");
        await admit(false);
      }
      cell = row.currentEffect!;
    }
    cell = row.currentEffect!;
    if (cell.calls.length === 2) {
      const ref = (await read(`${rowId}:ref`)) as { ref?: string; old?: string; next?: string } | undefined;
      if (
        !ref ||
        ref.ref !== `refs/heads/${row.branch}` ||
        ref.old !== input.headSha ||
        !sha(ref.next) ||
        (cell.calls[0]?.state === "accepted" && cell.calls[0].commitSha !== ref.next)
      )
        return fail("conflict");
    }
    const createIndex = cell.calls.length - 1;
    const call = cell.calls[createIndex]!;
    const headSha =
      cell.calls.length === 2 && cell.calls[0]?.state === "accepted" ? cell.calls[0].commitSha : input.headSha;
    if (!sha(headSha)) return fail("conflict");
    if (cell.calls.length === 2 && cell.calls[0]?.state !== "accepted") return fail("conflict");
    if (call.state === "accepted") {
      if (!call.pr || call.commitSha?.toLowerCase() !== headSha.toLowerCase()) return fail("conflict");
      if (cell.phase !== "settled") await move({ kind: "settle", expected: row, execution, effectId });
      return {
        ok: true,
        pr: { number: call.pr.number, htmlUrl: call.pr.url, created: true },
        effectOrdinal: cell.ordinal,
      };
    }
    if (call.state === "refused") return (await settleRefusal()) ?? fail("conflict");
    if ((await deps.head()) !== headSha) return fail("conflict");
    await move({ kind: "begin", expected: row, execution, effectId, call: createIndex });
    let answer: Awaited<ReturnType<RecoverPublicationDeps["create"]>> = { state: "uncertain" };
    try {
      answer = await deps.create({
        repo: instance.repo,
        headBranch: row.branch,
        base: instance.base,
        title: rendered.title,
        body: rendered.body,
        headSha,
      });
    } catch {
      /* Unknown admission retains the exact cell. */
    }
    if (answer.state === "accepted" && (!sha(answer.headSha) || answer.headSha.toLowerCase() !== headSha.toLowerCase()))
      answer = { state: "uncertain" };
    await move({
      kind: "complete",
      expected: row,
      execution,
      effectId,
      call: createIndex,
      outcome:
        answer.state === "accepted"
          ? {
              state: "accepted",
              commitSha: answer.headSha.toLowerCase(),
              pr: { number: answer.pr.number, url: answer.pr.htmlUrl },
            }
          : answer.state === "refused"
            ? { state: "refused", cause: "external_refused" }
            : { state: "uncertain" },
    });
    if (answer.state === "uncertain") return fail("uncertain");
    await move({ kind: "settle", expected: row, execution, effectId });
    return answer.state === "accepted"
      ? { ok: true, pr: answer.pr, effectOrdinal: input.ordinal }
      : { ok: true, refused: true, effectOrdinal: input.ordinal };
  } catch (reason) {
    return fail(
      typeof reason === "string" &&
        ["stale", "stopped", "execution", "busy", "uncertain", "conflict", "owned", "incomplete"].includes(reason)
        ? (reason as UnitEffectRefusal)
        : "unavailable",
    );
  }
}
