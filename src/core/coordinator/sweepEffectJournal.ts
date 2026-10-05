import type { SweepEffectJournal, SweepNativePlan } from "../pullSweep.js";
import { isPublicationRepo } from "../branchPublication.js";
import { PRIVATE_WORKER_REPLY_MAX_CHARS, privateWorkerThreadKey } from "../privateWorkerLog.js";
import { UNKNOWN_CONTEXT_DEPENDENCIES } from "../references/contextDependencies.js";
import { sourceHash } from "../references/receipts.js";
import { contextThreadSessionKey, storedTurnRow } from "../runLedger/sessionLog.js";
import type { RunLedger } from "../runLedger/ledger.js";
import {
  isCoordinatorInstance,
  isCoordinatorUnit,
  type CoordinatorInstance,
  type CoordinatorUnit,
} from "./contract.js";
import type { CoordinatorInstanceStore } from "./instanceStore.js";
import {
  isUnitCurrentEffect,
  isUnitEffectOutcome,
  unitEffectResultMatches,
  type UnitCurrentEffect,
  type UnitEffectExecution,
  type UnitEffectTransition,
} from "./unitEffect.js";

export interface SweepJournalInput {
  instance: CoordinatorInstance;
  unit: CoordinatorUnit;
  execution: UnitEffectExecution;
  effectId: string;
  ordinal: number;
}
export interface SweepJournalDeps {
  instances: Pick<CoordinatorInstanceStore, "get" | "listUnits" | "transitionUnitEffect">;
  ledger: Pick<RunLedger, "appendSession" | "readSessionEntry">;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: readonly string[]) => Object.keys(v).every((k) => names.includes(k));
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/i.test(v);
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : object(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .filter((k) => value[k] !== undefined)
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hash = (v: unknown) => sourceHash(canonical(v));
const invalid = () => new Error("original sweep ownership or frozen payload unavailable");
function ownerIdentity(instance: CoordinatorInstance) {
  return {
    id: instance.id,
    kind: instance.kind,
    userId: instance.userId,
    authenticatedAs: instance.authenticatedAs,
    postedBy: instance.postedBy,
    channelId: instance.channelId,
    threadKey: instance.threadKey,
    repo: instance.repo.toLowerCase(),
    branch: instance.branch,
    base: instance.base ?? "main",
    attempt: instance.attempt ?? 0,
    createdAt: instance.createdAt,
    grant: instance.grant,
    caps: instance.caps,
  };
}
/** Closed immutable bytes; call state is always projected from the unit cell. */
function frozenPlan(value: unknown): SweepNativePlan {
  if (
    !object(value) ||
    !keys(value, ["pr", "newHead", "decision", "calls", "preparedSource"]) ||
    !object(value.pr) ||
    !keys(value.pr, ["repo", "number", "branch", "base", "headSha", "mergeableState", "approved"]) ||
    !isPublicationRepo(value.pr.repo) ||
    !positive(value.pr.number) ||
    !text(value.pr.branch) ||
    !text(value.pr.base) ||
    !sha(value.pr.headSha) ||
    typeof value.pr.mergeableState !== "string" ||
    typeof value.pr.approved !== "boolean" ||
    !sha(value.newHead) ||
    !["carry", "delta-review", "fix-round"].includes(value.decision as string) ||
    !Array.isArray(value.calls) ||
    value.calls.length < 1 ||
    value.calls.length > 4
  )
    throw invalid();
  const pr = value.pr;
  const seen = new Set<string>();
  const calls = value.calls.map((call: unknown, index: number): SweepNativePlan["calls"][number] => {
    if (
      !object(call) ||
      !["unstarted", "pending", "accepted", "refused", "uncertain"].includes(call.state as string) ||
      !text(call.operation) ||
      seen.has(call.operation)
    )
      throw invalid();
    seen.add(call.operation);
    if (call.operation === "rebase_push" && index === 0 && keys(call, ["operation", "state"]))
      return { operation: call.operation, state: "unstarted" as const };
    if (
      call.operation === "review_anchor" &&
      index > 0 &&
      keys(call, ["operation", "state", "patch"]) &&
      object(call.patch) &&
      keys(call.patch, ["title", "body"]) &&
      typeof call.patch.title === "string" &&
      typeof call.patch.body === "string"
    )
      return {
        operation: call.operation,
        state: "unstarted" as const,
        patch: { title: call.patch.title, body: call.patch.body },
      };
    if (
      call.operation === "approval_reset" &&
      index > 0 &&
      value.decision === "carry" &&
      pr.approved === true &&
      keys(call, ["operation", "state", "body"]) &&
      typeof call.body === "string" &&
      call.body.length > 0
    )
      return { operation: call.operation, state: "unstarted" as const, body: call.body };
    if (
      call.operation === "spawn" &&
      ((index > 0 && value.decision === "delta-review" && call.agent === undefined) ||
        (index === 0 && value.decision === "fix-round" && call.agent === "coding")) &&
      keys(call, ["operation", "state", "request", "agent"]) &&
      object(call.request) &&
      keys(call.request, ["channelId", "userId", "threadKey", "text"]) &&
      text(call.request.channelId) &&
      text(call.request.userId) &&
      text(call.request.threadKey) &&
      typeof call.request.text === "string" &&
      call.request.text.length > 0
    )
      return {
        operation: call.operation,
        ...(call.agent === "coding" ? { agent: "coding" as const } : {}),
        state: "unstarted" as const,
        request: {
          channelId: call.request.channelId,
          userId: call.request.userId,
          threadKey: call.request.threadKey,
          text: call.request.text,
        },
      };
    throw invalid();
  });
  if (
    (value.decision === "fix-round"
      ? calls.length !== 1 ||
        value.newHead.toLowerCase() !== (pr.headSha as string).toLowerCase() ||
        value.preparedSource !== undefined
      : calls[0]?.operation !== "rebase_push") ||
    (value.decision === "carry" && value.pr.approved && !seen.has("approval_reset"))
  )
    throw invalid();
  const source = value.preparedSource;
  if (
    source !== undefined &&
    (!object(source) ||
      !keys(source, ["baseHead", "committer"]) ||
      !sha(source.baseHead) ||
      !object(source.committer) ||
      !keys(source.committer, ["name", "email"]) ||
      !text(source.committer.name) ||
      !text(source.committer.email))
  )
    throw invalid();
  const plan: SweepNativePlan = {
    pr: {
      repo: value.pr.repo.toLowerCase(),
      number: value.pr.number,
      branch: value.pr.branch,
      base: value.pr.base,
      headSha: value.pr.headSha.toLowerCase(),
      mergeableState: value.pr.mergeableState,
      approved: value.pr.approved,
    },
    newHead: value.newHead.toLowerCase(),
    decision: value.decision as SweepNativePlan["decision"],
    calls,
    ...(source === undefined
      ? {}
      : {
          preparedSource: {
            baseHead: (source as { baseHead: string }).baseHead.toLowerCase(),
            committer: { ...(source as { committer: { name: string; email: string } }).committer },
          },
        }),
  };
  if (JSON.stringify(plan).length > PRIVATE_WORKER_REPLY_MAX_CHARS) throw invalid();
  return plan;
}
interface Snapshot {
  plan: SweepNativePlan;
  initialHash: string;
  proposalHash: string;
}
/** Existing session bytes and unit transitions are the only durable authority. */
export function createSweepEffectJournal(input: SweepJournalInput, deps: SweepJournalDeps): SweepEffectJournal {
  input = structuredClone(input);
  if (
    !isCoordinatorInstance(input.instance) ||
    !isCoordinatorUnit(input.unit) ||
    input.unit.instanceId !== input.instance.id ||
    !text(input.effectId) ||
    !positive(input.ordinal)
  )
    throw invalid();
  const owner = ownerIdentity(input.instance);
  const binding = {
    owner,
    unit: input.unit.unit,
    execution: input.execution,
    effectId: input.effectId,
    ordinal: input.ordinal,
  };
  const location = hash(binding).then((digest) => ({
    key: contextThreadSessionKey(privateWorkerThreadKey({ instanceId: input.instance.id, unit: input.unit.unit })),
    rowId: `sweep-effect:${digest}`,
  }));
  let begun: { index: number; row: CoordinatorUnit } | undefined;
  const fresh = async () => {
    const [actualOwner, rows] = await Promise.all([
      deps.instances.get(input.instance.id),
      deps.instances.listUnits(input.instance.id),
    ]);
    const matches = rows.filter((row) => row.unit === input.unit.unit);
    if (
      !actualOwner ||
      !isCoordinatorInstance(actualOwner) ||
      !same(ownerIdentity(actualOwner), owner) ||
      matches.length !== 1 ||
      !isCoordinatorUnit(matches[0]) ||
      matches[0]!.instanceId !== input.instance.id ||
      (input.execution.maintenance
        ? !same(matches[0]!.currentEffect?.execution, input.execution) ||
          !!matches[0]!.recovery ||
          !!matches[0]!.recoveryHold
        : input.execution.workflowId !== (matches[0]!.recovery?.workflowId ?? actualOwner.id) ||
          input.execution.recoveryActionId !== matches[0]!.recovery?.actionId)
    )
      throw invalid();
    return { owner: actualOwner, row: matches[0]! };
  };
  const target = (plan: SweepNativePlan) => ({
    repo: plan.pr.repo,
    pr: plan.pr.number,
    ref: plan.pr.branch,
    base: plan.pr.base,
    headSha: plan.pr.headSha,
  });
  const planMatchesOwner = (plan: SweepNativePlan, row: CoordinatorUnit) =>
    plan.pr.repo === owner.repo &&
    plan.pr.branch === input.unit.branch &&
    plan.pr.base === (input.execution.maintenance ? input.unit.currentEffect?.target.base : owner.base) &&
    (!input.execution.maintenance ||
      (row.currentEffect?.target.base === plan.pr.base && row.publication?.baseRef === plan.pr.base)) &&
    plan.pr.number === input.unit.pr?.number &&
    (plan.pr.headSha === (row.publication?.expectedHeadSha ?? row.lastPush)?.toLowerCase() ||
      (row.currentEffect?.id === input.effectId &&
        row.currentEffect.ordinal === input.ordinal &&
        same(row.currentEffect.execution, input.execution) &&
        same(row.currentEffect.target, target(plan)) &&
        row.publication?.expectedHeadSha.toLowerCase() === plan.newHead &&
        row.currentEffect.calls.some(
          (call) =>
            call.operation === "rebase_push" &&
            call.state === "accepted" &&
            call.commitSha?.toLowerCase() === plan.newHead,
        )));
  const load = async (): Promise<Snapshot | undefined> => {
    const { key, rowId } = await location;
    const rows = await deps.ledger.readSessionEntry(key, rowId);
    if (rows === undefined) return undefined;
    if (rows.length !== 1 || rows[0]!.part !== 0) throw invalid();
    let row: unknown;
    try {
      row = JSON.parse(rows[0]!.json);
    } catch {
      throw invalid();
    }
    if (
      !object(row) ||
      !keys(row, ["role", "part", "silent", "folded", "context", "sweepEffect"]) ||
      row.role !== "assistant" ||
      row.silent !== true ||
      row.folded !== true ||
      !same(row.part, { type: "text", text: "" }) ||
      !same(row.context, UNKNOWN_CONTEXT_DEPENDENCIES) ||
      !object(row.sweepEffect) ||
      !keys(row.sweepEffect, ["version", "binding", "initialHash", "proposalHash", "plan"]) ||
      row.sweepEffect.version !== 1 ||
      !same(row.sweepEffect.binding, binding) ||
      typeof row.sweepEffect.initialHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.sweepEffect.initialHash) ||
      typeof row.sweepEffect.proposalHash !== "string"
    )
      throw invalid();
    const plan = frozenPlan(row.sweepEffect.plan);
    if (
      !planMatchesOwner(plan, (await fresh()).row) ||
      !same(plan, row.sweepEffect.plan) ||
      row.sweepEffect.proposalHash !== (await hash({ binding, initialHash: row.sweepEffect.initialHash, plan }))
    )
      throw invalid();
    return { plan, initialHash: row.sweepEffect.initialHash, proposalHash: row.sweepEffect.proposalHash };
  };
  const matchesCell = (row: CoordinatorUnit, snapshot: Snapshot) => {
    const cell = row.currentEffect;
    return (
      !!cell &&
      isUnitCurrentEffect(cell) &&
      cell.id === input.effectId &&
      cell.ordinal === input.ordinal &&
      cell.preparation === undefined &&
      same(cell.execution, input.execution) &&
      same(cell.target, target(snapshot.plan)) &&
      cell.calls.length === snapshot.plan.calls.length &&
      cell.calls.every(
        (call, index) =>
          call.operation === snapshot.plan.calls[index]!.operation &&
          call.agent ===
            (snapshot.plan.calls[index]!.operation === "spawn" ? snapshot.plan.calls[index]!.agent : undefined) &&
          call.resourceId === undefined &&
          (call.state !== "accepted" ||
            (call.operation === "rebase_push"
              ? call.commitSha?.toLowerCase() === snapshot.plan.newHead &&
                call.runId === undefined &&
                call.pr === undefined
              : call.operation === "spawn"
                ? call.runId !== undefined && call.commitSha === undefined && call.pr === undefined
                : call.commitSha === undefined && call.runId === undefined && call.pr === undefined)),
      )
    );
  };
  const preAdmission = (row: CoordinatorUnit) =>
    (row.currentEffect?.preparation === "reserved" &&
      row.currentEffect.id === input.effectId &&
      row.currentEffect.ordinal === input.ordinal &&
      same(row.currentEffect.execution, input.execution)) ||
    (row.currentEffect?.phase !== "active" &&
      (row.currentEffect?.ordinal ?? 0) + 1 === input.ordinal &&
      row.currentEffect?.id !== input.effectId);
  const confirmed = async (change: UnitEffectTransition, retry = false): Promise<CoordinatorUnit | undefined> => {
    for (let attempt = 0; ; attempt++) {
      let answer;
      try {
        answer = await deps.instances.transitionUnitEffect(change);
      } catch {
        answer = { ok: false as const, reason: "unavailable" as const };
      }
      if (answer.ok && unitEffectResultMatches(change, answer.unit)) return answer.unit;
      // A matching pending row cannot identify which concurrent caller began
      // it. Only this transition's positive receipt permits a native write.
      if (change.kind === "begin") return undefined;
      const actual = await fresh();
      if (unitEffectResultMatches(change, actual.row)) return actual.row;
      if (!retry || attempt !== 0 || answer.ok || answer.reason !== "unavailable" || !same(actual.row, change.expected))
        return undefined;
    }
  };
  const admit = async (value: SweepNativePlan): Promise<boolean> => {
    try {
      const plan = frozenPlan(value);
      if (plan.decision === "fix-round" && !input.execution.maintenance) return false;
      if (!planMatchesOwner(plan, (await fresh()).row)) return false;
      let snapshot = await load();
      let actual = await fresh();
      if (snapshot && !same(snapshot.plan, plan)) return false;
      if (snapshot && matchesCell(actual.row, snapshot)) return true;
      if (actual.owner.stop || !preAdmission(actual.row) || !same(actual.row, input.unit)) return false;
      if (snapshot && snapshot.initialHash !== (await hash(actual.row))) return false;
      if (!snapshot) {
        const initialHash = await hash(actual.row);
        const proposalHash = await hash({ binding, initialHash, plan });
        const json = JSON.stringify({
          ...JSON.parse(
            storedTurnRow({
              role: "assistant",
              text: "",
              silent: true,
              folded: true,
              context: UNKNOWN_CONTEXT_DEPENDENCIES,
            }),
          ),
          sweepEffect: { version: 1, binding, initialHash, proposalHash, plan },
        });
        const { key, rowId } = await location;
        try {
          await deps.ledger.appendSession(key, rowId, [{ part: 0, json }], UNKNOWN_CONTEXT_DEPENDENCIES);
        } catch {
          /* Read only the exact original append after transport loss. */
        }
        snapshot = await load();
        if (
          !snapshot ||
          !same(snapshot.plan, plan) ||
          snapshot.initialHash !== initialHash ||
          snapshot.proposalHash !== proposalHash
        )
          return false;
      }
      actual = await fresh();
      if (actual.owner.stop || snapshot.initialHash !== (await hash(actual.row)) || !preAdmission(actual.row))
        return false;
      const effect: UnitCurrentEffect = {
        version: 1,
        id: input.effectId,
        ordinal: input.ordinal,
        execution: input.execution,
        phase: "active",
        target: target(plan),
        calls: plan.calls.map((call) => ({
          operation: call.operation,
          ...(call.operation === "spawn" && call.agent === "coding" ? { agent: "coding" as const } : {}),
          state: "unstarted",
        })),
      };
      return !!(await confirmed({
        kind: actual.row.currentEffect?.preparation === "reserved" ? "prepare" : "admit",
        expected: actual.row,
        execution: input.execution,
        effect,
      }));
    } catch {
      return false;
    }
  };
  return {
    async read(pr) {
      try {
        const actual = await fresh();
        const snapshot = await load();
        if (!snapshot) {
          if (!preAdmission(actual.row) || !same(actual.row, input.unit)) throw invalid();
          return undefined;
        }
        if (
          snapshot.plan.pr.repo !== pr.repo.toLowerCase() ||
          snapshot.plan.pr.number !== pr.number ||
          snapshot.plan.pr.branch !== pr.branch ||
          snapshot.plan.pr.base !== pr.base
        )
          throw invalid();
        if (matchesCell(actual.row, snapshot))
          return {
            ...structuredClone(snapshot.plan),
            calls: snapshot.plan.calls.map((call, index) => ({
              ...call,
              state: actual.row.currentEffect!.calls[index]!.state,
            })),
          };
        if (!preAdmission(actual.row) || snapshot.initialHash !== (await hash(actual.row))) throw invalid();
        return structuredClone(snapshot.plan);
      } catch {
        throw invalid();
      }
    },
    admit,
    async begin(value, index) {
      try {
        const snapshot = await load();
        if (
          !snapshot ||
          !same(snapshot.plan, frozenPlan(value)) ||
          !Number.isSafeInteger(index) ||
          index < 0 ||
          !snapshot.plan.calls[index]
        )
          return false;
        let actual = await fresh();
        if (!matchesCell(actual.row, snapshot)) {
          if (index !== 0 || !(await admit(snapshot.plan))) return false;
          actual = await fresh();
        }
        const cell = actual.row.currentEffect!;
        if (
          cell.phase !== "active" ||
          actual.owner.stop ||
          cell.calls.some(
            (call) => call.state === "pending" || call.state === "uncertain" || call.state === "refused",
          ) ||
          cell.calls[index]!.state !== "unstarted" ||
          cell.calls.slice(0, index).some((call) => call.state !== "accepted")
        )
          return false;
        const next = await confirmed({
          kind: "begin",
          expected: actual.row,
          execution: input.execution,
          effectId: input.effectId,
          call: index,
        });
        if (!next) return false;
        begun = { index, row: next };
        return true;
      } catch {
        return false;
      }
    },
    async complete(value, index, outcome) {
      try {
        const snapshot = await load();
        if (
          !snapshot ||
          !same(snapshot.plan, frozenPlan(value)) ||
          begun?.index !== index ||
          !isUnitEffectOutcome(outcome) ||
          (outcome.state === "refused" && outcome.cause !== "external_refused")
        )
          return false;
        const call = snapshot.plan.calls[index];
        if (
          !call ||
          (outcome.state === "accepted" &&
            (call.operation === "rebase_push"
              ? outcome.commitSha?.toLowerCase() !== snapshot.plan.newHead ||
                outcome.runId !== undefined ||
                outcome.pr !== undefined
              : call.operation === "spawn"
                ? outcome.runId === undefined || outcome.commitSha !== undefined || outcome.pr !== undefined
                : outcome.runId !== undefined || outcome.commitSha !== undefined || outcome.pr !== undefined))
        )
          return false;
        await fresh();
        const next = await confirmed(
          {
            kind: "complete",
            expected: begun.row,
            execution: input.execution,
            effectId: input.effectId,
            call: index,
            outcome,
          },
          outcome.state !== "uncertain",
        );
        if (!next) return false;
        begun = undefined;
        return true;
      } catch {
        return false;
      }
    },
    async settle(value) {
      try {
        const snapshot = await load();
        const actual = await fresh();
        if (
          !snapshot ||
          !same(snapshot.plan, frozenPlan(value)) ||
          !matchesCell(actual.row, snapshot) ||
          actual.row.currentEffect!.calls.some((call) => call.state !== "accepted")
        )
          return false;
        if (actual.row.currentEffect!.phase === "settled") return true;
        return !!(await confirmed({
          kind: "settle",
          expected: actual.row,
          execution: input.execution,
          effectId: input.effectId,
        }));
      } catch {
        return false;
      }
    },
  };
}
